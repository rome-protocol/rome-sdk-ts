import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { hexToBytes } from "viem";
import { deriveAuthorityPda, deriveAta, deriveUserAta, pubkeyToBytes32 } from "../src/index.js";

const PROGRAM_ID = new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf");
const EVM_ADDR = "0x1111111111111111111111111111111111111111";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Oracle: the EXACT canonical external_auth derivation (literal seed string +
// Buffer), written independently of src — which derives from the
// SDK's EXTERNAL_AUTHORITY_SEED constant + a Uint8Array.
// Matching results validates both the algorithm and the constant.
function oracleAuthPda(programId: PublicKey, addr: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("EXTERNAL_AUTHORITY"), Buffer.from(hexToBytes(addr as `0x${string}`))],
    programId,
  );
  return pda;
}

describe("deriveAuthorityPda", () => {
  it("matches the canonical external_auth derivation byte-for-byte", () => {
    expect(deriveAuthorityPda(EVM_ADDR, PROGRAM_ID).toBase58()).toBe(
      oracleAuthPda(PROGRAM_ID, EVM_ADDR).toBase58(),
    );
  });
  it("accepts a base58 program-id string", () => {
    expect(
      deriveAuthorityPda(EVM_ADDR, PROGRAM_ID.toBase58()).equals(deriveAuthorityPda(EVM_ADDR, PROGRAM_ID)),
    ).toBe(true);
  });
  it("is deterministic + off-curve (a real PDA)", () => {
    const a = deriveAuthorityPda(EVM_ADDR, PROGRAM_ID);
    expect(a.equals(deriveAuthorityPda(EVM_ADDR, PROGRAM_ID))).toBe(true);
    expect(PublicKey.isOnCurve(a.toBytes())).toBe(false);
  });
  it("tolerates a missing 0x + rejects a wrong-length address", () => {
    expect(
      deriveAuthorityPda(EVM_ADDR.slice(2), PROGRAM_ID).equals(deriveAuthorityPda(EVM_ADDR, PROGRAM_ID)),
    ).toBe(true);
    expect(() => deriveAuthorityPda("0x1234", PROGRAM_ID)).toThrow(/20 bytes/);
  });
});

describe("deriveAta / deriveUserAta", () => {
  it("deriveUserAta == ATA(authorityPda, mint)", () => {
    const pda = deriveAuthorityPda(EVM_ADDR, PROGRAM_ID);
    expect(deriveUserAta(EVM_ADDR, MINT, PROGRAM_ID).equals(deriveAta(pda, MINT))).toBe(true);
  });
  it("the ATA of a PDA owner is itself off-curve", () => {
    expect(PublicKey.isOnCurve(deriveUserAta(EVM_ADDR, MINT, PROGRAM_ID).toBytes())).toBe(false);
  });
});

describe("pubkeyToBytes32", () => {
  it("round-trips a pubkey to 32-byte hex", () => {
    const hex = pubkeyToBytes32(MINT);
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(new PublicKey(hexToBytes(hex)).equals(MINT)).toBe(true);
  });
  it("accepts a base58 string", () => {
    expect(pubkeyToBytes32(MINT.toBase58())).toBe(pubkeyToBytes32(MINT));
  });
});
