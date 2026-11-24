// AggLayer messages: the on-chain half (encode a bridge message, send it from an EVM wallet or a Solana wallet, read its
// leaf from the receipt, and claim it on the destination) and the API half (`createMessagesClient`, in `./messagesApi.ts`,
// re-exported below). Separate entry point: `@rome-protocol/sdk/messages`.
//
// The on-chain functions call no API: the claim proof is an input (`MessageProof`), the shape of the `proof` field in the
// answer of Solgate's `/v1/messages/:id/proof`. Sends and claims on a Rome chain go through the SDK's write paths (`submitRomeTx` for an EVM wallet that
// asks for it, `submitRomeTxV1` for a Solana wallet).
import { decodeEventLog, encodeFunctionData, parseAbi, type Hex, type PublicClient, type WalletClient } from "viem";
import { submitRomeTx } from "./write.js";
import { submitRomeTxV1, type SolanaLaneV1Deps, type SolanaLaneV1Result } from "./solanaV1.js";
import { syntheticAddress, type SolanaPubkeyInput } from "./solana.js";

export * from "./messagesApi.js";

/** The bridge's message calls. `bridgeMessage` is payable (value only where the chain's gas token is ETH); `bridgeMessageWETH` burns the bridge's WETH. */
export const bridgeMessageAbi = parseAbi([
  "function bridgeMessage(uint32 destinationNetwork, address destinationAddress, bool forceUpdateGlobalExitRoot, bytes metadata) payable",
  "function bridgeMessageWETH(uint32 destinationNetwork, address destinationAddress, uint256 amountWETH, bool forceUpdateGlobalExitRoot, bytes metadata)",
]);

/** The bridge's claim and claim-status calls. */
export const claimMessageAbi = parseAbi([
  "function claimMessage(bytes32[32] smtProofLocalExitRoot, bytes32[32] smtProofRollupExitRoot, uint256 globalIndex, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata)",
  "function isClaimed(uint32 leafIndex, uint32 sourceBridgeNetwork) view returns (bool)",
]);

/** The event the bridge emits for every leaf it adds: `leafType` 0 is a token, 1 is a message. */
export const bridgeEventAbi = parseAbi([
  "event BridgeEvent(uint8 leafType, uint32 originNetwork, address originAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes metadata, uint32 depositCount)",
]);

/** What a receiving contract implements; the bridge calls it on `claimMessage`, and the bridge is `msg.sender`. */
export const messageReceiverAbi = parseAbi([
  "function onMessageReceived(address originAddress, uint32 originNetwork, bytes data) payable",
]);

/** Value out of Rome moves only in whole units of 1e9 wei (the bridge's WETH adapter mints and burns whole 9-decimal SPL units). */
export const ROME_WETH_UNIT = 10n ** 9n;

const LEAF_TYPE_MESSAGE = 1;

export interface BridgeMessage {
  /** The AggLayer network id of the chain the message goes to. */
  destinationNetwork: number;
  /** The contract on that chain whose `onMessageReceived` runs. */
  destinationAddress: Hex;
  /** What the receiver is handed as `data`. */
  metadata: Hex;
  /** Publish the global exit root in the same transaction, so the message is claimable without waiting for another deposit. Default true. */
  forceUpdateGlobalExitRoot?: boolean;
}

/** A message to address 0 reaches nothing and nobody can claim it, so no send is built for it, in any case of the digits. */
function assertDestination(m: BridgeMessage): void {
  if (/^0x0{40}$/i.test(m.destinationAddress)) throw new Error("destinationAddress is the zero address: a message sent there is lost, so no calldata is built");
}

/** The calldata of `bridgeMessage`. Refuses a zero destination address. */
export function encodeBridgeMessage(m: BridgeMessage): Hex {
  assertDestination(m);
  return encodeFunctionData({
    abi: bridgeMessageAbi,
    functionName: "bridgeMessage",
    args: [m.destinationNetwork, m.destinationAddress, m.forceUpdateGlobalExitRoot ?? true, m.metadata],
  });
}

/** The calldata of `bridgeMessageWETH`: the message carries `amountWETH` of the bridge's WETH, burned on the send. Refuses a zero destination address. */
export function encodeBridgeMessageWETH(m: BridgeMessage & { amountWETH: bigint }): Hex {
  assertDestination(m);
  return encodeFunctionData({
    abi: bridgeMessageAbi,
    functionName: "bridgeMessageWETH",
    args: [m.destinationNetwork, m.destinationAddress, m.amountWETH, m.forceUpdateGlobalExitRoot ?? true, m.metadata],
  });
}

function assertWholeUnits(amount: bigint): void {
  if (amount < 0n || amount % ROME_WETH_UNIT !== 0n) {
    throw new Error(`WETH amount ${amount} is not a whole multiple of ROME_WETH_UNIT (${ROME_WETH_UNIT} wei)`);
  }
}

