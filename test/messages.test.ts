import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { decodeFunctionData, getAddress, toFunctionSelector, type Hex, type PublicClient, type WalletClient } from "viem";
import {
  ROME_WETH_UNIT,
  bridgeMessageAbi,
  claimMessageAbi,
  claimMessageFromEvm,
  claimMessageFromSolanaWallet,
  encodeBridgeMessage,
  encodeBridgeMessageWETH,
  encodeClaimMessage,
  isMessageClaimed,
  messageLeavesOf,
  messageOriginOf,
  sendMessageFromEvm,
  sendMessageFromSolanaWallet,
  type MessageProof,
} from "../src/messages.js";
import { submitRomeTxV1, type SolanaLaneV1Deps } from "../src/solanaV1.js";
import encodeFixture from "./fixtures/messages-encode.json" with { type: "json" };
import claimFixture from "./fixtures/messages-claim.json" with { type: "json" };
import receiptFixture from "./fixtures/messages-receipt.json" with { type: "json" };

vi.mock("../src/solanaV1.js", () => ({ submitRomeTxV1: vi.fn() }));
const submitMock = vi.mocked(submitRomeTxV1);

const BRIDGE = "0x528e26b25a34a4A5d0dbDa1d57D318153d2ED582" as Hex;
const RECEIVER = "0x3403e0de09bc76ca7d74762f264e4f6b649a0562" as Hex;
const MSG = { destinationNetwork: 1, destinationAddress: RECEIVER, metadata: "0xdeadbeef" as Hex, forceUpdateGlobalExitRoot: false };
const proof = claimFixture.proof as unknown as MessageProof;

beforeEach(() => submitMock.mockReset());

describe("send encoders", () => {
  it("bridgeMessage equals the reference encoder's calldata for every fixture vector", () => {
    for (const v of encodeFixture.message) {
      expect(encodeBridgeMessage(v.input as never), v.name).toBe(v.calldata);
    }
  });

  it("bridgeMessageWETH equals the reference encoder's calldata for every fixture vector", () => {
    for (const v of encodeFixture.weth) {
      expect(encodeBridgeMessageWETH({ ...(v.input as never), amountWETH: BigInt(v.input.amountWETH) }), v.name).toBe(v.calldata);
    }
  });

  it("has the bridge's selectors and decodes back to its inputs", () => {
    const a = encodeBridgeMessage(MSG);
    expect(a.slice(0, 10)).toBe(toFunctionSelector("bridgeMessage(uint32,address,bool,bytes)"));
    expect(decodeFunctionData({ abi: bridgeMessageAbi, data: a }).args).toEqual([1, getAddress(RECEIVER), false, "0xdeadbeef"]);
    const b = encodeBridgeMessageWETH({ ...MSG, amountWETH: 3n * ROME_WETH_UNIT });
    expect(b.slice(0, 10)).toBe(toFunctionSelector("bridgeMessageWETH(uint32,address,uint256,bool,bytes)"));
    expect(decodeFunctionData({ abi: bridgeMessageAbi, data: b }).args).toEqual([1, getAddress(RECEIVER), 3_000_000_000n, false, "0xdeadbeef"]);
  });

  it("forces the global exit root update unless told not to", () => {
    const { forceUpdateGlobalExitRoot: _, ...rest } = MSG;
    expect(encodeBridgeMessage(rest)).toBe(encodeBridgeMessage({ ...rest, forceUpdateGlobalExitRoot: true }));
    expect(encodeBridgeMessage(rest)).not.toBe(encodeBridgeMessage({ ...rest, forceUpdateGlobalExitRoot: false }));
    expect(encodeBridgeMessageWETH({ ...rest, amountWETH: ROME_WETH_UNIT })).toBe(encodeBridgeMessageWETH({ ...rest, amountWETH: ROME_WETH_UNIT, forceUpdateGlobalExitRoot: true }));
  });

  it("ROME_WETH_UNIT is 1e9 wei", () => expect(ROME_WETH_UNIT).toBe(1_000_000_000n));
});

describe("encodeClaimMessage", () => {
  it("equals the calldata the claim worker builds for the same leaf and proofs", () => {
    expect(encodeClaimMessage(proof)).toBe(claimFixture.calldata);
  });

  it("decimal strings for the bigint fields give the same calldata as bigints", () => {
    const asBigint = { ...proof, globalIndex: BigInt(proof.globalIndex), amount: BigInt(proof.amount) };
    expect(encodeClaimMessage(asBigint)).toBe(claimFixture.calldata);
  });

  it("has the claimMessage selector and decodes to the named arguments", () => {
    const d = decodeFunctionData({ abi: claimMessageAbi, data: encodeClaimMessage(proof) });
    expect(d.functionName).toBe("claimMessage");
    expect(d.args?.[2]).toBe(BigInt(proof.globalIndex));
    expect(d.args?.[5]).toBe(proof.originNetwork);
    expect(d.args?.[10]).toBe(proof.metadata);
  });

  it("refuses a proof that is not 32 hashes, and a non-decimal string", () => {
    expect(() => encodeClaimMessage({ ...proof, smtProofLocalExitRoot: proof.smtProofLocalExitRoot.slice(1) })).toThrow(/smtProofLocalExitRoot must hold 32/);
    expect(() => encodeClaimMessage({ ...proof, smtProofRollupExitRoot: [...proof.smtProofRollupExitRoot, proof.mainnetExitRoot] })).toThrow(/smtProofRollupExitRoot must hold 32/);
    expect(() => encodeClaimMessage({ ...proof, globalIndex: "0x10" })).toThrow(/globalIndex/);
    expect(() => encodeClaimMessage({ ...proof, amount: "-1" })).toThrow(/amount/);
  });
});

