// lint-public-surface.mjs — public-surface conformance for the SDK.
//
// Two invariants, both fail-closed:
//   1. Every tracked .json file parses.
//   2. Every URL host in the tree is on the PUBLIC allowlist below.
//
// The allowlist is deliberately positive (expected public hosts only) — this
// repo must never carry a deny-list of names that don't belong here. Adapted
// from the registry's lint; the SDK is a self-contained TS package (its lockfile
// resolves entirely from npmjs.org — no git deps).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EXACT = new Set([
  "github.com",
  "cdn.jsdelivr.net",
  "registry.npmjs.org",
  "api.devnet.solana.com",
  "api.testnet.solana.com",
  "api.mainnet-beta.solana.com",
  "explorer.solana.com",
]);
// One-label public Rome hosts (never deeper).
const ROME_PUBLIC = /^[a-z0-9-]+\.(testnet|devnet|mainnet)\.romeprotocol\.xyz$/;
// RFC 2606 reserved documentation TLD — placeholder hosts in examples/docs.
const isDocPlaceholder = (host) => host === "example" || host.endsWith(".example");

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n");
const failures = [];

for (const f of files) {
  const text = readFileSync(f, "utf8");
  if (f.endsWith(".json")) {
    try {
      JSON.parse(text);
    } catch (e) {
      failures.push(`${f}: invalid JSON — ${e.message}`);
    }
  }
  if (f === "package-lock.json") {
    // Its one security invariant is provenance: every package resolves from npm.
    for (const m of text.matchAll(/"resolved":\s*"([^"]+)"/g)) {
      if (!m[1].startsWith("https://registry.npmjs.org/")) {
        failures.push(`${f}: package resolved outside registry.npmjs.org — ${m[1]}`);
      }
    }
    continue;
  }
  for (const m of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
    const host = m[1].toLowerCase();
    if (!EXACT.has(host) && !ROME_PUBLIC.test(host) && !isDocPlaceholder(host)) {
      failures.push(`${f}: host not on the public allowlist — ${host}`);
    }
  }
}

if (failures.length) {
  console.error(`public-surface lint FAILED (${failures.length}):`);
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`public-surface lint OK — ${files.length} files: JSON validity + host allowlist clean`);
