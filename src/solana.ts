/**
 * @rome-protocol/sdk — the **Solana lane** (v1.1): the mirror of `submitRomeTx`.
 *
 * Let a **Solana wallet drive an EVM contract on Rome**, with no Ethereum key.
 * A Solana-native user's EVM identity is their SYNTHETIC ADDRESS
 * (`keccak256(pubkey)[12:]`), where their balance + nonce live. A `DoTxUnsigned`
 * Solana instruction carries an unsigned EIP-1559 RLP payload; the Solana signer
 * (the tx fee-payer) authorizes it, and the program derives `from` from that
 * signer — no ECDSA signature.
 *
 * `submitRomeTxSolanaLane(deps, call)` is the one-call path (mirrors
 * `submitRomeTx`): size nonce + fees → discover accounts → assemble → wallet
 * signs → submit to the Solana RPC → confirm.
 *
 * It handles two requirements that are NOT in the prose docs and that a
 * hand-built `DoTxUnsigned` will fault without:
 *  - **ComputeBudget** — Rome's EVM needs a raised CU limit (~1.35M) AND a large
 *    heap frame (250 KB); Solana's 200K-CU / 32-KB defaults fault.
 *  - **Treasure wallet** — execution pays a per-chain treasure PDA ~5000
 *    lamports; account discovery (`eth_estimateGas`) omits it, so it's appended.
 */
import {
  Connection,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { keccak256, serializeTransaction, hexToBytes, encodeFunctionData, type Hex } from "viem";
import { DO_TX_UNSIGNED_TAG, ACTIVATE_ATA_TAG } from "./constants.js";
import { deriveAuthorityPda, pubkeyToBytes32 } from "./pda.js";
import { padRomeGas, buildRome1559Fees, DEFAULT_ROME_GAS_FALLBACK } from "./write.js";

function pk(programId: PublicKey | string): PublicKey {
  return typeof programId === "string" ? new PublicKey(programId) : programId;
}
function u64le(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

// ---------------------------------------------------------------- identity ---
export type SolanaPubkeyInput = Uint8Array | PublicKey | string;

function pubkeyBytes(pubkey: SolanaPubkeyInput): Uint8Array {
  if (pubkey instanceof Uint8Array) return pubkey;
  if (typeof pubkey === "string") return new PublicKey(pubkey).toBytes();
  return pubkey.toBytes();
}

/**
 * Synthetic EVM address for a Solana pubkey — `keccak256(pubkey)[12:]`. The EVM
 * identity (balance + nonce) a Solana-native user controls on Rome.
 * Byte-identical to the on-chain `do_tx_unsigned::derive_sender`.
 */
export function syntheticAddress(pubkey: SolanaPubkeyInput): Hex {
  return `0x${keccak256(pubkeyBytes(pubkey)).slice(-40)}`;
}

// ------------------------------------------------- unsigned EIP-1559 (RLP) ---
export interface UnsignedEip1559 {
  chainId: number | bigint;
  nonce: number | bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  /** undefined = contract creation */
  to?: Hex;
  value?: bigint;
  data?: Hex;
}

/**
 * Bare RLP-encoded unsigned EIP-1559 payload the Rome program decodes inside a
 * `DoTxUnsigned` instruction: the 9-item list, with viem's leading `0x02` type
 * byte removed (the on-chain decoder wants the bare list, not the typed
 * envelope). No signature — the Solana signer authorizes.
 */
export function buildUnsignedEip1559Rlp(tx: UnsignedEip1559): Hex {
  const serialized = serializeTransaction({
    type: "eip1559",
    chainId: Number(tx.chainId),
    nonce: Number(tx.nonce),
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    maxFeePerGas: tx.maxFeePerGas,
    gas: tx.gasLimit,
    to: tx.to,
    value: tx.value ?? 0n,
    data: tx.data ?? "0x",
    accessList: [],
  });
  return `0x${serialized.slice(4)}`;
}

// ----------------------------------------------------- DoTxUnsigned instr. ---
/**
 * The `DoTxUnsigned` Solana instruction: `data = [tag(17), ...unsignedRlp]`,
 * `keys = accounts` (the list from {@link emulateCallAccounts}; order +
 * signer/writable flags are authoritative and passed through unchanged).
 */
export function buildDoTxUnsigned(params: {
  programId: PublicKey | string;
  unsignedRlp: Hex;
  accounts: AccountMeta[];
}): TransactionInstruction {
  const data = Buffer.concat([
    Buffer.from([DO_TX_UNSIGNED_TAG]),
    Buffer.from(hexToBytes(params.unsignedRlp)),
  ]);
  return new TransactionInstruction({ programId: pk(params.programId), keys: params.accounts, data });
}

// ----------------------------------------- account discovery (proxy RPC) ---
/** Shape the proxy returns per account (`rome_emulateCallAccounts`, snake_case). */
export interface RawAccountMetaB58 {
  pubkey: string;
  is_signer: boolean;
  is_writable: boolean;
}
export function toAccountMeta(raw: RawAccountMetaB58): AccountMeta {
  return { pubkey: new PublicKey(raw.pubkey), isSigner: raw.is_signer, isWritable: raw.is_writable };
}

export interface DiscoveryCall {
  from: Hex;
  to: Hex;
  data?: Hex;
  value?: Hex;
}

/**
 * Ask the Rome proxy which Solana accounts an EVM call from `from` would touch,
 * via `rome_emulateCallAccounts`. The returned metas feed {@link buildDoTxUnsigned}
 * directly. `payer` must be an existing on-chain account (the user's wallet),
 * else the proxy errors "Signer not found".
 */
export async function emulateCallAccounts(
  rpcUrl: string,
  call: DiscoveryCall,
  payer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountMeta[]> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "rome_emulateCallAccounts",
      params: [
        { from: call.from, to: call.to, data: call.data ?? "0x", ...(call.value ? { value: call.value } : {}) },
        payer,
      ],
    }),
  });
  const json = (await res.json()) as { result?: RawAccountMetaB58[]; error?: { code: number; message: string } };
  if (json.error) throw new Error(`rome_emulateCallAccounts: ${json.error.message} (code ${json.error.code})`);
  return (json.result ?? []).map(toAccountMeta);
}