type EvmSendResult = Hex;

/** Send through the wallet; with `rome`, through `submitRomeTx` (Rome gas sizing; needs a wallet that signs over JSON-RPC, such as a browser wallet). */
async function sendFromEvm(
  walletClient: WalletClient,
  tx: { to: Hex; data: Hex; value?: bigint },
  rome: boolean | undefined,
): Promise<EvmSendResult> {
  const account = walletClient.account;
  if (!account) throw new Error("the wallet client has no account");
  if (rome) {
    const provider = { request: (args: { method: string; params?: unknown[] }) => walletClient.request(args as never) as Promise<unknown> };
    return submitRomeTx(provider, { from: account.address, to: tx.to, data: tx.data, value: tx.value });
  }
  return walletClient.sendTransaction({ account, chain: walletClient.chain, to: tx.to, data: tx.data, value: tx.value });
}

export interface SendMessageOptions {
  /** The bridge of the chain the message leaves. */
  bridge: Hex;
  message: BridgeMessage;
  /**
   * Without `weth`: native value sent with `bridgeMessage`, the caller's choice (on a chain whose gas token is not ETH the bridge reverts a send that carries value).
   * With `weth: true`: the amount of the bridge's WETH to carry, in wei; it must be a whole multiple of {@link ROME_WETH_UNIT} (Rome's rule: its WETH adapter moves whole 9-decimal units, so a bridge on Rome refuses any other amount; value into a Rome chain arrives only in whole units, the remainder below one unit is lost).
   * On a Rome chain the send first needs an `approve`: call `approve` on the adapter's wrapper (`adapter.wrapper()`, 9 decimals, the adapter being the bridge's `WETHToken()`) with the adapter as spender for at least `value / ROME_WETH_UNIT`. Without it the send reverts, and on the relay route the revert does not throw: it comes back as a receipt with status `0x0`.
   */
  value?: bigint;
  /** Use `bridgeMessageWETH`, with `value` as the WETH amount; no native value is sent. */
  weth?: boolean;
  /** Send through `submitRomeTx` instead of the wallet's own fee sizing. Set it when the bridge is on a Rome chain. */
  rome?: boolean;
}

/** Send a bridge message from an EVM wallet; returns the transaction hash. */
export async function sendMessageFromEvm(walletClient: WalletClient, o: SendMessageOptions): Promise<Hex> {
  if (o.weth) {
    if (o.value === undefined) throw new Error("weth: the amount to carry is `value`");
    assertWholeUnits(o.value);
    return sendFromEvm(walletClient, { to: o.bridge, data: encodeBridgeMessageWETH({ ...o.message, amountWETH: o.value }) }, o.rome);
  }
  return sendFromEvm(walletClient, { to: o.bridge, data: encodeBridgeMessage(o.message), value: o.value }, o.rome);
}

/**
 * Send a bridge message from a Solana wallet as one call through `submitRomeTxV1` (atomic, relayed when the proxy refuses it atomic).
 * With `amountWETH` the message carries that much of the bridge's WETH (a whole multiple of {@link ROME_WETH_UNIT}); otherwise it carries none.
 * On a Rome chain the WETH send needs an `approve` first: call `approve` on the adapter's wrapper (`adapter.wrapper()`, the adapter being the bridge's `WETHToken()`) with the adapter as spender for at least `amountWETH / ROME_WETH_UNIT`, as its own call, before this one. Without it the send reverts, and on the relay route the revert does not throw: check `receipt?.status === "0x1"`.
 */
export async function sendMessageFromSolanaWallet(
  deps: SolanaLaneV1Deps,
  o: { bridge: Hex; message: BridgeMessage; amountWETH?: bigint },
): Promise<SolanaLaneV1Result> {
  if (o.amountWETH !== undefined) {
    assertWholeUnits(o.amountWETH);
    return submitRomeTxV1(deps, { to: o.bridge, data: encodeBridgeMessageWETH({ ...o.message, amountWETH: o.amountWETH }) });
  }
  return submitRomeTxV1(deps, { to: o.bridge, data: encodeBridgeMessage(o.message) });
}

/**
 * The `originAddress` a destination sees for a message sent by a Solana wallet or a PDA on Rome: the synthetic address
 * `keccak256(pubkey)[12..32]`.
 */
export function messageOriginOf(pubkeyOrPda: SolanaPubkeyInput): Hex {
  return syntheticAddress(pubkeyOrPda);
}

