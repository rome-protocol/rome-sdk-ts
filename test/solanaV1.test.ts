import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { keccak256, type Hex } from "viem";
import {
  ED25519_AUTH_MESSAGE_PREFIX,
  ATOMIC_REFUSAL_TEXT,
  authHashFor,
  ed25519AuthMessage,
  toLaneSigner,
  splitV1Wire,
  packSignedV1Wire,
  parseV1Message,
  isAtomicRefusal,
  submitRomeTxV1,
  relayV1,
  fundSyntheticGas,
  type LaneSigner,
} from "../src/solanaV1.js";
import { syntheticAddress, type FeeFields } from "../src/solana.js";
import { buildV1Message, wireOf } from "./helpers/v1Message.js";
import fixture from "./fixtures/composed-v1.json" with { type: "json" };

afterEach(() => vi.unstubAllGlobals());

const PROXY = "https://proxy.example/";
const SOLANA_RPC = "https://solana.example/";
const CHAIN_ID = 200010;
const ROME_PROGRAM = new PublicKey("RPTWwELXAY4KC9ZPHhaxp7Sq1hHtU3HNEgLbSegCcWf");
const TOKEN = "0x1111111111111111111111111111111111111111" as Hex;
const FEE: FeeFields = { gasLimit: 1_000_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };
const kp = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 7));
const unsignedWire = (): Uint8Array => fixtureWire();
function fixtureWire(): Uint8Array {
  return Uint8Array.from(Buffer.from(fixture.transaction, "base64"));
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// ---- a stub proxy: each method maps to a handler returning a result or { error } ----
type Handler = (params: unknown[]) => unknown;
function stubProxy(handlers: Record<string, Handler>) {
  const calls: { method: string; params: unknown[]; url: string }[] = [];
  const fn = vi.fn(async (url: unknown, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
    calls.push({ method, params, url: String(url) });
    const h = handlers[method];
    const out = h ? h(params) : { error: { code: -32601, message: `no handler for ${method}` } };
    const isErr = typeof out === "object" && out !== null && "error" in out;
    return { json: async () => (isErr ? out : { result: out }) };
  });
  vi.stubGlobal("fetch", fn);
  return { calls, of: (m: string) => calls.filter((c) => c.method === m) };
}

function fakeConnection(status: unknown = { err: null, confirmationStatus: "confirmed" }) {
  const conn = {
    sendRawTransaction: vi.fn(async (_raw: Uint8Array, _opts?: unknown) => "SOLSIG"),
    getSignatureStatuses: vi.fn(async () => ({ value: [status] })),
    rpcEndpoint: SOLANA_RPC,
  };
  return { conn, asConnection: conn as unknown as Connection };
}

function spySigner(): LaneSigner & { auth: ReturnType<typeof vi.fn>; wire: ReturnType<typeof vi.fn> } {
  const real = toLaneSigner(kp);
  const auth = vi.fn(real.signAuthHash);
  const wire = vi.fn(real.signV1Wire);
  return { payer: real.payer, signAuthHash: auth, signV1Wire: wire, auth, wire };
}

const receipt = { status: "0x1", blockNumber: "0x10", transactionHash: "0xabc" };

describe("authorization message", () => {
  it("prefix is the exact 21 bytes", () => {
    expect(hex(new TextEncoder().encode(ED25519_AUTH_MESSAGE_PREFIX))).toBe(
      "526f6d6520617574686f72697a6174696f6e0a3078",
    );
    expect(ED25519_AUTH_MESSAGE_PREFIX.length).toBe(21);
  });
  it("envelope = prefix || 64 lowercase hex chars (85 bytes)", () => {
    const hash = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i);
    const msg = ed25519AuthMessage(hash);
    expect(msg.length).toBe(85);
    expect(new TextDecoder().decode(msg)).toBe(`${ED25519_AUTH_MESSAGE_PREFIX}${hex(hash)}`);
  });
  it("authHashFor is keccak256(0x02 || rlp)", () => {
    const rlp = "0xe483030d4a81868080830f424094d868eec27e47376e739d0a3555f81b7657faa3228080c0" as Hex;
    expect(`0x${hex(authHashFor(rlp))}`).toBe(keccak256(`0x02${rlp.slice(2)}` as Hex));
  });
});

