import { encodeFunctionData, parseAbi, bytesToHex, type Hex } from "viem";
import type { PublicKey } from "@solana/web3.js";
import { CPI_ABI } from "./abis.js";
import { PRECOMPILE_ADDRESSES } from "./addresses.js";
import { pubkeyToBytes32 } from "./pda.js";

const CPI = parseAbi([...CPI_ABI]);

/** The CPI precompile address (0xFF..08) — the `to` for invoke/invoke_signed calldata. */
export const CPI_PRECOMPILE = PRECOMPILE_ADDRESSES.cpi;

/** A Solana account reference for a CPI, in ergonomic (camelCase) form. */
export interface AccountMeta {
  pubkey: PublicKey | string;
  isSigner: boolean;
  isWritable: boolean;
}

const toTuple = (m: AccountMeta) => ({
  pubkey: pubkeyToBytes32(m.pubkey),
  is_signer: m.isSigner,
  is_writable: m.isWritable,
});

/**
 * Encode calldata for `CpiProgram.invoke(program, accounts, data)` — an arbitrary
 * Solana CPI signed as the caller's external-auth PDA. Send it to {@link CPI_PRECOMPILE}.
 */
export function encodeInvoke(
  programId: PublicKey | string,
  accounts: readonly AccountMeta[],
  data: Hex,
): Hex {
  return encodeFunctionData({
    abi: CPI,
    functionName: "invoke",
    args: [pubkeyToBytes32(programId), accounts.map(toTuple), data],
  });
}

/**
 * Encode calldata for `CpiProgram.invoke_signed(program, accounts, data, seeds)`
 * — a CPI signed by N caller-derived PDAs (salts → seeds). Send it to {@link CPI_PRECOMPILE}.
 */
export function encodeInvokeSigned(
  programId: PublicKey | string,
  accounts: readonly AccountMeta[],
  data: Hex,
  seeds: readonly Hex[],
): Hex {
  return encodeFunctionData({
    abi: CPI,
    functionName: "invoke_signed",
    args: [pubkeyToBytes32(programId), accounts.map(toTuple), data, seeds],
  });
}

/** Little-endian u64 (8 bytes) — for assembling inner Solana instruction data. */
export function u64Le(value: bigint): Hex {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`u64 out of range: ${value}`);
  }
  const b = new Uint8Array(8);
  let x = value;
  for (let i = 0; i < 8; i++) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return bytesToHex(b);
}

/** A single byte. */
export function u8(value: number): Hex {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`u8 out of range: ${value}`);
  }
  return bytesToHex(Uint8Array.of(value));
}
