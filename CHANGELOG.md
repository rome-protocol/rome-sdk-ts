# Changelog

## 0.7.0

- Gas: a call can require a real estimate. `submitRomeTx`, `submitRomeTxV1`, `relayV1` and `sizeSolanaLaneFee` take `requireEstimate: true`: a thrown `eth_estimateGas` counts as no estimate and the call stops with `RomeEstimateUnavailableError` before anything is signed, instead of signing the fixed 250M ceiling. An explicit `fallbackGas` (`submitRomeTx`, `sizeSolanaLaneFee`) or, on the V1 lane, an explicit `fee` still wins; `fallbackGas: null` counts as unset, as before. Default is off, so nothing changes for a caller that does not pass it. New exports: `RomeEstimateUnavailableError`, `ROME_ESTIMATE_FLOOR`, `sizeFromEstimate`.
- Gas: `requireEstimate` no longer treats an estimate of exactly 21,000 as no estimate (the clause from #30 is removed): Rome answers max(cost, 21,000) only for an emulation that succeeds and returns an error for one that fails, so 21,000 is a real estimate and is padded like any other; only a thrown estimate stops the call.
- Docs: the `write.ts` header, the README and AGENTS.md now say what gas is on Rome (the call's Solana cost, new accounts included; the estimate follows it, as max(cost, 21,000); the 1.3x pad covers small moves between the estimate and the send such as the Solana priority fee, not a new account created in between; 21,000 is the floor of a successful emulation that saw no new account, and a failed emulation is an error) and that the limit is enforced wherever Rome has a fee recipient, with limit x price required of the balance on a call that runs iteratively and by browser wallets, so over-provisioning is not free there. Only a transaction with no fee recipient ignores the limit (a Solana wallet's DoTxUnsigned and the v1 lane's atomic route); a v1 payload that is relayed is still enforced.
- A message to the zero address is refused: `encodeBridgeMessage`, `encodeBridgeMessageWETH`, `sendMessageFromEvm`, `sendMessageFromSolanaWallet` and the API client's `sendStep` (a zero `receiver`) throw before anything is built or sent.
- README: the install line names v0.7.0.

## 0.6.0

- Add the Solgate messages API client to `@rome-protocol/sdk/messages`: `createMessagesClient({ base })` with `record`, `list` (by `wallet`, `sender`, `receiver`, or a `since` feed), `get`, `proof`, `claimStep`, `claimSteps` (up to 10 together), `sendStep` and `waitReady` (it retries a rate limit, an unavailable upstream and network errors), typed answers, and `SolgateApiError` with the API's codes (`SOLGATE_ERROR_CODES`). It signs and sends nothing.
- README: the install line names v0.6.0, the first tag with the messages API client.

## 0.5.0

- Add `evmTxIdFor(signingHash, pubkey)`: the sender-bound transaction id of a Solana-wallet call, `keccak256("RomeSolanaV1TxId" || signingHash || ed25519Pubkey)`. The signing (authorization) hash from `authHashFor` is unchanged.
- `submitRomeTxV1` and `relayV1` accept either the authorization hash or the sender-bound id from the proxy. On the atomic route the id in the compose answer's `evmTxHash` is polled when present (it must be one of the two ids, checked before the wallet signs the transaction), otherwise the authorization hash.
- A receipt is accepted only when `receipt.from` is this wallet's synthetic sender and `receipt.transactionHash` is one of the two locally computed ids; another wallet's receipt for the same payload is ignored and polling continues. `result.hash` is now the receipt's own `transactionHash`.
- `waitForReceipt` takes an optional `accept` predicate.
- Docs: the hash in the `Rome authorization` message is the authorization hash, not the transaction id.
