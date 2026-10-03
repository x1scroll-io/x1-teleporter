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
 *
 * WALLET SHAPE (THE REVERSE-LEG BUG): the v2 wallet layer holds ONE session
 * per family, but a session's `provider` is the CONNECT WRAPPER
 * (createSolanaProviderAdapter → `{ family, id, isReal, walletName, adapter,
 * connect, disconnect }`) — the sign functions live at `provider.adapter`
 * (the Wallet Standard adapter). Reading `solWallet?.provider` raw and
 * checking it for sign functions therefore ALWAYS fails on a real v2
 * session — "Connect your Solana/X1 wallet to sign", the exact stage-2
 * error — and the LiFi tx is never built or submitted. The signer is
 * resolved through resolveSolanaAdapter — the SAME resolver stage 1's burn
 * path uses — which unwraps `.adapter`. The v2 form additionally passes the
 * ALREADY-RESOLVED adapter down (defaultReverseStage2Runner), so
 * resolveSolSigner accepts both shapes (see below).
 */

import { simulateSolanaTx, SimulationError } from "./simulateTx.js";
import { resolveSolanaAdapter } from "./wallet/sessionProviders.js";

const canSignSolana = (x) =>
  Boolean(
    x &&
      (typeof x.signAndSendTransaction === "function" ||
        typeof x.signTransaction === "function"),
  );

/**
 * Resolve the sign-capable Solana surface from whatever the caller injected.
 *
 * Three shapes arrive here (all covered by ONE resolver — the fix lives in
 * this function, not at the call sites):
 *   1. The RESOLVED adapter — the v2 form's defaultReverseStage2Runner passes
 *      `solAdapter` (resolveSolanaAdapter output) straight through.
 *   2. A wallet SESSION `{ provider }` — v1 Teleporter.jsx and the THORChain
 *      auto-advance pass the session; the provider may be a legacy injected
 *      wallet (sign fns at top level) or the v2 CONNECT WRAPPER (sign fns at
 *      `provider.adapter`). resolveSolanaAdapter — the proven stage-1
 *      resolver — handles both.
 *   3. The v2 connect wrapper itself (`provider.adapter`), defensively.
 * The listSolProviders fallback (v1) yields `{ key, label, provider }`
 * entries; those resolve the same way.
 *
 * @param {object|null} solWallet connected wallet session ({provider}), a
 *   resolved adapter, or null
 * @param {() => Array<{provider:object}>} [listSolProviders] fallback lister
 * @returns {Promise<object|null>} the sign-capable adapter, or null when
 *   nothing can sign (caller surfaces the honest error).
 */
export async function resolveSolSigner(solWallet, listSolProviders) {
  // 1. Already a sign-capable adapter/provider (form's resolved adapter,
  //    legacy injected wallet, test fake).
  if (canSignSolana(solWallet)) return solWallet;
  // 3. The v2 connect wrapper itself (no session envelope).
  if (canSignSolana(solWallet?.adapter)) return solWallet.adapter;
  // 2. Session shape — the proven stage-1 resolver (unwrap raw provider OR
  //    the wrapper's `.adapter`; returns null when it can't sign).
  if (solWallet?.provider) {
    const resolved = await resolveSolanaAdapter(solWallet);
    if (resolved) return resolved;
  }
  // Fallback lister (v1 Teleporter.jsx): entries are { key, label, provider }.
  const first = listSolProviders?.()?.[0];
  if (first) {
    const entry = first.provider ?? first;
    if (canSignSolana(entry)) return entry;
    if (canSignSolana(entry?.adapter)) return entry.adapter;
  }
  return null;
}

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
 * Resolve the Solana RPC URL for the LiFi leg (env-overridable).
 */
export function solanaRpcUrl(solanaRpc) {
  return (
    solanaRpc ||
    (typeof import.meta !== "undefined" &&
    import.meta.env &&
    import.meta.env.VITE_SOLANA_RPC) ||
    "https://berty-633y20-fast-mainnet.helius-rpc.com"
  );
}

/**
 * Materialise the executable Solana tx payload from a LI.Fi quote: locate it
 * (transactionRequest / transactionData / includedSteps), and when the quote
 * carries none (common for Solana) ask LiFi to build it via the app's
 * /api/lifi/stepTransaction proxy. Throws the reference error when no
 * executable payload can be produced.
 *
 * @param {{lifiData: object, apiBase?: string}} args
 * @returns {Promise<{b64: string}>}
 */
