/**
 * The **v1 Solana lane**: a Solana wallet drives an EVM contract on Rome with
 * one Solana v1 transaction (4096 bytes, up to 64 accounts, no lookup table).
 *
 * The proxy emulates the call and composes the whole transaction, so the client
 * sends no ComputeBudget instructions, treasure wallet or account list. The same
 * wallet key signs twice, over two different messages:
 *  1. an authorization over the readable text `Rome authorization\n0x<hash>`
 *     (`<hash>` = the EVM transaction hash), sent with the compose request;
 *  2. the Solana transaction signature over the composed v1 message.
 *
 * A call too large for one atomic transaction is refused by the composer; the
 * proxy can then relay it with the same authorization signature. A sender short
 * of native gas can top up from the wallet's gas-token account with {@link fundSyntheticGas}.
 *
 * `submitRomeTxSolanaLane` (`./solana.ts`) is the older legacy-transaction path.
 * The one-time `create_pda` step is still `provisionSynthetic` from that module.
 */
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { concatHex, keccak256, type Hex } from "viem";
import {
  buildUnsignedEip1559Rlp,
  sizeSolanaLaneFee,
  syntheticAddress,
  type EvmCall,
  type FeeFields,
} from "./solana.js";
import { jsonRpc } from "./jsonRpc.js";

// ------------------------------------------------------------ authorization ---
/** The text a wallet shows for the authorization signature, up to the hash. */
export const ED25519_AUTH_MESSAGE_PREFIX = "Rome authorization\n0x";

/** The EVM transaction hash of an unsigned EIP-1559 payload: `keccak256(0x02 ‖ rlp)`. */
export function authHashFor(unsignedRlp: Hex): Uint8Array {
  return keccak256(concatHex(["0x02", unsignedRlp]), "bytes");
}

/** The bytes the wallet signs: the prefix, then the hash as 64 lowercase hex characters (85 bytes). */
export function ed25519AuthMessage(hash: Uint8Array): Uint8Array {
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  return new TextEncoder().encode(`${ED25519_AUTH_MESSAGE_PREFIX}${hex}`);
}

// ------------------------------------------------------------------ signer ---
/**
 * What the lane needs from a wallet. Both methods return a raw 64-byte ed25519
 * signature from the key behind `payer`.
 */
export interface LaneSigner {
  payer: PublicKey;
  /**
   * Sign the readable authorization message exactly as given. A Wallet Standard
   * wallet does this with `solana:signMessage`.
   */
  signAuthHash(message: Uint8Array): Promise<Uint8Array>;
  /**
   * Sign a v1 wire (the message followed by one zero signature slot) and return
   * only the 64-byte signature for that slot, not the signed wire. A Wallet
   * Standard wallet's `solana:signTransaction` returns the whole signed wire as
   * `signedTransaction`, so return `signedTransaction.slice(-64)`.
   */
  signV1Wire(unsignedWire: Uint8Array): Promise<Uint8Array>;
}

export type SignerLike = LaneSigner | Keypair;

/** Wrap a `Keypair` as a {@link LaneSigner}; a `LaneSigner` is returned as is. */
export function toLaneSigner(signer: SignerLike): LaneSigner {
  // Duck-typed: a Keypair from another copy of web3.js is not an `instanceof` this one.
  const secretKey = (signer as { secretKey?: unknown }).secretKey;
  if (!(secretKey instanceof Uint8Array)) return signer as LaneSigner;
  const kp = signer as Keypair;
  const seed = kp.secretKey.slice(0, 32);
  return {
    payer: kp.publicKey,
    signAuthHash: async (message) => ed25519.sign(message, seed),
    signV1Wire: async (wire) => ed25519.sign(splitV1Wire(wire).message, seed),
  };
}

// --------------------------------------------------------------- v1 wire ---
const V1_VERSION_BYTE = 0x81;
const SIGNATURE_BYTES = 64;
const KNOWN_CONFIG_MASK_BITS = 0b11111;
/** Version, header, config mask, blockhash and the two counts. */
const MIN_MESSAGE_BYTES = 42;

