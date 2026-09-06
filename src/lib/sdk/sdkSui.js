/**
 * sdkSui.js — READINESS SCAFFOLDING for the official Sui SDK (`@mysten/sui`,
 * pinned ^2.29.0 — @mysten/sui.js is DEPRECATED/renamed, verified on npm
 * 2026-09-06).
 *
 * ROADMAP LEG: SUI source chain. Today Sui is a Rango rail source (real
 * SUI→SOL quotes via NearIntent, docs/ROUTING-ENGINE.md §10). This module
 * exists so the official Sui TS SDK is GRABBED, version-pinned and
 * import-verified for the future in-app Sui leg (balance reads; tx
 * construction through the SDK's Transaction builder).
 *
 * ⛔ NOT WIRED. Nothing in the app imports this module. No funds, no
 * broadcasts — import/verify only.
 *
 * SHAPE VERIFIED at 2.29.0 (probe, 2026-09-06): @mysten/sui has NO root
 * export — subpaths only (./client, ./jsonRpc, ./grpc, ./graphql, ./utils,
 * …). In this version the JSON-RPC client surface is DEPRECATED ("use
 * SuiGrpcClient from @mysten/sui/grpc or SuiGraphQLClient from
 * @mysten/sui/graphql") — the non-deprecated official balance surface is
 * **SuiGrpcClient** (`@mysten/sui/grpc`, which exports SuiGrpcClient +
 * GrpcWebFetchTransport). Constructing `new SuiGrpcClient({ network:
 * "mainnet" })` builds its own transport and fires NO network request
 * (verified). Address validation lives in `@mysten/sui/utils`.
 */

import { makeSdkLoader } from "./sdkLoader.js";

/** Cached lazy loader for the gRPC client subpath (SuiGrpcClient). */
export const loadSuiClientSdk = makeSdkLoader("@mysten/sui/grpc", {
  exports: ["SuiGrpcClient"],
});

/** Cached lazy loader for the utils subpath (address validation). */
export const loadSuiUtilsSdk = makeSdkLoader("@mysten/sui/utils", {
  exports: ["isValidSuiAddress"],
});

/**
 * Create the official Sui client for the future leg (the non-deprecated
 * gRPC client; the SDK builds its own transport). No network on
 * construction.
 * @param {object} [opts]
 * @param {"mainnet"|"testnet"|"devnet"} [opts.network]
 * @returns {Promise<import("@mysten/sui/grpc").SuiGrpcClient>}
 */
export async function createSuiClient({ network = "mainnet" } = {}) {
  const { SuiGrpcClient } = await loadSuiClientSdk();
  return new SuiGrpcClient({ network });
}

/**
 * Read a Sui balance through the official client.
 * @param {import("@mysten/sui/grpc").SuiGrpcClient} client
 * @param {string} owner 0x… address
 * @param {string} [coinType] optional coin type (defaults to SUI)
 * @returns {Promise<{totalBalance: string}>}
 */
export async function getSuiBalance(client, owner, coinType) {
  await loadSuiClientSdk(); // pin/verify the SDK is the grabbed one before use
  return client.getBalance({ owner, coinType });
}

/**
 * Validate a Sui address through the official utils.
 * @param {string} address candidate 0x… address
 * @returns {Promise<boolean>}
 */
export async function isValidSuiAddress(address) {
  const { isValidSuiAddress } = await loadSuiUtilsSdk();
  return isValidSuiAddress(address);
}
