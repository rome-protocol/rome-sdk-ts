# @rome-protocol/sdk

> **Built on [Rome Protocol](https://docs.rome.builders)** — EVM chains that run natively inside the Solana runtime, where Solidity apps call Solana programs atomically (CPI) and Solana users drive EVM apps: two VMs, one chain, one block.


- **Single state** — EVM contracts and Solana programs share one state; no bridging or sync delay.
- **Atomic CPI access** — Solidity calls any Solana program directly (SPL Token, Meteora, …) inside one atomic transaction.
- **App Sovereignty** — each app runs its own EVM chain with a custom gas token and captures its own fee revenue.

TypeScript SDK for building on [Rome](https://github.com/rome-protocol) — EVM chains that run on Solana. It handles the Rome-specific write path, fee sizing, PDA derivation, CPI calldata encoding, and the **Solana lane** (a Solana wallet driving your EVM app) so your app doesn't re-derive them.

## Install

Repo-first — install from the repo, pinned to a release tag (npm publish is deferred until demand):

```
npm install github:rome-protocol/rome-sdk-ts#v0.3.0 viem @solana/web3.js @solana/spl-token
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
  { connection, proxyUrl, programId, chainId, signer: keypair }, // programId: the chain's Rome EVM program; signer: a Keypair, or any LaneSigner
  { to: contract, data: encodeFunctionData({ abi, functionName: "deposit" }) },
);
```

The authorization message is plain text, so any wallet that offers `solana:signMessage` can sign it. The transaction signature is different: `signV1Wire` receives the raw v1 wire and must return **only the 64-byte ed25519 signature** for its empty signature slot, which the SDK checks before it broadcasts. A `Keypair` does this directly. Wallet Standard's `solana:signTransaction` returns the whole signed wire, so slice the signature off its end. Wallet code that first decodes the transaction with web3.js 1.x or `@solana/kit` may not recognise the v1 format, so check your wallet's `solana:signTransaction` against a v1 wire before relying on it:

```ts
const signer: LaneSigner = {
  payer: new PublicKey(account.address),
  async signAuthHash(message) {
    const [{ signature }] = await wallet.features["solana:signMessage"].signMessage({ account, message });
    return signature;
  },
  signV1Wire: async (wire) => {
    const [{ signedTransaction }] = await wallet.features["solana:signTransaction"].signTransaction({ account, transaction: wire });
    return signedTransaction.slice(-64);
  },
};
```

Before the wallet is asked for the second signature, the SDK checks the composed transaction against what you asked for, and throws if anything differs: one signer with the payer at account 0, no priority fee, instructions only for `programId` and the Ed25519 verifier, exactly one Rome instruction carrying your payload byte for byte, and an Ed25519 instruction that vouches for the payer over this call's authorization. The check covers which programs run and the payload they carry; choosing the right accounts for that payload is still the Rome program's job on chain. `fundSyntheticGas` is held to the same standard (one deposit instruction for your chain, to your own synthetic address, for the amount you asked). The parser also refuses config-mask bits it does not know on purpose, so a proxy upgrade that introduces a new bit needs an SDK update.

If the composer refuses a call because it does not fit one atomic transaction, `submitRomeTxV1` hands it to the proxy with the **same** authorization signature (no second prompt), and the result has `route: "relay"` and no Solana `signature`. Pass `relayOnRefusal: false` to get the refusal as an error, or call `relayV1` yourself. `relayOnRefusal: false` only changes what the SDK does: the authorization signature is already with the proxy, which can run that one payload by either route, up to `gasLimit × maxFeePerGas`. A relayed call that reverted on the EVM side does not throw: it resolves with `receipt.status === "0x0"`, so check `receipt?.status === "0x1"`. A relayed call is paid for in the chain's native gas token, so the sender needs a balance: `fundSyntheticGas(deps, amountWei)` tops it up from the wallet's own token account of the chain's gas token (USDC on Hadrian and Rubicon; the wallet needs some of it, plus SOL for the Solana fee). `amountWei` is in the chain's 18-decimal wei and must be a multiple of 10^12. The relay needs at least `gasLimit × maxFeePerGas` of balance.

`submitRomeTxV1` does not provision a new synthetic address. `provisionSynthetic` from the legacy lane still does that one-time `create_pda` step. `submitRomeTxSolanaLane` above remains the legacy-transaction path. A runnable script is in [`examples/solana-lane-v1.mjs`](./examples/solana-lane-v1.mjs).

#### Plain Solana instructions as a v1 transaction

Some steps around a lane call are ordinary Solana instructions with no EVM call in them: the fund leg, or creating the wallet's token account before a sweep. `submitSolanaInstructionsV1` sends those as a v1 transaction too, signed through the same `signV1Wire`, with no proxy involved:

```ts
import { buildFundLeg, submitSolanaInstructionsV1 } from "@rome-protocol/sdk";

const ixs = buildFundLeg({ programId, chainId, mint, amount, wallet: keypair.publicKey, synthetic });
const { signature } = await submitSolanaInstructionsV1(ixs, { connection, signer: keypair });
```

The wallet is the only signer. A v1 message carries the compute-unit limit in its config rather than in a ComputeBudget instruction, so pass `computeUnitLimit` instead of adding one (a ComputeBudget instruction is refused). Left out, it is 200,000 per instruction, capped at 1,400,000; the v1 priority fee is a flat amount, so a generous limit costs nothing extra. Every message also carries a loaded-accounts data size of 64 MiB, because the cluster reads a missing value as 0 and would fail the transaction on the first account it loads. A message may hold up to 64 instructions, 64 account keys and the signed transaction up to 4096 bytes; the SDK throws before signing if it would not fit. `compileV1Message` is the underlying compiler, the inverse of `parseV1Message`.

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
| `buildFundLeg` / `buildSweepLeg` / `submitSolanaInstructions` | value-in (ActivateAta) / value-out (transfer_spl) / native-instruction submit (legacy transaction) |
| `submitSolanaInstructionsV1(ixs, deps)` | send plain instructions (the fund leg, a token-account creation) as one v1 transaction, signed by your `Keypair` or `LaneSigner` |
| `compileV1Message` | compile plain instructions into a v1 message: the inverse of `parseV1Message` |
| `submitRomeTxV1(deps, call)` | the v1 Solana lane: one composed v1 transaction, two signatures from one key, relay on refusal |
| `relayV1` / `fundSyntheticGas` / `waitForReceipt` | relay a call through the proxy / top up native gas from the wallet's gas-token account / poll the EVM receipt |
| `toLaneSigner` / `authHashFor` / `ed25519AuthMessage` / `ED25519_AUTH_MESSAGE_PREFIX` | signer wrapper and the readable authorization message |
| `isAtomicRefusal` / `splitV1Wire` / `packSignedV1Wire` / `parseV1Message` | v1 wire helpers (the composed transaction is fetched and checked inside `submitRomeTxV1`, never handed back unchecked) |
| `provisionSynthetic` / `isSyntheticProvisioned` / `buildCreatePdaCall` | fresh-synthetic provisioning (`create_pda`) — auto on first `submitRomeTxSolanaLane` |
| `syntheticAddress` / `emulateCallAccounts` / `buildDoTxUnsigned` / `buildActivateAtaInstruction` / `treasureWallet` / `balanceKeyPda` / `computeBudgetIxs` / `SyntheticNonceTracker` | Solana-lane primitives |
| `PRECOMPILE_ADDRESSES` / `CPI_ABI` / `HELPER_ABI` / `WITHDRAW_ABI` / `SYSTEM_ABI` / `SELECTORS` / `EXTERNAL_AUTHORITY_SEED` | precompile addresses, ABIs, and verified selectors |

Precompile addresses, ABIs, and verified selectors are exported directly (each selector is checked against `keccak256(sig)` in CI). Solidity interfaces live in the public [`rome-solidity`](https://github.com/rome-protocol/rome-solidity) repo.

## Building with an AI agent?

See [`AGENTS.md`](./AGENTS.md) — the Rome-specific rules a coding agent needs.

## License

MIT
