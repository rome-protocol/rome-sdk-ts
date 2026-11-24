import { describe, it, expect, vi } from "vitest";
import type { Hex } from "viem";
import {
  SOLGATE_ERROR_CODES,
  SolgateApiError,
  createMessagesClient,
  encodeClaimMessage,
  type MessageProof,
  type SolgateMessage,
} from "../src/messages.js";
import claimFixture from "./fixtures/messages-claim.json" with { type: "json" };

const BASE = "https://solgate.example";
const TX = `0x${"ab".repeat(32)}` as Hex;
const RECEIVER = "0x0000000000000000000000000000000000000011" as Hex;
const ID = "11111111-1111-4111-8111-111111111111";
const WALLET = "11111111111111111111111111111111";

const message = (over: Partial<SolgateMessage> = {}): SolgateMessage => ({
  id: ID, status: "ready_to_claim", needsAttention: false,
  source: { networkId: 7, name: "Rome" }, destination: { networkId: 0, name: "Sepolia" },
  sender: { networkId: 7, address: RECEIVER, solanaWallet: false }, receiver: RECEIVER, value: "0",
  dataHash: `0x${"9".repeat(64)}`, data: "0xdeadbeef", dataTooLarge: false, claimAfter: null,
  sourceTxHash: TX, claimTxHash: null, stages: [], createdAt: "2026-11-22T00:00:00.000Z", updatedAt: "2026-11-22T00:00:00.000Z",
  ...over,
});
const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;
const step = { id: "claim", kind: "evm-tx", chain: "Sepolia", networkId: 0, to: RECEIVER, data: "0x01", value: "0", label: "Claim", oneTime: false, skipIf: null };

function client(answer: (url: string, init?: RequestInit) => Response) {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => answer(String(url), init));
  return { api: createMessagesClient({ base: `${BASE}/`, fetch: fetch as unknown as typeof globalThis.fetch }), fetch };
}

