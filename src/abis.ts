/**
 * viem/ethers-ready human-readable ABIs for the Rome precompiles. Pass to
 * `parseAbi(...)` (viem) or `new ethers.Interface([...])`. Selectors for every
 * mutating/keyed method are pinned + verified in `./selectors`.
 */

/** CpiProgram (0xFF..08): arbitrary Solana CPI + read shortcuts. */
export const CPI_ABI = [
  "function invoke(bytes32 program_id, (bytes32 pubkey, bool is_signer, bool is_writable)[] accounts, bytes data)",
  "function invoke_signed(bytes32 program_id, (bytes32 pubkey, bool is_signer, bool is_writable)[] accounts, bytes data, bytes32[] seeds)",
  "function account_info(bytes32 pubkey) view returns (uint64 lamports, bytes32 owner, bool is_signer, bool is_writable, bool executable, bytes data)",
  "function account_data_at(bytes32 pubkey, uint16 offset, uint16 length) view returns (bytes)",
  "function account_u64_at(bytes32 pubkey, uint16 offset) view returns (uint64)",
  "function account_lamports(bytes32 pubkey) view returns (uint64)",
  "function pdas_batch_derive(bytes[][] seed_groups, bytes32 program_id) view returns ((bytes32 pda, uint8 bump)[])",
] as const;

/** HelperProgram (0xFF..09): SPL/PDA/ATA/lamports plumbing signed by the caller's external-auth PDA. */
export const HELPER_ABI = [
  "function create_ata(address user)",
  "function create_ata(address user, bytes32 mint)",
  "function create_ata_for_key(bytes32 wallet, bytes32 mint)",
  "function create_pda(address user)",
  "function create_pda(address user, uint64 lamports)",
  "function swap_gas_to_lamports(uint64 lamports)",
  "function transfer_lamports(address to, uint64 lamports)",
  "function transfer_spl(address to, uint64 tokens)",
  "function transfer_spl(bytes32 to_ata, uint64 tokens)",
  "function transfer_spl(address to, uint64 tokens, bytes32 mint)",
  "function transfer_spl(bytes32 to_ata, uint64 tokens, bytes32 mint)",
  "function transfer_spl(bytes32 src_ata, bytes32 to_ata, uint64 tokens, bytes32 mint)",
  "function transfer_spl(address from, address to, uint64 tokens, bytes32 mint)",
  "function transfer_spl_to_signer(uint64 amount, bytes32 mint)",
  "function approve_spl(address spender, uint64 amount, bytes32 mint)",
  "function mint_spl(address to, uint64 amount, bytes32 mint)",
  "function deposit_from_ata(uint256 wei_)",
  "function pda(address user) view returns (bytes32)",
  "function pda_with_salt(address user, bytes32 salt) view returns (bytes32)",
  "function ata(address user) view returns (bytes32)",
  "function ata(address user, bytes32 mint) view returns (bytes32)",
  "function user_balance(address account, bytes32 mint) view returns (uint64)",
  "function allowance_of(address owner, address spender, bytes32 mint) view returns (uint64)",
] as const;

/** Withdraw (0x42..16): SOL withdrawal + the two gas-token wrap/unwrap legs. */
export const WITHDRAW_ABI = [
  "function withdrawal(bytes32 owner) payable",
  "function withdraw_to_pda(uint256 wei_)",
  "function withdraw_to_ata(uint256 wei_)",
] as const;

/** System Program (0xFF..07): PDA derivation, base58, mint/operator/program-id getters. */
export const SYSTEM_ABI = [
  "function program_id() view returns (bytes32)",
  "function rome_evm_program_id() view returns (bytes32)",
  "function find_program_address(bytes32 program, (bytes item)[] seeds) pure returns (bytes32, uint8)",
  "function bytes32_to_base58(bytes32) view returns (bytes)",
  "function base58_to_bytes32(bytes) view returns (bytes32)",
  "function operator() view returns (bytes32)",
  "function mint_id() view returns (bytes32)",
] as const;
