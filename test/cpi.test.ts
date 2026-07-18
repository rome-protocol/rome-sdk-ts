import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { decodeFunctionData, parseAbi } from "viem";
import { encodeInvoke, encodeInvokeSigned, CPI_PRECOMPILE, u64Le, u8 } from "../src/index.js";
import { CPI_ABI, SELECTORS, PRECOMPILE_ADDRESSES } from "../src/index.js";

const PROGRAM = new PublicKey("So11111111111111111111111111111111111111112");
const ACC = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const SEED32 = ("0x" + "11".repeat(32)) as `0x${string}`;
const CPI = parseAbi([...CPI_ABI]);

describe("CPI encoders", () => {
  it("CPI_PRECOMPILE is the canonical 0xFF..08 address", () => {
    expect(CPI_PRECOMPILE).toBe(PRECOMPILE_ADDRESSES.cpi);
    expect(CPI_PRECOMPILE).toBe("0xff00000000000000000000000000000000000008");
  });

  it("encodeInvoke: selector matches the canonical one + decodes to the args", () => {
    const data = encodeInvoke(PROGRAM, [{ pubkey: ACC, isSigner: true, isWritable: false }], "0xdead");
    expect(data.slice(0, 10)).toBe(SELECTORS["invoke(bytes32,(bytes32,bool,bool)[],bytes)"]);
    const decoded = decodeFunctionData({ abi: CPI, data });
    expect(decoded.functionName).toBe("invoke");
    const args = decoded.args as readonly unknown[];
    expect(args[2]).toBe("0xdead");
    expect((args[1] as readonly { is_signer: boolean }[])[0]!.is_signer).toBe(true);
  });

  it("encodeInvokeSigned: selector matches the canonical one", () => {
    const data = encodeInvokeSigned(
      PROGRAM,
      [{ pubkey: ACC, isSigner: false, isWritable: true }],
      "0xbeef",
      [SEED32],
    );
    expect(data.slice(0, 10)).toBe(SELECTORS["invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])"]);
  });
});

describe("little-endian primitives", () => {
  it("u64Le", () => {
    expect(u64Le(1n)).toBe("0x0100000000000000");
    expect(u64Le(255n)).toBe("0xff00000000000000");
    expect(u64Le(0x0102030405060708n)).toBe("0x0807060504030201");
    expect(() => u64Le(-1n)).toThrow(/out of range/);
    expect(() => u64Le(2n ** 64n)).toThrow(/out of range/);
  });
  it("u8", () => {
    expect(u8(0)).toBe("0x00");
    expect(u8(255)).toBe("0xff");
    expect(() => u8(256)).toThrow(/out of range/);
  });
});
