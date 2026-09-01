/**
 * lifiSolanaTx.js — execute a LI.FI Solana transaction with the connected
 * Solana/X1 wallet (extracted from Teleporter.jsx `executeLiFiSolanaTx`,
 * Step 3.1 — the THORChain hop's auto-advance reuses this instead of
 * duplicating it).
 *
 * The logic is byte-for-byte the body that lived inside the Teleporter
 * component: locate the executable tx in the quote (transactionRequest /
 * transactionData / includedSteps), materialise it via the
 * /api/lifi/stepTransaction proxy when the quote carries none (common for
 * Solana), deserialise the base64 VersionedTransaction, MANDATORY pre-send
 * simulation (Step 1.3A fail-closed — a failed or unavailable simulation
 * BLOCKS the send and surfaces the reason), then sign + broadcast via the
 * connected wallet (signAndSendTransaction, or signTransaction + RPC send).
 *
 * PURE OF WINDOW: the wallet and the provider-lister are injected, so this
 * module never reads injected globals (noWindowProbe rule) and runs under
 * node --test with mocks.
 */

import { simulateSolanaTx, SimulationError } from "./simulateTx.js";

/** Locate the executable Solana tx payload inside a LI.Fi quote (any shape). */
export function extractSolanaTxPayload(lifiData) {
  const txReq =
    lifiData?.transactionRequest ||
    lifiData?.steps?.[0]?.transactionRequest ||
    lifiData?.transactionData ||
    lifiData?.steps?.[0]?.transactionData;
  const b64 = txReq?.data || txReq?.transaction || (typeof txReq === "string" ? txReq : null);
  return { txReq, b64 };
}

/**
 * Execute a LI.Fi Solana transaction.
 *
 * @param {object} args
 * @param {object} args.lifiData the LI.Fi quote (or step) carrying the tx
 * @param {object|null} args.solWallet connected Solana wallet session ({provider})
 * @param {() => Array<{provider:object}>} [args.listSolProviders] fallback provider lister
 * @param {string} [args.apiBase] API base for the /api/lifi/stepTransaction proxy
 * @param {string} [args.solanaRpc] Solana RPC URL for simulation + RPC sends
 * @returns {Promise<string>} the transaction signature
 */
export async function executeLiFiSolanaTx({
  lifiData,
  solWallet,
  listSolProviders,
  apiBase = "",
  solanaRpc,
}) {
  const SOLANA_RPC =
    solanaRpc ||
    (typeof import.meta !== "undefined" &&
    import.meta.env &&
    import.meta.env.VITE_SOLANA_RPC) ||
    "https://berty-633y20-fast-mainnet.helius-rpc.com";

  let { b64 } = extractSolanaTxPayload(lifiData);

  // If the quote didn't include the executable tx (common for Solana), ask
  // LiFi to materialize it via /advanced/stepTransaction using the step.
  if (!b64) {
    const step = lifiData?.includedSteps?.[0] || lifiData?.steps?.[0] || lifiData;
    console.log("[Onward leg2] no tx in quote — calling stepTransaction with step:", step?.id || "(quote)");
    try {
      const r = await fetch(`${apiBase}/api/lifi/stepTransaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(step),
      });
      const stepData = await r.json();
      console.log("[Onward leg2] stepTransaction response keys:", Object.keys(stepData || {}));
      const txReq = stepData?.transactionRequest || stepData?.steps?.[0]?.transactionRequest;
      b64 = txReq?.data || txReq?.transaction || (typeof txReq === "string" ? txReq : null);
    } catch (e) {
      console.error("[Onward leg2] stepTransaction failed:", e);
    }
  }

  if (!b64) {
    console.error(
      "[Onward leg2] STILL no tx data. Quote keys:",
      Object.keys(lifiData || {}),
      "step0 keys:",
      Object.keys(lifiData?.steps?.[0] || {}),
      "transactionRequest:",
      lifiData?.transactionRequest,
    );
    throw new Error("LiFi returned no executable Solana transaction for this route");
  }

  const sol = solWallet?.provider || listSolProviders?.()[0]?.provider || null;
  if (!sol?.signAndSendTransaction && !sol?.signTransaction) {
    throw new Error("Connect your Solana/X1 wallet to sign");
  }

  const { VersionedTransaction } = await import("@solana/web3.js");
  const { createProxiedConnection } = await import("./proxiedConnection.js");
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const vtx = VersionedTransaction.deserialize(raw);
  console.log("[Onward leg2] deserialized Solana tx, simulating…");

  // ── MANDATORY PRE-SEND SIMULATION (Step 1.3A, fail-closed) ──
  // PROXIED transport (fix/proxy-solana-x1-rpc): the simulation read goes
  // through the app's own /api/rpc/solana serverless function (the browser's
  // direct Solana-RPC fetches were blocked in the user's network — the same
  // block that broke the reverse stage-2 signing path). The broadcast below
  // stays with the connected wallet / direct RPC (the shim routes
  // sendRawTransaction straight to the real endpoint, unchanged).
  const conn = await createProxiedConnection(SOLANA_RPC, "/api/rpc/solana");
  const sim = await simulateSolanaTx(conn, vtx);
  if (!sim.ok) {
    if (sim.simUnavailable) {
      throw new SimulationError(
        `Simulation couldn't run (RPC: ${sim.rpcError || "unknown"}) — send blocked. Retry when the RPC is reachable.`,
        { code: "sim-unavailable", reason: sim.rpcError || "simulation RPC unavailable", raw: sim },
      );
    }
    const errText = typeof sim.err === "string" ? sim.err : JSON.stringify(sim.err);
    const keyLogs = (sim.logs || [])
      .filter((l) => /error|failed|assert|seq|insufficient|invalid|constraint/i.test(l))
      .slice(-2)
      .join(" | ");
    throw new SimulationError(
      `Simulation failed: ${errText}${keyLogs ? ` — ${keyLogs}` : ""}`,
      { code: "solana-sim-failed", reason: errText, raw: sim },
    );
  }

  console.log("[Onward leg2] simulation passed, signing…");
  if (typeof sol.signAndSendTransaction === "function") {
    const res = await sol.signAndSendTransaction(vtx);
    const sig = res?.signature || res;
    console.log("[Onward leg2] sent, sig:", sig);
    return sig;
  }
  const signed = await sol.signTransaction(vtx);
  const sig = await conn.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
  console.log("[Onward leg2] sent via RPC, sig:", sig);
  return sig;
}
