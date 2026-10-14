// Live proxy-path check (fix/proxy-warp-poll): run the SAME handler Vercel
// will invoke (api/warp/status.js default export path — real fetch, mainnet
// base) against the REAL Warp API with the REAL stuck reverse-burn signature,
// and confirm the proxy returns status "executed" + destTxSig. This proves
// the deployed proxy path works end to end without deploying.
import { createWarpStatusProxy } from "../api/warp/status.js";
import { createWarpSignaturesProxy } from "../api/warp/signatures.js";

const SIG = "4eiHySR4X4QpBzGyNMVPKzeALSnm7558WWA9RWeZ6TLe1RKH6iQf7zDSAfwxDsvrqJwQB5QSZmn6L1X1ULfx2JvH";

function fakeReq(query) {
  return { headers: {}, method: "GET", query };
}
function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

const statusProxy = createWarpStatusProxy(); // real fetch, mainnet base — the deployed default export
const sigProxy = createWarpSignaturesProxy();

const statusRes = fakeRes();
await statusProxy.handler(fakeReq({ sig: SIG, from: "x1" }), statusRes);

const sigRes = fakeRes();
await sigProxy.handler(fakeReq({ sig: SIG, from: "x1" }), sigRes);

console.log("status handler  HTTP", statusRes.statusCode);
console.log("signatures handler HTTP", sigRes.statusCode);

const t = statusRes.body?.transaction || statusRes.body || {};
console.log("status:", t.status);
console.log("destTxSig:", t.destTxSig || t.destinationTxSignature || t.destination_tx || null);
console.log("signaturesCollected:", t.signaturesCollected, "signaturesRequired:", t.signaturesRequired);

const sigs = Array.isArray(sigRes.body) ? sigRes.body : (sigRes.body?.signatures || []);
console.log("guardian sigs returned:", Array.isArray(sigs) ? sigs.length : "n/a");

const ok =
  statusRes.statusCode === 200 &&
  String(t.status || "").toLowerCase() === "executed" &&
  Boolean(t.destTxSig || t.destinationTxSignature || t.destination_tx);

console.log(ok ? "LIVE CHECK PASS ✓ — proxy returns executed + destTxSig" : "LIVE CHECK FAILED ✗");
process.exit(ok ? 0 : 1);
