import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { base58 } from "@scure/base";

export const MAX_V1_ACCOUNTS = 64;
export const MAX_V1_INSTRUCTIONS = 255;
export const MAX_V1_DATA_BYTES = 65535;
export const MAX_V1_WIRE_BYTES = 4096;

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

export interface CompileV1Params {
  /** The one signer and fee payer. */
  payer: PublicKey;
  instructions: TransactionInstruction[];
  /** Base58 blockhash from `getLatestBlockhash`. */
  recentBlockhash: string;
  /** Compute-unit limit for the message config; leave out to use the cluster default. */
  computeUnitLimit?: number;
}

interface KeyEntry {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}

/**
 * Compile plain instructions into a v1 message (no signature): the inverse of
 * `parseV1Message`, whose doc comment has the byte layout. Keys are merged
 * across instructions with signer and writable flags OR-ed, and program ids
 * count as read-only unless an instruction also lists them writable. Order: the
 * payer, then writable signers, read-only signers, writable non-signers and
 * read-only non-signers, each in first-seen order (an instruction's accounts,
 * then its program id). Only the payer may sign. The compute-unit limit goes in
 * the message config, so ComputeBudget instructions are refused.
 */
export function compileV1Message(params: CompileV1Params): Uint8Array {
  const { payer, instructions, computeUnitLimit } = params;
  const blockhash = base58.decode(params.recentBlockhash);
  if (blockhash.length !== 32) throw new Error(`recentBlockhash must decode to 32 bytes, got ${blockhash.length}`);
  if (instructions.length > MAX_V1_INSTRUCTIONS) {
    throw new Error(`${instructions.length} instructions; a v1 message carries at most ${MAX_V1_INSTRUCTIONS}`);
  }
  if (computeUnitLimit !== undefined && !(Number.isInteger(computeUnitLimit) && computeUnitLimit >= 0 && computeUnitLimit <= 0xffffffff)) {
    throw new Error(`computeUnitLimit must be a u32, got ${computeUnitLimit}`);
  }

  const entries = new Map<string, KeyEntry>();
  const merge = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => {
    const id = pubkey.toBase58();
    const seen = entries.get(id);
    if (seen) {
      seen.isSigner ||= isSigner;
      seen.isWritable ||= isWritable;
    } else {
      entries.set(id, { pubkey, isSigner, isWritable });
    }
  };
  merge(payer, true, true);
  for (const ix of instructions) {
    if (ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM) {
      throw new Error("ComputeBudget instructions are not carried in a v1 message; pass computeUnitLimit instead");
    }
    if (ix.data.length > MAX_V1_DATA_BYTES) {
      throw new Error(`instruction data is ${ix.data.length} bytes; a v1 instruction carries at most ${MAX_V1_DATA_BYTES}`);
    }
    if (ix.keys.length > 255) throw new Error(`an instruction lists ${ix.keys.length} accounts; at most 255 fit`);
    for (const k of ix.keys) merge(k.pubkey, k.isSigner, k.isWritable);
    merge(ix.programId, false, false);
  }
  for (const e of entries.values()) {
    if (e.isSigner && !e.pubkey.equals(payer)) {
      throw new Error(`${e.pubkey.toBase58()} is marked as a signer; this lane has exactly one signer, the payer`);
    }
  }

  const all = [...entries.values()];
  if (all.length > MAX_V1_ACCOUNTS) throw new Error(`${all.length} account keys; a v1 message carries at most ${MAX_V1_ACCOUNTS}`);
  const writable = all.filter((e) => !e.isSigner && e.isWritable);
  const readOnly = all.filter((e) => !e.isSigner && !e.isWritable);
  const keys = [all[0]!, ...writable, ...readOnly].map((e) => e.pubkey);
  const index = new Map(keys.map((k, i) => [k.toBase58(), i]));

  const config = new Uint8Array(computeUnitLimit === undefined ? 0 : 4);
  if (computeUnitLimit !== undefined) new DataView(config.buffer).setUint32(0, computeUnitLimit, true);
  const headers = new Uint8Array(instructions.length * 4);
  const payloads: Uint8Array[] = [];
  instructions.forEach((ix, i) => {
    headers[i * 4] = index.get(ix.programId.toBase58())!;
    headers[i * 4 + 1] = ix.keys.length;
    new DataView(headers.buffer).setUint16(i * 4 + 2, ix.data.length, true);
    payloads.push(Uint8Array.from(ix.keys.map((k) => index.get(k.pubkey.toBase58())!)), ix.data);
  });

  const fixed = new Uint8Array(42);
  fixed.set([0x81, 1, 0, readOnly.length], 0);
  new DataView(fixed.buffer).setUint32(4, computeUnitLimit === undefined ? 0 : 0b100, true);
  fixed.set(blockhash, 8);
  fixed.set([instructions.length, keys.length], 40);

  const parts = [fixed, ...keys.map((k) => k.toBytes()), config, headers, ...payloads];
  const message = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    message.set(p, off);
    off += p.length;
  }
  const wireBytes = message.length + 64;
  if (wireBytes > MAX_V1_WIRE_BYTES) throw new Error(`the signed transaction would be ${wireBytes} bytes; the limit is ${MAX_V1_WIRE_BYTES}`);
  return message;
}
