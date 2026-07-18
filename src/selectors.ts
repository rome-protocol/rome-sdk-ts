/**
 * Canonical 4-byte selectors (`keccak256(signature)[0:4]`) for the Rome precompile
 * methods, transcribed from Rome EVM's canonical precompile dispatch table. Keys are the canonical
 * function signatures. Every entry is re-derived + asserted in the test suite, so a
 * bad transcription can never ship.
 *
 * Use for low-level calldata assembly when you don't want a full ABI:
 *   `SELECTORS["withdraw_to_ata(uint256)"] + encodeAbiParameters([{type:"uint256"}],[wei])`
 */
export const SELECTORS = {
  // CpiProgram (0xFF..08)
  "invoke(bytes32,(bytes32,bool,bool)[],bytes)": "0x7480cb86",
  "invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])": "0xb94f3733",
  "account_info(bytes32)": "0xc13465d9",
  "account_data_at(bytes32,uint16,uint16)": "0x593762e8",
  "account_u64_at(bytes32,uint16)": "0xb317d4c1",
  "account_lamports(bytes32)": "0xde79ed54",
  "pdas_batch_derive(bytes[][],bytes32)": "0x944336f8",

  // HelperProgram (0xFF..09)
  "create_ata(address)": "0x5a7c3259",
  "create_ata(address,bytes32)": "0x3de2251a",
  "create_ata_for_key(bytes32,bytes32)": "0xd258a69d",
  "create_pda(address)": "0xff3556ca",
  "create_pda(address,uint64)": "0x58e88298",
  "swap_gas_to_lamports(uint64)": "0x6e3f24e0",
  "transfer_lamports(address,uint64)": "0x5fe71665",
  "transfer_spl(address,uint64)": "0xb12be5ba",
  "transfer_spl(bytes32,uint64)": "0xba3a5eac",
  "transfer_spl(address,uint64,bytes32)": "0x53b505e0",
  "transfer_spl(bytes32,uint64,bytes32)": "0xb6977879",
  "transfer_spl(bytes32,bytes32,uint64,bytes32)": "0x766b362a",
  "transfer_spl(address,address,uint64,bytes32)": "0xe479df56",
  "transfer_spl_to_signer(uint64,bytes32)": "0x46efa679",
  "approve_spl(address,uint64,bytes32)": "0xabf6f675",
  "mint_spl(address,uint64,bytes32)": "0xd795522b",
  "deposit_from_ata(uint256)": "0x4479b709",
  "pda(address)": "0x8854a299",
  "pda_with_salt(address,bytes32)": "0x5c6d04b3",
  "ata(address)": "0x31db4f82",
  "ata(address,bytes32)": "0xfeb1c647",
  "user_balance(address,bytes32)": "0xdd0119c8",
  "allowance_of(address,address,bytes32)": "0xed72dbc8",

  // Withdraw (0x42..16)
  "withdrawal(bytes32)": "0x4d8b0ea4",
  "withdraw_to_pda(uint256)": "0x7f3124a0",
  "withdraw_to_ata(uint256)": "0x8059abc0",
} as const satisfies Record<string, `0x${string}`>;
