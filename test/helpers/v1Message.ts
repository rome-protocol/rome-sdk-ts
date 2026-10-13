// Test-side builder for a v1 Solana message: the exact inverse of `parseV1Message`.
import { PublicKey } from "@solana/web3.js";
import { hexToBytes, toHex, toRlp, type Hex } from "viem";
import { authHashFor, ed25519AuthMessage, parseV1Message, splitV1Wire } from "../../src/solanaV1.js";
import atomicFixture from "../fixtures/composed-v1.json" with { type: "json" };
import depositFixture from "../fixtures/composed-deposit-v1.json" with { type: "json" };

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

// ---------------------------------------------------------------------------
// Composed-transaction variants, built from the parts of the two live fixtures.
// ---------------------------------------------------------------------------

export const ED25519 = new PublicKey("Ed25519SigVerify111111111111111111111111111");
export const SYSTEM = new PublicKey("11111111111111111111111111111111");
export const ROME_PROGRAM = new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf");

export type Ix = { programIdIndex: number; accountIndices: number[]; data: Uint8Array };
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
const partsOf = (transaction: string) => {
  const { message } = splitV1Wire(b64(transaction));
  return { parsed: parseV1Message(message), message };
};
const atomicParts = partsOf(atomicFixture.transaction);
const depositParts = partsOf(depositFixture.transaction);
const loadedAccountsDataSize = 64_000;

/** The Ed25519 verifier instruction data: one signature, offsets header, then key, signature, message. */
export function ed25519Data(pubkey: Uint8Array, signature: Uint8Array, message: Uint8Array, indexes = [0xffff, 0xffff, 0xffff]): Buffer {
  const head = Buffer.alloc(16);
  head[0] = 1;
  const keyOff = 16;
  const sigOff = keyOff + 32;
  const msgOff = sigOff + 64;
  [sigOff, indexes[0]!, keyOff, indexes[1]!, msgOff, message.length, indexes[2]!].forEach((v, i) => head.writeUInt16LE(v, 2 + 2 * i));
  return Buffer.concat([head, pubkey, signature, message]);
}

export interface AtomicSpec {
  /** The key the transaction is built for; it sits at account index 0 unless `payerAt` says otherwise. */
  payer: PublicKey;
  rlp: Hex;
  authSig?: Uint8Array;
  /** What the Ed25519 instruction verifies; default the readable envelope for `rlp`. */
  edMessage?: Uint8Array;
  edPubkey?: Uint8Array;
  edIndexes?: number[];
  /** Replaces the Rome instruction data (default: 10 zero bytes, 0x02, then the rlp). */
  romeData?: Uint8Array;
  /** Ed25519 instructions to include (default 1). */
  edCount?: number;
  /** Instructions appended after the fixture's two. */
  extra?: Ix[];
  /** Account keys appended after the fixture's (so `extra` can name a new program). */
  extraKeys?: PublicKey[];
  /** Splice a priority fee (micro-lamports per compute unit) into the config. */
  priorityFee?: bigint;
  /** Overrides the compute-unit limit of the fixture. */
  computeUnitLimit?: number;
  /** Put another key at index 0 and the payer at index 1. */
  payerAt1?: boolean;
}

/** The rlp-dependent Rome instruction data of the atomic path. */
export const romeAtomicData = (rlp: Hex): Uint8Array => Buffer.concat([Buffer.alloc(10), Buffer.from([0x02]), hexToBytes(rlp)]);

/** An unsigned v1 wire (one empty signature slot) shaped like the live atomic fixture. */
export function atomicWire(spec: AtomicSpec): Buffer {
  const { parsed } = atomicParts;
  const keys = [...parsed.accountKeys];
  keys[0] = spec.payerAt1 ? PublicKey.unique() : spec.payer;
  if (spec.payerAt1) keys[1] = spec.payer;
  keys.push(...(spec.extraKeys ?? []));
  const edIx = parsed.instructions[0]!;
  const romeIx = parsed.instructions[1]!;
  const ed = ed25519Data(
    spec.edPubkey ?? spec.payer.toBytes(),
    spec.authSig ?? new Uint8Array(64),
    spec.edMessage ?? ed25519AuthMessage(authHashFor(spec.rlp)),
    spec.edIndexes,
  );
  const instructions: Ix[] = [
    ...Array.from({ length: spec.edCount ?? 1 }, () => ({ ...edIx, data: ed })),
    { ...romeIx, data: spec.romeData ?? romeAtomicData(spec.rlp) },
    ...(spec.extra ?? []),
  ];
  return wireOf(
    buildV1Message({
      numReadonlyUnsigned: parsed.header.numReadonlyUnsignedAccounts,
      accountKeys: keys,
      config: {
        ...(spec.priorityFee === undefined ? {} : { priorityFee: spec.priorityFee }),
        computeUnitLimit: spec.computeUnitLimit ?? parsed.computeUnitLimit ?? 1_000_000,
        loadedAccountsDataSize,
      },
      instructions,
    }),
  );
}

/** Index of a program in the atomic fixture's account list, for hand-made extra instructions. */
export const atomicKeyIndex = (k: PublicKey): number => atomicParts.parsed.accountKeys.findIndex((x) => x.equals(k));

/** The deposit instruction data: tag 1, chain id u64 LE, 0x7e, then the RLP deposit payload. */
export function depositData(opts: { chainId: number; from: Hex; to: Hex; mint: bigint; value: bigint; rlpItems?: Hex[] }): Buffer {
  const head = Buffer.alloc(10);
  head[0] = 1;
  head.writeBigUInt64LE(BigInt(opts.chainId), 1);
  head[9] = 0x7e;
  const num = (n: bigint): Hex => (n === 0n ? "0x" : toHex(n));
  const items = opts.rlpItems ?? [`0x${"00".repeat(32)}`, opts.from, opts.to, num(opts.mint), num(opts.value), "0x5208", "0x", "0x"];
  return Buffer.concat([head, hexToBytes(toRlp(items))]);
}

export interface DepositSpec {
  payer: PublicKey;
  priorityFee?: bigint;
  data: Uint8Array;
  extra?: Ix[];
}

/** An unsigned v1 wire shaped like the live deposit fixture. */
export function depositWire(spec: DepositSpec): Buffer {
  const { parsed } = depositParts;
  const keys = [...parsed.accountKeys];
  keys[0] = spec.payer;
  return wireOf(
    buildV1Message({
      numReadonlyUnsigned: parsed.header.numReadonlyUnsignedAccounts,
      accountKeys: keys,
      config: {
        ...(spec.priorityFee === undefined ? {} : { priorityFee: spec.priorityFee }),
        computeUnitLimit: parsed.computeUnitLimit ?? 1_000_000,
        loadedAccountsDataSize,
      },
      instructions: [{ ...parsed.instructions[0]!, data: spec.data }, ...(spec.extra ?? [])],
    }),
  );
}

/** A System Program transfer of `lamports` from key 0 to key 1, as an appended instruction. */
export function systemTransfer(lamports: bigint): Ix {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(lamports, 4);
  return { programIdIndex: atomicKeyIndex(SYSTEM), accountIndices: [0, 1], data };
}

