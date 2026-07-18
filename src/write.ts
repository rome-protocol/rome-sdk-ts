// submitRomeTx — the canonical Rome EVM write path.
//
// Rome charges the EXACT gas used (it inherits Solana's cost model: compute is
// unmetered, fee is flat per-signature), but two Rome-specific quirks make a
// naive `eth_sendTransaction` fail or render a broken fee. This module handles
// both so every write is consistent — do NOT send Rome writes with raw
// `eth_sendTransaction` / wagmi `writeContract`; route them through here.
//
//   1. `eth_estimateGas` UNDERCOUNTS Solana-CPI cost (SPL transfers, ATA
//      creation, cached-wrapper ops). Submitting at the bare estimate
//      under-gasses the tx → out-of-gas at submit, even though `eth_call` /
//      `eth_estimateGas` pass (neither enforces a limit). We pad the estimate
//      by 1.3x. Plain-ERC20 ops estimate accurately and are unaffected.
//   2. Some CPI-heavy writes REVERT under `eth_estimateGas` (they only succeed
//      inside a real tx). Then the wallet runs its own (same-reverting) estimate
//      and renders "Network fee: Unavailable", blocking the send. We hand the
//      wallet an explicit ceiling instead.
//
// Over-provisioning gas is free on Rome's cost model, so padding + a ceiling
// cost the user nothing.

/** Gas-estimate safety factor (1.3x) covering Rome's SPL-CPI undercount. */
export const ROME_GAS_PAD_NUMERATOR = 13n;
export const ROME_GAS_PAD_DENOMINATOR = 10n;

// Default gas ceiling used when `eth_estimateGas` THROWS and the caller passed
// no explicit `fallbackGas`. Many CPI-heavy writes revert under estimation;
// without a ceiling the wallet estimates the reverting call itself and shows
// "Network fee: Unavailable". 250M covers the heaviest common op with headroom
// and stays below the padded estimate Rome accepts for it. A USABLE estimate
// always wins (padded 1.3x); this applies ONLY on estimate failure.
export const DEFAULT_ROME_GAS_FALLBACK = 250_000_000n;

/**
 * Pad an `eth_estimateGas` result by the Rome safety factor (1.3x) to cover
 * Rome's SPL-CPI undercount. Integer bigint math; truncates the fractional unit.
 */
export function padRomeGas(estimate: bigint): bigint {
  return (estimate * ROME_GAS_PAD_NUMERATOR) / ROME_GAS_PAD_DENOMINATOR;
}

/**
 * Size gas for a Rome write whose `eth_estimateGas` may be UNUSABLE. Most writes
 * estimate fine and just need the {@link padRomeGas} 1.3x bump; a few (e.g. a
 * constructor that CPIs to load an SPL mint) REVERT under estimation, so there's
 * nothing to pad. Prefer the real (padded) estimate when the chain can produce
 * one; fall back to a caller-supplied ceiling when it can't. Over-provisioning
 * is free on Rome's cost model.
 *
 * @param estimate        returns the raw `eth_estimateGas` result (bigint)
 * @param fallbackCeiling explicit gas to use when `estimate` throws
 */
export async function romeWriteGas(
  estimate: () => Promise<bigint>,
  fallbackCeiling: bigint,
): Promise<bigint> {
  try {
    return padRomeGas(await estimate());
  } catch {
    return fallbackCeiling;
  }
}

// maxFee headroom over baseFee (~1.1x). See buildRome1559Fees for why this is
// deliberately small on Rome.
export const ROME_MAX_FEE_HEADROOM_NUMERATOR = 11n;
export const ROME_MAX_FEE_HEADROOM_DENOMINATOR = 10n;

/**
 * Build STANDARD EIP-1559 fee fields for a Rome write from the live 1559
 * context. Rome maps the Solana cu-price market onto the standard fee RPCs:
 * `eth_maxPriorityFeePerGas` (a single suggested tip, 0 on a quiet cluster) and
 * a real, non-zero block `baseFeePerGas`. So the correct construction is the one
 * every wallet uses:
 *
 *     maxPriorityFeePerGas = suggested tip          (0 when the market is idle)
 *     maxFeePerGas         = baseFee * 1.1 + tip    (small headroom for base drift)
 *
 * WHY ~1.1x and not a wallet-style 2x: Rome's baseFee is an oracle-derived
 * near-constant — contention moves the TIP, not base — so 2x base-movement
 * headroom guards against movement that can't happen, and makes wallets flag
 * "site suggested a fee higher than the network estimate". 1.1x only covers
 * oracle ticks between the fee read and inclusion. Display-only either way — the
 * proxy charges baseFee + tip on gasUsed, never maxFee.
 *
 * WHY declare the real tip: setting BOTH fields to `eth_gasPrice` (where
 * gasPrice == baseFee today) declares a `maxPriorityFeePerGas` == baseFee — a
 * real tip the proxy folds into the charge (a measurable overcharge that scales
 * with the tx's Solana CU). Declaring the REAL suggested tip (0 when idle)
 * removes that and still auto-tracks contention.
 *
 * LEGACY fallback: a proxy that still reports `baseFeePerGas == 0` needs the old
 * workaround — a wallet's own 1559 estimate collapses to maxFee = 0 → "Network
 * fee: Unavailable", so both fields fall back to `gasPrice`. Returns `{}` when
 * nothing usable is available so a 0 fee is never submitted.
 */
