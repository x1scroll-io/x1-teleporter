// api/rpc/x1.js — serverless proxy for the X1 mainnet JSON-RPC.
//
// Part of fix/proxy-solana-x1-rpc: the bridge form's Balances line read X1
// (getTokenAccountsByOwner for USDC.x/wSOL.X) DIRECTLY from the browser and
// showed `X1: —` in the user's network while EVM worked — the same
// browser-network block that broke the reverse stage-2 signing path. This
// proxy makes every X1 READ + simulation a same-origin fetch to the app's
// own backend — no CORS, no browser-network variance. See api/rpc/_rpc.js
// for the full rationale + fail-closed contract.
import { createRpcProxy, DEFAULT_X1_RPC } from "./_rpc.js";

/** Factory — tests inject fetchImpl/upstream; the default export is what
 *  Vercel invokes (real fetch, same upstream the client used to hit). */
export const createX1RpcProxy = (deps = {}) =>
  createRpcProxy({
    upstream: process.env.X1_RPC ?? DEFAULT_X1_RPC,
    errorCode: "x1_rpc_failed",
    ...deps,
  });

export default createX1RpcProxy().handler;
