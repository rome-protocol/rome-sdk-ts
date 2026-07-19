# @rome-protocol/sdk

> **Built on [Rome Protocol](https://docs.rome.builders)** — EVM chains that run natively inside the Solana runtime, where Solidity apps call Solana programs atomically (CPI) and Solana users drive EVM apps: two VMs, one chain, one block.

TypeScript SDK for building on [Rome](https://github.com/rome-protocol) — EVM chains that run on Solana. It handles the Rome-specific write path, fee sizing, PDA derivation, and CPI calldata encoding so your app doesn't re-derive them.

## Install

Repo-first — install from the repo, pinned to a release tag (npm publish is deferred until demand):

```
npm install github:rome-protocol/rome-sdk-ts#v0.1.0 viem @solana/web3.js @solana/spl-token
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
| `PRECOMPILE_ADDRESSES` / `CPI_ABI` / `HELPER_ABI` / `WITHDRAW_ABI` / `SYSTEM_ABI` / `SELECTORS` / `EXTERNAL_AUTHORITY_SEED` | precompile addresses, ABIs, and verified selectors |

Precompile addresses, ABIs, and verified selectors are exported directly (each selector is checked against `keccak256(sig)` in CI). Solidity interfaces live in the public [`rome-solidity`](https://github.com/rome-protocol/rome-solidity) repo.

## Building with an AI agent?

See [`AGENTS.md`](./AGENTS.md) — the Rome-specific rules a coding agent needs.

## License

MIT
