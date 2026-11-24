# Changelog

## Unreleased

- Gas: a call can require a real estimate. `submitRomeTx`, `submitRomeTxV1`, `relayV1` and `sizeSolanaLaneFee` take `requireEstimate: true`: a thrown `eth_estimateGas`, or an answer of exactly 21,000 (Rome's answer when its emulation fails), counts as no estimate and the call stops with `RomeEstimateUnavailableError` before anything is signed, instead of signing the fixed 250M ceiling. An explicit `fallbackGas` still wins. Default is off, so nothing changes for a caller that does not pass it. New exports: `RomeEstimateUnavailableError`, `ROME_ESTIMATE_FLOOR`, `sizeFromEstimate`.
- Docs: the `write.ts` header, the README and AGENTS.md now say what gas is on Rome (the call's Solana cost, new accounts included; the estimate follows it; the 1.3x pad covers the estimate-to-send gap) and that the limit is enforced on a signed send and on the relay route, so over-provisioning is not free there.
- A message to the zero address is refused: `encodeBridgeMessage`, `encodeBridgeMessageWETH`, `sendMessageFromEvm`, `sendMessageFromSolanaWallet` and the API client's `sendStep` (a zero `receiver`) throw before anything is built or sent.

## 0.6.0

- Add the Solgate messages API client to `@rome-protocol/sdk/messages`: `createMessagesClient({ base })` with `record`, `list` (by `wallet`, `sender`, `receiver`, or a `since` feed), `get`, `proof`, `claimStep`, `claimSteps` (up to 10 together), `sendStep` and `waitReady` (it retries a rate limit, an unavailable upstream and network errors), typed answers, and `SolgateApiError` with the API's codes (`SOLGATE_ERROR_CODES`). It signs and sends nothing.
- README: the install line names v0.6.0, the first tag with the messages API client.

## 0.5.0

- Add `evmTxIdFor(signingHash, pubkey)`: the sender-bound transaction id of a Solana-wallet call, `keccak256("RomeSolanaV1TxId" || signingHash || ed25519Pubkey)`. The signing (authorization) hash from `authHashFor` is unchanged.
- `submitRomeTxV1` and `relayV1` accept either the authorization hash or the sender-bound id from the proxy. On the atomic route the id in the compose answer's `evmTxHash` is polled when present (it must be one of the two ids, checked before the wallet signs the transaction), otherwise the authorization hash.
- A receipt is accepted only when `receipt.from` is this wallet's synthetic sender and `receipt.transactionHash` is one of the two locally computed ids; another wallet's receipt for the same payload is ignored and polling continues. `result.hash` is now the receipt's own `transactionHash`.
- `waitForReceipt` takes an optional `accept` predicate.
- Docs: the hash in the `Rome authorization` message is the authorization hash, not the transaction id.
