import { describe, it, expect } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { base58 } from "@scure/base";
import { compileV1Message } from "../src/v1Message.js";
import { parseV1Message, type ParsedV1Message } from "../src/solanaV1.js";
import { buildActivateAtaInstruction } from "../src/solana.js";

const key = (n: number) => Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => n)).publicKey;
const payer = key(1);
const MINT = key(2);
const PROGRAM = key(3);
const BLOCKHASH = base58.encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));

type Meta = { pubkey: string; isSigner: boolean; isWritable: boolean };
type Decoded = { programId: string; keys: Meta[]; data: string };

/** Read instruction `i` of a parsed message back as program id, account metas and data. */
function metasForInstruction(parsed: ParsedV1Message, i: number): Decoded {
  const { numRequiredSignatures: signers, numReadonlySignedAccounts: roSigned, numReadonlyUnsignedAccounts: roUnsigned } = parsed.header;
  const total = parsed.accountKeys.length;
  const ix = parsed.instructions[i]!;
  return {
    programId: parsed.accountKeys[ix.programIdIndex]!.toBase58(),
    keys: ix.accountIndices.map((idx) => ({
      pubkey: parsed.accountKeys[idx]!.toBase58(),
      isSigner: idx < signers,
      isWritable: idx < signers ? idx < signers - roSigned : idx < total - roUnsigned,
    })),
    data: Buffer.from(ix.data).toString("hex"),
  };
}
const decode = (ix: TransactionInstruction): Decoded => ({
  programId: ix.programId.toBase58(),
  keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(ix.data).toString("hex"),
});
const ix = (programId: PublicKey, keys: { pubkey: PublicKey; isSigner?: boolean; isWritable?: boolean }[], data = Buffer.alloc(0)) =>
  new TransactionInstruction({
    programId,
    keys: keys.map((k) => ({ pubkey: k.pubkey, isSigner: k.isSigner ?? false, isWritable: k.isWritable ?? false })),
    data,
  });
const compile = (instructions: TransactionInstruction[], extra: { computeUnitLimit?: number } = {}) =>
  compileV1Message({ payer, instructions, recentBlockhash: BLOCKHASH, ...extra });

