import { describe, it, expect, vi, afterEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { keccak256, parseTransaction, hexToBytes, type Hex } from "viem";
import {
  syntheticAddress,
  buildUnsignedEip1559Rlp,
  buildDoTxUnsigned,
  emulateCallAccounts,
  treasureWallet,
  balanceKeyPda,
  computeBudgetIxs,
  SyntheticNonceTracker,
  DEFAULT_DOTX_CU_LIMIT,
  buildActivateAtaData,
  ownerInfoPda,
  buildFundLeg,
  buildSweepLeg,
} from "../src/solana.js";

// A deterministic 32-byte Solana pubkey for tests (not the zero key).
const PUBKEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PUBKEY = new PublicKey(PUBKEY_BYTES);
const PROGRAM = new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf"); // any valid program id
const CHAIN_ID = 200010;

afterEach(() => vi.unstubAllGlobals());

describe("syntheticAddress", () => {
  it("is keccak256(pubkey)[12:] — matches the documented derivation", () => {
    const expected = (`0x${keccak256(PUBKEY_BYTES).slice(-40)}`).toLowerCase();
    expect(syntheticAddress(PUBKEY_BYTES)).toBe(expected);
  });
  it("is 0x + 40 hex and deterministic", () => {
    const a = syntheticAddress(PUBKEY);
    expect(a).toMatch(/^0x[0-9a-f]{40}$/);
    expect(syntheticAddress(PUBKEY)).toBe(a);
  });
  it("accepts Uint8Array | PublicKey | base58 string identically", () => {
    const a = syntheticAddress(PUBKEY_BYTES);
    expect(syntheticAddress(PUBKEY)).toBe(a);
    expect(syntheticAddress(PUBKEY.toBase58())).toBe(a);
  });
  it("different keys → different addresses", () => {
    const other = new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => i + 2));
    expect(syntheticAddress(other)).not.toBe(syntheticAddress(PUBKEY));
  });
});

describe("buildUnsignedEip1559Rlp", () => {
  it("round-trips through viem parseTransaction (bare list + 0x02 type byte)", () => {
    const to = "0x1111111111111111111111111111111111111111" as Hex;
    const rlp = buildUnsignedEip1559Rlp({
      chainId: CHAIN_ID,
      nonce: 7n,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 1000n,
      gasLimit: 250000n,
      to,
      value: 123n,
      data: "0xdeadbeef",
    });
    expect(rlp.startsWith("0x")).toBe(true);
    // module strips viem's 0x02 type byte; re-add it to parse the typed envelope
    const parsed = parseTransaction(`0x02${rlp.slice(2)}` as Hex);
    expect(parsed.type).toBe("eip1559");
    expect(parsed.chainId).toBe(CHAIN_ID);
    expect(parsed.nonce).toBe(7);
    expect(parsed.to?.toLowerCase()).toBe(to);
    expect(parsed.value).toBe(123n);
    expect(parsed.gas).toBe(250000n);
    expect(parsed.maxFeePerGas).toBe(1000n);
    expect(parsed.maxPriorityFeePerGas).toBe(1n);
    expect(parsed.data).toBe("0xdeadbeef");
  });
  it("has no signature fields (unsigned)", () => {
    const rlp = buildUnsignedEip1559Rlp({
      chainId: CHAIN_ID, nonce: 0n, maxPriorityFeePerGas: 0n, maxFeePerGas: 1n, gasLimit: 21000n,
      to: "0x2222222222222222222222222222222222222222" as Hex,
    });
    const parsed = parseTransaction(`0x02${rlp.slice(2)}` as Hex);
    expect(parsed.r).toBeUndefined();
    expect(parsed.s).toBeUndefined();
  });
});

describe("buildDoTxUnsigned", () => {
  it("data = [tag 17, ...rlp] and keys pass through unchanged", () => {
    const accounts = [
      { pubkey: PUBKEY, isSigner: true, isWritable: true },
      { pubkey: PROGRAM, isSigner: false, isWritable: false },
    ];
    const rlp = "0xdeadbeef" as Hex;
    const ix = buildDoTxUnsigned({ programId: PROGRAM, unsignedRlp: rlp, accounts });
    expect(ix.programId.equals(PROGRAM)).toBe(true);
    expect(ix.data[0]).toBe(17);
    expect(Buffer.from(ix.data.subarray(1))).toEqual(Buffer.from(hexToBytes(rlp)));
    expect(ix.keys).toEqual(accounts);
  });
});

describe("required PDAs", () => {
  it("treasureWallet is deterministic and chain-scoped", () => {
    const a = treasureWallet(PROGRAM, CHAIN_ID);
    expect(treasureWallet(PROGRAM, CHAIN_ID).equals(a)).toBe(true);
    expect(treasureWallet(PROGRAM, CHAIN_ID + 1).equals(a)).toBe(false);
    expect(PublicKey.isOnCurve(a.toBytes())).toBe(false); // it's a PDA
  });
  it("balanceKeyPda is deterministic and address-scoped", () => {
    const addr = syntheticAddress(PUBKEY);
    const a = balanceKeyPda(PROGRAM, CHAIN_ID, addr);
    expect(balanceKeyPda(PROGRAM, CHAIN_ID, addr).equals(a)).toBe(true);
    expect(balanceKeyPda(PROGRAM, CHAIN_ID, "0x3333333333333333333333333333333333333333").equals(a)).toBe(false);
  });
});

