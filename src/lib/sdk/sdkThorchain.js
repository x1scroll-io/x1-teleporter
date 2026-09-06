/**
 * sdkThorchain.js — READINESS SCAFFOLDING for the official THORChain SDK
 * family: `@xchainjs/xchain-thorchain` (pinned ^3.1.1) + its core
 * `@xchainjs/xchain-client` (pinned ^2.0.17) — versions verified on npm
 * 2026-09-06.
 *
 * ROADMAP LEG: future cosmos/thorchain legs. The leg-sdk audit's verdict
 * (docs/LEG-SDK-AUDIT.md §1/§4.3): the THORChain deposit MEMO is a protocol
 * DATA STRING (THORNode SwapMemo.String() scheme) and even the official
 * xchain-thorchain SDK takes memos as CALLER-SUPPLIED strings — its
 * deposit()/prepareTx() never build one. The app's memo module
 * (src/lib/thorchain/memo.js) therefore STAYS the memo builder, and the
 * deposit tx today is executed out-of-band in the user's external wallet
 * (family "external"). This module exists so the SDK family is GRABBED,
 * version-pinned and import-verified for the day an in-app THORChain/Cosmos
 * deposit-tx leg lands (it would construct the tx through xchain-thorchain's
 * Client and hand it the caller-supplied memo from the app's memo module).
 *
 * ⛔ NOT WIRED. Nothing in the app imports this module. No funds, no
 * broadcasts — import/verify only.
 *
 * SHAPE VERIFIED at 3.1.1 / 2.0.17 (probe, 2026-09-06): xchain-thorchain
 * exports Client (+ ClientKeystore/ClientLedger + RUNE/asset constants);
 * xchain-client exports BaseXChainClient. (Instantiating a Client requires a
 * phrase + network + thornode endpoints — left to the future leg; the class
 * accessors below exist so wiring code constructs through the SAME pinned
 * classes the smoke tests verify.)
 */

import { makeSdkLoader } from "./sdkLoader.js";

/** Cached lazy loader — the checked `@xchainjs/xchain-thorchain` namespace. */
export const loadThorchainSdk = makeSdkLoader("@xchainjs/xchain-thorchain", {
  exports: ["Client"],
});

/** Cached lazy loader — the checked `@xchainjs/xchain-client` namespace. */
export const loadXchainClientSdk = makeSdkLoader("@xchainjs/xchain-client", {
  exports: ["BaseXChainClient"],
});

/**
 * Resolve the official THORChain Client class (pinned + shape-checked). The
 * future in-app leg instantiates it with the caller-supplied memo from
 * src/lib/thorchain/memo.js (the audit's memo verdict — never build memos
 * inside the SDK layer).
 * @returns {Promise<Function>} the xchain-thorchain Client class
 */
export async function thorchainClientClass() {
  const ns = await loadThorchainSdk();
  return ns.Client;
}

/**
 * Resolve the official xchain-client BaseXChainClient class (the shared base
 * of the xchainjs family — the future cosmos/thorchain legs' common
 * interface).
 * @returns {Promise<Function>} the xchain-client BaseXChainClient class
 */
export async function xchainBaseClientClass() {
  const ns = await loadXchainClientSdk();
  return ns.BaseXChainClient;
}
