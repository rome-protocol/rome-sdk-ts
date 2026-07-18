/**
 * Seed for a user's external-authority PDA:
 *   find_program_address(["EXTERNAL_AUTHORITY", evmAddress20bytes], romeEvmProgramId)
 * The precompiles sign as this PDA when `msg.sender == evmAddress`.
 */
export const EXTERNAL_AUTHORITY_SEED = "EXTERNAL_AUTHORITY";

/**
 * The gas-token wrapper is 18-decimal ("rsol-wei") on the EVM side; Rome downscales
 * by 10^(18 - mintDecimals) on the Solana side. `Withdraw.withdraw_to_ata` (wrap) and
 * `HelperProgram.deposit_from_ata` (unwrap) BOTH take rsol-wei — not the mint's decimals.
 */
export const RSOL_DECIMALS = 18;

/** Solana-side rome-evm instruction tags for the Solana-native (Phantom) lane. */
export const DO_TX_UNSIGNED_TAG = 17;
export const ACTIVATE_ATA_TAG = 18;
