# Changelog

## Unreleased

- Add the Solgate messages API client to `@rome-protocol/sdk/messages`: `createMessagesClient({ base })` with `record`, `list` (by `wallet`, `sender`, `receiver`, or a `since` feed), `get`, `proof`, `claimStep`, `claimSteps` (up to 10 together), `sendStep` and `waitReady`, typed answers, and `SolgateApiError` with the API's codes (`SOLGATE_ERROR_CODES`). It signs and sends nothing.
- README: the install line names v0.5.0, the tag that has the on-chain messages half; the API client section says it comes with the next tag.

## 0.5.0

- Add `evmTxIdFor(signingHash, pubkey)`: the sender-bound transaction id of a Solana-wallet call, `keccak256("RomeSolanaV1TxId" || signingHash || ed25519Pubkey)`. The signing (authorization) hash from `authHashFor` is unchanged.
- `submitRomeTxV1` and `relayV1` accept either the authorization hash or the sender-bound id from the proxy. On the atomic route the id in the compose answer's `evmTxHash` is polled when present (it must be one of the two ids, checked before the wallet signs the transaction), otherwise the authorization hash.
- A receipt is accepted only when `receipt.from` is this wallet's synthetic sender and `receipt.transactionHash` is one of the two locally computed ids; another wallet's receipt for the same payload is ignored and polling continues. `result.hash` is now the receipt's own `transactionHash`.
- `waitForReceipt` takes an optional `accept` predicate.
- Docs: the hash in the `Rome authorization` message is the authorization hash, not the transaction id.