/** Split a v1 wire into its message and signature count. Only single-signer wires are accepted. */
export function splitV1Wire(wire: Uint8Array): { message: Uint8Array; numRequiredSignatures: number } {
  if (wire[0] !== V1_VERSION_BYTE) {
    throw new Error(`not a v1 transaction (version byte 0x${(wire[0] ?? 0).toString(16)}, expected 0x81)`);
  }
  const numRequiredSignatures = wire[1] ?? 0;
  if (numRequiredSignatures !== 1) {
    throw new Error(`composed transaction needs ${numRequiredSignatures} signatures; this lane signs for one payer`);
  }
  if (wire.length < SIGNATURE_BYTES * numRequiredSignatures + MIN_MESSAGE_BYTES) {
    throw new Error(`v1 wire too short (${wire.length} bytes) for a header and ${numRequiredSignatures} signature`);
  }
  return { message: wire.slice(0, wire.length - SIGNATURE_BYTES * numRequiredSignatures), numRequiredSignatures };
}

/** The wire to broadcast: the message followed by the 64-byte signature. */
export function packSignedV1Wire(message: Uint8Array, signature: Uint8Array): Uint8Array {
  const out = new Uint8Array(message.length + signature.length);
  out.set(message, 0);
  out.set(signature, message.length);
  return out;
}

export interface V1Instruction {
  programIdIndex: number;
  accountIndices: number[];
  data: Uint8Array;
}
export interface ParsedV1Message {
  header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
  accountKeys: PublicKey[];
  instructions: V1Instruction[];
  /** Set only when the message's config mask carries a compute-unit limit. */
  computeUnitLimit?: number;
  /** Set only when the message's config mask carries a heap size. */
  heapBytes?: number;
}

/**
 * Decode a v1 message (no signatures). Layout: version(1) header(3) config mask
 * u32 blockhash(32) instruction count(1) account count(1), the account keys,
 * the config values the mask selects (priority fee u64 needs both of its bits,
 * then compute-unit limit u32, loaded-accounts size u32, heap size u32), the
 * 4-byte instruction headers (program index, account count, data length u16),
 * then each instruction's account indices and data. Throws on a wrong version,
 * unknown mask bits, a half-set priority fee, or a truncated message.
 */
export function parseV1Message(message: Uint8Array): ParsedV1Message {
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  let off = 0;
  const need = (n: number, what: string) => {
    if (off + n > message.length) {
      throw new Error(`v1 message truncated reading ${what} (need ${n} bytes at ${off}, ${message.length - off} left)`);
    }
  };
  need(MIN_MESSAGE_BYTES, "the fixed header");
  if (message[0] !== V1_VERSION_BYTE) throw new Error(`not a v1 message (version byte 0x${message[0]!.toString(16)})`);
  const header = {
    numRequiredSignatures: message[1]!,
    numReadonlySignedAccounts: message[2]!,
    numReadonlyUnsignedAccounts: message[3]!,
  };
  const mask = view.getUint32(4, true);
  if ((mask & ~KNOWN_CONFIG_MASK_BITS) !== 0) throw new Error(`unknown config mask bits set (0b${mask.toString(2)})`);
  const feeBits = mask & 0b11;
  if (feeBits !== 0 && feeBits !== 0b11) {
    throw new Error(`partial priority-fee bits in config mask (0b${mask.toString(2)}); both or neither`);
  }
  const numInstructions = message[40]!;
  const numAccounts = message[41]!;
  off = 42;

  const accountKeys: PublicKey[] = [];
  for (let i = 0; i < numAccounts; i++) {
    need(32, `account key ${i}`);
    accountKeys.push(new PublicKey(message.slice(off, off + 32)));
    off += 32;
  }

  const u32 = (what: string) => {
    need(4, what);
    const v = view.getUint32(off, true);
    off += 4;
    return v;
  };
  if (feeBits) {
    need(8, "the priority fee");
    off += 8;
  }
  const computeUnitLimit = mask & 0b100 ? u32("the compute-unit limit") : undefined;
  if (mask & 0b1000) u32("the loaded-accounts size");
  const heapBytes = mask & 0b10000 ? u32("the heap size") : undefined;

  const heads: { programIdIndex: number; numAccounts: number; dataLen: number }[] = [];
  for (let i = 0; i < numInstructions; i++) {
    need(4, `instruction ${i} header`);
    heads.push({ programIdIndex: message[off]!, numAccounts: message[off + 1]!, dataLen: view.getUint16(off + 2, true) });
    off += 4;
  }
  const instructions: V1Instruction[] = [];
  for (const [i, h] of heads.entries()) {
    need(h.numAccounts, `instruction ${i} accounts`);
    const accountIndices = Array.from(message.slice(off, off + h.numAccounts));
    off += h.numAccounts;
    need(h.dataLen, `instruction ${i} data`);
    const data = Uint8Array.from(message.subarray(off, off + h.dataLen));
    off += h.dataLen;
    instructions.push({ programIdIndex: h.programIdIndex, accountIndices, data });
  }
  if (off !== message.length) throw new Error(`v1 message has ${message.length - off} trailing bytes after the last instruction`);
  return {
    header,
    accountKeys,
    instructions,
    ...(computeUnitLimit === undefined ? {} : { computeUnitLimit }),
    ...(heapBytes === undefined ? {} : { heapBytes }),
  };
}