// -------------------------------------------------------- required PDAs ---
/**
 * Per-chain treasure (gas/fee) PDA — seeds `[chainId u64-LE, "TREASURE_SEED",
 * index u64-LE]`. The `DoTxUnsigned` execution pays it ~5000 lamports, but
 * account discovery omits it, so it's appended to the account list. `index` is
 * reliably 0.
 */
export function treasureWallet(programId: PublicKey | string, chainId: number, index = 0): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [u64le(chainId), Buffer.from("TREASURE_SEED"), u64le(index)],
    pk(programId),
  );
  return pda;
}

/**
 * The address's EVM-state PDA (nonce / balance / code) — seeds `[chainId u64-LE,
 * "ACCOUN_SEED", addr20]` ("ACCOUN_SEED" is the on-chain spelling). If absent
 * from a `DoTxUnsigned` account list the program panics ("error to get nonce");
 * pass it via `extraAccounts` when discovery truncates it.
 */
export function balanceKeyPda(programId: PublicKey | string, chainId: number, address: Hex): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [u64le(chainId), Buffer.from("ACCOUN_SEED"), Buffer.from(hexToBytes(address))],
    pk(programId),
  );
  return pda;
}

// ---------------------------------------------- compute budget (mandatory) ---
/** Default CU limit: above Solana's 200K default (Rome's EVM exceeds it), below the 1.4M max. */
export const DEFAULT_DOTX_CU_LIMIT = 1_350_000;
/** Default heap frame: Rome's EVM heap ceiling; the 32-KB default faults. */
export const DEFAULT_DOTX_HEAP_BYTES = 250 * 1024;

