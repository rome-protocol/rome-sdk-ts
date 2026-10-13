// Run an ERC20 approve on Rome from a Solana keypair over the v1 Solana lane.
//
//   npm run build
//   SOLANA_KEYPAIR=~/.config/solana/id.json node examples/solana-lane-v1.mjs
//
// The keypair needs a little SOL for the Solana fee. Its key is never printed.
import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { encodeFunctionData, parseAbi } from "viem";
import { submitRomeTxV1 } from "../dist/index.js";

const keypairPath = process.env.SOLANA_KEYPAIR;
if (!keypairPath) throw new Error("set SOLANA_KEYPAIR to the path of a JSON keypair file");
const proxyUrl = process.env.PROXY_URL ?? "https://hadrian.testnet.romeprotocol.xyz/";
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const chainId = Number(process.env.CHAIN_ID ?? 200010);
const token = process.env.TOKEN ?? "0xbce339ba4c3a8de3bb8af1c5539e6ac11da3112d";
const spender = "0x000000000000000000000000000000000000dEaD";

const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));
const connection = new Connection(rpcUrl, "confirmed");
console.log("wallet   ", keypair.publicKey.toBase58());

const result = await submitRomeTxV1(
  { connection, proxyUrl, chainId, signer: keypair },
  {
    to: token,
    data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [spender, 1n] }),
  },
);
console.log("route    ", result.route);
console.log("solana   ", result.signature ?? "(relayed by the proxy)");
console.log("evm hash ", result.hash);
console.log("receipt  ", result.receipt ? `status ${result.receipt.status}, block ${BigInt(result.receipt.blockNumber)}` : "not seen yet");

if (result.signature) {
  // web3.js 1.x may not decode a v1 transaction, so fall back to a plain JSON-RPC read.
  let tx;
  try {
    tx = await connection.getTransaction(result.signature, { maxSupportedTransactionVersion: 1 });
  } catch {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [result.signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 1 }],
      }),
    });
    tx = (await res.json()).result;
  }
  console.log("version  ", tx?.version);
  console.log("compute  ", tx?.meta?.computeUnitsConsumed);
}