// ------------------------------------------------------------ proxy calls ---
export interface ComposeV1Result {
  recentBlockhash: string;
  /** Base64 v1 wire with a zero signature slot. */
  transaction: string;
}

/** Ask the proxy to emulate the call and compose the atomic v1 transaction. */
export async function composeAtomicV1(
  proxyUrl: string,
  unsignedRlp: Hex,
  payer: PublicKey,
  authSig: Uint8Array,
  fetchImpl: typeof fetch = fetch,
): Promise<ComposeV1Result> {
  const result = await jsonRpc<ComposeV1Result | null>(
    proxyUrl,
    "rome_composeUnsignedAtomicV1",
    [unsignedRlp, payer.toBase58(), base58.encode(authSig)],
    fetchImpl,
  );
  if (!result) throw new Error("rome_composeUnsignedAtomicV1: empty result");
  return result;
}

/** The composer's answer for a call that does not fit one atomic transaction. */
export const ATOMIC_REFUSAL_TEXT = "external atomic plan requires iterative composition";

/** True when `err` (an Error or a string) is the composer's refusal; no other failure qualifies. */
export function isAtomicRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return message.includes(ATOMIC_REFUSAL_TEXT);
}

// -------------------------------------------------------------- headline ---
export interface TransactionReceiptLike {
  status?: Hex;
  blockNumber?: Hex;
  transactionHash?: Hex;
  [key: string]: unknown;
}

export interface SolanaLaneV1Deps {
  /** Solana RPC connection: the signed transaction is sent and confirmed here, not on the proxy. */
  connection: Connection;
  proxyUrl: string;
  chainId: number;
  signer: SignerLike;
  fetchImpl?: typeof fetch;
  /** How long to wait for the EVM receipt. Default 90 000 ms. */
  receiptTimeoutMs?: number;
  /** How long to wait for the Solana transaction to confirm. Default 90 000 ms. */
  confirmTimeoutMs?: number;
}

export interface SolanaLaneV1Result {
  hash: Hex;
  from: Hex;
  route: "atomic" | "relay";
  /** The Solana signature; atomic route only. */
  signature?: string;
  /** `null` when the receipt did not appear in time. */
  receipt: TransactionReceiptLike | null;
}

type V1Call = EvmCall & { nonce?: bigint; fee?: FeeFields };

