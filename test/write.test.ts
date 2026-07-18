import { describe, it, expect } from "vitest";
import {
  padRomeGas,
  romeWriteGas,
  buildRome1559Fees,
  romeFeeFields,
  submitRomeTx,
  ROME_GAS_PAD_NUMERATOR,
  ROME_GAS_PAD_DENOMINATOR,
  DEFAULT_ROME_GAS_FALLBACK,
  ROME_MAX_FEE_HEADROOM_NUMERATOR,
  ROME_MAX_FEE_HEADROOM_DENOMINATOR,
} from "../src/index.js";

/** Minimal EIP-1193 mock that records calls and returns per-method responses. */
function mockProvider(handlers: Record<string, (params: unknown[] | undefined) => unknown>) {
  const calls: { method: string; params?: unknown[] }[] = [];
  return {
    calls,
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw new Error(`unhandled ${method}`);
      const r = h(params);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const sentTx = (p: ReturnType<typeof mockProvider>) =>
  (p.calls.find((c) => c.method === "eth_sendTransaction")!.params![0]) as Record<string, string>;

describe("gas padding", () => {
  it("pads by exactly 1.3x (13/10)", () => {
    expect(ROME_GAS_PAD_NUMERATOR).toBe(13n);
    expect(ROME_GAS_PAD_DENOMINATOR).toBe(10n);
    expect(padRomeGas(100n)).toBe(130n);
    expect(padRomeGas(1_000_000n)).toBe(1_300_000n);
    expect(padRomeGas(0n)).toBe(0n);
  });
  it("default fallback ceiling is 250M", () => {
    expect(DEFAULT_ROME_GAS_FALLBACK).toBe(250_000_000n);
  });
  it("romeWriteGas: pads a usable estimate, else uses the ceiling", async () => {
    expect(await romeWriteGas(async () => 100n, 999n)).toBe(130n);
    expect(await romeWriteGas(async () => { throw new Error("revert"); }, 999n)).toBe(999n);
  });
});

describe("buildRome1559Fees", () => {
  it("base>0: maxFee = base*1.1 + tip, maxPriority = tip", () => {
    expect(ROME_MAX_FEE_HEADROOM_NUMERATOR).toBe(11n);
    expect(ROME_MAX_FEE_HEADROOM_DENOMINATOR).toBe(10n);
    expect(buildRome1559Fees({ baseFeePerGas: 100n, suggestedPriorityFee: 10n })).toEqual({
      maxPriorityFeePerGas: 10n,
      maxFeePerGas: 120n, // 100*11/10 + 10
    });
  });
  it("base>0, idle market (tip 0): maxFee = base*1.1, maxPriority = 0", () => {
    expect(buildRome1559Fees({ baseFeePerGas: 200n })).toEqual({
      maxPriorityFeePerGas: 0n,
      maxFeePerGas: 220n,
    });
  });
  it("legacy base=0: both fields fall back to gasPrice", () => {
    expect(buildRome1559Fees({ gasPrice: 42n })).toEqual({
      maxFeePerGas: 42n,
      maxPriorityFeePerGas: 42n,
    });
  });
  it("nothing usable → {} (never submit a 0 fee)", () => {
    expect(buildRome1559Fees({})).toEqual({});
    expect(buildRome1559Fees({ baseFeePerGas: 0n, gasPrice: 0n })).toEqual({});
  });
  it("romeFeeFields delegates to the legacy gasPrice path", () => {
    expect(romeFeeFields(42n)).toEqual({ maxFeePerGas: 42n, maxPriorityFeePerGas: 42n });
    expect(romeFeeFields(undefined)).toEqual({});
  });
});

describe("submitRomeTx", () => {
  const req = { from: "0xfrom", to: "0xto", data: "0xda7a" };

  it("throws when the provider has no request()", async () => {
    await expect(submitRomeTx(null, req)).rejects.toThrow(/provider not available/);
    await expect(submitRomeTx({}, req)).rejects.toThrow(/provider not available/);
  });

  it("happy path: pads the estimate, sets 1559 fees, returns the hash", async () => {
    const p = mockProvider({
      eth_estimateGas: () => "0x64", // 100 -> padded 130 -> 0x82
      eth_getBlockByNumber: () => ({ baseFeePerGas: "0x64" }), // base 100
      eth_maxPriorityFeePerGas: () => "0xa", // tip 10
      eth_gasPrice: () => "0x3b9aca00",
      eth_sendTransaction: () => "0xhash",
    });
    const hash = await submitRomeTx(p, req);
    expect(hash).toBe("0xhash");
    const tx = sentTx(p);
    expect(tx.gas).toBe("0x82"); // 130
    expect(tx.maxFeePerGas).toBe("0x78"); // 100*11/10 + 10 = 120
    expect(tx.maxPriorityFeePerGas).toBe("0xa"); // 10
    expect(tx.from).toBe("0xfrom");
    expect(tx.data).toBe("0xda7a");
  });

  it("estimate reverts → uses fallbackGas (or the 250M default)", async () => {
    const base = {
      eth_getBlockByNumber: () => ({ baseFeePerGas: "0x0" }),
      eth_maxPriorityFeePerGas: () => "0x0",
      eth_gasPrice: () => "0x5",
      eth_sendTransaction: () => "0xhash",
    };
    const withFallback = mockProvider({
      ...base,
      eth_estimateGas: () => new Error("execution reverted"),
    });
    await submitRomeTx(withFallback, { ...req, fallbackGas: 0x1234n });
    expect(sentTx(withFallback).gas).toBe("0x1234");

    const noFallback = mockProvider({ ...base, eth_estimateGas: () => new Error("revert") });
    await submitRomeTx(noFallback, req);
    expect(BigInt(sentTx(noFallback).gas)).toBe(DEFAULT_ROME_GAS_FALLBACK);
  });

  it("minGas floors the final gas (only raises)", async () => {
    const p = mockProvider({
      eth_estimateGas: () => "0x64", // padded 130
      eth_getBlockByNumber: () => ({ baseFeePerGas: "0x0" }),
      eth_maxPriorityFeePerGas: () => "0x0",
      eth_gasPrice: () => "0x5",
      eth_sendTransaction: () => "0xhash",
    });
    await submitRomeTx(p, { ...req, minGas: 1000n });
    expect(BigInt(sentTx(p).gas)).toBe(1000n); // floor raised above padded 130
  });

  it("serializes native value to a hex quantity", async () => {
    const p = mockProvider({
      eth_estimateGas: () => "0x1",
      eth_getBlockByNumber: () => ({ baseFeePerGas: "0x0" }),
      eth_maxPriorityFeePerGas: () => "0x0",
      eth_gasPrice: () => "0x5",
      eth_sendTransaction: () => "0xhash",
    });
    await submitRomeTx(p, { ...req, value: 1000n });
    expect(sentTx(p).value).toBe("0x3e8"); // 1000
  });
});
