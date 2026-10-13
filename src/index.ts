/**
 * @rome-protocol/sdk — TypeScript SDK for building on Rome (EVM chains that run
 * on Solana).
 *
 * - `write` — `submitRomeTx`, the canonical Rome EVM write wrapper, + fee/gas sizing.
 * - `pda`   — external-authority PDA + ATA derivation.
 * - `cpi`   — invoke / invoke_signed calldata encoders for the CPI precompile.
 * - precompile bindings — addresses, ABIs, verified selectors, and constants for
 *   the Rome precompiles (CPI 0xFF..08, Helper 0xFF..09, Withdraw 0x42..16, …).
 *
 * - `solana` — the SOLANA LANE: `submitRomeTxSolanaLane`, the mirror of
 *   `submitRomeTx` — a Solana wallet drives an EVM contract on Rome (synthetic
 *   address + `DoTxUnsigned`), with account discovery, ComputeBudget, and the
 *   treasure wallet handled for you.
 *
 * - `solanaV1` — the v1 SOLANA LANE: `submitRomeTxV1`, one proxy-composed Solana v1
 *   transaction signed twice by the wallet (authorization + transaction), with relay
 *   on refusal and `fundSyntheticGas`. `solana` stays as the legacy-transaction path.
 *
 * The bridge client is a separate entry point: `@rome-protocol/sdk/bridge`.
 * Solidity interfaces live in the public `rome-solidity` repo.
 */
export * from "./write.js";
export * from "./pda.js";
export * from "./cpi.js";
export * from "./addresses.js";
export * from "./abis.js";
export * from "./selectors.js";
export * from "./constants.js";
export * from "./solana.js";
export * from "./solanaV1.js";
export * from "./v1Message.js";