/** The two ComputeBudget instructions every `DoTxUnsigned` needs (heap frame + CU limit). */
export function computeBudgetIxs(
  cuLimit = DEFAULT_DOTX_CU_LIMIT,
  heapBytes = DEFAULT_DOTX_HEAP_BYTES,
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.requestHeapFrame({ bytes: heapBytes }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
  ];
}

// -------------------------------------------------------------- nonce ---
/**
 * Client-side nonce sequencer for a synthetic address. Seed from the address's
 * on-chain count (`eth_getTransactionCount`), then `reserve()` a nonce per
 * `DoTxUnsigned` in a multi-step chain so later steps don't collide with
 * earlier-but-unconfirmed ones.
 */
export class SyntheticNonceTracker {
  private next: bigint;
  constructor(seed: bigint | number) {
    this.next = BigInt(seed);
  }
  peek(): bigint {
    return this.next;
  }
  reserve(): bigint {
    const n = this.next;
    this.next += 1n;
    return n;
  }
  reset(seed: bigint | number): void {
    this.next = BigInt(seed);
  }
}

// -------------------------------------------------- fee / gas sizing ---
export interface FeeFields {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
}

/** POST one JSON-RPC call and return its `result`; an error answer throws. */
export async function jsonRpc<T>(rpcUrl: string, method: string, params: unknown[], fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message} (code ${json.error.code})`);
  return json.result as T;
}

/**
 * Size `gasLimit` + EIP-1559 fees for a Solana-lane call via the Rome proxy's
 * EVM JSON-RPC — mirrors `submitRomeTx`: a padded `eth_estimateGas` (1.3×) with
 * a fallback ceiling on revert, plus real base + tip fee fields.
 */
export async function sizeSolanaLaneFee(
  rpcUrl: string,
  call: DiscoveryCall,
  opts: { fallbackGas?: bigint; fetchImpl?: typeof fetch } = {},
): Promise<FeeFields> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let gasLimit: bigint;
  try {
    const est = await jsonRpc<Hex>(
      rpcUrl,
      "eth_estimateGas",
      [{ from: call.from, to: call.to, data: call.data ?? "0x", ...(call.value ? { value: call.value } : {}) }],
      fetchImpl,
    );
    gasLimit = padRomeGas(BigInt(est));
  } catch {
    gasLimit = opts.fallbackGas ?? DEFAULT_ROME_GAS_FALLBACK;
  }
  let baseFeePerGas: bigint | undefined;
  let suggestedPriorityFee: bigint | undefined;
  let gasPrice: bigint | undefined;
  try {
    const blk = await jsonRpc<{ baseFeePerGas?: Hex }>(rpcUrl, "eth_getBlockByNumber", ["latest", false], fetchImpl);
    if (blk?.baseFeePerGas) baseFeePerGas = BigInt(blk.baseFeePerGas);
  } catch { /* older proxy */ }
  try {
    suggestedPriorityFee = BigInt(await jsonRpc<Hex>(rpcUrl, "eth_maxPriorityFeePerGas", [], fetchImpl));
  } catch { /* optional */ }
  try {
    gasPrice = BigInt(await jsonRpc<Hex>(rpcUrl, "eth_gasPrice", [], fetchImpl));
  } catch { /* optional */ }
  const fees = buildRome1559Fees({ baseFeePerGas, suggestedPriorityFee, gasPrice });
  return {
    gasLimit,
    maxFeePerGas: "maxFeePerGas" in fees ? fees.maxFeePerGas : (gasPrice ?? 0n),
    maxPriorityFeePerGas: "maxPriorityFeePerGas" in fees ? fees.maxPriorityFeePerGas : 0n,
  };
}

// -------------------------------------------------------------- assemble ---
export interface EvmCall {
  to: Hex;
  data?: Hex;
  value?: bigint;
}
export interface AssembleDeps {
  proxyUrl: string;
  programId: PublicKey | string;
  chainId: number;
  fetchImpl?: typeof fetch;
}

/**
 * Build the (unsigned) Solana `Transaction` for an EVM call from a Solana-native
 * user: discover accounts → append the treasure wallet (+ any `extraAccounts`
 * discovery can't surface) → RLP + `DoTxUnsigned` + the two ComputeBudget
 * instructions. Caller supplies `recentBlockhash` (keeps this off the network
 * beyond discovery).
 */
export async function assembleDoTxUnsignedTx(
  params: {
    call: EvmCall;
    payer: PublicKey;
    nonce: bigint;
    fee: FeeFields;
    recentBlockhash: string;
    extraAccounts?: AccountMeta[];
  },
  deps: AssembleDeps,
): Promise<Transaction> {
  const programId = pk(deps.programId);
  const from = syntheticAddress(params.payer);
  const accounts = await emulateCallAccounts(
    deps.proxyUrl,
    {
      from,
      to: params.call.to,
      data: params.call.data,
      // Pass value so discovery emulates the real (payable) call — else a
      // value-dependent SSTORE (e.g. a fresh mapping slot) isn't allocated in
      // emulation and its account is omitted → "modified read-only account".
      value: params.call.value !== undefined ? (`0x${params.call.value.toString(16)}` as Hex) : undefined,
    },
    params.payer.toBase58(),
    deps.fetchImpl,
  );
  const treasure = treasureWallet(programId, deps.chainId, 0);
  if (!accounts.some((a) => a.pubkey.equals(treasure))) {
    accounts.push({ pubkey: treasure, isSigner: false, isWritable: true });
  }
  for (const extra of params.extraAccounts ?? []) {
    if (!accounts.some((a) => a.pubkey.equals(extra.pubkey))) accounts.push(extra);
  }
  const unsignedRlp = buildUnsignedEip1559Rlp({
    chainId: deps.chainId,
    nonce: params.nonce,
    maxPriorityFeePerGas: params.fee.maxPriorityFeePerGas,
    maxFeePerGas: params.fee.maxFeePerGas,
    gasLimit: params.fee.gasLimit,
    to: params.call.to,
    value: params.call.value,
    data: params.call.data,
  });
  const ix = buildDoTxUnsigned({ programId, unsignedRlp, accounts });
  const tx = new Transaction();
  tx.feePayer = params.payer;
  tx.recentBlockhash = params.recentBlockhash;
  for (const cb of computeBudgetIxs()) tx.add(cb);
  tx.add(ix);
  return tx;
}

// -------------------------------------- headline: submit (mirror of write) ---
export interface SolanaLaneDeps {
  /** Solana RPC connection (submit + confirm go here, NOT the proxy). */
  connection: Connection;
  /** Rome proxy URL — the EVM JSON-RPC + `rome_emulateCallAccounts`. */
  proxyUrl: string;
  programId: PublicKey | string;
  chainId: number;
  /** The Solana wallet pubkey — fee-payer and authorizing signer. */
  payer: PublicKey;
  /** The wallet's `signTransaction` (e.g. Phantom's adapter). */
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  fetchImpl?: typeof fetch;
}

/**
 * The Solana-lane mirror of `submitRomeTx`: a Solana wallet drives an EVM
 * contract on Rome. Auto-sizes the nonce (`eth_getTransactionCount` on the
 * synthetic address) and gas/fees, discovers accounts, assembles the
 * `DoTxUnsigned` tx (with the mandatory ComputeBudget + treasure wallet), has
 * the wallet sign, submits to the Solana RPC, and polls confirmation over HTTP.
 * Pass `nonce` / `fee` / `extraAccounts` to override auto-sizing.
 */
export async function submitRomeTxSolanaLane(
  deps: SolanaLaneDeps,
  call: EvmCall & { nonce?: bigint; fee?: FeeFields; extraAccounts?: AccountMeta[]; autoProvision?: boolean },
): Promise<{ signature: string; from: Hex }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const from = syntheticAddress(deps.payer);
  // First use of a brand-new synthetic: create its external-auth PDA. It doesn't
  // exist until `create_pda` runs, and value-moving calls (the sweep's
  // `transfer_spl`, ERC20SPL `transferFrom`) are signed by that PDA — so they
  // revert until it's provisioned. Opt out with `autoProvision: false` to run
  // your own one-time Activate step (see `provisionSynthetic`).
  const createCall = buildCreatePdaCall(from);
  const isCreatePdaCall = call.to === createCall.to && call.data === createCall.data;
  if (call.autoProvision !== false && !isCreatePdaCall && !(await isSyntheticProvisioned(deps.connection, deps.programId, from))) {
    await submitRomeTxSolanaLane(deps, { ...createCall, autoProvision: false });
  }
  const nonce =
    call.nonce ?? BigInt(await jsonRpc<Hex>(deps.proxyUrl, "eth_getTransactionCount", [from, "pending"], fetchImpl));
  const fee =
    call.fee ??
    (await sizeSolanaLaneFee(
      deps.proxyUrl,
      { from, to: call.to, data: call.data, value: call.value !== undefined ? (`0x${call.value.toString(16)}` as Hex) : undefined },
      { fetchImpl },
    ));
  const { blockhash, lastValidBlockHeight } = await deps.connection.getLatestBlockhash();
  const tx = await assembleDoTxUnsignedTx(
    { call, payer: deps.payer, nonce, fee, recentBlockhash: blockhash, extraAccounts: call.extraAccounts },
    { proxyUrl: deps.proxyUrl, programId: deps.programId, chainId: deps.chainId, fetchImpl },
  );
  const signed = await deps.signTransaction(tx);
  const signature = await deps.connection.sendRawTransaction(signed.serialize());
  const err = await pollConfirmation(deps.connection, signature, lastValidBlockHeight);
  if (err) throw new Error(`Solana-lane tx reverted: ${JSON.stringify(err)}`);
  return { signature, from };
}

async function pollConfirmation(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
): Promise<unknown | null> {
  for (;;) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const s = value[0];
    if (s) {
      if (s.err) return s.err;
      if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return null;
    }
    if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      throw new Error("Solana-lane tx not confirmed before blockhash expired");
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ============================================================================
// Funding-in — the transient-synthetic model
// ----------------------------------------------------------------------------
// The synthetic holds nothing at rest; a Solana-native user's spendable balance
// lives in their WALLET's SPL ATA. To gas + value a lane write, the wallet first
// moves the gas token into the synthetic (the FUND LEG — wallet-signed
// ActivateAta); the DoTxUnsigned then spends it and nets the synthetic to ~0.
// ============================================================================

/** Chain OwnerInfo/config PDA — single seed `[OWNER_INFO]`. Required by ActivateAta. */
export function ownerInfoPda(programId: PublicKey | string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("OWNER_INFO")], pk(programId));
  return pda;
}

/**
 * ActivateAta instruction data: `[tag(18), chainId u64-LE, mint(32), tokens u64-LE]`.
 * `tokens` is in the MINT's decimals. NOT a DoTxUnsigned (no VM / ComputeBudget).
 */
export function buildActivateAtaData(params: { chainId: number | bigint; mint: PublicKey; tokens: bigint }): Buffer {
  const data = Buffer.alloc(1 + 8 + 32 + 8);
  data.writeUInt8(ACTIVATE_ATA_TAG, 0);
  data.writeBigUInt64LE(BigInt(params.chainId), 1);
  Buffer.from(params.mint.toBytes()).copy(data, 9);
  data.writeBigUInt64LE(params.tokens, 41);
  return data;
}

/** Full ActivateAta instruction. Accounts: signer(s+w), owner_info(r), mint(r), fromAta(w), toAta(w), tokenProgram(r). */
export function buildActivateAtaInstruction(params: {
  programId: PublicKey | string;
  chainId: number | bigint;
  mint: PublicKey;
  tokens: bigint;
  signer: PublicKey;
  fromAta: PublicKey;
  toAta: PublicKey;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const programId = pk(params.programId);
  const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: params.signer, isSigner: true, isWritable: true },
      { pubkey: ownerInfoPda(programId), isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: params.fromAta, isSigner: false, isWritable: true },
      { pubkey: params.toAta, isSigner: false, isWritable: true },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: buildActivateAtaData({ chainId: params.chainId, mint: params.mint, tokens: params.tokens }),
  });
}

/**
 * FUND LEG (wallet → synthetic): ensure the synthetic's ATA exists, then move
 * `amount` (in the mint's decimals) of the gas token from the wallet's ATA into
 * it (ActivateAta, wallet-signed). Returns native instructions for one
 * wallet-signed tx; the subsequent {@link submitRomeTxSolanaLane} spends it.
 */
export function buildFundLeg(params: {
  programId: PublicKey | string;
  chainId: number | bigint;
  mint: PublicKey;
  amount: bigint;
  wallet: PublicKey;
  synthetic: Hex;
  tokenProgram?: PublicKey;
}): TransactionInstruction[] {
  const programId = pk(params.programId);
  const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID;
  const synthPda = deriveAuthorityPda(params.synthetic, programId);
  const walletAta = getAssociatedTokenAddressSync(params.mint, params.wallet, true, tokenProgram);
  const synthAta = getAssociatedTokenAddressSync(params.mint, synthPda, true, tokenProgram);
  const ensureSynthAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    params.wallet, synthAta, synthPda, params.mint, tokenProgram,
  );
  const activateIx = buildActivateAtaInstruction({
    programId, chainId: params.chainId, mint: params.mint, tokens: params.amount,
    signer: params.wallet, fromAta: walletAta, toAta: synthAta, tokenProgram,
  });
  return [ensureSynthAtaIx, activateIx];
}

/** Submit native (non-DoTxUnsigned) instructions in one wallet-signed Solana tx (e.g. the fund leg). */
export async function submitSolanaInstructions(
  instructions: TransactionInstruction[],
  deps: { connection: Connection; feePayer: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
): Promise<{ signature: string }> {
  const { blockhash, lastValidBlockHeight } = await deps.connection.getLatestBlockhash();
  const tx = new Transaction();
  tx.feePayer = deps.feePayer;
  tx.recentBlockhash = blockhash;
  for (const ix of instructions) tx.add(ix);
  const signed = await deps.signTransaction(tx);
  const signature = await deps.connection.sendRawTransaction(signed.serialize());
  const err = await pollConfirmation(deps.connection, signature, lastValidBlockHeight);
  if (err) throw new Error(`fund-leg tx reverted: ${JSON.stringify(err)}`);
  return { signature };
}

// ---- Sweep leg (synthetic → wallet): value-OUT, the mirror of the fund leg ----

/** HelperProgram precompile (`0xFF…09`) — home of `transfer_spl` (PDA-signed SPL move). */
export const HELPER_PROGRAM = "0xff00000000000000000000000000000000000009" as Hex;
const HELPER_TRANSFER_SPL_ABI = [
  {
    type: "function",
    name: "transfer_spl",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to_ata", type: "bytes32" },
      { name: "tokens", type: "uint64" },
      { name: "mint", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

export interface SweepLeg {
  /** Idempotent create of the wallet's dest ATA (native ix; `transfer_spl` reverts without it). */
  ensureWalletAtaIx: TransactionInstruction;
  /** The `DoTxUnsigned` target — the HelperProgram precompile. */
  helperTo: Hex;
  /** `transfer_spl(walletAta, amount, mint)` calldata for the `DoTxUnsigned` call. */
  calldata: Hex;
  /** Source (synth ATA) + dest (wallet ATA) — append to the discovered accounts (both writable). */
  extraAccounts: AccountMeta[];
}

/**
 * SWEEP LEG (synthetic → wallet): after value lands in the synthetic (e.g. a
 * withdraw / borrow / claim), push `amount` of `mint` back to the user's own
 * wallet ATA via `HelperProgram.transfer_spl`, so the synthetic holds nothing at
 * rest. Wire it as: submit `ensureWalletAtaIx` (native, via
 * {@link submitSolanaInstructions}), then
 * `submitRomeTxSolanaLane({ to: helperTo, data: calldata, extraAccounts })`.
 */
export function buildSweepLeg(params: {
  programId: PublicKey | string;
  mint: PublicKey;
  amount: bigint;
  wallet: PublicKey;
  synthetic: Hex;
  tokenProgram?: PublicKey;
}): SweepLeg {
  const programId = pk(params.programId);
  const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ID;
  const synthPda = deriveAuthorityPda(params.synthetic, programId);
  const walletAta = getAssociatedTokenAddressSync(params.mint, params.wallet, true, tokenProgram);
  const synthAta = getAssociatedTokenAddressSync(params.mint, synthPda, true, tokenProgram);
  const ensureWalletAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    params.wallet, walletAta, params.wallet, params.mint, tokenProgram,
  );
  const calldata = encodeFunctionData({
    abi: HELPER_TRANSFER_SPL_ABI,
    functionName: "transfer_spl",
    args: [pubkeyToBytes32(walletAta), params.amount, pubkeyToBytes32(params.mint)],
  });
  const extraAccounts: AccountMeta[] = [
    { pubkey: walletAta, isSigner: false, isWritable: true }, // dest (wallet)
    { pubkey: synthAta, isSigner: false, isWritable: true }, // source (synthetic)
  ];
  return { ensureWalletAtaIx, helperTo: HELPER_PROGRAM, calldata, extraAccounts };
}

// ------------------------------------------- fresh-synthetic provisioning ---
// A Solana-native user's synthetic external-auth PDA is NOT lazy: it must be
// created once (`create_pda`) before any value-moving call, because the sweep's
// `transfer_spl` and ERC20SPL `transferFrom` are signed by that PDA.
// `submitRomeTxSolanaLane` auto-provisions on first use; these are the explicit
// primitives (e.g. for an app "Activate" step).

const HELPER_CREATE_PDA_ABI = [
  { type: "function", name: "create_pda", stateMutability: "nonpayable", inputs: [{ name: "user", type: "address" }], outputs: [] },
] as const;

/**
 * The one-time provisioning call — `create_pda(synthetic)` on the HelperProgram
 * (`0xFF…09`). Submit once (via {@link submitRomeTxSolanaLane}) before the
 * synthetic's first value-moving write; gate on {@link isSyntheticProvisioned}.
 */
export function buildCreatePdaCall(synthetic: Hex): EvmCall {
  return {
    to: HELPER_PROGRAM,
    data: encodeFunctionData({ abi: HELPER_CREATE_PDA_ABI, functionName: "create_pda", args: [synthetic] }),
  };
}

/**
 * Whether the synthetic's external-auth PDA already exists on-chain (i.e. it's
 * been provisioned). One Solana-RPC account read.
 */
export async function isSyntheticProvisioned(
  connection: Connection,
  programId: PublicKey | string,
  synthetic: Hex,
): Promise<boolean> {
  return (await connection.getAccountInfo(deriveAuthorityPda(synthetic, pk(programId)))) !== null;
}

/**
 * Provision a fresh synthetic if needed: create its external-auth PDA via
 * `create_pda`. Returns the signature if it created one, else
 * `{ alreadyProvisioned: true }`. The explicit form of what
 * {@link submitRomeTxSolanaLane}'s default `autoProvision` does — call it once
 * for an app "Activate" step, then submit writes with `autoProvision: false`.
 */
export async function provisionSynthetic(
  deps: SolanaLaneDeps,
): Promise<{ signature?: string; alreadyProvisioned: boolean }> {
  const synthetic = syntheticAddress(deps.payer);
  if (await isSyntheticProvisioned(deps.connection, deps.programId, synthetic)) {
    return { alreadyProvisioned: true };
  }
  const { signature } = await submitRomeTxSolanaLane(deps, { ...buildCreatePdaCall(synthetic), autoProvision: false });
  return { signature, alreadyProvisioned: false };
}
