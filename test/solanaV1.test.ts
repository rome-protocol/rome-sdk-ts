import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { fromRlp, keccak256, type Hex } from "viem";
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
import {
  ED25519,
  ROME_PROGRAM,
  SYSTEM,
  atomicWire,
  buildV1Message,
  depositData,
  depositWire,
  ed25519Data,
  romeAtomicData,
  systemTransfer,
  wireOf,
} from "./helpers/v1Message.js";
import fixture from "./fixtures/composed-v1.json" with { type: "json" };
import depositFixture from "./fixtures/composed-deposit-v1.json" with { type: "json" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// The live fixtures belong to a payer whose secret key we do not hold, so the wallet's signature over them cannot be real.
const acceptAnySignature = () => vi.spyOn(ed25519, "verify").mockReturnValue(true);

const PROXY = "https://proxy.example/";
const SOLANA_RPC = "https://solana.example/";
const CHAIN_ID = 200010;
const TOKEN = "0x1111111111111111111111111111111111111111" as Hex;
const FEE: FeeFields = { gasLimit: 1_000_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };
const kp = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 7));
const unsignedWire = (): Uint8Array => fixtureWire();
function fixtureWire(): Uint8Array {
  return Uint8Array.from(Buffer.from(fixture.transaction, "base64"));
}
const toHexWei = (n: bigint) => `0x${n.toString(16)}`;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// What a well-behaved proxy answers for `kp`: the live atomic shape, rebuilt around the request's own payload.
const composeAtomicFor = (params: unknown[]) => ({
  recentBlockhash: fixture.recentBlockhash,
  transaction: atomicWire({ payer: kp.publicKey, rlp: params[0] as Hex, authSig: base58.decode(params[2] as string) }).toString("base64"),
});
const composeDepositFor = (params: unknown[]) => ({
  recentBlockhash: "x",
  transaction: depositWire({
    payer: kp.publicKey,
    data: depositData({ chainId: CHAIN_ID, from: syntheticAddress(kp.publicKey), to: syntheticAddress(kp.publicKey), mint: BigInt(params[1] as string), value: BigInt(params[1] as string) }),
  }).toString("base64"),
});

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