describe("toLaneSigner", () => {
  it("signs the auth envelope with the keypair", async () => {
    const msg = ed25519AuthMessage(new Uint8Array(32).fill(5));
    const sig = await toLaneSigner(kp).signAuthHash(msg);
    expect(sig.length).toBe(64);
    expect(ed25519.verify(sig, msg, kp.publicKey.toBytes())).toBe(true);
  });
  it("signs exactly the message part of a wire", async () => {
    const wire = unsignedWire();
    const sig = await toLaneSigner(kp).signV1Wire(wire);
    expect(ed25519.verify(sig, wire.slice(0, wire.length - 64), kp.publicKey.toBytes())).toBe(true);
    expect(ed25519.verify(sig, wire, kp.publicKey.toBytes())).toBe(false);
  });
  it("passes a LaneSigner through untouched", () => {
    const s = spySigner();
    expect(toLaneSigner(s)).toBe(s);
  });
});

describe("v1 wire", () => {
  it("split and pack round-trip", () => {
    const wire = unsignedWire();
    const { message, numRequiredSignatures } = splitV1Wire(wire);
    expect(numRequiredSignatures).toBe(1);
    expect(message.length).toBe(wire.length - 64);
    const sig = new Uint8Array(64).fill(9);
    const signed = packSignedV1Wire(message, sig);
    expect(signed.slice(0, message.length)).toEqual(message);
    expect(signed.slice(message.length)).toEqual(sig);
  });
  it("rejects a wrong version byte", () => {
    const wire = unsignedWire().slice();
    wire[0] = 0x80;
    expect(() => splitV1Wire(wire)).toThrow(/v1/);
  });
  it("rejects more than one required signature", () => {
    const wire = unsignedWire().slice();
    wire[1] = 2;
    expect(() => splitV1Wire(wire)).toThrow(/signature/);
  });
  it("rejects a wire too short to hold a header and a signature", () => {
    expect(() => splitV1Wire(Uint8Array.of(0x81, 1, 0, 0, 0))).toThrow(/too short/);
  });
  it("decodes a message composed by a live proxy", () => {
    const { message } = splitV1Wire(unsignedWire());
    const parsed = parseV1Message(message);
    expect(parsed.accountKeys).toHaveLength(8);
    expect(parsed.accountKeys[0]!.toBase58()).toBe(fixture.payer);
    expect(parsed.instructions).toHaveLength(2);
    expect(parsed.instructions.some((i) => parsed.accountKeys[i.programIdIndex]!.equals(ROME_PROGRAM))).toBe(true);
    expect(parsed.header).toEqual({ numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 5 });
    // mask: compute-unit limit + loaded-accounts size set; priority fee and heap unset
    expect(new DataView(message.buffer, message.byteOffset).getUint32(4, true)).toBe(0b1100);
    expect(parsed.computeUnitLimit).toBeGreaterThan(0);
    expect(parsed.heapBytes).toBeUndefined();
  });
  const keys = [kp.publicKey, ROME_PROGRAM];
  const ix = [{ programIdIndex: 1, accountIndices: [0], data: Uint8Array.of(1, 2, 3) }];
  it("round-trips a built message with every config value", () => {
    const m = buildV1Message({
      accountKeys: keys,
      config: { priorityFee: 5n, computeUnitLimit: 1_200_000, loadedAccountsDataSize: 64_000, heapBytes: 262_144 },
      instructions: ix,
    });
    const p = parseV1Message(m);
    expect(p.computeUnitLimit).toBe(1_200_000);
    expect(p.heapBytes).toBe(262_144);
    expect(p.instructions[0]!.data).toEqual(Uint8Array.of(1, 2, 3));
    expect(p.instructions[0]!.accountIndices).toEqual([0]);
  });
  it("rejects unknown mask bits", () => {
    expect(() => parseV1Message(buildV1Message({ accountKeys: keys, rawMask: 0b100000, instructions: ix }))).toThrow(/unknown config mask/);
  });
  it("rejects partial priority-fee bits", () => {
    expect(() => parseV1Message(buildV1Message({ accountKeys: keys, rawMask: 0b01, instructions: ix }))).toThrow(/priority-fee/);
    expect(() => parseV1Message(buildV1Message({ accountKeys: keys, rawMask: 0b10, instructions: ix }))).toThrow(/priority-fee/);
  });
  it("rejects trailing bytes after the last instruction", () => {
    const m = buildV1Message({ accountKeys: keys, instructions: ix });
    const longer = new Uint8Array(m.length + 1);
    longer.set(m);
    expect(() => parseV1Message(longer)).toThrow(/trailing/);
  });
  it("rejects a truncated message", () => {
    const m = buildV1Message({ accountKeys: keys, config: { computeUnitLimit: 1 }, instructions: ix });
    for (const cut of [10, 60, m.length - 2]) expect(() => parseV1Message(m.subarray(0, cut))).toThrow(/truncated/);
  });
});

