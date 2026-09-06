/**
 * sdkTon.js — READINESS SCAFFOLDING for the official TON SDK (`@ton/ton`,
 * pinned ^16.3.0 — verified on npm 2026-09-06).
 *
 * ROADMAP LEG: TON source chain. Rango's chain list includes TON ✅
 * (docs/ROUTING-ENGINE.md §10) and the ENGINE-UPDATE expansion names TON as
 * a roadmap source. This module exists so the official @ton/ton SDK is
 * GRABBED, version-pinned and import-verified for the future in-app TON leg
 * (address handling, balance reads, and tx construction through
 * WalletContractV4/beginCell when TON construction moves in-app).
 *
 * ⛔ NOT WIRED. Nothing in the app imports this module. No funds, no
 * broadcasts — import/verify only.
 *
 * SHAPE VERIFIED at 16.3.0 (probe, 2026-09-06): exports Address, TonClient,
 * WalletContractV4 (+174 exports total). Offline wallet-address build +
 * parse roundtrip executed successfully.
 */

import { makeSdkLoader } from "./sdkLoader.js";

/** Cached lazy loader — the checked `@ton/ton` namespace. */
export const loadTonSdk = makeSdkLoader("@ton/ton", {
  exports: ["Address", "TonClient", "WalletContractV4"],
});

/**
 * Parse + validate a TON address through the official lib (throws on
 * invalid). Offline.
 * @param {string} address EQ… / UQ… friendly address
 * @returns {Promise<object>} a @ton/ton Address
 */
export async function parseTonAddress(address) {
  const { Address } = await loadTonSdk();
  return Address.parse(address);
}

/**
 * Read a TON balance through an official TonClient the caller owns.
 * @param {import("@ton/ton").TonClient} client a TonClient (mainnet/testnet)
 * @param {string} address friendly EQ…/UQ… address
 * @returns {Promise<bigint>} balance in nanoTON
 */
export async function getTonBalance(client, address) {
  const { Address } = await loadTonSdk(); // pin/verify the SDK is the grabbed one
  return client.getBalance(Address.parse(address));
}

/**
 * Build a v4 wallet contract from a public key — offline; the future leg's
 * starting point for TON tx construction (WalletContractV4.create →
 * contract.createTransfer(…)).
 * @param {Uint8Array} publicKey 32 bytes
 * @param {object} [opts]
 * @param {number} [opts.workchain]
 * @returns {Promise<object>} a @ton/ton WalletContractV4
 */
export async function createTonV4Wallet(publicKey, { workchain = 0 } = {}) {
  const { WalletContractV4 } = await loadTonSdk();
  return WalletContractV4.create({ workchain, publicKey: Buffer.from(publicKey) });
}