describe("compileV1Message", () => {
  it("round-trips a transfer, an idempotent ATA create and an ActivateAta through parseV1Message", () => {
    const dest = key(4);
    const walletAta = getAssociatedTokenAddressSync(MINT, payer, true);
    const destAta = getAssociatedTokenAddressSync(MINT, dest, true);
    const ixs = [
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: dest, lamports: 1234n }),
      createAssociatedTokenAccountIdempotentInstruction(payer, destAta, dest, MINT),
      buildActivateAtaInstruction({ programId: PROGRAM, chainId: 200010, mint: MINT, tokens: 5_000_000n, signer: payer, fromAta: walletAta, toAta: destAta }),
    ];
    const parsed = parseV1Message(compile(ixs));

    expect(parsed.accountKeys[0]!.equals(payer)).toBe(true);
    expect(parsed.instructions).toHaveLength(3);
    // A v1 message flags each key once, so an instruction reads back with the flags OR-ed across all of them.
    const merged = new Map<string, { isSigner: boolean; isWritable: boolean }>();
    for (const m of ixs.flatMap((x) => decode(x).keys)) {
      const seen = merged.get(m.pubkey);
      merged.set(m.pubkey, { isSigner: !!seen?.isSigner || m.isSigner, isWritable: !!seen?.isWritable || m.isWritable });
    }
    ixs.forEach((original, i) => {
      const want = decode(original);
      expect(metasForInstruction(parsed, i)).toEqual({ ...want, keys: want.keys.map((k) => ({ ...k, ...merged.get(k.pubkey)! })) });
    });
    expect(merged.get(dest.toBase58())).toMatchObject({ isWritable: true }); // writable in the transfer, read-only in the ATA create
    expect(parsed.header.numRequiredSignatures).toBe(1);
    expect(parsed.header.numReadonlySignedAccounts).toBe(0);
    // writable: payer, dest, destAta, walletAta; read-only: system, mint, token, ATA program, owner-info PDA, the Rome program
    expect(parsed.accountKeys).toHaveLength(10);
    expect(parsed.header.numReadonlyUnsignedAccounts).toBe(6);
    expect(parsed.computeUnitLimit).toBeUndefined();
    expect(parsed.priorityFeeMicroLamports).toBeUndefined();
  });

  it("writes the blockhash into the message", () => {
    const message = compile([SystemProgram.transfer({ fromPubkey: payer, toPubkey: key(4), lamports: 1n })]);
    expect(base58.encode(message.slice(8, 40))).toBe(BLOCKHASH);
    expect(message[0]).toBe(0x81);
  });

  it("orders keys by class, first seen first, and counts the header", () => {
    const a = key(10), b = key(11), c = key(12), d = key(13), e = key(14);
    const message = compile([
      ix(PROGRAM, [{ pubkey: a }, { pubkey: b, isWritable: true }, { pubkey: payer, isSigner: true, isWritable: true }]),
      ix(PROGRAM, [{ pubkey: c, isWritable: true }, { pubkey: d }, { pubkey: e }]),
    ]);
    const parsed = parseV1Message(message);
    // payer, writable non-signers (b, c), read-only non-signers (a, PROGRAM, d, e)
    expect(parsed.accountKeys.map((k) => k.toBase58())).toEqual([payer, b, c, a, PROGRAM, d, e].map((k) => k.toBase58()));
    expect(parsed.header).toEqual({ numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 4 });
  });

  it("makes a key writable when any instruction needs it writable", () => {
    const shared = key(20);
    const parsed = parseV1Message(compile([
      ix(PROGRAM, [{ pubkey: shared }]),
      ix(PROGRAM, [{ pubkey: shared, isWritable: true }]),
    ]));
    expect(metasForInstruction(parsed, 0).keys[0]).toMatchObject({ pubkey: shared.toBase58(), isWritable: true });
    expect(metasForInstruction(parsed, 1).keys[0]).toMatchObject({ pubkey: shared.toBase58(), isWritable: true });
    expect(parsed.accountKeys).toHaveLength(3);
  });

  it("keeps a program id read-only, and honours a writable listing of it", () => {
    const other = key(21);
    const plain = parseV1Message(compile([ix(PROGRAM, [{ pubkey: other, isWritable: true }])]));
    expect(plain.header.numReadonlyUnsignedAccounts).toBe(1);
    expect(plain.accountKeys.at(-1)!.equals(PROGRAM)).toBe(true);

    const alsoAccount = parseV1Message(compile([
      ix(PROGRAM, [{ pubkey: other }]),
      ix(other, [{ pubkey: PROGRAM, isWritable: true }]),
    ]));
    // PROGRAM is a program id in the first instruction and a writable account in the second; `other` is the reverse and stays read-only.
    expect(alsoAccount.accountKeys.map((k) => k.toBase58())).toEqual([payer, PROGRAM, other].map((k) => k.toBase58()));
    expect(alsoAccount.header.numReadonlyUnsignedAccounts).toBe(1);
  });

  it("sets config bit 2 and the value only when a compute-unit limit is given", () => {
    const base = [SystemProgram.transfer({ fromPubkey: payer, toPubkey: key(4), lamports: 1n })];
    const without = compile(base);
    expect(new DataView(without.buffer, without.byteOffset).getUint32(4, true)).toBe(0);

    const withLimit = compile(base, { computeUnitLimit: 300_000 });
    expect(new DataView(withLimit.buffer, withLimit.byteOffset).getUint32(4, true)).toBe(0b100);
    expect(withLimit.length).toBe(without.length + 4);
    expect(parseV1Message(withLimit).computeUnitLimit).toBe(300_000);
  });

  describe("refusals", () => {
    const transfer = SystemProgram.transfer({ fromPubkey: payer, toPubkey: key(4), lamports: 1n });

    it("a second signer", () => {
      const other = key(30);
      expect(() => compile([transfer, ix(PROGRAM, [{ pubkey: other, isSigner: true }])])).toThrow(/one signer.*payer/i);
    });

    it("a ComputeBudget instruction, pointing at computeUnitLimit", () => {
      expect(() => compile([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), transfer])).toThrow(/computeUnitLimit/);
    });

    it("more than 64 account keys", () => {
      const keys = Array.from({ length: 64 }, (_, i) => ({ pubkey: new PublicKey(Uint8Array.from({ length: 32 }, () => (i + 40) % 256)) }));
      // payer + 64 accounts + the program id = 66
      expect(() => compile([ix(PROGRAM, keys)])).toThrow(/66.*64/);
      expect(() => compile([ix(PROGRAM, keys.slice(0, 62))])).not.toThrow(); // payer + 62 + program = 64
    });

    it("more than 255 instructions", () => {
      expect(() => compile(Array.from({ length: 256 }, () => transfer))).toThrow(/256.*255/);
    });

    it("data longer than 65535 bytes", () => {
      expect(() => compile([ix(PROGRAM, [], Buffer.alloc(65_536))])).toThrow(/65536.*65535/);
    });

    it("a wire over 4096 bytes", () => {
      const big = [ix(PROGRAM, [], Buffer.alloc(4_000)), ix(PROGRAM, [], Buffer.alloc(200))];
      expect(() => compile(big)).toThrow(/4[0-9]{3}.*4096/);
      expect(() => compile([ix(PROGRAM, [], Buffer.alloc(3_900))])).not.toThrow();
    });
  });
});
