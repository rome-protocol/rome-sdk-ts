# @rome-protocol/sdk

> **Built on [Rome Protocol](https://docs.rome.builders)** — EVM chains that run natively inside the Solana runtime, where Solidity apps call Solana programs atomically (CPI) and Solana users drive EVM apps: two VMs, one chain, one block.


- **Single state** — EVM contracts and Solana programs share one state; no bridging or sync delay.
- **Atomic CPI access** — Solidity calls any Solana program directly (SPL Token, Meteora, …) inside one atomic transaction.
- **App Sovereignty** — each app runs its own EVM chain with a custom gas token and captures its own fee revenue.

TypeScript SDK for building on [Rome](https://github.com/rome-protocol) — EVM chains that run on Solana. It handles the Rome-specific write path, fee sizing, PDA derivation, CPI calldata encoding, and the **Solana lane** (a Solana wallet driving your EVM app) so your app doesn't re-derive them.

## Install

Repo-first — install from the repo, pinned to a release tag (npm publish is deferred until demand):

```
npm install github:rome-protocol/rome-sdk-ts#v0.2.1 viem @solana/web3.js @solana/spl-token
```

Imports use the package name (`@rome-protocol/sdk`) unchanged.

## Every Rome write goes through `submitRomeTx`

```ts
import { submitRomeTx } from "@rome-protocol/sdk";

// provider = an EIP-1193 provider (window.ethereum, connector.getProvider(), ...)
const hash = await submitRomeTx(provider, { from, to, data });
```

`submitRomeTx` sizes gas from `eth_estimateGas` padded 1.3× (Rome's estimator undercounts Solana-CPI cost), falls back to an explicit ceiling when estimation reverts, and supplies standard EIP-1559 fee fields — so the wallet never shows "Network fee: Unavailable" and never under-gasses a CPI write. **Don't send Rome writes with raw `eth_sendTransaction` / wagmi `writeContract`.**

## Calling a Solana program from your EVM app (CPI)

```ts
import {
  encodeInvoke, CPI_PRECOMPILE,
  deriveAuthorityPda, deriveUserAta, submitRomeTx,
} from "@rome-protocol/sdk";

const data = encodeInvoke(solanaProgramId, accountMetas, innerInstructionData);
await submitRomeTx(provider, { from, to: CPI_PRECOMPILE, data });
```

The CPI precompile signs as your **external-authority PDA** — `deriveAuthorityPda(evmAddress, romeEvmProgramId)` — and `deriveUserAta(evmAddress, mint, programId)` is that PDA's ATA (where bridged/wrapped tokens live).

## Driving your EVM app from a Solana wallet (the Solana lane)

A Solana wallet (Phantom) can call your EVM contracts directly — no Ethereum key. `submitRomeTxSolanaLane` is the mirror of `submitRomeTx`:

```ts
import { submitRomeTxSolanaLane, syntheticAddress } from "@rome-protocol/sdk";
import { encodeFunctionData } from "viem";

const { signature } = await submitRomeTxSolanaLane(
  { connection, proxyUrl, programId, chainId, payer: wallet.publicKey, signTransaction: wallet.signTransaction },
  { to: contract, data: encodeFunctionData({ abi, functionName: "deposit" }), value: amount },
);
```

The wallet **signs the Solana transaction and sends it to the Solana RPC** (the proxy is used only for account emulation). On-chain, `msg.sender` is the wallet's **synthetic address** — `syntheticAddress(pubkey)` = `keccak256(pubkey)[12:]`.

**The synthetic holds nothing at rest.** A Solana user's spendable balance is their **wallet's SPL ATA, exposed 1:1 as an ERC20SPL wrapper** on the EVM side (e.g. `wUSDC`) — so your app moves it with ordinary ERC20 `transfer` / `transferFrom`, *not* native `msg.value`. Value flows *through* the synthetic:

- **Fund leg** (value in) — `buildFundLeg(...)` + `submitSolanaInstructions(...)`: move USDC from the wallet into the synthetic's ATA (`ActivateAta`) before the call.
- **Sweep leg** (value out) — `buildSweepLeg(...)`: push USDC from the synthetic's ATA back to the wallet (`HelperProgram.transfer_spl`) after a withdraw.

**Provisioning is automatic.** A brand-new synthetic's external-auth PDA doesn't exist until `create_pda` runs — and value-moving calls are signed by it. `submitRomeTxSolanaLane` provisions it transparently on first use; pass `autoProvision: false` and call `provisionSynthetic(deps)` yourself for an explicit one-time "Activate" step (gate a UI with `isSyntheticProvisioned`).

`submitRomeTxSolanaLane` also handles what a hand-built transaction gets wrong: the **ComputeBudget** (raised CU + heap), the **treasure wallet** account, and emulating account discovery **with `value`** (so value-dependent storage slots are allocated). The user needs a little **SOL** (tx fee) + **USDC** (SPL) in their wallet; there is no faucet. Full walkthrough: **Build a dual-lane app** in the [docs](https://docs.rome.builders).

### The v1 Solana lane

`submitRomeTxV1` is the newer Solana lane. The proxy composes **one Solana v1 transaction** (up to 4096 bytes and 64 accounts, no lookup table) for your EVM call, and the wallet signs it. There is no ComputeBudget, treasure wallet or account list to assemble on the client. The same key signs **twice**: first a readable authorization message that the wallet shows as `Rome authorization\n0x<hash>` (the `<hash>` is the EVM transaction hash), then the Solana transaction itself. The app sends the signed transaction to the Solana RPC.

```ts
import { submitRomeTxV1 } from "@rome-protocol/sdk";

const { route, signature, hash, receipt } = await submitRomeTxV1(
  { connection, proxyUrl, chainId, signer: keypair }, // a Keypair, or any LaneSigner
  { to: contract, data: encodeFunctionData({ abi, functionName: "deposit" }) },
);
```

A Wallet Standard wallet satisfies `LaneSigner` with two features: `solana:signMessage` for the authorization and `solana:signTransaction` on the raw wire bytes for the transaction signature (a v1 signed wire is the message followed by the 64-byte signature):

```ts
const signer: LaneSigner = {
  payer: new PublicKey(account.address),
  async signAuthHash(message) {
    const [{ signature }] = await wallet.features["solana:signMessage"].signMessage({ account, message });
    return signature;
  },
  async signV1Wire(wire) {
    const [{ signedTransaction }] = await wallet.features["solana:signTransaction"].signTransaction({ account, transaction: wire });
    return signedTransaction.slice(-64);
  },
};
```

If the composer refuses a call because it does not fit one atomic transaction, `submitRomeTxV1` hands it to the proxy with the **same** authorization signature (no second prompt), and the result has `route: "relay"` and no Solana `signature`. Pass `relayOnRefusal: false` to get the refusal as an error, or call `relayV1` yourself. A relayed call is paid for in the chain's native gas token, so the sender needs a balance: `fundSyntheticGas(deps, amountWei)` tops it up from the wallet's SOL (`amountWei` must be a multiple of 10^12).

`submitRomeTxV1` does not provision a new synthetic address. `provisionSynthetic` from the legacy lane still does that one-time `create_pda` step. `submitRomeTxSolanaLane` above remains the legacy-transaction path. A runnable script is in [`examples/solana-lane-v1.mjs`](./examples/solana-lane-v1.mjs).

## Bridging (`@rome-protocol/sdk/bridge`)

```ts
import { requestQuote, inboundCctpQuoteRequest, userSignedTxs, step1BindingTxIndex, registerTransfer } from "@rome-protocol/sdk/bridge";

const opts = { base: "https://<your-bridge-api>" }; // your bridge API endpoint
const quote = await requestQuote(inboundCctpQuoteRequest({ sourceChainId, romeChainId, amount, evmAddress }), opts);

// Sign the quote's txs VERBATIM (never locally-built calldata), broadcast the
// binding tx, then register the transfer with the quote object UNMODIFIED:
const items = userSignedTxs(quote, quote.route);
// ...sign + send items[...].tx via your wallet...
await registerTransfer({ quote, step1TxHash: hashes[step1BindingTxIndex(items)] }, opts);
```

Quote-first: the bridge API owns route + calldata; the client signs the quote's `unsignedTxs` verbatim and (for the trustless gas path) signs an EIP-712 settle authorization. Chain / token / contract data comes from [`@rome-protocol/registry`](https://github.com/rome-protocol/rome-registry).

## API

| Export | What |
|---|---|
| `submitRomeTx(provider, tx)` | the canonical Rome EVM write path (gas + fee handled) |
| `padRomeGas` / `romeWriteGas` / `buildRome1559Fees` / `romeFeeFields` | the fee/gas primitives it uses |
| `deriveAuthorityPda` / `deriveAta` / `deriveUserAta` / `pubkeyToBytes32` | PDA + ATA derivation |
| `encodeInvoke` / `encodeInvokeSigned` / `CPI_PRECOMPILE` | CPI calldata encoders |
| `u64Le` / `u8` | little-endian primitives for inner Solana instruction data |
| `submitRomeTxSolanaLane(deps, call)` | the Solana lane — a Solana wallet drives your EVM contract |
| `buildFundLeg` / `buildSweepLeg` / `submitSolanaInstructions` | value-in (ActivateAta) / value-out (transfer_spl) / native-instruction submit |
| `submitRomeTxV1(deps, call)` | the v1 Solana lane: one composed v1 transaction, two signatures from one key, relay on refusal |
| `relayV1` / `fundSyntheticGas` / `waitForReceipt` | relay a call through the proxy / top up native gas from SOL / poll the EVM receipt |
| `toLaneSigner` / `authHashFor` / `ed25519AuthMessage` / `ED25519_AUTH_MESSAGE_PREFIX` | signer wrapper and the readable authorization message |
| `composeAtomicV1` / `isAtomicRefusal` / `splitV1Wire` / `packSignedV1Wire` / `parseV1Message` | v1 proxy call and wire helpers |
| `provisionSynthetic` / `isSyntheticProvisioned` / `buildCreatePdaCall` | fresh-synthetic provisioning (`create_pda`) — auto on first `submitRomeTxSolanaLane` |
| `syntheticAddress` / `emulateCallAccounts` / `buildDoTxUnsigned` / `buildActivateAtaInstruction` / `treasureWallet` / `balanceKeyPda` / `computeBudgetIxs` / `SyntheticNonceTracker` | Solana-lane primitives |
| `PRECOMPILE_ADDRESSES` / `CPI_ABI` / `HELPER_ABI` / `WITHDRAW_ABI` / `SYSTEM_ABI` / `SELECTORS` / `EXTERNAL_AUTHORITY_SEED` | precompile addresses, ABIs, and verified selectors |

Precompile addresses, ABIs, and verified selectors are exported directly (each selector is checked against `keccak256(sig)` in CI). Solidity interfaces live in the public [`rome-solidity`](https://github.com/rome-protocol/rome-solidity) repo.

## Building with an AI agent?

See [`AGENTS.md`](./AGENTS.md) — the Rome-specific rules a coding agent needs.

## License

MIT
