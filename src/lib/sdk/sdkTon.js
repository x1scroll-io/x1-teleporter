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
 *
 * 2026-09-30 EXTENSION — the TON native-DEX lane (tonSwapLeg): stonfiSdk and
 * dedustSdk loaders added beside the @ton/ton loader (both dynamic — no chunk
 * pollution, no network at import). SHAPE VERIFIED at @ston-fi/sdk@2.7.0:
 * exports DEX (DEX.v1.Router / DEX.v1.Pool / DEX.v1.pTON), DEX_TYPE,
 * DEX_VERSION, pTON, toUnits, fromUnits; DEX.v1.Router.address === the
 * registry's STON.fi v1 Router. SHAPE VERIFIED at @dedust/sdk@0.8.7: exports
 * Factory, MAINNET_FACTORY_ADDR, Pool, PoolType, Asset, AssetType, Vault,
 * VaultNative, VaultJetton (DeDust fallback lane).
 */

import { makeSdkLoader } from "./sdkLoader.js";

/** Cached lazy loader — the checked `@ton/ton` namespace. */
export const loadTonSdk = makeSdkLoader("@ton/ton", {
  exports: ["Address", "TonClient", "WalletContractV4"],
});

/** Cached lazy loader — the checked `@ston-fi/sdk` namespace (STON.fi DEX). */
export const loadStonfiSdk = makeSdkLoader("@ston-fi/sdk", {
  exports: ["DEX", "DEX_TYPE", "DEX_VERSION", "pTON", "toUnits", "fromUnits"],
});

/** Cached lazy loader — the checked `@dedust/sdk` namespace (DeDust fallback). */
export const loadDedustSdk = makeSdkLoader("@dedust/sdk", {
  exports: ["Factory", "MAINNET_FACTORY_ADDR", "Pool", "PoolType", "Asset", "AssetType", "Vault", "VaultNative", "VaultJetton"],
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

/**
 * Construct a STON.fi v1 Router contract handle (offline — the constructor
 * only stores the address; every read/build method takes an injected
 * ContractProvider). The tonSwapLeg uses this as the swap builder.
 * @param {string} [address] the router address (default: the SDK's own
 *   DEX.v1.Router.address — the registry's verified STON.fi router).
 * @returns {Promise<object>} a @ston-fi/sdk DEX.v1.Router
 */
export async function createStonfiRouterV1(address) {
  const { DEX } = await loadStonfiSdk();
  return address ? new DEX.v1.Router(address) : new DEX.v1.Router();
}

/**
 * The STON.fi v1 Router address (from the SDK — cross-checked against the
 * registry by sdkTon.test.js). Used as the tonSwapLeg's default swap entry
 * point.
 * @returns {Promise<string>} EQ… friendly address
 */
export async function getStonfiRouterAddress() {
  const { DEX } = await loadStonfiSdk();
  return DEX.v1.Router.address.toString();
}

/**
 * The DeDust mainnet Factory address (the swap entry point — DeDust has no
 * single router). From the SDK's MAINNET_FACTORY_ADDR.
 * @returns {Promise<string>} EQ… friendly address
 */
export async function getDedustFactoryAddress() {
  const { MAINNET_FACTORY_ADDR } = await loadDedustSdk();
  return MAINNET_FACTORY_ADDR.toString();
}
