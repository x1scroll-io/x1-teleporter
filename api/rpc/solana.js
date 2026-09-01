// api/rpc/solana.js — serverless proxy for the Solana mainnet JSON-RPC.
//
// Part of fix/proxy-solana-x1-rpc: the bridge form's Balances line read
// Solana (getTokenAccountsByOwner for USDC/WSOL) DIRECTLY from the browser
// and showed `Solana: —` in the user's network while EVM worked — the same
// browser-network block that broke the reverse stage-2 signing path. This
// proxy makes every Solana READ + simulation a same-origin fetch to the
// app's own backend — no CORS, no browser-network variance. See api/rpc/_rpc.js
// for the full rationale + fail-closed contract.
import { createRpcProxy, DEFAULT_SOLANA_RPC } from "./_rpc.js";

/** Factory — tests inject fetchImpl/upstream; the default export is what
 *  Vercel invokes (real fetch, same upstream the client used to hit). */
export const createSolanaRpcProxy = (deps = {}) =>
  createRpcProxy({
    upstream: process.env.SOLANA_RPC ?? DEFAULT_SOLANA_RPC,
    errorCode: "solana_rpc_failed",
    ...deps,
  });

export default createSolanaRpcProxy().handler;