describe("computeBudgetIxs", () => {
  it("returns heap-frame + CU-limit against the ComputeBudget program", () => {
    const ixs = computeBudgetIxs();
    expect(ixs).toHaveLength(2);
    for (const ix of ixs) expect(ix.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(DEFAULT_DOTX_CU_LIMIT).toBeGreaterThan(200_000);
    expect(DEFAULT_DOTX_CU_LIMIT).toBeLessThanOrEqual(1_400_000);
  });
});

describe("emulateCallAccounts", () => {
  it("maps snake_case proxy metas → AccountMeta", async () => {
    const fetchFn = vi.fn(async () => ({
      json: async () => ({
        result: [{ pubkey: PUBKEY.toBase58(), is_signer: true, is_writable: true }],
      }),
    }));
    const metas = await emulateCallAccounts(
      "https://proxy.example",
      { from: syntheticAddress(PUBKEY), to: "0x1111111111111111111111111111111111111111" },
      PUBKEY.toBase58(),
      fetchFn as unknown as typeof fetch,
    );
    expect(metas).toHaveLength(1);
    expect(metas[0].pubkey.equals(PUBKEY)).toBe(true);
    expect(metas[0].isSigner).toBe(true);
    expect(metas[0].isWritable).toBe(true);
    // posts the rome_emulateCallAccounts JSON-RPC
    const body = JSON.parse((fetchFn.mock.calls[0][1] as { body: string }).body);
    expect(body.method).toBe("rome_emulateCallAccounts");
  });
  it("throws on a proxy error", async () => {
    const fetchFn = vi.fn(async () => ({ json: async () => ({ error: { code: -1, message: "Signer not found" } }) }));
    await expect(
      emulateCallAccounts("https://proxy.example", { from: "0x0", to: "0x0" }, "x", fetchFn as unknown as typeof fetch),
    ).rejects.toThrow(/Signer not found/);
  });
});

describe("SyntheticNonceTracker", () => {
  it("peek / reserve / reset", () => {
    const t = new SyntheticNonceTracker(5);
    expect(t.peek()).toBe(5n);
    expect(t.reserve()).toBe(5n);
    expect(t.reserve()).toBe(6n);
    expect(t.peek()).toBe(7n);
    t.reset(0);
    expect(t.peek()).toBe(0n);
  });
});

describe("fund leg (transient-synthetic funding-in)", () => {
  it("buildActivateAtaData = [tag 18, chainId u64-LE, mint(32), tokens u64-LE]", () => {
    const data = buildActivateAtaData({ chainId: CHAIN_ID, mint: PROGRAM, tokens: 5_000_000n });
    expect(data).toHaveLength(1 + 8 + 32 + 8);
    expect(data[0]).toBe(18);
    expect(data.readBigUInt64LE(1)).toBe(BigInt(CHAIN_ID));
    expect(Buffer.from(data.subarray(9, 41))).toEqual(Buffer.from(PROGRAM.toBytes()));
    expect(data.readBigUInt64LE(41)).toBe(5_000_000n);
  });
  it("ownerInfoPda is deterministic and off-curve (a PDA)", () => {
    const a = ownerInfoPda(PROGRAM);
    expect(ownerInfoPda(PROGRAM).equals(a)).toBe(true);
    expect(PublicKey.isOnCurve(a.toBytes())).toBe(false);
  });
  it("buildFundLeg = [ensureSynthAta, activateAta(tag 18)]", () => {
    const ixs = buildFundLeg({ programId: PROGRAM, chainId: CHAIN_ID, mint: PROGRAM, amount: 2_000_000n, wallet: PUBKEY, synthetic: syntheticAddress(PUBKEY) });
    expect(ixs).toHaveLength(2);
    expect(ixs[1].programId.equals(PROGRAM)).toBe(true); // ActivateAta → rome-evm program
    expect(ixs[1].data[0]).toBe(18);
  });
});

describe("sweep leg (value-out)", () => {
  it("buildSweepLeg → Helper precompile transfer_spl + 2 writable extraAccounts", () => {
    const s = buildSweepLeg({ programId: PROGRAM, mint: PROGRAM, amount: 1_000_000n, wallet: PUBKEY, synthetic: syntheticAddress(PUBKEY) });
    expect(s.helperTo.toLowerCase()).toBe("0xff00000000000000000000000000000000000009");
    expect(s.calldata.startsWith("0x")).toBe(true);
    expect(s.extraAccounts).toHaveLength(2);
    expect(s.extraAccounts.every((a) => a.isWritable)).toBe(true);
    expect(s.ensureWalletAtaIx.programId.toBase58()).toBe("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"); // ATA program
  });
});