describe("isAtomicRefusal", () => {
  it("matches an Error, a string, and nothing else", () => {
    expect(isAtomicRefusal(new Error(`rome_composeUnsignedAtomicV1: ${ATOMIC_REFUSAL_TEXT} (code -32000)`))).toBe(true);
    expect(isAtomicRefusal(ATOMIC_REFUSAL_TEXT)).toBe(true);
    expect(isAtomicRefusal(new Error("insufficient funds"))).toBe(false);
    expect(isAtomicRefusal(undefined)).toBe(false);
    expect(isAtomicRefusal({ message: ATOMIC_REFUSAL_TEXT })).toBe(false);
  });
});

describe("submitRomeTxV1", () => {
  const call = { to: TOKEN, data: "0xdeadbeef" as Hex, nonce: 4n, fee: FEE };
  const composed = { recentBlockhash: fixture.recentBlockhash, transaction: fixture.transaction };
  const receiptHandler = () => receipt;

  it("signs twice with one key, broadcasts message || sig, returns the receipt", async () => {
    const signer = spySigner();
    const { conn, asConnection } = fakeConnection();
    const proxy = stubProxy({
      eth_getTransactionCount: () => "0x4",
      rome_composeUnsignedAtomicV1: () => composed,
      eth_getTransactionReceipt: receiptHandler,
    });
    const res = await submitRomeTxV1(
      { connection: asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer },
      { to: TOKEN, data: "0xdeadbeef", fee: FEE },
    );
    expect(proxy.of("eth_getTransactionCount")[0]!.params).toEqual([syntheticAddress(kp.publicKey), "pending"]);

    // one auth prompt, over the 85-byte readable envelope
    expect(signer.auth).toHaveBeenCalledTimes(1);
    const envelope = signer.auth.mock.calls[0]![0] as Uint8Array;
    expect(envelope.length).toBe(85);
    expect(new TextDecoder().decode(envelope)).toBe(`${ED25519_AUTH_MESSAGE_PREFIX}${res.hash.slice(2)}`);

    // compose got [rlp, payer, base58(authSig)]
    const [rlp, payerB58, sigB58] = proxy.of("rome_composeUnsignedAtomicV1")[0]!.params as string[];
    expect(`0x${hex(authHashFor(rlp as Hex))}`).toBe(res.hash);
    expect(payerB58).toBe(kp.publicKey.toBase58());
    const authSig = base58.decode(sigB58!);
    expect(ed25519.verify(authSig, envelope, kp.publicKey.toBytes())).toBe(true);

    // second signature over the unsigned wire; broadcast = message || that signature
    expect(signer.wire).toHaveBeenCalledTimes(1);
    expect(signer.wire.mock.calls[0]![0]).toEqual(unsignedWire());
    const [raw, opts] = conn.sendRawTransaction.mock.calls[0]!;
    const txSig = await signer.wire.mock.results[0]!.value;
    expect(raw).toEqual(packSignedV1Wire(splitV1Wire(unsignedWire()).message, txSig));
    expect(opts).toEqual({ skipPreflight: true });

    expect(proxy.of("eth_getTransactionReceipt")[0]!.params).toEqual([res.hash]);
    expect(res).toMatchObject({ route: "atomic", signature: "SOLSIG", from: syntheticAddress(kp.publicKey), receipt });
  });

  it("throws on a malformed compose answer BEFORE the second signature", async () => {
    const bad = buildV1Message({ accountKeys: [kp.publicKey, ROME_PROGRAM], rawMask: 0b100000, instructions: [] });
    const signer = spySigner();
    const { conn, asConnection } = fakeConnection();
    stubProxy({ rome_composeUnsignedAtomicV1: () => ({ recentBlockhash: "x", transaction: wireOf(bad).toString("base64") }), eth_getTransactionReceipt: () => receipt });
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer }, call),
    ).rejects.toThrow(/unknown config mask/);
    expect(signer.wire).toHaveBeenCalledTimes(0);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("includes the tx logs, read with a plain JSON-RPC getTransaction at the Solana endpoint", async () => {
    const { asConnection } = fakeConnection({ err: { InstructionError: [1, "Custom"] }, confirmationStatus: "confirmed" });
    const proxy = stubProxy({
      rome_composeUnsignedAtomicV1: () => composed,
      getTransaction: () => ({ meta: { logMessages: ["Program log: boom"] } }),
    });
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer: kp }, call),
    ).rejects.toThrow(/InstructionError[\s\S]*Program log: boom/);
    const [get] = proxy.of("getTransaction");
    expect(get!.url).toBe(SOLANA_RPC);
    expect(get!.params).toEqual(["SOLSIG", { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
  });

  it("still reports the Solana error when the log fetch fails", async () => {
    const { asConnection } = fakeConnection({ err: { InstructionError: [1, "Custom"] }, confirmationStatus: "confirmed" });
    stubProxy({ rome_composeUnsignedAtomicV1: () => composed }); // no getTransaction handler: answers an error
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer: kp }, call),
    ).rejects.toThrow(/InstructionError/);
  });

  it("refuses a signV1Wire result that is not exactly 64 bytes", async () => {
    const real = toLaneSigner(kp);
    const signer: LaneSigner = { payer: real.payer, signAuthHash: real.signAuthHash, signV1Wire: async (w) => w }; // a whole signed wire
    const { conn, asConnection } = fakeConnection();
    stubProxy({ rome_composeUnsignedAtomicV1: () => composed });
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer }, call),
    ).rejects.toThrow(/signV1Wire must return the 64-byte signature; with solana:signTransaction return signedTransaction\.slice\(-64\)/);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("keeps polling through a status error after the send, and still returns the signature", async () => {
    const { conn, asConnection } = fakeConnection();
    conn.getSignatureStatuses
      .mockRejectedValueOnce(new Error("429 too many requests"))
      .mockResolvedValueOnce({ value: [null] } as never);
    stubProxy({ rome_composeUnsignedAtomicV1: () => composed, eth_getTransactionReceipt: () => receipt });
    const res = await submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer: kp }, call);
    expect(res.signature).toBe("SOLSIG");
    expect(conn.getSignatureStatuses.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("names the Solana signature when polling keeps failing until the deadline", async () => {
    const { conn, asConnection } = fakeConnection();
    conn.getSignatureStatuses.mockRejectedValue(new Error("rpc down"));
    stubProxy({ rome_composeUnsignedAtomicV1: () => composed });
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer: kp, confirmTimeoutMs: 20 }, call),
    ).rejects.toThrow(/SOLSIG[\s\S]*rpc down/);
  });

  it("names the Solana signature when the transaction fails", async () => {
    const { asConnection } = fakeConnection({ err: { InstructionError: [1, "Custom"] }, confirmationStatus: "confirmed" });
    stubProxy({ rome_composeUnsignedAtomicV1: () => composed });
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer: kp }, call),
    ).rejects.toThrow(/SOLSIG/);
  });

  it("throws when the Solana transaction never confirms", async () => {
    const { asConnection } = fakeConnection(null);
    stubProxy({ rome_composeUnsignedAtomicV1: () => composed });
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer: kp, confirmTimeoutMs: 20 }, call),
    ).rejects.toThrow(/not confirmed within 20 ms/);
  });

  describe("refusal", () => {
    const refusal = () => ({ error: { code: -32000, message: ATOMIC_REFUSAL_TEXT } });

    it("relays with the SAME authorization signature, one prompt", async () => {
      const signer = spySigner();
      const { conn, asConnection } = fakeConnection();
      const proxy = stubProxy({
        rome_composeUnsignedAtomicV1: refusal,
        rome_relayUnsignedV1: () => "0xfeed",
        eth_getTransactionReceipt: receiptHandler,
      });
      const res = await submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer }, call);
      expect(signer.auth).toHaveBeenCalledTimes(1);
      expect(signer.wire).not.toHaveBeenCalled();
      expect(conn.sendRawTransaction).not.toHaveBeenCalled();
      const composeParams = proxy.of("rome_composeUnsignedAtomicV1")[0]!.params;
      expect(proxy.of("rome_relayUnsignedV1")[0]!.params).toEqual(composeParams);
      expect(res).toMatchObject({ route: "relay", hash: "0xfeed", receipt });
      expect(res.signature).toBeUndefined();
    });

    it("relays the very payload the signature covers when nonce and fee are not pinned", async () => {
      const signer = spySigner();
      let counts = 0;
      const proxy = stubProxy({
        eth_getTransactionCount: () => `0x${(4 + counts++).toString(16)}`, // a different answer on every call
        eth_estimateGas: () => "0x186a0",
        eth_getBlockByNumber: () => ({ baseFeePerGas: "0x5" }),
        rome_composeUnsignedAtomicV1: refusal,
        rome_relayUnsignedV1: () => "0xfeed",
        eth_getTransactionReceipt: receiptHandler,
      });
      await submitRomeTxV1(
        { connection: fakeConnection().asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer },
        { to: TOKEN, data: "0xdeadbeef" },
      );
      const [composeRlp, , composeSig] = proxy.of("rome_composeUnsignedAtomicV1")[0]!.params as string[];
      const [relayRlp, , relaySig] = proxy.of("rome_relayUnsignedV1")[0]!.params as string[];
      expect(relayRlp).toBe(composeRlp);
      expect(relaySig).toBe(composeSig);
      expect(proxy.of("eth_getTransactionCount")).toHaveLength(1);
      const envelope = ed25519AuthMessage(authHashFor(relayRlp as Hex));
      expect(ed25519.verify(base58.decode(relaySig!), envelope, kp.publicKey.toBytes())).toBe(true);
    });

    it("propagates the refusal when relayOnRefusal is false", async () => {
      const proxy = stubProxy({ rome_composeUnsignedAtomicV1: refusal, rome_relayUnsignedV1: () => "0xfeed" });
      await expect(
        submitRomeTxV1({ connection: fakeConnection().asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer: kp }, { ...call, relayOnRefusal: false }),
      ).rejects.toThrow(ATOMIC_REFUSAL_TEXT);
      expect(proxy.of("rome_relayUnsignedV1")).toHaveLength(0);
    });

    it("propagates any other compose error without relaying", async () => {
      const proxy = stubProxy({
        rome_composeUnsignedAtomicV1: () => ({ error: { code: -32000, message: "insufficient funds" } }),
        rome_relayUnsignedV1: () => "0xfeed",
      });
      await expect(
        submitRomeTxV1({ connection: fakeConnection().asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer: kp }, call),
      ).rejects.toThrow(/insufficient funds/);
      expect(proxy.of("rome_relayUnsignedV1")).toHaveLength(0);
    });
  });
});

