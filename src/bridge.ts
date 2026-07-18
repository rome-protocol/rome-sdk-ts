// Typed client + pure flow logic for the Rome bridge API (`/v1`) — the
// off-chain orchestrator + fee-sponsor for cross-chain transfers (CORS *, no
// key; it holds no funds).
//
// The load-bearing contract (equality-only verification): clients sign the
// QUOTE'S `unsignedTxs` VERBATIM — never locally-built calldata — and submit the
// quote object back UNMODIFIED. For the trustless gas settle the wallet signs a
// filled COPY of the quote's EIP-712 SettleAuthorization (sourceTxHash = the
// burn tx); the API overlays the hash itself at verify time, so the quote stays
// pristine. `domain.chainId` stays NUMERIC over JSON — a string yields a
// different domain separator and a signer mismatch on-chain.
//
// Pass your bridge API endpoint per call via `opts.base`.

export interface BridgeApiOpts {
  /** Bridge API base URL, e.g. "https://bridge-api.example". Required. */
  base: string;
}

// ── Wire types (mirror the bridge API's /v1 routes) ──────────────────────────

export interface QuoteRequest {
  asset: "USDC" | "ETH" | "SOL" | "SPL" | "TOKEN";
  splAsset?: { mint: string; decimals: number; symbol?: string; wrapper?: string };
  direction: "to-rome" | "from-rome";
  /** Legacy symbolic rail ("ethereum") or CAIP-2 ("eip155:11155111"). */
  sourceChain: string;
  sourceChainId?: number;
  destinationChainId?: number;
  speed?: "standard" | "fast";
  simulate?: boolean;
  deadlineSec?: number;
  romeChainId: string;
  intent?: "gas" | "wrapper";
  /** Base units, decimal string. */
  amount: string;
  sender: { ethereum?: string; solana?: string; rome?: string };
  recipient: string;
}

export interface UnsignedTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: string;
  estimatedGas?: string;
  description?: string;
  simulation?: { ok: boolean; revertReason?: string };
}

export interface QuoteStep {
  n: number;
  chain: string;
  kind: string;
  /** Present on user-signed steps — sign these VERBATIM. */
  unsignedTxs?: UnsignedTx[];
  unsignedTx?: null;
  blockedBy?: string[];
  userSigns?: boolean;
  sponsor?: "user" | "rome" | "partner";
  chainRef?: string;
  chainName?: string;
  recipientAta?: string;
  recipientPdaOwner?: string;
  /** Settle step only: the Rome recipient the authorization must recover to. */
  user?: string;
}

export interface SettleTypedData {
  domain: { name: string; version: string; chainId: number; [k: string]: unknown };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, string>;
}

export interface SettleSignatureRequest {
  kind: "settle-authorization-eip712";
  /** Which message field the client fills from the burn tx hash. */
  fillFromBurn: "sourceTxHash";
  typedData: SettleTypedData;
}

export interface Quote {
  route: string;
  direction: "to-rome" | "from-rome";
  amountIn: string;
  amountOut: string;
  fee?: { bps: number; absolute: string; asset: string };
  etaSeconds?: number;
  steps: QuoteStep[];
  signatureRequests?: SettleSignatureRequest[];
  outputs?: Array<{ kind: string; chainId?: string }>;
  cctpVersion?: number;
  sourceChainId?: number;
  sourceChainRef?: string;
  [k: string]: unknown;
}

export type TransferStepStatus = "blocked" | "ready" | "submitted" | "confirmed" | "failed";

export interface TransferStep extends Omit<QuoteStep, "unsignedTxs" | "unsignedTx"> {
  status: TransferStepStatus;
  txHashes?: string[];
  skipped?: boolean;
  attestation?: unknown;
  vaa?: unknown;
  confirmedAt?: string;
}

export interface TransferRecord {
  id: string;
  route: string;
  direction: "to-rome" | "from-rome";
  amountIn: string;
  amountOut: string;
  sender: { ethereum?: string; solana?: string; rome?: string };
  recipient: string;
  steps: TransferStep[];
  outcome: "pending" | "complete" | "failed";
  degradation?: string;
  degradationReason?: string;
  settleAuthorized?: boolean;
  [k: string]: unknown;
}

// ── Errors ───────────────────────────────────────────────────────────────────

