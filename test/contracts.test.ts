import { describe, it, expect } from "vitest";
import { parseAbi, toFunctionSelector, getAddress } from "viem";
import {
  PRECOMPILE_ADDRESSES,
  CPI_ABI,
  HELPER_ABI,
  WITHDRAW_ABI,
  SYSTEM_ABI,
  SELECTORS,
  EXTERNAL_AUTHORITY_SEED,
  RSOL_DECIMALS,
  DO_TX_UNSIGNED_TAG,
  ACTIVATE_ATA_TAG,
} from "../src/index.js";

describe("precompile addresses", () => {
  it("match the canonical fixed Rome precompile addresses", () => {
    expect(PRECOMPILE_ADDRESSES.system).toBe("0xff00000000000000000000000000000000000007");
    expect(PRECOMPILE_ADDRESSES.cpi).toBe("0xff00000000000000000000000000000000000008");
    expect(PRECOMPILE_ADDRESSES.helper).toBe("0xff00000000000000000000000000000000000009");
    expect(PRECOMPILE_ADDRESSES.withdraw).toBe("0x4200000000000000000000000000000000000016");
    expect(PRECOMPILE_ADDRESSES.systemCached).toBe("0xff00000000000000000000000000000000000004");
    expect(PRECOMPILE_ADDRESSES.splCached).toBe("0xff00000000000000000000000000000000000005");
    expect(PRECOMPILE_ADDRESSES.associatedSplCached).toBe("0xff00000000000000000000000000000000000006");
    expect(PRECOMPILE_ADDRESSES.withdrawCached).toBe("0xff0000000000000000000000000000000000000b");
  });

  it("are all lowercase — mixed-case fails viem's EIP-55 checksum in signTransaction", () => {
    for (const [name, addr] of Object.entries(PRECOMPILE_ADDRESSES)) {
      expect(addr, name).toBe(addr.toLowerCase());
      expect(() => getAddress(addr), name).not.toThrow(); // still a valid address
    }
  });
});

describe("ABIs parse under viem", () => {
  it("every precompile ABI group is parseable", () => {
    expect(() => parseAbi([...CPI_ABI])).not.toThrow();
    expect(() => parseAbi([...HELPER_ABI])).not.toThrow();
    expect(() => parseAbi([...WITHDRAW_ABI])).not.toThrow();
    expect(() => parseAbi([...SYSTEM_ABI])).not.toThrow();
  });
});

describe("selectors are canonically correct — keccak256(sig)[0:4]", () => {
  // SELECTORS maps a canonical function signature -> its 4-byte selector,
  // transcribed from Rome EVM's canonical precompile dispatch table.
  // Re-derive each with viem and assert — a wrong signature transcription fails here.
  it("each SELECTORS entry matches the keccak of its signature", () => {
    for (const [sig, selector] of Object.entries(SELECTORS)) {
      expect(toFunctionSelector(`function ${sig}`), sig).toBe(selector);
    }
  });

  it("covers the load-bearing precompile methods with their canonical hex", () => {
    expect(SELECTORS["invoke(bytes32,(bytes32,bool,bool)[],bytes)"]).toBe("0x7480cb86");
    expect(SELECTORS["invoke_signed(bytes32,(bytes32,bool,bool)[],bytes,bytes32[])"]).toBe("0xb94f3733");
    expect(SELECTORS["account_lamports(bytes32)"]).toBe("0xde79ed54");
    expect(SELECTORS["withdraw_to_ata(uint256)"]).toBe("0x8059abc0");
    expect(SELECTORS["deposit_from_ata(uint256)"]).toBe("0x4479b709");
    expect(SELECTORS["transfer_spl(bytes32,uint64,bytes32)"]).toBe("0xb6977879");
    expect(SELECTORS["ata(address,bytes32)"]).toBe("0xfeb1c647");
  });
});

describe("constants", () => {
  it("EXTERNAL_AUTHORITY seed + rsol decimals + DoTx instruction tags", () => {
    expect(EXTERNAL_AUTHORITY_SEED).toBe("EXTERNAL_AUTHORITY");
    expect(RSOL_DECIMALS).toBe(18);
    expect(DO_TX_UNSIGNED_TAG).toBe(17);
    expect(ACTIVATE_ATA_TAG).toBe(18);
  });
});