export function buildRome1559Fees(ctx: {
  baseFeePerGas?: bigint;
  suggestedPriorityFee?: bigint;
  gasPrice?: bigint;
}): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | Record<string, never> {
  const base = ctx.baseFeePerGas ?? 0n;
  const tip = ctx.suggestedPriorityFee ?? 0n;
  if (base > 0n) {
    return {
      maxPriorityFeePerGas: tip,
      maxFeePerGas:
        (base * ROME_MAX_FEE_HEADROOM_NUMERATOR) / ROME_MAX_FEE_HEADROOM_DENOMINATOR + tip,
    };
  }
  const gasPrice = ctx.gasPrice ?? 0n;
  return gasPrice > 0n
    ? { maxFeePerGas: gasPrice, maxPriorityFeePerGas: gasPrice }
    : {};
}

/**
 * Back-compat thin wrapper: standard (EIP-1559) fee fields from a bare
 * `gasPrice`. Prefer {@link buildRome1559Fees} with the full 1559 context (base
 * + suggested tip) so the tip isn't over-declared. Apply ONLY on Rome chains —
 * source chains (e.g. Sepolia) have a healthy baseFee; pass their own price.
 */
export function romeFeeFields(
  gasPrice: bigint | undefined,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | Record<string, never> {
  return buildRome1559Fees({ gasPrice });
}

export interface RomeTxRequest {
  from: string;
  to: string;
  data: string;
  /** Native value in wei; serialized to a hex quantity when present. */
  value?: bigint;
  /**
   * Explicit gas ceiling used ONLY when `eth_estimateGas` throws. Without it, an
   * estimate revert makes submitRomeTx omit `gas`, the wallet runs its own
   * (same-reverting) estimation, and the wallet renders "Network fee:
   * Unavailable" and blocks the tx. A USABLE estimate always wins (padded 1.3x);
   * this is a last resort. When omitted, {@link DEFAULT_ROME_GAS_FALLBACK} is
   * used on estimate failure (never left unset). Pass a value only to override
   * the default (e.g. an op heavier than the default ceiling).
   */
  fallbackGas?: bigint;
  /**
   * Floor applied to the FINAL gas value (padded estimate OR fallback), for
   * writes where Rome's emulator under-estimates so badly that even the 1.3x pad
   * sits below real on-chain cost. The floor only raises, never lowers.
   */
  minGas?: bigint;
}

interface EthRequestProvider {
  request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

/**
 * Submit a Rome write via `eth_sendTransaction`, sizing gas from
 * `eth_estimateGas` padded by {@link padRomeGas} (1.3x), falling back to an
 * explicit ceiling when estimation throws, and supplying standard EIP-1559 fee
 * fields from the live 1559 context. Returns the tx hash.
 *
 * Adopt this for any Rome write instead of calling `eth_sendTransaction` raw.
 * Accepts the wallet's EIP-1193 provider and throws if it has no `request`.
 */
export async function submitRomeTx(
  provider: EthRequestProvider | null | undefined,
  tx: RomeTxRequest,
): Promise<`0x${string}`> {
  if (!provider?.request) {
    throw new Error("EVM wallet provider not available");
  }
  const request = provider.request.bind(provider);
  const base: Record<string, string> = {
    from: tx.from,
    to: tx.to,
    data: tx.data,
    ...(tx.value !== undefined ? { value: `0x${tx.value.toString(16)}` } : {}),
  };
  let gasValue: bigint;
  try {
    const est = (await request({ method: "eth_estimateGas", params: [base] })) as string;
    gasValue = padRomeGas(BigInt(est));
  } catch {
    // Estimation failed — hand the wallet an explicit ceiling so it renders a
    // fee and never runs its own (reverting) estimation. A usable estimate above
    // always wins; this is the last-resort ceiling only.
    gasValue = tx.fallbackGas ?? DEFAULT_ROME_GAS_FALLBACK;
  }
  // Caller-supplied floor for known emulator under-estimates (see minGas).
  if (tx.minGas !== undefined && gasValue < tx.minGas) {
    gasValue = tx.minGas;
  }
  const gas = `0x${gasValue.toString(16)}`;

  // Standard EIP-1559 fee fields from the live 1559 context (non-zero block
  // baseFee + suggested tip). All three reads are best-effort; on a legacy
  // baseFee=0 proxy the builder falls back to gasPrice so the fee still renders.
  const readBigint = async (method: string, params: unknown[] = []) => {
    try {
      const v = (await request({ method, params })) as string;
      return v ? BigInt(v) : undefined;
    } catch {
      return undefined;
    }
  };
  let baseFeePerGas: bigint | undefined;
  try {
    const block = (await request({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    })) as { baseFeePerGas?: string } | null;
    if (block?.baseFeePerGas) baseFeePerGas = BigInt(block.baseFeePerGas);
  } catch {
    // fall through — builder handles undefined baseFee
  }
  const suggestedPriorityFee = await readBigint("eth_maxPriorityFeePerGas");
  const gasPrice = await readBigint("eth_gasPrice");
  const feeFields = buildRome1559Fees({ baseFeePerGas, suggestedPriorityFee, gasPrice });
  const fee =
    "maxFeePerGas" in feeFields
      ? {
          maxFeePerGas: `0x${feeFields.maxFeePerGas.toString(16)}`,
          maxPriorityFeePerGas: `0x${feeFields.maxPriorityFeePerGas.toString(16)}`,
        }
      : undefined;

  return (await request({
    method: "eth_sendTransaction",
    params: [{ ...base, gas, ...(fee !== undefined ? fee : {}) }],
  })) as `0x${string}`;
}
