// AggLayer messages — the API half: a client for Solgate's `/v1/messages` routes (record a sent message, list or follow messages,
// read a message's proof, get the step that claims it, claim several together, build a send). Re-exported by `@rome-protocol/sdk/messages`.
//
// The wire types follow Solgate's OpenAPI file for these routes (served by the Solgate app at `/v1/messages/openapi.yaml` where
// messages are on; it answers 404 where they are off).
// Nothing here signs or sends: the API hands out steps (transactions to sign) and the caller's wallet sends them, with the
// helpers of the on-chain half (`sendMessageFromEvm`, `claimMessageFromEvm`, the Solana-wallet variants).
//
// With the messages switch off on a network, every one of these routes answers 404 (the server's own "not found" body, not a Solgate code).
import type { Hex } from "viem";
import type { MessageProof } from "./messages.js";

/** Where a message is on its way. `ready_to_claim` is when anyone may claim it. */
export type SolgateMessageStatus = "sent" | "certified" | "settled" | "ready_to_claim" | "claimed" | "in_rome_account" | "received";

/** The error codes the messages routes answer with (`error` in the body). */
export const SOLGATE_ERROR_CODES = [
  "bad_request", "bad_wallet", "bad_tx", "bad_network", "evm_wallet_needed", "value_not_whole_units", "value_needs_evm_wallet",
  "value_not_supported", "message_too_large_for_solana_wallet", "bad_receiver", "outbound_disabled", "inbound_disabled",
  "not_found", "tx_not_found", "not_claimable", "already_claimed", "claim_token_first", "receiver_has_no_code",
  "message_would_fail", "bridge_paused", "proof_not_ready", "not_available", "send_would_fail", "rate_limited", "upstream_unavailable",
] as const;
export type SolgateErrorCode = (typeof SOLGATE_ERROR_CODES)[number];

/**
 * The API's refusal: the HTTP `status`, its `code` (one of {@link SOLGATE_ERROR_CODES} for a Solgate refusal; another text for an answer from
 * something in front of it, or `"error"` when the body was not JSON), its plain `message`, and every other field it sent (`id` of the message
 * a multi-claim refusal is about, `claimAfter` with `claim_token_first`, the revert `data` with `message_would_fail`) as `extra`.
 */
export class SolgateApiError extends Error {
  constructor(readonly status: number, readonly code: SolgateErrorCode | (string & {}), message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "SolgateApiError";
  }
}

export interface SolgateNetwork {
  networkId: number;
  name: string;
}

export interface SolgateStage {
  status: SolgateMessageStatus;
  txHash: string | null;
  at: string;
  explorerUrl: string | null;
}

/** A message row. `sender` is the origin the receiver sees; `value` and `dataHash` are the leaf's; `data` is the message as 0x hex (null until the source's bridge service has it, and in a list also when it is larger than 8,192 bytes: see `dataTooLarge`). */
export interface SolgateMessage {
  id: string;
  status: SolgateMessageStatus;
  needsAttention: boolean;
  source: SolgateNetwork;
  destination: SolgateNetwork;
  sender: { networkId: number; address: string; solanaWallet: boolean };
  receiver: string;
  /** The coin the message carries, in wei, as text. */
  value: string;
  dataHash: string;
  data: string | null;
  dataTooLarge: boolean;
  /** The deposit count of the token sent in the same transaction to the same network, which is claimed first. */
  claimAfter: number | null;
  sourceTxHash: string;
  claimTxHash: string | null;
  stages: SolgateStage[];
  createdAt: string;
  updatedAt: string;
}

/** One transaction to sign. An `evm-tx` is sent to `to` on `networkId` with `data` and `value`; a `rome-call-from-solana` is the same call, signed by a Solana wallet on a Rome chain. */
export interface SolgateStep {
  id: string;
  kind: "evm-tx" | "rome-call-from-solana";
  chain: string;
  networkId: number;
  to: string;
  data: string;
  /** Wei of the chain's coin, as text. */
  value: string;
  label: string;
  oneTime: boolean;
  /** A read that proves the step is already done, when there is one. */
  skipIf: Record<string, unknown> | null;
  relayOnRefusal?: false;
}

/** The estimate of a step at the chain's gas price now. `usdc` is present only on a Rome chain. */
export interface SolgateCost {
  networkId: number;
  gas: string;
  gasPrice: string;
  fee: string;
  usdc?: string;
}

export interface RecordMessagesAnswer {
  /** False when the transaction was recorded before. */
  created: boolean;
  messages: SolgateMessage[];
}

/** A page of a list, or one answer of a feed. `next` is null on the last page of a list; on a feed it is always the cursor to poll with. */
export interface SolgateMessagePage {
  items: SolgateMessage[];
  next: string | null;
}

