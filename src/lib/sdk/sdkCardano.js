/**
 * sdkCardano.js — READINESS SCAFFOLDING for the official Cardano CSL SDK:
 * `@emurgo/cardano-serialization-lib-browser` (pinned ^17.0.0 — the current
 * Emurgo package line; the old monolithic `cardano-serialization-lib` died
 * at 10.0.0-beta.16 in 2022 and the -asmjs/-nodejs/-browser twins are the
 * maintained split — verified on npm 2026-09-06. The -browser twin is the
 * right one for the SPA and ALSO imports + executes cleanly under the repo's
 * Node test harness (wasm embedded — probe-verified with a real address
 * roundtrip)).
 *
 * ROADMAP LEG: ADA. Honest status per docs/ROUTING-ENGINE.md §10/§11: ADA
 * has NO quotable rail in [THORChain, Rango, Wanchain] today (Rango's
 * /basic/meta chain list has no CARDANO; Wanchain XFlows v3 quotes EVM
 * pairs only) — an ADA leg lands only when a rail adds the chain or an
 * ADA-native path is ruled. This module exists so CSL is GRABBED,
 * version-pinned and import-verified ahead of that ruling (address/asset
 * handling + tx construction through the official (de)serialization lib).
 *
 * ⛔ NOT WIRED. Nothing in the app imports this module. No funds, no
 * broadcasts — import/verify only.
 *
 * SHAPE VERIFIED at 17.0.0 (probe, 2026-09-06): 297 exports incl. Address,
 * BaseAddress, Credential, Ed25519KeyHash, PrivateKey — and a full offline
 * key → base-address derivation + bech32 roundtrip executed successfully
 * (wasm alive).
 */

import { makeSdkLoader } from "./sdkLoader.js";

/** Cached lazy loader — the checked CSL namespace. */
export const loadCardanoSdk = makeSdkLoader(
  "@emurgo/cardano-serialization-lib-browser",
  {
    exports: ["Address", "BaseAddress", "Credential", "PrivateKey", "Ed25519KeyHash"],
  },
);

/**
 * Parse a bech32 Cardano address through the official lib (throws on
 * invalid). Offline.
 * @param {string} bech32 addr1… / addr_test1…
 * @returns {Promise<object>} a CSL Address
 */
export async function cardanoAddressFromBech32(bech32) {
  const ns = await loadCardanoSdk();
  return ns.Address.from_bech32(bech32);
}

/**
 * Derive a deterministic mainnet base address from 32 seed bytes — offline
 * proof the wasm executes (used by the smoke test). The future ADA leg
 * derives real addresses from the user's keys the same way.
 * @param {Uint8Array} [seedBytes] 32 bytes (default: fixed test vector)
 * @returns {Promise<string>} bech32 addr1… address
 */
export async function deriveCardanoAddress(seedBytes = new Uint8Array(32).fill(7)) {
  const ns = await loadCardanoSdk();
  const pub = ns.PrivateKey.from_normal_bytes(seedBytes).to_public();
  const base = ns.BaseAddress.new(
    1, // mainnet network id
    ns.Credential.from_keyhash(pub.hash()),
    ns.Credential.from_keyhash(pub.hash()),
  );
  return base.to_address().to_bech32();
}