export async function materializeLiFiSolanaTx({ lifiData, apiBase = "" }) {
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
  return { b64 };
}

/**
 * Deserialise + MANDATORY PRE-SEND SIMULATION of the materialised LiFi
 * Solana tx (Step 1.3A, fail-closed — a failed or unavailable simulation
 * BLOCKS the send and surfaces the reason). Throws SimulationError on a
 * failed/unavailable sim; returns { vtx, conn, b64 } on success. The engine's
 * LiFi-out leg runs THIS as its simulate phase — the signer is never touched
 * here, so a doomed tx never reaches the wallet.
 *
 * @param {{b64: string, solanaRpc?: string,
 *          simulate?: (conn:object, vtx:object) => Promise<{ok:boolean}>}} args
 * @returns {Promise<{vtx: object, conn: object, b64: string}>}
 */
export async function simulateLiFiSolanaTx({
  b64,
  solanaRpc,
  simulate = simulateSolanaTx,
}) {
  const { VersionedTransaction, Connection } = await import("@solana/web3.js");
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const vtx = VersionedTransaction.deserialize(raw);
  console.log("[Onward leg2] deserialized Solana tx, simulating…");

  const conn = new Connection(solanaRpcUrl(solanaRpc), "confirmed");
  const sim = await simulate(conn, vtx);
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
  return { vtx, conn, b64 };
}

/**
 * Sign + broadcast a simulated LiFi Solana tx with the sign-capable adapter.
 * Prefers signAndSendTransaction; falls back to signTransaction + app-side
 * RPC broadcast through the SAME connection the sim ran against.
 *
 * @param {{sol: object, vtx: object, conn: object}} args the resolved
 *   sign-capable Solana adapter (SignerResolver output / resolveSolSigner
 *   result), the deserialised VersionedTransaction and its connection.
 * @returns {Promise<string>} the transaction signature
 */
export async function sendLiFiSolanaTx({ sol, vtx, conn }) {
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

/**
 * Execute a LI.Fi Solana transaction.
 *
 * THE SIGNER PATH (the #43 fix, unchanged): the sign-capable adapter is
 * resolved via resolveSolSigner — the SAME resolver family as stage 1's burn
 * (resolveSolanaAdapter underneath). The engine's reverse LiFi-out leg does
 * NOT call this function; it runs the same materialise → simulate → send
 * phases through the LegContract with the signer resolved by the engine's
 * SINGLE SignerResolver (see src/engine/legs/reverse/lifiSolanaOutLeg.js).
 * This function stays the composed reference path for non-engine callers
 * (THORChain auto-advance, v1 Teleporter).
 *
 * @param {object} args
 * @param {object} args.lifiData the LI.Fi quote (or step) carrying the tx
 * @param {object|null} args.solWallet connected Solana wallet session ({provider})
 * @param {() => Array<{provider:object}>} [args.listSolProviders] fallback provider lister
 * @param {string} [args.apiBase] API base for the /api/lifi/stepTransaction proxy
 * @param {string} [args.solanaRpc] Solana RPC URL for simulation + RPC sends
 * @param {(conn:object, vtx:object) => Promise<{ok:boolean}>} [args.simulate]
 *   pre-send simulation override (default: simulateSolanaTx). Test seam — the
 *   fail-closed Step 1.3A gate is untouched.
 * @returns {Promise<string>} the transaction signature
 */
export async function executeLiFiSolanaTx({
  lifiData,
  solWallet,
  listSolProviders,
  apiBase = "",
  solanaRpc,
  simulate = simulateSolanaTx,
}) {
  // THE FIX: resolve the sign-capable adapter (unwraps the v2 connect
  // wrapper's `.adapter`; accepts the already-resolved adapter too) instead
  // of reading the raw provider shape. Same honest error when nothing can
  // sign.
  const sol = await resolveSolSigner(solWallet, listSolProviders);
  if (!sol) {
    throw new Error("Connect your Solana/X1 wallet to sign");
  }

  const { b64 } = await materializeLiFiSolanaTx({ lifiData, apiBase });
  const { vtx, conn } = await simulateLiFiSolanaTx({ b64, solanaRpc, simulate });
  return sendLiFiSolanaTx({ sol, vtx, conn });
}