/** Bridge API errors are problem+json: {code, title, status, detail}. */
export class BridgeApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: string;
  constructor(p: { code: string; status: number; title?: string; detail?: string }) {
    super(p.detail ?? p.title ?? p.code);
    this.name = "BridgeApiError";
    this.code = p.code;
    this.status = p.status;
    if (p.detail !== undefined) this.detail = p.detail;
  }
}

async function request<T>(path: string, opts: BridgeApiOpts, init?: RequestInit): Promise<T> {
  const res = await fetch(`${opts.base}${path}`, { cache: "no-store", ...init });
  if (res.ok) return (await res.json()) as T;
  let problem: { code?: string; title?: string; detail?: string } | null = null;
  try {
    problem = await res.json();
  } catch {
    /* non-JSON failure body (gateway/proxy) — fall through to the generic code */
  }
  throw new BridgeApiError({
    code: typeof problem?.code === "string" ? problem.code : "rome.bridge.http-error",
    status: res.status,
    ...(problem?.title !== undefined ? { title: problem.title } : {}),
    ...(problem?.detail !== undefined ? { detail: problem.detail } : {}),
  });
}

function postJson<T>(path: string, body: unknown, opts: BridgeApiOpts): Promise<T> {
  return request<T>(path, opts, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── The four /v1 calls ───────────────────────────────────────────────────────

export function requestQuote(req: QuoteRequest, opts: BridgeApiOpts): Promise<Quote> {
  return postJson<Quote>("/v1/quote", req, opts);
}

/**
 * Register the transfer AFTER the source tx is broadcast. `quote` must be the
 * object `/v1/quote` returned, verbatim; `userSettleSig` only on gas-intent CCTP
 * inbound (absent = wormhole / wrapper / outbound).
 */
export function registerTransfer(
  p: { quote: Quote; step1TxHash: string; userSettleSig?: string },
  opts: BridgeApiOpts,
): Promise<TransferRecord> {
  return postJson<TransferRecord>(
    "/v1/transfers",
    {
      quote: p.quote,
      step1TxHash: p.step1TxHash,
      ...(p.userSettleSig !== undefined ? { userSettleSig: p.userSettleSig } : {}),
    },
    opts,
  );
}

export function getTransfer(id: string, opts: BridgeApiOpts): Promise<TransferRecord> {
  return request<TransferRecord>(`/v1/transfers/${encodeURIComponent(id)}`, opts);
}

/** Report a user-executed step tx (e.g. the outbound destination claim). */
export function reportStep(id: string, n: number, txHash: string, opts: BridgeApiOpts): Promise<TransferRecord> {
  return postJson<TransferRecord>(`/v1/transfers/${encodeURIComponent(id)}/steps/${n}`, { txHash }, opts);
}

/**
 * The typed-data the wallet signs for the trustless gas settle: the quote's
 * SettleAuthorization with the burn tx hash filled into `message.sourceTxHash`.
 * Returns a COPY — the quote object stays pristine for registerTransfer. Null
 * when the quote carries no settle authorization (wormhole inbound, wrapper
 * intent, outbound).
 */
export function settleTypedDataWithBurn(quote: Quote, burnTxHash: string): SettleTypedData | null {
  const req = quote.signatureRequests?.[0];
  if (!req?.typedData) return null;
  const fillField = req.fillFromBurn ?? "sourceTxHash";
  return {
    ...req.typedData,
    message: { ...req.typedData.message, [fillField]: burnTxHash },
  };
}

// ── Pure flow logic (no wallet, no framework) ────────────────────────────────

export class BridgeFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeFlowError";
  }
}

export function inboundCctpQuoteRequest(p: {
  sourceChainId: number;
  romeChainId: number | string;
  amount: bigint;
  evmAddress: string;
  speed?: "standard" | "fast";
}): QuoteRequest {
  return {
    asset: "USDC",
    direction: "to-rome",
    sourceChain: "ethereum",
    sourceChainId: p.sourceChainId,
    romeChainId: String(p.romeChainId),
    intent: "gas",
    ...(p.speed !== undefined ? { speed: p.speed } : {}),
    amount: p.amount.toString(),
    sender: { ethereum: p.evmAddress },
    recipient: p.evmAddress,
  };
}