export interface MessageLeaf {
  /** 0 is a token leaf, 1 a message leaf. */
  leafType: number;
  depositCount: number;
  originNetwork: number;
  /** Lower case. */
  originAddress: Hex;
  destinationNetwork: number;
  /** Lower case. */
  destinationAddress: Hex;
  /** The value the leaf carries, in base units (the WETH amount, or a token amount on a token leaf). */
  amount: bigint;
  /** What the receiver is handed as `data`; empty on a token leaf. */
  metadata: Hex;
}

type LogLike = { address: string; topics: readonly string[]; data: string };

/** A viem `TransactionReceipt`, or the receipt of a Solana lane result (`SolanaLaneV1Result.receipt`, which may carry no `logs`). */
export type ReceiptLike = { logs?: unknown; [key: string]: unknown } | null | undefined;

/** The leaves a transaction added to `bridge`, from its receipt's BridgeEvent logs, in log order. Message leaves only, unless `includeTokens`. */
export function messageLeavesOf(receipt: ReceiptLike, bridge: Hex, opts: { includeTokens?: boolean } = {}): MessageLeaf[] {
  const out: MessageLeaf[] = [];
  const logs = receipt && Array.isArray(receipt.logs) ? (receipt.logs as readonly LogLike[]) : [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== bridge.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: bridgeEventAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
    } catch {
      continue; // another event of the bridge
    }
    const a = ev.args;
    if (a.leafType !== LEAF_TYPE_MESSAGE && !opts.includeTokens) continue;
    out.push({
      leafType: a.leafType,
      depositCount: a.depositCount,
      originNetwork: a.originNetwork,
      originAddress: a.originAddress.toLowerCase() as Hex,
      destinationNetwork: a.destinationNetwork,
      destinationAddress: a.destinationAddress.toLowerCase() as Hex,
      amount: a.amount,
      metadata: a.metadata,
    });
  }
  return out;
}

/** `claimMessage`'s arguments, by their names. `bigint` fields may be given as decimal strings (the form a JSON API serves). */
export interface MessageProof {
  /** 32 hashes. */
  smtProofLocalExitRoot: readonly Hex[];
  /** 32 hashes. */
  smtProofRollupExitRoot: readonly Hex[];
  globalIndex: bigint | string;
  mainnetExitRoot: Hex;
  rollupExitRoot: Hex;
  originNetwork: number;
  originAddress: Hex;
  destinationNetwork: number;
  destinationAddress: Hex;
  amount: bigint | string;
  metadata: Hex;
}

const PROOF_DEPTH = 32;

function toBigint(name: string, v: bigint | string): bigint {
  if (typeof v === "bigint") return v;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a bigint or a decimal string`);
  return BigInt(v);
}

function toProof32(name: string, p: readonly Hex[]): readonly Hex[] & { length: 32 } {
  if (p.length !== PROOF_DEPTH) throw new Error(`${name} must hold ${PROOF_DEPTH} hashes, got ${p.length}`);
  return p as readonly Hex[] & { length: 32 };
}

/** The calldata of `claimMessage` for a proof. */
export function encodeClaimMessage(p: MessageProof): Hex {
  return encodeFunctionData({
    abi: claimMessageAbi,
    functionName: "claimMessage",
    args: [
      toProof32("smtProofLocalExitRoot", p.smtProofLocalExitRoot) as never,
      toProof32("smtProofRollupExitRoot", p.smtProofRollupExitRoot) as never,
      toBigint("globalIndex", p.globalIndex),
      p.mainnetExitRoot,
      p.rollupExitRoot,
      p.originNetwork,
      p.originAddress,
      p.destinationNetwork,
      p.destinationAddress,
      toBigint("amount", p.amount),
      p.metadata,
    ],
  });
}

/** Claim a message on an EVM chain from an EVM wallet; returns the transaction hash. Set `rome` when the destination is a Rome chain (see {@link SendMessageOptions}). */
export async function claimMessageFromEvm(walletClient: WalletClient, bridge: Hex, proof: MessageProof, opts: { rome?: boolean } = {}): Promise<Hex> {
  return sendFromEvm(walletClient, { to: bridge, data: encodeClaimMessage(proof) }, opts.rome);
}

/** Claim a message on a Rome chain from a Solana wallet, through `submitRomeTxV1`. */
export async function claimMessageFromSolanaWallet(deps: SolanaLaneV1Deps, bridge: Hex, proof: MessageProof): Promise<SolanaLaneV1Result> {
  return submitRomeTxV1(deps, { to: bridge, data: encodeClaimMessage(proof) });
}

/** Whether the bridge has already claimed the leaf `depositCount` of `originNetwork`. */
export async function isMessageClaimed(publicClient: PublicClient, bridge: Hex, depositCount: number, originNetwork: number): Promise<boolean> {
  return publicClient.readContract({ address: bridge, abi: claimMessageAbi, functionName: "isClaimed", args: [depositCount, originNetwork] });
}