const toHex = (n: bigint): Hex => `0x${n.toString(16)}`;
const hexOf = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Size the nonce and fee, build the unsigned payload and its hash. */
async function prepare(deps: SolanaLaneV1Deps, call: V1Call) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const signer = toLaneSigner(deps.signer);
  const from = syntheticAddress(signer.payer);
  const nonce = call.nonce ?? BigInt(await jsonRpc<Hex>(deps.proxyUrl, "eth_getTransactionCount", [from, "pending"], fetchImpl));
  const fee =
    call.fee ??
    (await sizeSolanaLaneFee(
      deps.proxyUrl,
      { from, to: call.to, data: call.data, value: call.value !== undefined ? toHex(call.value) : undefined },
      { fetchImpl },
    ));
  const rlp = buildUnsignedEip1559Rlp({
    chainId: deps.chainId,
    nonce,
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    maxFeePerGas: fee.maxFeePerGas,
    gasLimit: fee.gasLimit,
    to: call.to,
    value: call.value,
    data: call.data,
  });
  return { fetchImpl, signer, from, rlp, hash: hexOf(authHashFor(rlp)) };
}

/**
 * Run an EVM call from a Solana wallet as one v1 transaction. Sizes the nonce and
 * fees, asks the wallet for the authorization signature (one prompt), has the
 * proxy compose the transaction, checks it, asks for the transaction signature,
 * sends it to the Solana RPC and waits for the EVM receipt.
 *
 * When the composer refuses the call, it is relayed through the proxy with the
 * same authorization signature (no second prompt); pass `relayOnRefusal: false`
 * to get the refusal as an error instead.
 */
export async function submitRomeTxV1(
  deps: SolanaLaneV1Deps,
  call: V1Call & { relayOnRefusal?: boolean },
): Promise<SolanaLaneV1Result> {
  const prepared = await prepare(deps, call);
  const { fetchImpl, signer, from, rlp, hash } = prepared;
  const authSig = await signer.signAuthHash(ed25519AuthMessage(authHashFor(rlp)));

  let composed: ComposeV1Result;
  try {
    composed = await composeAtomicV1(deps.proxyUrl, rlp, signer.payer, authSig, fetchImpl);
  } catch (err) {
    if (call.relayOnRefusal === false || !isAtomicRefusal(err)) throw err;
    // Relay the payload the signature was made over, not a freshly sized one.
    return relayPrepared(deps, prepared, authSig);
  }

  const signature = await signAndSend(deps, signer, decodeBase64(composed.transaction));
  const receipt = await waitForReceipt(deps.proxyUrl, hash, { timeoutMs: deps.receiptTimeoutMs ?? 90_000, fetchImpl });
  return { hash, from, route: "atomic", signature, receipt };
}

/**
 * Relay an EVM call through the proxy, which composes, submits and pays for the
 * Solana transaction itself; the sender pays gas in the chain's native token.
 * The wallet signs only the authorization message, unless `authSig` is passed;
 * a passed signature covers one payload, so pin `nonce` and `fee` with it.
 */
export async function relayV1(
  deps: SolanaLaneV1Deps,
  call: V1Call & { authSig?: Uint8Array },
): Promise<SolanaLaneV1Result> {
  const prepared = await prepare(deps, call);
  const authSig = call.authSig ?? (await prepared.signer.signAuthHash(ed25519AuthMessage(authHashFor(prepared.rlp))));
  return relayPrepared(deps, prepared, authSig);
}

/** Send an already built payload and its authorization signature to the proxy's relay. */
async function relayPrepared(
  deps: SolanaLaneV1Deps,
  { fetchImpl, signer, from, rlp }: Awaited<ReturnType<typeof prepare>>,
  authSig: Uint8Array,
): Promise<SolanaLaneV1Result> {
  const hash = await jsonRpc<Hex | null>(
    deps.proxyUrl,
    "rome_relayUnsignedV1",
    [rlp, signer.payer.toBase58(), base58.encode(authSig)],
    fetchImpl,
  );
  if (!hash) throw new Error("rome_relayUnsignedV1: empty result");
  const receipt = await waitForReceipt(deps.proxyUrl, hash, { timeoutMs: deps.receiptTimeoutMs ?? 90_000, fetchImpl });
  return { hash, from, route: "relay", receipt };
}