export function inboundWhQuoteRequest(p: {
  sourceChainId: number;
  romeChainId: number | string;
  amount: bigint;
  evmAddress: string;
}): QuoteRequest {
  return {
    asset: "ETH",
    direction: "to-rome",
    sourceChain: "ethereum",
    sourceChainId: p.sourceChainId,
    romeChainId: String(p.romeChainId),
    amount: p.amount.toString(),
    sender: { ethereum: p.evmAddress },
    recipient: p.evmAddress,
  };
}

export function outboundCctpQuoteRequest(p: {
  destinationChainId: number;
  romeChainId: number | string;
  amount: bigint;
  evmAddress: string;
  recipient: string;
}): QuoteRequest {
  return {
    asset: "USDC",
    direction: "from-rome",
    sourceChain: "ethereum",
    destinationChainId: p.destinationChainId,
    romeChainId: String(p.romeChainId),
    amount: p.amount.toString(),
    sender: { rome: p.evmAddress },
    recipient: p.recipient,
  };
}

export function outboundWhQuoteRequest(p: {
  romeChainId: number | string;
  amount: bigint;
  evmAddress: string;
  recipient: string;
}): QuoteRequest {
  return {
    asset: "ETH",
    direction: "from-rome",
    sourceChain: "ethereum",
    romeChainId: String(p.romeChainId),
    amount: p.amount.toString(),
    sender: { rome: p.evmAddress },
    recipient: p.recipient,
  };
}

export interface UserSignedTx {
  stepN: number;
  tx: UnsignedTx;
}

/**
 * The txs the USER signs, verbatim from the quote, ordered by step. Sponsor
 * steps (no `unsignedTxs`) are skipped. Route is asserted so a surprising quote
 * can never put the wallet on the wrong flow.
 */
export function userSignedTxs(quote: Quote, expectedRoute: string): UserSignedTx[] {
  if (quote.route !== expectedRoute) {
    throw new BridgeFlowError(`quote route ${quote.route} != expected ${expectedRoute}`);
  }
  const out: UserSignedTx[] = [];
  for (const step of [...quote.steps].sort((a, b) => a.n - b.n)) {
    if (!step.unsignedTxs?.length) continue;
    for (const tx of step.unsignedTxs) out.push({ stepN: step.n, tx });
  }
  if (out.length === 0) {
    throw new BridgeFlowError(`quote for ${expectedRoute} carries no user-signed txs`);
  }
  return out;
}

/**
 * Index (into userSignedTxs' result) of the tx whose hash is `step1TxHash` at
 * registration: the LAST tx of the FIRST step (e.g. CCTP-in [approve,
 * depositForBurn] → the burn). The API verifies `step1TxHash` against the last
 * unsignedTx of the quote's first step.
 */
export function step1BindingTxIndex(items: UserSignedTx[]): number {
  const firstStep = items[0]!.stepN;
  let idx = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i]!.stepN === firstStep) idx = i;
  }
  return idx;
}

export interface FlowStatus {
  /** registered | awaiting-attestation | awaiting-vaa | submitting | complete | failed */
  phase: string;
  /** only on `complete`: all-gas | wrapper-only | settle-skipped */
  outcome?: string;
}

/** Map a TransferRecord to a coarse phase/outcome for status display. */
export function transferFlowStatus(record: TransferRecord): FlowStatus {
  const steps = record.steps ?? [];
  if (record.outcome === "failed" || steps.some((s) => s.status === "failed")) {
    return { phase: "failed" };
  }
  if (record.outcome === "complete") {
    if (record.degradation === "settle-skipped") return { phase: "complete", outcome: "settle-skipped" };
    const settle = steps.find((s) => s.kind === "settle-inbound-bridge-sponsored");
    if (settle && settle.status === "confirmed" && !settle.skipped) return { phase: "complete", outcome: "all-gas" };
    return { phase: "complete", outcome: "wrapper-only" };
  }
  if (steps.some((s) => s.status === "ready" || (s.status === "submitted" && s.n !== 1))) {
    return { phase: "submitting" };
  }
  const blockers = steps.filter((s) => s.status === "blocked").flatMap((s) => s.blockedBy ?? []);
  if (blockers.includes("circle-attestation")) return { phase: "awaiting-attestation" };
  if (blockers.includes("wormhole-vaa")) return { phase: "awaiting-vaa" };
  return { phase: "registered" };
}
