/**
 * Rome EVM exposes Solana programs as EVM precompiles at fixed addresses.
 *
 * Addresses are LOWERCASE on purpose: passed mixed-case, viem's EIP-55 checksum
 * rejects them inside `signTransaction` / `writeContract` (observed in production
 * for the Helper precompile). Keep them lowercase everywhere.
 *
 * Source of truth: the canonical Rome precompile interface (`interface.sol`,
 * shipped in this package), mirroring Rome EVM's on-chain dispatch table.
 */
export const PRECOMPILE_ADDRESSES = {
  /** Cached (revertable) system-program ops — PDA create, allocate, assign, lamport transfer. */
  systemCached: "0xff00000000000000000000000000000000000004",
  /** Cached (revertable) SPL Token / Token-2022 transfers, ATA init, account reads. */
  splCached: "0xff00000000000000000000000000000000000005",
  /** Cached (revertable) idempotent ATA-create variants. */
  associatedSplCached: "0xff00000000000000000000000000000000000006",
  /** System Program — PDA derivation, base58, mint/operator/program-id getters. */
  system: "0xff00000000000000000000000000000000000007",
  /** CpiProgram — arbitrary Solana CPI (invoke / invoke_signed) + read shortcuts. */
  cpi: "0xff00000000000000000000000000000000000008",
  /** HelperProgram — SPL / PDA / ATA / lamports / gas-token plumbing, signed by the caller's PDA. */
  helper: "0xff00000000000000000000000000000000000009",
  /** Cached (revertable) counterpart of Withdraw. */
  withdrawCached: "0xff0000000000000000000000000000000000000b",
  /** Withdraw — SOL withdrawal + the two gas-token wrap/unwrap legs. */
  withdraw: "0x4200000000000000000000000000000000000016",
} as const satisfies Record<string, `0x${string}`>;

export type PrecompileName = keyof typeof PRECOMPILE_ADDRESSES;
