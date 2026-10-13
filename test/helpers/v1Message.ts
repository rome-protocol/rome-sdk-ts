// Test-side builder for a v1 Solana message: the exact inverse of `parseV1Message`.
import type { PublicKey } from "@solana/web3.js";

export interface V1Config {
  priorityFee?: bigint;
  computeUnitLimit?: number;
  loadedAccountsDataSize?: number;
  heapBytes?: number;
}

export interface V1MessageSpec {
  numRequiredSignatures?: number;
  numReadonlySigned?: number;
  numReadonlyUnsigned?: number;
  accountKeys: PublicKey[];
  config?: V1Config;
  /** Overrides the mask derived from `config` (for malformed-input cases). */
  rawMask?: number;
  instructions: { programIdIndex: number; accountIndices: number[]; data: Uint8Array }[];
}

const le = (n: number | bigint, bytes: number): Buffer => {
  const b = Buffer.alloc(bytes);
  if (bytes === 8) b.writeBigUInt64LE(BigInt(n));
  else if (bytes === 4) b.writeUInt32LE(Number(n));
  else b.writeUInt16LE(Number(n));
  return b;
};

export function buildV1Message(spec: V1MessageSpec): Buffer {
  const c = spec.config ?? {};
  let mask = 0;
  const values: Buffer[] = [];
  if (c.priorityFee !== undefined) { mask |= 0b11; values.push(le(c.priorityFee, 8)); }
  if (c.computeUnitLimit !== undefined) { mask |= 0b100; values.push(le(c.computeUnitLimit, 4)); }
  if (c.loadedAccountsDataSize !== undefined) { mask |= 0b1000; values.push(le(c.loadedAccountsDataSize, 4)); }
  if (c.heapBytes !== undefined) { mask |= 0b10000; values.push(le(c.heapBytes, 4)); }
  return Buffer.concat([
    Buffer.from([0x81, spec.numRequiredSignatures ?? 1, spec.numReadonlySigned ?? 0, spec.numReadonlyUnsigned ?? 0]),
    le(spec.rawMask ?? mask, 4),
    Buffer.alloc(32, 0xab), // blockhash
    Buffer.from([spec.instructions.length, spec.accountKeys.length]),
    ...spec.accountKeys.map((k) => k.toBuffer()),
    ...values,
    ...spec.instructions.map((ix) =>
      Buffer.concat([Buffer.from([ix.programIdIndex, ix.accountIndices.length]), le(ix.data.length, 2)]),
    ),
    ...spec.instructions.map((ix) => Buffer.concat([Buffer.from(ix.accountIndices), Buffer.from(ix.data)])),
  ]);
}

/** The wire the proxy answers with: the message plus one zero signature slot per required signature. */
export function wireOf(message: Buffer, numSignatures = 1): Buffer {
  return Buffer.concat([message, Buffer.alloc(64 * numSignatures)]);
}