export interface SolgateMessageProof {
  /** The destination network's bridge. */
  bridge: Hex;
  l1InfoTreeIndex: number;
  /** The arguments of the bridge's `claimMessage`, under the names of its ABI: hand it to `encodeClaimMessage`, `claimMessageFromEvm` or `claimMessageFromSolanaWallet`. */
  proof: MessageProof;
  /** `claimMessage` with these arguments. */
  calldata: Hex;
}

export interface ClaimStepAnswer {
  /** One step, or none when the message is already claimed (`message` says so). */
  steps: SolgateStep[];
  cost?: SolgateCost;
  message?: string;
}

export interface ClaimStepsAnswer {
  steps: SolgateStep[];
  /** True when `steps` is one Multicall3 transaction for all the messages. */
  batched: boolean;
  /** Why there is no batch, when there is none. */
  reason?: string;
  cost?: SolgateCost;
}

export interface SendStepAnswer {
  steps: SolgateStep[];
  /** The address the receiver on the destination sees as the sender. */
  origin: string;
  cost?: SolgateCost;
  /** `receiver_has_no_code`: the receiver has no code on the destination (a warning, never a refusal). */
  warnings?: "receiver_has_no_code"[];
}

export interface RecordMessagesRequest {
  /** The network the transaction was sent on. */
  networkId: number;
  txHash: Hex;
  /** A Solana public key: a hint that the sender is that wallet. It counts only when the wallet's Rome address is the receipt's sender. */
  solanaWallet?: string;
}

/**
 * Give one of `wallet`, `sender`, `receiver` or `since`.
 * `wallet`: the rows the wallet acts on (a send out of Rome is the wallet that sent it; a message into Rome belongs to its receiver) and the rows addressed to it. It does NOT find a message sent into Rome by its sender: use `sender` for that.
 * `sender`: the origin address, the caller of `bridgeMessage` on the source network, in both directions; `receiver` may narrow it. `receiver`: the contract the message goes to.
 * An address is a 0x address or a Solana public key (its Rome address is what the rows hold). `wallet` is not given together with `sender` or `receiver`.
 * `since` (a feed, oldest first, for a poller): the `next` of an earlier feed answer, or an ISO time (URL-encoding is done here); `cursor` and `wallet` are not used with it (the server refuses them).
 */
export interface ListMessagesQuery {
  wallet?: string;
  sender?: string;
  receiver?: string;
  since?: string;
  /** The source network id. */
  from?: number;
  /** The destination network id. */
  to?: number;
  /** `claimable` is `ready_to_claim`, leaving out a row whose claim the chain already records. */
  status?: SolgateMessageStatus | "claimable";
  /** 1 to 50, default 20. */
  limit?: number;
  /** The `next` of the page before (a list, not a feed). */
  cursor?: string;
}

export interface SendStepRequest {
  /** The source network id. */
  from: number;
  /** The destination network id. One of the two is the Rome chain. */
  to: number;
  /** The contract on the destination whose `onMessageReceived` runs. */
  receiver: Hex;
  /** The message as 0x hex, at most 8,192 bytes. */
  data: Hex;
  /** Wei as text. Out of Rome it goes only as the bridge's WETH, in whole multiples of 1e9 wei. Default "0". */
  value?: string;
  /** Default true. */
  forceUpdateGlobalExitRoot?: boolean;
  /** The sending wallet: a 0x address, or a Solana public key (only for a send out of Rome). */
  wallet: string;
}

export interface SolgateMessagesOptions {
  /** The Solgate API's base URL, for one network. */
  base: string;
  /** The `fetch` to use; default the global one. */
  fetch?: typeof fetch;
}

