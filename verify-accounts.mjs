#!/usr/bin/env node
/**
 * verify-accounts.mjs — Warp account drift guard.
 *
 * Re-derives every PDA-based Warp account from the spec seeds and checks every
 * FIXED account against the two finalized on-chain transactions that prove them.
 * Runs on `npm run build` (prebuild) and standalone via `npm run verify`.
 *
 * Ground-truth transactions:
 *   forward lock : 5EwuE3rr4exxnzaVNLzfZ9kUbrqWmz43Bj6bWgWE6Qy9trLVAkz7sQF12BkBzXVsBAtLw7LEMjVQkrETGcq3nSPU
 *   reverse burn : 4yZdEJncRsNS9CZpVkGAitVCmWZoy2K6BPcFpYyRo9b1myubJpW4hf2WqukegQjQ9SWEeFzxB3VzMxi3DCX6pn7m
 *
 * A stale constant (e.g. the wrong 687zD fee account) fails HERE, loudly, at
 * build time — instead of surfacing as "Assertion failed" mid-bridge.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
// Mint constants may now be expressed as `new PublicKey(requireToken("SYM",
// "chain").address)` — resolve those through the canonical registry so the
// drift check still sees the ACTUAL value the module will use at runtime.
import { requireToken } from "./src/lib/tokenResolver.js";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "src", "warpBridge.js"), "utf8");

const PROG = new PublicKey("6JbPTuxVuoTgyQeXFb9MH8C8nUY8NBbLP1Lu4B13JfMD");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");   // Solana-native USDC
const USDCX = new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq"); // X1 wrapped USDC.x
const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROG)[0].toBase58();

// Pull `NAME: new PublicKey("...")` / `NAME = new PublicKey("...")` from
// source, or the resolver form `NAME = new PublicKey(requireToken("SYM",
// "chain").address)` (resolved through tokenResolver so the compared value is
// the real runtime address).
function actual(name) {
  const literal = src.match(new RegExp(name + "\\s*[:=]\\s*new PublicKey\\(\\s*\"([1-9A-HJ-NP-Za-km-z]{32,44})\""));
  if (literal) return literal[1];
  const viaResolver = src.match(new RegExp(name + "\\s*[:=]\\s*new PublicKey\\(\\s*requireToken\\(\"([^\"]+)\",\\s*\"([^\"]+)\"\\)\\.address\\)"));
  if (viaResolver) return requireToken(viaResolver[1], viaResolver[2]).address;
  throw new Error(`could not find constant "${name}" in src/warpBridge.js`);
}

// [ label, actual-from-source, expected, how-we-know ]
const checks = [
  // --- Forward (Solana -> X1), derivable per spec ---
  ["config",             actual("config"),           pda([enc("config")]),                                                     "PDA[config]"],
  ["tokenRegistry",      actual("tokenRegistry"),    pda([enc("token_registry"), USDC.toBytes()]),                             "PDA[token_registry, USDC]"],
  ["vault",              actual("vault"),            pda([enc("vault"), USDC.toBytes()]),                                      "PDA[vault, USDC]"],
  ["vaultTokenAccount",  actual("vaultTokenAccount"),getAssociatedTokenAddressSync(USDC, new PublicKey(pda([enc("vault"), USDC.toBytes()])), true, TOKEN_PROGRAM_ID).toBase58(), "ATA[USDC, vault]"],
  // --- Forward fixed accounts, pinned from tx 5EwuE3rr (Operation: lock) ---
  ["feePda",             actual("feePda"),           "7bz2ZNphReLcmwv1tbhG8VnR1RzAzyxPNuKa3s2Jig7j",                           "tx 5EwuE3rr acct #8"],
  ["feeCollectorAta",    actual("feeCollectorAta"),  "6ob9XW6f6mweGu5sGh3JwW2Vp6UNQApjuPvrubXMQXyi",                           "tx 3A6FeNFD BridgeOut acct #10 / inner transferChecked (got the 1 USDC fee)"],
  // --- Reverse (X1 -> Solana) ---
  ["X1_USDCX_MINT",      actual("X1_USDCX_MINT"),    USDCX.toBase58(),                                                         "X1 wrapped mint"],
  ["X1_FEE_COLLECTOR",   actual("X1_FEE_COLLECTOR"), "7bz2ZNphReLcmwv1tbhG8VnR1RzAzyxPNuKa3s2Jig7j",                           "tx 4yZdEJnc acct #8"],
  ["X1_FEE_ACCOUNT",     actual("X1_FEE_ACCOUNT"),   "4uRFjqVU5ZKkp7hQLx3Lm3YeWFts17ER8a5HLUE18ayG",                           "tx 4yZdEJnc acct #9 (got the 1 USDC.x fee)"],
];

let failed = 0;
console.log("\nWarp account verification (spec derivations + pinned on-chain txs)\n");
for (const [label, got, want, how] of checks) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? "OK  " : "FAIL"}  ${label.padEnd(18)} ${how}`);
  if (!ok) {
    console.log(`        in code : ${got}`);
    console.log(`        expected: ${want}`);
  }
}
console.log();
if (failed) {
  console.error(`✗ ${failed} account(s) drifted. Refusing to build. Fix src/warpBridge.js.\n`);
  process.exit(1);
}
console.log("✓ all Warp accounts verified.\n");
