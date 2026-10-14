// api/warp/signatures.js — serverless proxy for the Warp guardian-signatures
// endpoint: {base}/transactions/{sig}/signatures?from={from}
//
// Part of fix/proxy-warp-poll: the release poll (X1 burn → Solana release)
// previously fetched api.bridge.mainnet.x1.xyz DIRECTLY from the browser and
// got stuck in the field while being provably correct server-side. This
// proxy makes the poll a same-origin fetch to the app's own backend — no
// CORS, no cache, no browser-network variance. See api/_warp.js for the
// full rationale + fail-closed contract.
import { createWarpProxy } from "../_warp.js";

/** Factory — tests inject fetchImpl/baseUrl; the default export is what
 *  Vercel invokes (real fetch, mainnet base). */
export const createWarpSignaturesProxy = (deps = {}) =>
  createWarpProxy({ ...deps, kind: "signatures" });

export default createWarpSignaturesProxy().handler;