// What an honest relay answers: the hash of the payload it was sent.
const relayAnswer = (params: unknown[]) => `0x${hex(authHashFor(params[0] as Hex))}`;

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
  it("decodes the atomic message a live proxy composed", () => {
    const { message } = splitV1Wire(unsignedWire());
    const parsed = parseV1Message(message);
    expect(parsed.accountKeys).toHaveLength(10);
    expect(parsed.accountKeys[0]!.toBase58()).toBe(fixture.payer);
    expect(parsed.instructions).toHaveLength(2);
    const programs = parsed.instructions.map((i) => parsed.accountKeys[i.programIdIndex]!.toBase58());
    expect(programs).toEqual([ED25519.toBase58(), ROME_PROGRAM.toBase58()]);
    expect(parsed.header).toEqual({ numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 6 });
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
  const receiptHandler = () => receipt;

  it("signs twice with one key, broadcasts message || sig, returns the receipt", async () => {
    const signer = spySigner();
    const { conn, asConnection } = fakeConnection();
    const proxy = stubProxy({
      eth_getTransactionCount: () => "0x4",
      rome_composeUnsignedAtomicV1: composeAtomicFor,
      eth_getTransactionReceipt: receiptHandler,
    });
    const res = await submitRomeTxV1(
      { connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer },
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
    const composedWire = atomicWire({ payer: kp.publicKey, rlp: rlp as Hex, authSig });
    expect(signer.wire.mock.calls[0]![0]).toEqual(Uint8Array.from(composedWire));
    const [raw, opts] = conn.sendRawTransaction.mock.calls[0]!;
    const txSig = await signer.wire.mock.results[0]!.value;
    expect(raw).toEqual(packSignedV1Wire(splitV1Wire(Uint8Array.from(composedWire)).message, txSig));
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
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer }, call),
    ).rejects.toThrow(/unknown config mask/);
    expect(signer.wire).toHaveBeenCalledTimes(0);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("includes the tx logs, read with a plain JSON-RPC getTransaction at the Solana endpoint", async () => {
    const { asConnection } = fakeConnection({ err: { InstructionError: [1, "Custom"] }, confirmationStatus: "confirmed" });
    const proxy = stubProxy({
      rome_composeUnsignedAtomicV1: composeAtomicFor,
      getTransaction: () => ({ meta: { logMessages: ["Program log: boom"] } }),
    });
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer: kp }, call),
    ).rejects.toThrow(/InstructionError[\s\S]*Program log: boom/);
    const [get] = proxy.of("getTransaction");
    expect(get!.url).toBe(SOLANA_RPC);
    expect(get!.params).toEqual(["SOLSIG", { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 1 }]);
  });

  it("still reports the Solana error when the log fetch fails", async () => {
    const { asConnection } = fakeConnection({ err: { InstructionError: [1, "Custom"] }, confirmationStatus: "confirmed" });
    stubProxy({ rome_composeUnsignedAtomicV1: composeAtomicFor }); // no getTransaction handler: answers an error
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer: kp }, call),
    ).rejects.toThrow(/InstructionError/);
  });

  it("refuses a signV1Wire result that is not exactly 64 bytes", async () => {
    const real = toLaneSigner(kp);
    const signer: LaneSigner = { payer: real.payer, signAuthHash: real.signAuthHash, signV1Wire: async (w) => w }; // a whole signed wire
    const { conn, asConnection } = fakeConnection();
    stubProxy({ rome_composeUnsignedAtomicV1: composeAtomicFor });
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer }, call),
    ).rejects.toThrow(/signV1Wire must return the 64-byte signature; with solana:signTransaction return signedTransaction\.slice\(-64\)/);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("refuses a signature that is not over the message it checked, and sends nothing", async () => {
    const real = toLaneSigner(kp);
    // a valid signature, but over some other bytes (a wallet that changed the transaction first)
    const signer: LaneSigner = { payer: real.payer, signAuthHash: real.signAuthHash, signV1Wire: async (w) => real.signV1Wire(Uint8Array.of(...w, 0)) };
    const { conn, asConnection } = fakeConnection();
    stubProxy({ rome_composeUnsignedAtomicV1: composeAtomicFor });
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer }, call),
    ).rejects.toThrow(/the wallet signed a different transaction than the one composed/);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("names the Solana signature when the send itself throws, since the node may have accepted it", async () => {
    const signer = spySigner();
    const { conn, asConnection } = fakeConnection();
    conn.sendRawTransaction.mockRejectedValue(new Error("fetch failed: socket hang up"));
    stubProxy({ rome_composeUnsignedAtomicV1: composeAtomicFor });
    const err = await submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer }, call).catch((e: Error) => e);
    const txSig = await signer.wire.mock.results[0]!.value;
    expect((err as Error).message).toBe(`Solana transaction ${base58.encode(txSig)} may not have been sent: fetch failed: socket hang up`);
  });

  it("keeps polling through a status error after the send, and still returns the signature", async () => {
    const { conn, asConnection } = fakeConnection();
    conn.getSignatureStatuses
      .mockRejectedValueOnce(new Error("429 too many requests"))
      .mockResolvedValueOnce({ value: [null] } as never);
    stubProxy({ rome_composeUnsignedAtomicV1: composeAtomicFor, eth_getTransactionReceipt: () => receipt });
    const res = await submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer: kp }, call);
    expect(res.signature).toBe("SOLSIG");
    expect(conn.getSignatureStatuses.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("names the Solana signature when polling keeps failing until the deadline", async () => {
    const { conn, asConnection } = fakeConnection();
    conn.getSignatureStatuses.mockRejectedValue(new Error("rpc down"));
    stubProxy({ rome_composeUnsignedAtomicV1: composeAtomicFor });
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer: kp, confirmTimeoutMs: 20 }, call),
    ).rejects.toThrow(/SOLSIG[\s\S]*rpc down/);
  });

  it("names the Solana signature when the transaction fails", async () => {
    const { asConnection } = fakeConnection({ err: { InstructionError: [1, "Custom"] }, confirmationStatus: "confirmed" });
    stubProxy({ rome_composeUnsignedAtomicV1: composeAtomicFor });
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer: kp }, call),
    ).rejects.toThrow(/SOLSIG/);
  });

  it("throws when the Solana transaction never confirms", async () => {
    const { asConnection } = fakeConnection(null);
    stubProxy({ rome_composeUnsignedAtomicV1: composeAtomicFor });
    await expect(
      submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer: kp, confirmTimeoutMs: 20 }, call),
    ).rejects.toThrow(/not confirmed within 20 ms/);
  });

  describe("refusal", () => {
    const refusal = () => ({ error: { code: -32000, message: ATOMIC_REFUSAL_TEXT } });

    it("relays with the SAME authorization signature, one prompt", async () => {
      const signer = spySigner();
      const { conn, asConnection } = fakeConnection();
      const proxy = stubProxy({
        rome_composeUnsignedAtomicV1: refusal,
        rome_relayUnsignedV1: relayAnswer,
        eth_getTransactionReceipt: receiptHandler,
      });
      const res = await submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer }, call);
      expect(signer.auth).toHaveBeenCalledTimes(1);
      expect(signer.wire).not.toHaveBeenCalled();
      expect(conn.sendRawTransaction).not.toHaveBeenCalled();
      const composeParams = proxy.of("rome_composeUnsignedAtomicV1")[0]!.params;
      expect(proxy.of("rome_relayUnsignedV1")[0]!.params).toEqual(composeParams);
      expect(res).toMatchObject({ route: "relay", receipt });
      expect(res.hash).toBe(relayAnswer(composeParams));
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
        rome_relayUnsignedV1: relayAnswer,
        eth_getTransactionReceipt: receiptHandler,
      });
      await submitRomeTxV1(
        { connection: fakeConnection().asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer },
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
        submitRomeTxV1({ connection: fakeConnection().asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer: kp }, { ...call, relayOnRefusal: false }),
      ).rejects.toThrow(ATOMIC_REFUSAL_TEXT);
      expect(proxy.of("rome_relayUnsignedV1")).toHaveLength(0);
    });

    it("propagates any other compose error without relaying", async () => {
      const proxy = stubProxy({
        rome_composeUnsignedAtomicV1: () => ({ error: { code: -32000, message: "insufficient funds" } }),
        rome_relayUnsignedV1: () => "0xfeed",
      });
      await expect(
        submitRomeTxV1({ connection: fakeConnection().asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer: kp }, call),
      ).rejects.toThrow(/insufficient funds/);
      expect(proxy.of("rome_relayUnsignedV1")).toHaveLength(0);
    });
  });
});