describe("record", () => {
  it("posts networkId and txHash to /v1/messages and answers the message rows", async () => {
    const { api, fetch } = client(() => reply(201, { created: true, messages: [message()] }));
    const out = await api.record({ networkId: 7, txHash: TX });
    expect(out.created).toBe(true);
    expect(out.messages[0]?.id).toBe(ID);
    expect(fetch).toHaveBeenCalledWith(`${BASE}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ networkId: 7, txHash: TX }) });
  });

  it("sends the Solana wallet hint when given, and a repeat answers created: false", async () => {
    const { api, fetch } = client(() => reply(200, { created: false, messages: [message()] }));
    expect((await api.record({ networkId: 7, txHash: TX, solanaWallet: WALLET })).created).toBe(false);
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toEqual({ networkId: 7, txHash: TX, solanaWallet: WALLET });
  });
});

describe("list", () => {
  it("lists by sender, narrowed by receiver, with the page's own filters", async () => {
    const { api, fetch } = client(() => reply(200, { items: [message()], next: null }));
    const page = await api.list({ sender: RECEIVER, receiver: "0x00000000000000000000000000000000000000aa", from: 7, to: 0, status: "claimable", limit: 5 });
    expect(page).toEqual({ items: [message()], next: null });
    const url = new URL(fetch.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe("/v1/messages");
    expect(Object.fromEntries(url.searchParams)).toEqual({ sender: RECEIVER, receiver: "0x00000000000000000000000000000000000000aa", from: "7", to: "0", status: "claimable", limit: "5" });
    expect(fetch.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("lists by wallet and by receiver, and passes the cursor back", async () => {
    const { api, fetch } = client(() => reply(200, { items: [], next: "c2" }));
    expect((await api.list({ wallet: WALLET, cursor: "c1" })).next).toBe("c2");
    expect(new URL(fetch.mock.calls[0]?.[0] as string).search).toBe(`?wallet=${WALLET}&cursor=c1`);
    await api.list({ receiver: RECEIVER });
    expect(new URL(fetch.mock.calls[1]?.[0] as string).search).toBe(`?receiver=${RECEIVER}`);
  });

  it("a feed by since: an ISO time with an offset is URL-encoded (a raw + would read as a space)", async () => {
    const { api, fetch } = client(() => reply(200, { items: [], next: "cursor-1" }));
    await api.list({ since: "2026-11-22T10:00:00+02:00" });
    expect(fetch.mock.calls[0]?.[0]).toBe(`${BASE}/v1/messages?since=2026-11-22T10%3A00%3A00%2B02%3A00`);
  });
});

describe("get, proof and the claim steps", () => {
  it("reads one message, and its proof with the bridge's claimMessage arguments", async () => {
    const proof = claimFixture.proof as unknown as MessageProof;
    const { api, fetch } = client((url) => reply(200, url.endsWith("/proof") ? { bridge: RECEIVER, l1InfoTreeIndex: 4, proof, calldata: claimFixture.calldata } : message()));
    expect((await api.get(ID)).status).toBe("ready_to_claim");
    expect(fetch).toHaveBeenLastCalledWith(`${BASE}/v1/messages/${ID}`, undefined);
    const p = await api.proof(ID);
    expect(fetch).toHaveBeenLastCalledWith(`${BASE}/v1/messages/${ID}/proof`, undefined);
    // the proof is what claimMessage takes: encoding it gives the calldata the API sent
    expect(encodeClaimMessage(p.proof)).toBe(p.calldata);
  });

  it("claimStep reads the step and its cost, and passes a Solana wallet in the query", async () => {
    const { api, fetch } = client(() => reply(200, { steps: [step], cost: { networkId: 0, gas: "446636", gasPrice: "1", fee: "446636" } }));
    const out = await api.claimStep(ID);
    expect(out.steps).toHaveLength(1);
    expect(out.cost?.gas).toBe("446636");
    expect(fetch).toHaveBeenLastCalledWith(`${BASE}/v1/messages/${ID}/claim`, undefined);
    await api.claimStep(ID, { solanaWallet: WALLET });
    expect(fetch).toHaveBeenLastCalledWith(`${BASE}/v1/messages/${ID}/claim?solanaWallet=${WALLET}`, undefined);
  });

  it("an already claimed message answers no steps and the reason", async () => {
    const { api } = client(() => reply(200, { steps: [], message: "Already claimed." }));
    expect(await api.claimStep(ID)).toEqual({ steps: [], message: "Already claimed." });
  });

  it("claimSteps posts the ids (and the wallet) to /v1/messages/claims", async () => {
    const { api, fetch } = client(() => reply(200, { steps: [step], batched: true }));
    expect((await api.claimSteps([ID, "22222222-2222-4222-8222-222222222222"])).batched).toBe(true);
    expect(fetch).toHaveBeenLastCalledWith(`${BASE}/v1/messages/claims`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [ID, "22222222-2222-4222-8222-222222222222"] }) });
    await api.claimSteps([ID], { solanaWallet: WALLET });
    expect(JSON.parse(fetch.mock.calls[1]?.[1]?.body as string)).toEqual({ ids: [ID], solanaWallet: WALLET });
  });
});

describe("sendStep", () => {
  it("posts the send to /v1/messages/send and answers the steps, the origin and the warnings", async () => {
    const { api, fetch } = client(() => reply(200, { steps: [{ ...step, chain: "Rome", networkId: 7 }], origin: RECEIVER, warnings: ["receiver_has_no_code"] }));
    const body = { from: 7, to: 0, receiver: RECEIVER, data: "0xdeadbeef" as Hex, wallet: "0x0000000000000000000000000000000000000022" };
    const out = await api.sendStep(body);
    expect(out.origin).toBe(RECEIVER);
    expect(out.warnings).toEqual(["receiver_has_no_code"]);
    expect(fetch).toHaveBeenCalledWith(`${BASE}/v1/messages/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  });
});

describe("sendStep zero receiver", () => {
  it("refuses a zero receiver, in any case of the digits, before any request is made", async () => {
    const { api, fetch } = client(() => reply(200, { steps: [], origin: RECEIVER, warnings: [] }));
    const base = { from: 7, to: 0, data: "0xdeadbeef" as Hex, wallet: "0x0000000000000000000000000000000000000022" };
    await expect(api.sendStep({ ...base, receiver: `0x${"0".repeat(40)}` as Hex })).rejects.toThrow(/zero address/);
    await expect(api.sendStep({ ...base, receiver: `0X${"0".repeat(40)}` as Hex })).rejects.toThrow(/zero address/);
    expect(fetch).not.toHaveBeenCalled();
    await expect(api.sendStep({ ...base, receiver: `0x${"0".repeat(39)}1` as Hex })).resolves.toBeDefined();
  });
});

describe("errors", () => {
  it("a refusal is a SolgateApiError with the API's status, code, words and extra fields", async () => {
    const { api } = client(() => reply(409, { error: "claim_token_first", message: "Claim the token first.", claimAfter: 12 }));
    const e = await api.claimStep(ID).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(SolgateApiError);
    expect(e).toMatchObject({ name: "SolgateApiError", status: 409, code: "claim_token_first", message: "Claim the token first.", extra: { claimAfter: 12 } });
    const named = await client(() => reply(409, { error: "message_would_fail", message: "Message x: the claim would fail", id: ID, data: "0x08c379a0" })).api.claimSteps([ID]).then(() => null, (x: unknown) => x);
    expect(named).toMatchObject({ code: "message_would_fail", extra: { id: ID, data: "0x08c379a0" } });
  });

  it("every documented code is a known one, and an unknown body still throws with the status", async () => {
    expect(SOLGATE_ERROR_CODES).toContain("proof_not_ready");
    expect(new Set(SOLGATE_ERROR_CODES).size).toBe(SOLGATE_ERROR_CODES.length);
    // the switch off: the server's own 404 body
    expect(await client(() => reply(404, { message: "Route GET:/v1/messages not found", error: "Not Found", statusCode: 404 })).api.list({ wallet: WALLET }).then(() => null, (x: unknown) => x)).toMatchObject({ status: 404, code: "Not Found" });
    const broken = { ok: false, status: 502, json: async () => { throw new Error("not json"); } } as unknown as Response;
    const notJson = { ok: true, status: 200, json: async () => { throw new Error("not json"); } } as unknown as Response;
    expect(await client(() => notJson).api.get(ID).then(() => null, (x: unknown) => x)).toMatchObject({ status: 200, code: "error", message: "The answer was not JSON." });
    expect(await client(() => broken).api.get(ID).then(() => null, (x: unknown) => x)).toMatchObject({ status: 502, code: "error", message: "HTTP 502" });
  });
});

describe("waitReady", () => {
  it("polls until the message is ready to claim, then answers it", async () => {
    const seq = ["sent", "certified", "settled", "ready_to_claim"] as const;
    let i = 0;
    const { api, fetch } = client(() => reply(200, message({ status: seq[Math.min(i++, seq.length - 1)] as SolgateMessage["status"] })));
    const m = await api.waitReady(ID, { intervalMs: 1 });
    expect(m.status).toBe("ready_to_claim");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("answers at once for a message already claimed or received", async () => {
    for (const status of ["claimed", "in_rome_account", "received"] as const) {
      const { api, fetch } = client(() => reply(200, message({ status })));
      expect((await api.waitReady(ID, { intervalMs: 1 })).status).toBe(status);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up after the timeout, and stops when the signal aborts", async () => {
    const { api } = client(() => reply(200, message({ status: "settled" })));
    await expect(api.waitReady(ID, { intervalMs: 5, timeoutMs: 20 })).rejects.toThrow(/not ready to claim in time \(status settled\)/);
    const ac = new AbortController();
    const waiting = api.waitReady(ID, { intervalMs: 10_000, signal: ac.signal });
    setTimeout(() => ac.abort(new Error("stop")), 10);
    await expect(waiting).rejects.toThrow("stop");
  });

  it("retries a rate limit, an unavailable upstream and a network error, then answers", async () => {
    const seq = [
      () => reply(429, { error: "rate_limited", message: "Try again in a minute." }),
      () => reply(503, { error: "upstream_unavailable", message: "Try again shortly." }),
      () => { throw new TypeError("fetch failed"); },
      () => reply(200, message({ status: "ready_to_claim" })),
    ];
    let i = 0;
    const { api, fetch } = client(() => seq[i++]!());
    expect((await api.waitReady(ID, { intervalMs: 1 })).status).toBe("ready_to_claim");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("throws the last retryable error when the deadline passes", async () => {
    const { api } = client(() => reply(429, { error: "rate_limited", message: "Try again in a minute." }));
    await expect(api.waitReady(ID, { intervalMs: 5, timeoutMs: 20 })).rejects.toMatchObject({ status: 429, code: "rate_limited" });
  });

  it("a refusal while polling is thrown, not retried", async () => {
    const { api, fetch } = client(() => reply(404, { error: "not_found", message: "No message has that id." }));
    await expect(api.waitReady(ID, { intervalMs: 1 })).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("the client", () => {
  it("uses the global fetch when none is given, looked up at call time", async () => {
    const f = vi.fn(async () => reply(200, message()));
    vi.stubGlobal("fetch", f);
    try {
      await createMessagesClient({ base: BASE }).get(ID);
      expect(f).toHaveBeenCalledWith(`${BASE}/v1/messages/${ID}`, undefined);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