export interface WaitReadyOptions {
  /** Default 5,000. */
  intervalMs?: number;
  /** Give up after this long; default 30 minutes (a message from an L2 can take more than an hour: set it for the route). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SolgateMessagesClient {
  /** Tell the API about a transaction you have mined, so it tracks its messages. Posting the same transaction again answers with `created: false`. */
  record(req: RecordMessagesRequest): Promise<RecordMessagesAnswer>;
  /** List messages by `wallet`, `sender` or `receiver`, or follow them with `since`. */
  list(query: ListMessagesQuery): Promise<SolgateMessagePage>;
  /** One message, its data in full. */
  get(id: string): Promise<SolgateMessage>;
  /** The raw proof of the message's claim. 409 `proof_not_ready` until the source network's bridge service can prove the deposit. */
  proof(id: string): Promise<SolgateMessageProof>;
  /**
   * The step that claims a message, checked and simulated first, with its cost. A refusal (`not_claimable`, `claim_token_first`, `receiver_has_no_code`, `message_would_fail`, ...) is a {@link SolgateApiError}.
   * With `solanaWallet` and a destination that is a Rome chain, the step is a `rome-call-from-solana`; anyone may claim, so the wallet need not be the receiver.
   */
  claimStep(id: string, opts?: { solanaWallet?: string }): Promise<ClaimStepAnswer>;
  /** The claim steps of up to 10 messages that go to one network: one Multicall3 transaction where the destination has it (`batched: true`), otherwise one step each in order. */
  claimSteps(ids: readonly string[], opts?: { solanaWallet?: string }): Promise<ClaimStepsAnswer>;
  /** The steps that send a message (an `evm-tx` to the source bridge, or a `rome-call-from-solana`), with any one-time grant first. Record the sent transaction afterwards with `record`. Refuses a zero `receiver` before any request is made. */
  sendStep(req: SendStepRequest): Promise<SendStepAnswer>;
  /**
   * Poll `get` until the message is `ready_to_claim` and answer it; one already `claimed`, `in_rome_account` or `received` is answered at once.
   * A `rate_limited` (429) or `upstream_unavailable` (503) answer, or a network error, is retried with a growing wait (up to 60 s) until the deadline;
   * then the last such error is thrown. Any other refusal is thrown at once. Throws when `timeoutMs` passes or `signal` aborts.
   */
  waitReady(id: string, opts?: WaitReadyOptions): Promise<SolgateMessage>;
}

const DONE: readonly SolgateMessageStatus[] = ["ready_to_claim", "claimed", "in_rome_account", "received"];

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal?.reason ?? new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A busy or briefly unavailable API, or a network error: worth another try. A definitive refusal is not. */
function isRetryable(e: unknown): boolean {
  if (e instanceof SolgateApiError) return e.status === 429 || e.status === 503;
  return e instanceof TypeError;
}

/** A client for one network's Solgate messages API. */
export function createMessagesClient(opts: SolgateMessagesOptions): SolgateMessagesClient {
  let base = opts.base;
  while (base.endsWith("/")) base = base.slice(0, -1);

  async function call<T>(path: string, init?: { method: "POST"; body: unknown }): Promise<T> {
    const f = opts.fetch ?? globalThis.fetch;
    const res = await f(`${base}${path}`, init ? { method: init.method, headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) } : undefined);
    const parsed = await res.json().then((b: unknown) => ({ ok: true as const, b }), () => ({ ok: false as const, b: undefined }));
    const body = (parsed.ok && typeof parsed.b === "object" && parsed.b !== null ? parsed.b : {}) as Record<string, unknown>;
    if (res.ok && !parsed.ok) throw new SolgateApiError(res.status, "error", "The answer was not JSON.", {});
    if (!res.ok) {
      const { error, message, ...extra } = body;
      throw new SolgateApiError(res.status, typeof error === "string" ? error : "error", typeof message === "string" ? message : `HTTP ${res.status}`, extra);
    }
    return body as T;
  }

  const enc = encodeURIComponent;
  const withWallet = (path: string, solanaWallet?: string) => (solanaWallet === undefined ? path : `${path}?solanaWallet=${enc(solanaWallet)}`);

  const client: SolgateMessagesClient = {
    record: (req) => call("/v1/messages", { method: "POST", body: req }),
    list(query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
      return call(`/v1/messages?${q.toString()}`);
    },
    get: (id) => call(`/v1/messages/${enc(id)}`),
    proof: (id) => call(`/v1/messages/${enc(id)}/proof`),
    claimStep: (id, o = {}) => call(withWallet(`/v1/messages/${enc(id)}/claim`, o.solanaWallet)),
    claimSteps: (ids, o = {}) => call("/v1/messages/claims", { method: "POST", body: { ids, ...(o.solanaWallet !== undefined && { solanaWallet: o.solanaWallet }) } }),
    async sendStep(req) {
      if (/^0x0{40}$/i.test(req.receiver)) throw new Error("receiver is the zero address: a message sent there is lost, so no send is built");
      return call("/v1/messages/send", { method: "POST", body: req });
    },
    async waitReady(id, o = {}) {
      const interval = o.intervalMs ?? 5_000;
      const deadline = Date.now() + (o.timeoutMs ?? 30 * 60_000);
      let failures = 0;
      for (;;) {
        let wait = interval;
        try {
          const m = await client.get(id);
          failures = 0;
          if (DONE.includes(m.status)) return m;
          if (Date.now() + interval > deadline) throw new Error(`message ${id} was not ready to claim in time (status ${m.status})`);
        } catch (e) {
          if (!isRetryable(e)) throw e;
          failures += 1;
          wait = Math.min(interval * 2 ** failures, Math.max(interval, 60_000));
          if (Date.now() + wait > deadline) throw e;
        }
        await sleep(wait, o.signal);
      }
    },
  };
  return client;
}