describe("relayV1", () => {
  it("signs once when no signature is passed in", async () => {
    const signer = spySigner();
    const proxy = stubProxy({ rome_relayUnsignedV1: relayAnswer, eth_getTransactionReceipt: () => null });
    const res = await relayV1(
      { connection: fakeConnection().asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer, receiptTimeoutMs: 1, },
      { to: TOKEN, nonce: 0n, fee: FEE },
    );
    expect(signer.auth).toHaveBeenCalledTimes(1);
    expect(proxy.of("rome_relayUnsignedV1")[0]!.params).toHaveLength(3);
    expect(res).toMatchObject({ route: "relay", receipt: null });
    expect(res.hash).toBe(relayAnswer(proxy.of("rome_relayUnsignedV1")[0]!.params));
  });
});

describe("relayV1 with a passed signature", () => {
  it("refuses an authSig without a pinned nonce and fee, before any request", async () => {
    const proxy = stubProxy({});
    const deps = { connection: fakeConnection().asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer: kp };
    const msg = /relayV1: authSig requires nonce and fee \(the signature covers one payload\)/;
    await expect(relayV1(deps, { to: TOKEN, authSig: new Uint8Array(64) })).rejects.toThrow(msg);
    await expect(relayV1(deps, { to: TOKEN, nonce: 1n, authSig: new Uint8Array(64) })).rejects.toThrow(msg);
    await expect(relayV1(deps, { to: TOKEN, fee: FEE, authSig: new Uint8Array(64) })).rejects.toThrow(msg);
    expect(proxy.calls).toHaveLength(0);
  });
  it("accepts an authSig when nonce and fee are pinned", async () => {
    const proxy = stubProxy({ rome_relayUnsignedV1: relayAnswer, eth_getTransactionReceipt: () => receipt });
    const sig = new Uint8Array(64).fill(3);
    const res = await relayV1(
      { connection: fakeConnection().asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer: kp },
      { to: TOKEN, nonce: 0n, fee: FEE, authSig: sig },
    );
    expect(proxy.of("rome_relayUnsignedV1")[0]!.params[2]).toBe(base58.encode(sig));
    expect(res.hash).toBe(relayAnswer(proxy.of("rome_relayUnsignedV1")[0]!.params));
  });

  it("refuses a relay answer that is not the hash of the payload it was sent, and polls no receipt", async () => {
    const proxy = stubProxy({ rome_relayUnsignedV1: () => `0x${"ab".repeat(32)}`, eth_getTransactionReceipt: () => receipt });
    await expect(
      relayV1(
        { connection: fakeConnection().asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer: kp },
        { to: TOKEN, nonce: 0n, fee: FEE },
      ),
    ).rejects.toThrow(/relay answered 0xabab.*expected 0x[0-9a-f]{64}/);
    expect(proxy.of("eth_getTransactionReceipt")).toHaveLength(0);
  });
});