describe("relayV1", () => {
  it("signs once when no signature is passed in", async () => {
    const signer = spySigner();
    const proxy = stubProxy({ rome_relayUnsignedV1: () => "0xfeed", eth_getTransactionReceipt: () => null });
    const res = await relayV1(
      { connection: fakeConnection().asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer, receiptTimeoutMs: 1, },
      { to: TOKEN, nonce: 0n, fee: FEE },
    );
    expect(signer.auth).toHaveBeenCalledTimes(1);
    expect(proxy.of("rome_relayUnsignedV1")[0]!.params).toHaveLength(3);
    expect(res).toMatchObject({ route: "relay", hash: "0xfeed", receipt: null });
  });
});

describe("fundSyntheticGas", () => {
  const composed = { recentBlockhash: fixture.recentBlockhash, transaction: fixture.transaction };
  it("refuses an amount that is not a multiple of 10^12 before any request", async () => {
    const proxy = stubProxy({});
    await expect(
      fundSyntheticGas({ connection: fakeConnection().asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer: kp }, 10n ** 12n + 1n),
    ).rejects.toThrow(/10\^12/);
    expect(proxy.calls).toHaveLength(0);
  });
  it("refuses a signV1Wire result that is not exactly 64 bytes", async () => {
    const real = toLaneSigner(kp);
    const signer: LaneSigner = { payer: real.payer, signAuthHash: real.signAuthHash, signV1Wire: async () => new Uint8Array(65) };
    const { conn, asConnection } = fakeConnection();
    stubProxy({ rome_composeExternalDepositV1: () => composed });
    await expect(
      fundSyntheticGas({ connection: asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer }, 10n ** 12n),
    ).rejects.toThrow(/signV1Wire must return the 64-byte signature/);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("asks for a deposit in hex wei, signs and sends the returned wire", async () => {
    const signer = spySigner();
    const { conn, asConnection } = fakeConnection();
    const proxy = stubProxy({ rome_composeExternalDepositV1: () => composed });
    const res = await fundSyntheticGas(
      { connection: asConnection, proxyUrl: PROXY, chainId: CHAIN_ID, signer },
      3n * 10n ** 12n,
    );
    expect(proxy.of("rome_composeExternalDepositV1")[0]!.params).toEqual([kp.publicKey.toBase58(), `0x${(3n * 10n ** 12n).toString(16)}`]);
    expect(signer.auth).not.toHaveBeenCalled();
    expect(signer.wire.mock.calls[0]![0]).toEqual(unsignedWire());
    const txSig = await signer.wire.mock.results[0]!.value;
    expect(conn.sendRawTransaction.mock.calls[0]![0]).toEqual(packSignedV1Wire(splitV1Wire(unsignedWire()).message, txSig));
    expect(res).toEqual({ signature: "SOLSIG" });
  });
});
