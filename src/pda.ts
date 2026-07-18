import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { hexToBytes, bytesToHex, type Hex } from "viem";
import { EXTERNAL_AUTHORITY_SEED } from "./constants.js";

const asPublicKey = (v: PublicKey | string): PublicKey =>
  typeof v === "string" ? new PublicKey(v) : v;

function evmAddressBytes(address: string): Uint8Array {
  const hex = (address.startsWith("0x") ? address : `0x${address}`) as Hex;
  const bytes = hexToBytes(hex);
  if (bytes.length !== 20) {
    throw new Error(`invalid EVM address (expected 20 bytes): ${address}`);
  }
  return bytes;
}

/**
 * Derive a user's **external-authority PDA** — the Solana account the Rome
 * precompiles sign as on the user's behalf:
 *
 *   find_program_address(["EXTERNAL_AUTHORITY", evmAddress20], romeEvmProgramId)
 *
 * Byte-identical to the on-chain `HelperProgram.pda(address)` and to the
 * derivation every Rome app uses. `evmAddress` is a standard 20-byte hex address.
 */
export function deriveAuthorityPda(
  evmAddress: string,
  romeEvmProgramId: PublicKey | string,
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(EXTERNAL_AUTHORITY_SEED), evmAddressBytes(evmAddress)],
    asPublicKey(romeEvmProgramId),
  );
  return pda;
}

/**
 * The associated token account of any owner + mint. `allowOwnerOffCurve` is
 * true because Rome owners are usually PDAs (off the ed25519 curve).
 */
export function deriveAta(
  owner: PublicKey | string,
  mint: PublicKey | string,
): PublicKey {
  return getAssociatedTokenAddressSync(asPublicKey(mint), asPublicKey(owner), true);
}

/** A user's PDA-owned ATA for a mint: `ATA(authorityPda(evmAddress), mint)`. */
export function deriveUserAta(
  evmAddress: string,
  mint: PublicKey | string,
  romeEvmProgramId: PublicKey | string,
): PublicKey {
  return deriveAta(deriveAuthorityPda(evmAddress, romeEvmProgramId), mint);
}

/** A Solana pubkey as the 0x-prefixed 32-byte hex the precompiles take (`bytes32`). */
export function pubkeyToBytes32(pubkey: PublicKey | string): Hex {
  return bytesToHex(asPublicKey(pubkey).toBytes());
}
