import { describe, it, expect, vi, afterEach } from "vitest";
import {
  requestQuote,
  BridgeApiError,
  BridgeFlowError,
  settleTypedDataWithBurn,
  userSignedTxs,
  step1BindingTxIndex,
  transferFlowStatus,
  inboundCctpQuoteRequest,
  outboundWhQuoteRequest,
  type Quote,
  type TransferRecord,
} from "../src/bridge.js";

const OPTS = { base: "https://bridge.example" };
afterEach(() => vi.unstubAllGlobals());

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("bridge client (fetch)", () => {
  it("requestQuote posts to <base>/v1/quote and returns the quote", async () => {
    const fetchFn = mockFetch(200, { route: "cctp-in", direction: "to-rome" });
    const q = await requestQuote(
      inboundCctpQuoteRequest({ sourceChainId: 11155111, romeChainId: 200010, amount: 1000n, evmAddress: "0xabc" }),
      OPTS,
    );
    expect(q.route).toBe("cctp-in");
    expect(fetchFn).toHaveBeenCalledWith("https://bridge.example/v1/quote", expect.objectContaining({ method: "POST" }));
  });
  it("throws BridgeApiError on a problem+json error", async () => {
    mockFetch(422, { code: "rome.bridge.bad-amount", title: "bad", detail: "too small" });
    await expect(requestQuote({} as never, OPTS)).rejects.toMatchObject({
      name: "BridgeApiError",
      code: "rome.bridge.bad-amount",
      status: 422,
    });
  });
});

describe("quote builders", () => {
  it("inbound CCTP: USDC, to-rome, gas intent, sender/recipient = evm addr", () => {
    expect(inboundCctpQuoteRequest({ sourceChainId: 11155111, romeChainId: 200010, amount: 1000n, evmAddress: "0xabc" })).toMatchObject({
      asset: "USDC",
      direction: "to-rome",
      intent: "gas",
      amount: "1000",
      sender: { ethereum: "0xabc" },
      recipient: "0xabc",
      romeChainId: "200010",
    });
  });
  it("outbound WH: ETH, from-rome, sender.rome, explicit recipient", () => {
    expect(outboundWhQuoteRequest({ romeChainId: 200010, amount: 5n, evmAddress: "0xme", recipient: "0xdest" })).toMatchObject({
      asset: "ETH",
      direction: "from-rome",
      sender: { rome: "0xme" },
      recipient: "0xdest",
    });
  });
});

describe("settleTypedDataWithBurn", () => {
  const quote = {
    signatureRequests: [
      {
        kind: "settle-authorization-eip712",
        fillFromBurn: "sourceTxHash",
        typedData: {
          domain: { name: "x", version: "1", chainId: 200010 },
          types: {},
          primaryType: "S",
          message: { user: "0x1", sourceTxHash: "" },
        },
      },
    ],
  } as unknown as Quote;

  it("fills sourceTxHash into a COPY, leaving the quote pristine; chainId stays numeric", () => {
    const td = settleTypedDataWithBurn(quote, "0xburn")!;
    expect(td.message.sourceTxHash).toBe("0xburn");
    expect(quote.signatureRequests![0]!.typedData.message.sourceTxHash).toBe(""); // pristine
    expect(td.domain.chainId).toBe(200010);
    expect(typeof td.domain.chainId).toBe("number");
  });
  it("returns null when the quote carries no settle authorization", () => {
    expect(settleTypedDataWithBurn({} as Quote, "0xburn")).toBeNull();
  });
});

describe("userSignedTxs + step1BindingTxIndex", () => {
  const quote = {
    route: "cctp-in",
    steps: [
      { n: 2, chain: "rome", kind: "settle" }, // sponsor step, no unsignedTxs
      { n: 1, chain: "eth", kind: "burn", unsignedTxs: [{ to: "0xa", data: "0x1" }, { to: "0xb", data: "0x2" }] },
    ],
  } as unknown as Quote;

  it("extracts user-signed txs verbatim, ordered by step; asserts route", () => {
    const items = userSignedTxs(quote, "cctp-in");
    expect(items.map((i) => i.stepN)).toEqual([1, 1]);
    expect(items[1]!.tx.data).toBe("0x2");
    expect(() => userSignedTxs(quote, "wrong")).toThrow(BridgeFlowError);
  });
  it("step1 binding tx = the LAST tx of the first step", () => {
    expect(step1BindingTxIndex(userSignedTxs(quote, "cctp-in"))).toBe(1);
  });
  it("throws when the quote carries no user-signed txs", () => {
    const sponsorOnly = { route: "x", steps: [{ n: 1, chain: "r", kind: "sponsor" }] } as unknown as Quote;
    expect(() => userSignedTxs(sponsorOnly, "x")).toThrow(/no user-signed/);
  });
});

describe("transferFlowStatus", () => {
  const rec = (over: Partial<TransferRecord>): TransferRecord => ({
    id: "t", route: "r", direction: "to-rome", amountIn: "1", amountOut: "1",
    sender: {}, recipient: "0x", steps: [], outcome: "pending", ...over,
  });
  it("failed", () => expect(transferFlowStatus(rec({ outcome: "failed" })).phase).toBe("failed"));
  it("complete all-gas when the sponsored settle confirmed", () => {
    expect(
      transferFlowStatus(rec({ outcome: "complete", steps: [{ n: 3, chain: "rome", kind: "settle-inbound-bridge-sponsored", status: "confirmed" }] })),
    ).toEqual({ phase: "complete", outcome: "all-gas" });
  });
  it("complete wrapper-only when there's no confirmed settle", () => {
    expect(transferFlowStatus(rec({ outcome: "complete", steps: [] }))).toEqual({ phase: "complete", outcome: "wrapper-only" });
  });
  it("awaiting-attestation / awaiting-vaa from blockers", () => {
    expect(transferFlowStatus(rec({ steps: [{ n: 2, chain: "r", kind: "k", status: "blocked", blockedBy: ["circle-attestation"] }] })).phase).toBe("awaiting-attestation");
    expect(transferFlowStatus(rec({ steps: [{ n: 2, chain: "r", kind: "k", status: "blocked", blockedBy: ["wormhole-vaa"] }] })).phase).toBe("awaiting-vaa");
  });
  it("registered when nothing else matches", () => expect(transferFlowStatus(rec({})).phase).toBe("registered"));
});