describe("messageOriginOf", () => {
  it("is keccak256(pubkey)[12..32] for a known pubkey", () => {
    // keccak256 of 32 zero bytes is 0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563
    expect(messageOriginOf("11111111111111111111111111111111")).toBe("0x88386fc84ba6bc95484008f6362f93160ef3e563");
    expect(messageOriginOf(new PublicKey("11111111111111111111111111111111"))).toBe("0x88386fc84ba6bc95484008f6362f93160ef3e563");
    expect(messageOriginOf(new Uint8Array(32))).toBe("0x88386fc84ba6bc95484008f6362f93160ef3e563");
  });

  it("is the address a Solana wallet's keypair maps to", () => {
    const kp = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 7));
    expect(kp.publicKey.toBase58()).toBe("14BGX7Knx1pJrMnQGdmxDykxFEzkMghYVqsBSTzppbFX");
    expect(messageOriginOf(kp.publicKey)).toBe("0x30286ad231fba275c64be0698250358e94e602ec");
  });
});

describe("messageLeavesOf", () => {
  const receipt = receiptFixture.receipt;

  it("returns the message leaf only, decoded, from a receipt with a token leaf, a message leaf and other logs", () => {
    expect(messageLeavesOf(receipt, BRIDGE)).toEqual([
      {
        leafType: 1,
        depositCount: 42,
        originNetwork: 1,
        originAddress: "0x02aeace038269f9961c93d04dcacd6fb3adfa55f",
        destinationNetwork: 7,
        destinationAddress: RECEIVER,
        amount: 0n,
        metadata: "0xdeadbeef",
      },
    ]);
  });

  it("includes the token leaf, in log order, when asked", () => {
    const leaves = messageLeavesOf(receipt, BRIDGE, { includeTokens: true });
    expect(leaves.map((l) => [l.leafType, l.depositCount])).toEqual([
      [0, 41],
      [1, 42],
    ]);
    expect(leaves[0]).toMatchObject({ originAddress: "0x1111111111111111111111111111111111111111", amount: 2_000_000n, destinationNetwork: 7 });
  });

  it("matches the bridge address in any case, and finds nothing for another bridge", () => {
    expect(messageLeavesOf(receipt, BRIDGE.toLowerCase() as Hex)).toHaveLength(1);
    expect(messageLeavesOf(receipt, "0x0000000000000000000000000000000000000abc")).toEqual([]);
    expect(messageLeavesOf({ logs: [] }, BRIDGE)).toEqual([]);
  });
});