describe("fundSyntheticGas", () => {
  it("refuses an amount that is not a multiple of 10^12 before any request", async () => {
    const proxy = stubProxy({});
    await expect(
      fundSyntheticGas({ connection: fakeConnection().asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer: kp }, 10n ** 12n + 1n),
    ).rejects.toThrow(/10\^12/);
    expect(proxy.calls).toHaveLength(0);
  });
  it("refuses a signV1Wire result that is not exactly 64 bytes", async () => {
    const real = toLaneSigner(kp);
    const signer: LaneSigner = { payer: real.payer, signAuthHash: real.signAuthHash, signV1Wire: async () => new Uint8Array(65) };
    const { conn, asConnection } = fakeConnection();
    stubProxy({ rome_composeExternalDepositV1: composeDepositFor });
    await expect(
      fundSyntheticGas({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer }, 10n ** 12n),
    ).rejects.toThrow(/signV1Wire must return the 64-byte signature/);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("asks for a deposit in hex wei, signs and sends the returned wire", async () => {
    const signer = spySigner();
    const { conn, asConnection } = fakeConnection();
    const proxy = stubProxy({ rome_composeExternalDepositV1: composeDepositFor });
    const res = await fundSyntheticGas(
      { connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer },
      3n * 10n ** 12n,
    );
    expect(proxy.of("rome_composeExternalDepositV1")[0]!.params).toEqual([kp.publicKey.toBase58(), `0x${(3n * 10n ** 12n).toString(16)}`]);
    expect(signer.auth).not.toHaveBeenCalled();
    const composedWire = Uint8Array.from(Buffer.from(composeDepositFor([kp.publicKey.toBase58(), toHexWei(3n * 10n ** 12n)]).transaction, "base64"));
    expect(signer.wire.mock.calls[0]![0]).toEqual(composedWire);
    const txSig = await signer.wire.mock.results[0]!.value;
    expect(conn.sendRawTransaction.mock.calls[0]![0]).toEqual(packSignedV1Wire(splitV1Wire(composedWire).message, txSig));
    expect(res).toEqual({ signature: "SOLSIG" });
  });
});

// --- the composed transaction is checked against what was asked, before the wallet signs ---
describe("composed transaction check", () => {
  const call = { to: TOKEN, data: "0xdeadbeef" as Hex, nonce: 4n, fee: FEE };
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

  /** Run the atomic path against a proxy answer built from the request's rlp and auth signature. */
  async function runAtomic(build: (rlp: Hex, authSig: Uint8Array) => Uint8Array) {
    const signer = spySigner();
    const { conn, asConnection } = fakeConnection();
    stubProxy({
      rome_composeUnsignedAtomicV1: (params) => ({
        recentBlockhash: "x",
        transaction: b64(build(params[0] as Hex, base58.decode(params[2] as string))),
      }),
      eth_getTransactionReceipt: () => receipt,
    });
    const run = () => submitRomeTxV1({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer }, call);
    return { run, signer, conn };
  }
  async function expectRefused(build: (rlp: Hex, authSig: Uint8Array) => Uint8Array, why: RegExp) {
    const { run, signer, conn } = await runAtomic(build);
    await expect(run()).rejects.toThrow(why);
    expect(signer.wire).toHaveBeenCalledTimes(0); // refused before the wallet is asked to sign
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  }
  const base = (rlp: Hex, authSig: Uint8Array) => ({ payer: kp.publicKey, rlp, authSig });

  it("pins the live atomic fixture: Rome data is 10 zero bytes, 0x02, the rlp; the Ed25519 message is the envelope", () => {
    const parsed = parseV1Message(splitV1Wire(unsignedWire()).message);
    const [ed, rome] = parsed.instructions;
    expect(Buffer.from(rome!.data)).toEqual(Buffer.from(romeAtomicData(fixture.rlp as Hex)));
    expect(rome!.data.slice(0, 11)).toEqual(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2));
    // num_signatures 1, offsets header, then key, signature, message
    const key = ed!.data.slice(16, 48);
    const sig = ed!.data.slice(48, 112);
    const message = ed!.data.slice(112);
    expect(ed!.data.slice(0, 2)).toEqual(Uint8Array.of(1, 0));
    expect(Buffer.from(key)).toEqual(Buffer.from(new PublicKey(fixture.payer).toBytes()));
    expect(Buffer.from(message)).toEqual(Buffer.from(ed25519AuthMessage(authHashFor(fixture.rlp as Hex))));
    expect(ed25519.verify(sig, message, key)).toBe(true);
  });

  it("accepts the live atomic fixture end to end", async () => {
    acceptAnySignature();
    const payer = new PublicKey(fixture.payer);
    const fields = fromRlp(fixture.rlp as Hex, "hex") as string[];
    const signer: LaneSigner = {
      payer,
      signAuthHash: async () => new Uint8Array(64),
      signV1Wire: async () => new Uint8Array(64).fill(7),
    };
    const { conn, asConnection } = fakeConnection();
    stubProxy({
      rome_composeUnsignedAtomicV1: () => ({ recentBlockhash: fixture.recentBlockhash, transaction: fixture.transaction }),
      eth_getTransactionReceipt: () => receipt,
    });
    const res = await submitRomeTxV1(
      { connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: Number(BigInt(fields[0]!)), signer },
      {
        to: fields[5] as Hex,
        data: fields[7] as Hex,
        nonce: BigInt(fields[1]!),
        fee: { maxPriorityFeePerGas: 0n, maxFeePerGas: BigInt(fields[3]!), gasLimit: BigInt(fields[4]!) },
      },
    );
    expect(res.route).toBe("atomic");
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("accepts the bare 32-byte hash as the Ed25519 message", async () => {
    const { run, conn } = await runAtomic((rlp, authSig) => atomicWire({ ...base(rlp, authSig), edMessage: authHashFor(rlp) }));
    await run();
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses an appended System transfer before signing", async () => {
    await expectRefused(
      (rlp, authSig) => atomicWire({ ...base(rlp, authSig), extra: [systemTransfer(1_000_000_000n)] }),
      /unexpected program 11111111111111111111111111111111/,
    );
  });
  it("refuses a composed transaction that sets a priority fee, before signing", async () => {
    await expectRefused((rlp, authSig) => atomicWire({ ...base(rlp, authSig), priorityFee: 1_000_000n }), /sets a priority fee/);
  });
  it("refuses a compute-unit limit above the ceiling the caller set, and accepts one at it", async () => {
    const signer = spySigner();
    const { conn, asConnection } = fakeConnection();
    const answer = (cu: number) => (params: unknown[]) => ({
      recentBlockhash: "x",
      transaction: b64(atomicWire({ ...base(params[0] as Hex, base58.decode(params[2] as string)), computeUnitLimit: cu })),
    });
    const deps = { connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer, maxComputeUnitLimit: 200_000 };
    stubProxy({ rome_composeUnsignedAtomicV1: answer(1_400_000), eth_getTransactionReceipt: () => receipt });
    await expect(submitRomeTxV1(deps, call)).rejects.toThrow(/compute-unit limit of 1400000, above the allowed 200000/);
    expect(signer.wire).toHaveBeenCalledTimes(0);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
    stubProxy({ rome_composeUnsignedAtomicV1: answer(200_000), eth_getTransactionReceipt: () => receipt });
    await expect(submitRomeTxV1(deps, call)).resolves.toMatchObject({ route: "atomic" });
  });
  it("refuses an instruction for a third program", async () => {
    const stranger = Keypair.generate().publicKey;
    await expectRefused(
      (rlp, authSig) =>
        atomicWire({ ...base(rlp, authSig), extraKeys: [stranger], extra: [{ programIdIndex: 10, accountIndices: [0], data: Uint8Array.of(1) }] }),
      new RegExp(`unexpected program ${stranger.toBase58()}`),
    );
  });
  it("refuses a payer that is not account 0", async () => {
    await expectRefused((rlp, authSig) => atomicWire({ ...base(rlp, authSig), payerAt1: true }), /fee payer is .* not the signer/);
  });
  it("refuses a Rome instruction whose rlp differs by one byte", async () => {
    await expectRefused((rlp, authSig) => {
      const data = Uint8Array.from(romeAtomicData(rlp));
      data[data.length - 1]! ^= 1;
      return atomicWire({ ...base(rlp, authSig), romeData: data });
    }, /does not carry the payload that was authorized/);
  });
  it("refuses a Rome instruction with a different leading tag", async () => {
    await expectRefused((rlp, authSig) => {
      const data = Uint8Array.from(romeAtomicData(rlp));
      data[0] = 1;
      return atomicWire({ ...base(rlp, authSig), romeData: data });
    }, /does not carry the payload/);
  });
  it("refuses two Rome instructions", async () => {
    await expectRefused(
      (rlp, authSig) =>
        atomicWire({
          ...base(rlp, authSig),
          extra: [{ programIdIndex: 6, accountIndices: [0], data: Uint8Array.from(romeAtomicData(rlp)) }],
        }),
      /expected one Rome program instruction, found 2/,
    );
  });
  it("refuses an Ed25519 message for a different hash", async () => {
    await expectRefused(
      (rlp, authSig) => atomicWire({ ...base(rlp, authSig), edMessage: ed25519AuthMessage(new Uint8Array(32).fill(1)) }),
      /verifies a message other than this call's authorization/,
    );
  });
  it("refuses an Ed25519 key that is not the payer's", async () => {
    await expectRefused(
      (rlp, authSig) => atomicWire({ ...base(rlp, authSig), edPubkey: Keypair.generate().publicKey.toBytes() }),
      /not the payer's/,
    );
  });
  it("refuses an Ed25519 instruction that reads from another instruction", async () => {
    await expectRefused(
      (rlp, authSig) => atomicWire({ ...base(rlp, authSig), edIndexes: [0xffff, 0xffff, 1] }),
      /another instruction/,
    );
  });
  it("refuses zero or two Ed25519 instructions", async () => {
    await expectRefused((rlp, authSig) => atomicWire({ ...base(rlp, authSig), edCount: 0 }), /expected one Ed25519 instruction, found 0/);
    await expectRefused((rlp, authSig) => atomicWire({ ...base(rlp, authSig), edCount: 2 }), /expected one Ed25519 instruction, found 2/);
  });

  describe("deposit", () => {
    const AMOUNT = 10n ** 15n;
    const synthetic = syntheticAddress(kp.publicKey);
    const good = () => depositData({ chainId: CHAIN_ID, from: synthetic, to: synthetic, mint: AMOUNT, value: AMOUNT });

    async function runDeposit(wire: Uint8Array, amount = AMOUNT) {
      const signer = spySigner();
      const { conn, asConnection } = fakeConnection();
      stubProxy({ rome_composeExternalDepositV1: () => ({ recentBlockhash: "x", transaction: b64(wire) }) });
      const run = () => fundSyntheticGas({ connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: CHAIN_ID, signer }, amount);
      return { run, signer, conn };
    }
    async function refused(wire: Uint8Array, why: RegExp) {
      const { run, signer, conn } = await runDeposit(wire);
      await expect(run()).rejects.toThrow(why);
      expect(signer.wire).toHaveBeenCalledTimes(0);
      expect(conn.sendRawTransaction).not.toHaveBeenCalled();
    }

    it("pins the live deposit fixture: tag, chain id, 0x7e, and the amount in the mint and value fields", () => {
      const parsed = parseV1Message(splitV1Wire(Uint8Array.from(Buffer.from(depositFixture.transaction, "base64"))).message);
      expect(parsed.instructions).toHaveLength(1);
      const data = parsed.instructions[0]!.data;
      expect(data[0]).toBe(0x01);
      expect(new DataView(data.buffer, data.byteOffset).getBigUint64(1, true)).toBe(BigInt(depositFixture.chainId));
      expect(data[9]).toBe(0x7e);
      const fields = fromRlp(`0x${hex(data.slice(10))}`, "hex") as string[];
      expect(fields).toHaveLength(8);
      const synth = syntheticAddress(new PublicKey(depositFixture.payer));
      expect([fields[1], fields[2]]).toEqual([synth, synth]);
      expect(BigInt(fields[3]!)).toBe(BigInt(depositFixture.amountWei));
      expect(BigInt(fields[4]!)).toBe(BigInt(depositFixture.amountWei));
      // the test builder reproduces the live bytes
      const rebuilt = depositData({ chainId: depositFixture.chainId, from: synth, to: synth, mint: BigInt(depositFixture.amountWei), value: BigInt(depositFixture.amountWei) });
      expect(Buffer.from(data)).toEqual(rebuilt);
    });

    it("accepts the live deposit fixture end to end", async () => {
      acceptAnySignature();
      const payer = new PublicKey(depositFixture.payer);
      const signer: LaneSigner = { payer, signAuthHash: async () => new Uint8Array(64), signV1Wire: async () => new Uint8Array(64) };
      const { conn, asConnection } = fakeConnection();
      stubProxy({ rome_composeExternalDepositV1: () => ({ recentBlockhash: "x", transaction: depositFixture.transaction }) });
      const res = await fundSyntheticGas(
        { connection: asConnection, proxyUrl: PROXY, programId: ROME_PROGRAM, chainId: depositFixture.chainId, signer },
        BigInt(depositFixture.amountWei),
      );
      expect(res).toEqual({ signature: "SOLSIG" });
      expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    });

    it("accepts a well-formed deposit for the amount asked", async () => {
      const { run, conn } = await runDeposit(depositWire({ payer: kp.publicKey, data: good() }));
      await run();
      expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    });
    it("refuses a deposit that sets a priority fee", async () => {
      await refused(depositWire({ payer: kp.publicKey, data: good(), priorityFee: 1_000_000n }), /sets a priority fee/);
    });
    it("refuses an appended System transfer", async () => {
      await refused(depositWire({ payer: kp.publicKey, data: good(), extra: [{ ...systemTransfer(5n), programIdIndex: 5 }] }), /unexpected program/);
    });
    it("refuses a second Rome instruction", async () => {
      await refused(depositWire({ payer: kp.publicKey, data: good(), extra: [{ programIdIndex: 6, accountIndices: [0], data: good() }] }), /expected one Rome program instruction, found 2/);
    });
    it("refuses a payer that is not account 0", async () => {
      await refused(depositWire({ payer: Keypair.generate().publicKey, data: good() }), /fee payer is .* not the signer/);
    });
    it("refuses a deposit for another chain, another tag or another type byte", async () => {
      const wrongChain = depositData({ chainId: 1, from: synthetic, to: synthetic, mint: AMOUNT, value: AMOUNT });
      await refused(depositWire({ payer: kp.publicKey, data: wrongChain }), /not a deposit for this chain/);
      const wrongTag = Uint8Array.from(good());
      wrongTag[0] = 0;
      await refused(depositWire({ payer: kp.publicKey, data: wrongTag }), /not a deposit for this chain/);
      const wrongType = Uint8Array.from(good());
      wrongType[9] = 0x02;
      await refused(depositWire({ payer: kp.publicKey, data: wrongType }), /not a deposit for this chain/);
    });
    it("refuses a deposit that credits another address", async () => {
      const other = syntheticAddress(Keypair.generate().publicKey);
      await refused(depositWire({ payer: kp.publicKey, data: depositData({ chainId: CHAIN_ID, from: synthetic, to: other, mint: AMOUNT, value: AMOUNT }) }), /own synthetic address/);
    });
    it("refuses a deposit for a different amount", async () => {
      await refused(depositWire({ payer: kp.publicKey, data: depositData({ chainId: CHAIN_ID, from: synthetic, to: synthetic, mint: 2n * AMOUNT, value: 2n * AMOUNT }) }), /not the \d+ wei that was asked for/);
      await refused(depositWire({ payer: kp.publicKey, data: depositData({ chainId: CHAIN_ID, from: synthetic, to: synthetic, mint: AMOUNT, value: 0n }) }), /not the \d+ wei that was asked for/);
    });
    it("refuses a payload that is not RLP", async () => {
      const junk = Buffer.concat([good().subarray(0, 10), Buffer.from([0xf8])]);
      await refused(depositWire({ payer: kp.publicKey, data: junk }), /not valid RLP|unexpected deposit payload/);
    });
    it("refuses an Ed25519 instruction in a deposit", async () => {
      await refused(
        depositWire({ payer: kp.publicKey, data: good(), extra: [{ programIdIndex: 3, accountIndices: [], data: ed25519Data(kp.publicKey.toBytes(), new Uint8Array(64), new Uint8Array(32)) }] }),
        /unexpected program|expected the Rome instruction alone/,
      );
    });
  });
});

describe("public surface", () => {
  it("does not export a way to fetch a composed transaction without the check", async () => {
    const root = await import("../src/index.js");
    expect(root).not.toHaveProperty("composeAtomicV1");
  });
});
