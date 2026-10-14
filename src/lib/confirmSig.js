/**
 * confirmSig.js — robust POST-BROADCAST confirmation via ON-CHAIN polling.
 *
 * WHY THIS EXISTS (F1, real-funds full-route dust pass 2026-09-19)
 *   connection.confirmTransaction(sig, "confirmed") in @solana/web3.js confirms
 *   over the RPC **WebSocket** (signatureSubscribe). On api.mainnet.solana.com
 *   the WS endpoint can be unreachable while the plain HTTPS JSON-RPC is fine.
 *   The subscription then never fires, confirmTransaction rejects with
 *   "Transaction was not confirmed in 30.00 seconds. It is unknown if it
 *   succeeded or failed. Check signature …", and a caller that treats that
 *   rejection as "hop failed" ABORTS the route — even though the bridge_out had
 *   ALREADY LANDED on-chain (err:null, slot 448404000, ~1s after broadcast).
 *   That is exactly how a real Warp bridge_out was stranded: the funds were
 *   locked by a tx the wallet then declared failed.
 *
 * THE FIX
 *   After a successful broadcast (we already hold a signature from
 *   sendRawTransaction), confirm by POLLING getSignatureStatuses over HTTPS —
 *   no WebSocket — with backoff. Crucially:
 *     • an on-chain failure (err != null) is surfaced as `{ ok:false, failed }`
 *       (the tx truly reverted — safe to stop);
 *     • a confirmation TIMEOUT (or an unreachable status RPC) NEVER throws and
 *       NEVER signals failure: once a tx is broadcast we return `broadcast:true`
 *       and let the caller's arrival check (the X1 seq-poll / balance-watch) be
 *       the source of truth. We never abort AFTER funds are already bridged.
 *
 * FAIL-CLOSED IS PRESERVED UPSTREAM: "nothing broadcast → stop" still lives in
 * guardedSendSolanaTx / the per-hop executors — a simulation failure or a
 * broadcast error still blocks, with no signature, before this module runs.
 *
 * PURE / INJECTABLE: only `connection` (any object exposing getSignatureStatuses
 * or getSignatureStatus) plus injected `now`/`sleep` are used — no timers or
 * network at module scope — so it runs under `node --test`.
 */

export const DEFAULT_CONFIRM_POLL = Object.freeze({
  timeoutMs: 30000,     // matches the old confirmTransaction budget
  intervalMs: 800,
  maxIntervalMs: 4000,  // backoff ceiling
});

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pull the single status object out of the several RPC response shapes. */
function statusOf(res) {
  if (res == null) return null;
  if (Array.isArray(res?.value)) return res.value[0] ?? null;
  if (typeof res === "object" && ("err" in res || "confirmationStatus" in res || "slot" in res)) return res;
  return null;
}

/** One status read (HTTPS RPC — no WebSocket). Returns the status object or null. */
export async function getSignatureStatus(connection, signature) {
  if (typeof connection?.getSignatureStatuses === "function") {
    const r = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    return statusOf(r);
  }
  if (typeof connection?.getSignatureStatus === "function") {
    return statusOf(await connection.getSignatureStatus(signature, { searchTransactionHistory: true }));
  }
  return null;
}

/**
 * Confirm a broadcast signature by polling. NEVER throws for a timeout / RPC
 * hiccup; only a real on-chain error is reported as failed.
 *
 * @returns {Promise<{
 *   ok: boolean,            // true unless the tx FAILED on-chain
 *   broadcast: boolean,     // always true here (a signature exists)
 *   confirmed: boolean,     // reached confirmed/finalized with err:null
 *   failed?: boolean, err?: any, slot?: number|null,
 *   timedOut?: boolean, sawStatus?: boolean, rpcError?: string|null,
 *   signature: string,
 * }>}
 */
export async function confirmSignatureViaPoll(connection, signature, opts = {}) {
  const { timeoutMs, intervalMs, maxIntervalMs } = { ...DEFAULT_CONFIRM_POLL, ...opts };
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const start = now();
  let interval = intervalMs;
  let sawStatus = false;
  let rpcError = null;

  for (;;) {
    let status = null;
    try {
      status = await getSignatureStatus(connection, signature);
    } catch (e) {
      rpcError = e?.message || String(e);
    }

    if (status) {
      sawStatus = true;
      if (status.err != null) {
        // the tx reverted ON-CHAIN — a genuine failure (nothing landed).
        return { ok: false, failed: true, broadcast: true, confirmed: false, err: status.err, slot: status.slot ?? null, signature };
      }
      const c = String(status.confirmationStatus ?? "").toLowerCase();
      if (c === "confirmed" || c === "finalized") {
        return { ok: true, confirmed: true, broadcast: true, slot: status.slot ?? null, signature };
      }
    }

    if (now() - start >= timeoutMs) break;
    await sleep(Math.min(interval, maxIntervalMs));
    interval = Math.min(interval * 2, maxIntervalMs);
  }

  // Timed out (or the status RPC stayed unreachable) AFTER a broadcast: do NOT
  // throw and do NOT report failure. We hold a signature; the arrival check is
  // the source of truth. This is the whole point of the fix.
  return {
    ok: true, confirmed: false, broadcast: true, timedOut: true,
    sawStatus, rpcError, slot: null, signature,
  };
}