describe("Solana senders", () => {
  const deps = { chainId: 1 } as unknown as SolanaLaneV1Deps;
  const lane = { hash: "0xaa", from: RECEIVER, route: "atomic" as const, receipt: null };

  it("sendMessageFromSolanaWallet passes the exact bridgeMessage calldata and the bridge to submitRomeTxV1, and returns the lane result", async () => {
    submitMock.mockResolvedValue(lane);
    expect(await sendMessageFromSolanaWallet(deps, { bridge: BRIDGE, message: MSG })).toBe(lane);
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock).toHaveBeenCalledWith(deps, { to: BRIDGE, data: encodeBridgeMessage(MSG) });
  });

  it("with amountWETH it passes the bridgeMessageWETH calldata", async () => {
    submitMock.mockResolvedValue(lane);
    await sendMessageFromSolanaWallet(deps, { bridge: BRIDGE, message: MSG, amountWETH: 2n * ROME_WETH_UNIT });
    expect(submitMock).toHaveBeenCalledWith(deps, { to: BRIDGE, data: encodeBridgeMessageWETH({ ...MSG, amountWETH: 2_000_000_000n }) });
  });

  it("refuses an amount that is not a whole number of units, before anything is sent", async () => {
    await expect(sendMessageFromSolanaWallet(deps, { bridge: BRIDGE, message: MSG, amountWETH: ROME_WETH_UNIT + 1n })).rejects.toThrow(/whole multiple of ROME_WETH_UNIT/);
    await expect(sendMessageFromSolanaWallet(deps, { bridge: BRIDGE, message: MSG, amountWETH: -ROME_WETH_UNIT })).rejects.toThrow(/whole multiple/);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("claimMessageFromSolanaWallet passes the exact claimMessage calldata and the bridge", async () => {
    submitMock.mockResolvedValue(lane);
    expect(await claimMessageFromSolanaWallet(deps, BRIDGE, proof)).toBe(lane);
    expect(submitMock).toHaveBeenCalledWith(deps, { to: BRIDGE, data: claimFixture.calldata });
  });
});

describe("EVM senders", () => {
  const account = { address: "0x00000000000000000000000000000000000000a1" as Hex };
  const chain = { id: 11155111 };
  const wallet = () => {
    const sendTransaction = vi.fn(async () => "0xabc" as Hex);
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_estimateGas") return "0x100";
      if (method === "eth_getBlockByNumber") return { baseFeePerGas: "0x1" };
      if (method === "eth_maxPriorityFeePerGas") return "0x1";
      if (method === "eth_gasPrice") return "0x2";
      if (method === "eth_sendTransaction") return "0xdef";
      throw new Error(method);
    });
    return { client: { account, chain, sendTransaction, request } as unknown as WalletClient, sendTransaction, request };
  };

  it("sendMessageFromEvm sends bridgeMessage to the bridge with the caller's native value", async () => {
    const w = wallet();
    expect(await sendMessageFromEvm(w.client, { bridge: BRIDGE, message: MSG, value: 7n })).toBe("0xabc");
    expect(w.sendTransaction).toHaveBeenCalledWith({ account, chain, to: BRIDGE, data: encodeBridgeMessage(MSG), value: 7n });
  });

  it("sendMessageFromEvm without value sends none", async () => {
    const w = wallet();
    await sendMessageFromEvm(w.client, { bridge: BRIDGE, message: MSG });
    expect(w.sendTransaction).toHaveBeenCalledWith({ account, chain, to: BRIDGE, data: encodeBridgeMessage(MSG), value: undefined });
  });

  it("weth uses bridgeMessageWETH with value as the amount and sends no native value", async () => {
    const w = wallet();
    await sendMessageFromEvm(w.client, { bridge: BRIDGE, message: MSG, weth: true, value: 4n * ROME_WETH_UNIT });
    expect(w.sendTransaction).toHaveBeenCalledWith({ account, chain, to: BRIDGE, data: encodeBridgeMessageWETH({ ...MSG, amountWETH: 4_000_000_000n }), value: undefined });
  });

  it("weth refuses an amount that is not a whole multiple of ROME_WETH_UNIT, and a missing amount", async () => {
    const w = wallet();
    await expect(sendMessageFromEvm(w.client, { bridge: BRIDGE, message: MSG, weth: true, value: 1_500_000_000n })).rejects.toThrow(/whole multiple of ROME_WETH_UNIT/);
    await expect(sendMessageFromEvm(w.client, { bridge: BRIDGE, message: MSG, weth: true, value: 999_999_999n })).rejects.toThrow(/whole multiple/);
    await expect(sendMessageFromEvm(w.client, { bridge: BRIDGE, message: MSG, weth: true })).rejects.toThrow(/value/);
    expect(w.sendTransaction).not.toHaveBeenCalled();
  });

  it("refuses a wallet client with no account", async () => {
    const w = wallet();
    await expect(sendMessageFromEvm({ ...w.client, account: undefined } as unknown as WalletClient, { bridge: BRIDGE, message: MSG })).rejects.toThrow(/no account/);
  });

  it("with rome it sends through submitRomeTx (padded gas, eth_sendTransaction)", async () => {
    const w = wallet();
    expect(await sendMessageFromEvm(w.client, { bridge: BRIDGE, message: MSG, rome: true })).toBe("0xdef");
    expect(w.sendTransaction).not.toHaveBeenCalled();
    const send = w.request.mock.calls.map((c) => c[0]).find((c) => c.method === "eth_sendTransaction") as unknown as { params: [Record<string, string>] };
    expect(send.params[0]).toMatchObject({ from: account.address, to: BRIDGE, data: encodeBridgeMessage(MSG), gas: "0x14c" });
  });

  it("claimMessageFromEvm sends the claimMessage calldata to the bridge", async () => {
    const w = wallet();
    expect(await claimMessageFromEvm(w.client, BRIDGE, proof)).toBe("0xabc");
    expect(w.sendTransaction).toHaveBeenCalledWith({ account, chain, to: BRIDGE, data: claimFixture.calldata, value: undefined });
    await claimMessageFromEvm(w.client, BRIDGE, proof, { rome: true });
    expect(w.request).toHaveBeenCalledWith(expect.objectContaining({ method: "eth_sendTransaction" }));
  });
});

describe("isMessageClaimed", () => {
  it("reads isClaimed(depositCount, originNetwork) on the bridge", async () => {
    const readContract = vi.fn(async () => true);
    expect(await isMessageClaimed({ readContract } as unknown as PublicClient, BRIDGE, 42, 1)).toBe(true);
    expect(readContract).toHaveBeenCalledWith({ address: BRIDGE, abi: claimMessageAbi, functionName: "isClaimed", args: [42, 1] });
  });
});
