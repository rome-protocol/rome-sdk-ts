<!--
Public-safe AGENTS.md for building on Rome with an AI coding agent. No internal
hostnames, infra/platform names, or internal repo paths. Links marked (docs)
resolve once the docs site publishes. Keep it short — an agent reads it before
writing a line.
-->
# AGENTS.md — building on Rome with an AI coding agent

**Rome is EVM chains that run on Solana.** Your Solidity/EVM app executes inside a Solana program and can call Solana programs atomically (CPI). Two lanes reach the same chain and the same state: MetaMask/EVM tooling, and Phantom/Solana. This file is the set of Rome-specific rules to follow — vanilla-EVM habits produce plausible-but-wrong code here. Reads (`eth_call`, balances, logs) are standard; the differences are in **writes, gas, tooling, and CPI**.

## The rules that differ from vanilla EVM

### 1. Every Rome write goes through `submitRomeTx`
Do **not** send state-changing txs with raw `wagmi`/`ethers`/`viem` `writeContract`/`sendTransaction`. Rome writes have specific fee and submission semantics — use the SDK's `submitRomeTx` wrapper. Reads stay vanilla.

### 2. Gas: the estimate over-predicts; the charge is exact
`eth_estimateGas` can over-predict by a large factor — Rome charges the **exact** gas used, so do not hard-fail or size budgets off a high estimate. A plain **native-token transfer costs ~1.48M gas** on Rome (not 21k); budget for it in scripts and sweeps.

### 3. Foundry / Hardhat
`forge script` needs **`--skip-simulation`** (Rome's execution model breaks forge's local simulation). `forge create`, `cast`, and Hardhat work normally.

### 4. Calling Solana programs from Solidity (CPI — the differentiator)
Precompiles: **CPI `0xFF…08`**, **Helper `0xFF…09`**, **Withdraw `0x42…16`** (this package ships their addresses + ABIs + `interface.sol`). The account rules agents get wrong:
- the accounts array must be **non-empty**;
- the **operator and the program_id must NOT** appear in the accounts;
- to sign **as your contract**, use `HELPER.pda(address(this))` as the signer — the precompile signs as `msg.sender`, not `tx.origin`, so a router contract cannot sign a user's PDA.

Two gotchas this package encodes: precompile addresses are **lowercase** (mixed-case fails EIP-55 checksum in signing); wrap/unwrap take **rsol-wei (18-dec)**, not the mint's decimals.

### 5. Never hardcode addresses — read the registry
Chain ids, RPC URLs, contract addresses, token mints, and Solana program ids all come from **`@rome-protocol/registry`** (`getChain` / `getTokens` / `getContracts` / `getPrograms`). Hardcoded values drift and break across deploys. Precompile addresses are the exception — they're fixed, and this package ships them.

### 6. Test both lanes with a fresh wallet
A Rome feature must work on the **EVM lane** (MetaMask) *and* the **Solana lane** (Phantom). Verify each with a brand-new wallet and a tiny amount before claiming done.

### 7. When a tx fails, use the taxonomy + the cross-VM map
Rome surfaces specific failures (starved pool-payer rent, StateHolder rent, emulation-vs-simulation mismatches, nonce races). Match them against the **error taxonomy** (docs). To see the Solana settlement of a Rome tx, map it with `solanaTxForEvmTx`.

## Tooling (on the roadmap)
Agent-native tooling is in progress and will be announced when it ships:
- **`rome-mcp`** — a read-only MCP server (live registry / balance / gas / bridge / docs lookups + a rate-limited devnet faucet); holds no keys.
- **`doctor`** — a self-check (RPC config, `submitRomeTx` compliance, ALT needs, both-lane devnet smoke).
- **`create-rome-app`** — a scaffold with a runnable funded end-to-end harness.

Until then, follow the rules above and consume **`@rome-protocol/registry`** + **`@rome-protocol/sdk`** directly.