/**
 * Top up the sender's native gas balance from the wallet's own token account of
 * the chain's gas token (USDC on Hadrian and Rubicon). `amountWei` is
 * in the chain's wei and must be a multiple of 10^12 (the proxy refuses any
 * other amount). The wallet signs one plain v1 transaction.
 */
export async function fundSyntheticGas(deps: SolanaLaneV1Deps, amountWei: bigint): Promise<{ signature: string }> {
  if (amountWei <= 0n || amountWei % 10n ** 12n !== 0n) {
    throw new Error(`amountWei must be a positive multiple of 10^12 (got ${amountWei})`);
  }
  const signer = toLaneSigner(deps.signer);
  const composed = await jsonRpc<ComposeV1Result | null>(
    deps.proxyUrl,
    "rome_composeExternalDepositV1",
    [signer.payer.toBase58(), toHex(amountWei)],
    deps.fetchImpl ?? fetch,
  );
  if (!composed) throw new Error("rome_composeExternalDepositV1: empty result");
  return { signature: await signAndSend(deps, signer, decodeBase64(composed.transaction)) };
}

/**
 * Check a composed wire, sign it, broadcast it and wait for confirmation. The
 * wire is parsed BEFORE the wallet is asked to sign, so a malformed answer never
 * reaches a prompt. Preflight is skipped: web3.js 1.x cannot simulate a v1
 * transaction, and the chain validates it anyway.
 */
async function signAndSend(deps: SolanaLaneV1Deps, signer: LaneSigner, wire: Uint8Array): Promise<string> {
  const { connection } = deps;
  const { message } = splitV1Wire(wire);
  parseV1Message(message);
  const txSig = await signer.signV1Wire(wire);
  if (!(txSig instanceof Uint8Array) || txSig.length !== SIGNATURE_BYTES) {
    throw new Error(
      "signV1Wire must return the 64-byte signature; with solana:signTransaction return signedTransaction.slice(-64)",
    );
  }
  const signed = packSignedV1Wire(message, txSig);
  const signature = await connection.sendRawTransaction(signed, { skipPreflight: true });

  const confirmTimeoutMs = deps.confirmTimeoutMs ?? 90_000;
  const deadline = Date.now() + confirmTimeoutMs;
  for (;;) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.err) {
      const logs = await txLogs(connection, signature, deps.fetchImpl ?? fetch);
      throw new Error(`Solana transaction failed: ${JSON.stringify(status.err)}${logs ? `\n${logs}` : ""}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    if (Date.now() > deadline) throw new Error(`Solana transaction ${signature} not confirmed within ${confirmTimeoutMs} ms`);
    await sleep(Math.min(1000, Math.max(deadline - Date.now(), 1)));
  }
}

/**
 * The transaction's log lines, or `null` on any failure. Read with a plain
 * JSON-RPC call: web3.js 1.x's `getTransaction` rejects a v1 transaction.
 */
async function txLogs(connection: Connection, signature: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const tx = await jsonRpc<{ meta?: { logMessages?: string[] | null } | null } | null>(
      connection.rpcEndpoint,
      "getTransaction",
      [signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 1 }],
      fetchImpl,
    );
    return tx?.meta?.logMessages?.join("\n") ?? null;
  } catch {
    return null; // the signature is in the error anyway
  }
}

function decodeBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Poll `eth_getTransactionReceipt` until it returns a receipt; `null` after `timeoutMs` (default 90 000). */
export async function waitForReceipt(
  proxyUrl: string,
  hash: Hex,
  opts: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<TransactionReceiptLike | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const interval = opts.intervalMs ?? 1500;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  for (;;) {
    try {
      const receipt = await jsonRpc<TransactionReceiptLike | null>(proxyUrl, "eth_getTransactionReceipt", [hash], fetchImpl);
      if (receipt) return receipt;
    } catch {
      // a proxy that is briefly behind answers an error; keep polling until the deadline
    }
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await sleep(Math.min(interval, left));
  }
}
