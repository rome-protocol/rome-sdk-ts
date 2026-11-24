import { describe, it, expect, vi, afterEach } from "vitest";
import { sizeSolanaLaneFee } from "../src/solana.js";
import { DEFAULT_ROME_GAS_FALLBACK, RomeEstimateUnavailableError } from "../src/write.js";

afterEach(() => vi.unstubAllGlobals());

const CALL = { from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", data: "0xdeadbeef" } as const;

/** A proxy that answers `estimate` for eth_estimateGas (an Error is an error answer) and fixed fee reads. */
function proxy(estimate: string | Error) {
  const methods: string[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const { method } = JSON.parse(init.body) as { method: string };
    methods.push(method);
    if (method === "eth_estimateGas") {
      return { json: async () => (estimate instanceof Error ? { error: { code: 3, message: estimate.message } } : { result: estimate }) };
    }
    const results: Record<string, unknown> = { eth_getBlockByNumber: { baseFeePerGas: "0x64" }, eth_maxPriorityFeePerGas: "0xa", eth_gasPrice: "0x64" };
    return { json: async () => ({ result: results[method] }) };
  }) as unknown as typeof fetch;
  return { fetchImpl, methods };
}

describe("sizeSolanaLaneFee", () => {
  it("default behaviour is unchanged: pads a real estimate, pads 21,000, ceiling on a throw", async () => {
    expect((await sizeSolanaLaneFee("https://p.example/", CALL, { fetchImpl: proxy("0x64").fetchImpl })).gasLimit).toBe(130n);
    expect((await sizeSolanaLaneFee("https://p.example/", CALL, { fetchImpl: proxy("0x5208").fetchImpl })).gasLimit).toBe(27_300n);
    expect((await sizeSolanaLaneFee("https://p.example/", CALL, { fetchImpl: proxy(new Error("revert")).fetchImpl })).gasLimit).toBe(DEFAULT_ROME_GAS_FALLBACK);
  });

  it("requireEstimate: a thrown estimate stops with a clear error", async () => {
    await expect(sizeSolanaLaneFee("https://p.example/", CALL, { fetchImpl: proxy(new Error("revert")).fetchImpl, requireEstimate: true })).rejects.toBeInstanceOf(RomeEstimateUnavailableError);
    await expect(sizeSolanaLaneFee("https://p.example/", CALL, { fetchImpl: proxy(new Error("revert")).fetchImpl, requireEstimate: true })).rejects.toThrow(/no usable gas estimate/);
  });

  it("requireEstimate: 21,000 is a real estimate, padded", async () => {
    expect((await sizeSolanaLaneFee("https://p.example/", CALL, { fetchImpl: proxy("0x5208").fetchImpl, requireEstimate: true })).gasLimit).toBe(27_300n);
  });

  it("requireEstimate: an explicit fallbackGas is used only when the estimate throws, a real estimate is padded", async () => {
    expect((await sizeSolanaLaneFee("https://p.example/", CALL, { fetchImpl: proxy(new Error("revert")).fetchImpl, requireEstimate: true, fallbackGas: 5_000_000n })).gasLimit).toBe(5_000_000n);
    expect((await sizeSolanaLaneFee("https://p.example/", CALL, { fetchImpl: proxy("0x5208").fetchImpl, requireEstimate: true, fallbackGas: 5_000_000n })).gasLimit).toBe(27_300n);
    expect((await sizeSolanaLaneFee("https://p.example/", CALL, { fetchImpl: proxy("0x64").fetchImpl, requireEstimate: true })).gasLimit).toBe(130n);
  });

  it("fallbackGas: null is treated like undefined: the 250M default, and a stop under requireEstimate", async () => {
    const nul = null as unknown as bigint;
    expect((await sizeSolanaLaneFee("https://p.example/", CALL, { fetchImpl: proxy(new Error("revert")).fetchImpl, fallbackGas: nul })).gasLimit).toBe(DEFAULT_ROME_GAS_FALLBACK);
    await expect(sizeSolanaLaneFee("https://p.example/", CALL, { fetchImpl: proxy(new Error("revert")).fetchImpl, requireEstimate: true, fallbackGas: nul })).rejects.toBeInstanceOf(RomeEstimateUnavailableError);
  });

  it("a usable estimate beats fallbackGas", async () => {
    expect((await sizeSolanaLaneFee("https://p.example/", CALL, { fetchImpl: proxy("0x64").fetchImpl, fallbackGas: 0x1234n })).gasLimit).toBe(130n);
    expect((await sizeSolanaLaneFee("https://p.example/", CALL, { fetchImpl: proxy("0x64").fetchImpl, requireEstimate: true, fallbackGas: 0x1234n })).gasLimit).toBe(130n);
  });
});
