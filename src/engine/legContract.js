/**
 * legContract.js — the LegContract interface + generic leg lifecycle runner
 * for the routing engine (docs/ROUTING-ENGINE.md).
 *
 * A LEG is one atomic, chain-scoped step of a route. Every leg implements the
 * SAME five-phase contract:
 *
 *   build(ctx)             → the leg's deterministic artifact (the app-controlled
 *                            bytes: calldata + tx params, or the unsigned
 *                            serialized transaction). This is the byte-identity
 *                            surface the golden fixtures pin. Pure/offline
 *                            where possible.
 *   simulate(ctx, built)   → the pre-send gate (Step 1.3A, fail-closed):
 *                            EVM legs THROW SimulationError when the exact tx
 *                            would revert; SVM legs return the normalized
 *                            { ok, err/logs/simUnavailable } shape. A leg may
 *                            return { ok: true, skipSubmit: true } to declare
 *                            the rest of the lifecycle unnecessary (e.g. the
 *                            allowance is already sufficient).
 *   requestSignature(ctx)  → the wallet boundary, when the signing surface is
 *                            separate from the broadcast (future server-side
 *                            signers). Phase-1 legs use wallet-mediated sends
 *                            whose proven code bundles request+submit
 *                            (EIP-1193 eth_sendTransaction, Wallet-Standard
 *                            sign-and-send) — those legs implement `submit`
 *                            and leave this phase undefined; see ROUTING-ENGINE.md.
 *   submit(ctx, built)     → broadcast → tx id/hash/signature. ONLY runs when
 *                            simulate passed (runLeg gate) — a failed sim
 *                            never reaches the wallet or the network.
 *   confirm(ctx, built)    → finality (receipt / confirmation), optional.
 *
 * A leg never constructs wallets, RPC connections, or quote endpoints itself —
 * everything comes from the route context (dependency-injected), so legs are
 * deterministic, unit-testable, and chain-agnostic behind the same contract.
 *
 * runLeg(leg, ctx) is the generic executor: it runs each DEFINED phase in
 * contract order and records a trace. Rules:
 *   - undefined phases are skipped (a leg may implement only what it needs),
 *   - a phase that throws propagates (the EVM sim gate throws SimulationError
 *     — submit therefore never runs on a doomed tx),
 *   - after `simulate`, a non-ok result ({ ok:false } — the SVM sim shape) or
 *     a { skipSubmit:true } marker stops the leg before submit/confirm,
 *   - `confirm` is skipped when the leg defines no confirm (EVM bridge leg —
 *     the caller treats the hash as final, exactly like the reference path).
 */
export const LEG_PHASES = [
  "build",
  "simulate",
  "requestSignature",
  "submit",
  "confirm",
];

/**
 * Create a leg from a plain definition. `phases` may implement any subset of
 * LEG_PHASES; the rest default to undefined (skipped by runLeg).
 *
 * @param {{id: string, family: "evm"|"svm", chain: string,
 *          description: string, goldenStep?: string,
 *          phases: Partial<Record<Phase, Function>>}} def
 */
export function createLeg(def) {
  if (!def || typeof def.id !== "string" || !def.id) {
    throw new Error("createLeg: a leg needs an id");
  }
  if (!def.family || !["evm", "svm"].includes(def.family)) {
    throw new Error(`createLeg(${def.id}): family must be "evm" or "svm"`);
  }
  const phases = {};
  for (const phase of LEG_PHASES) {
    const fn = def.phases?.[phase];
    if (fn !== undefined) {
      if (typeof fn !== "function") {
        throw new Error(`createLeg(${def.id}): phase ${phase} must be a function`);
      }
      phases[phase] = fn;
    }
  }
  return Object.freeze({
    id: def.id,
    family: def.family,
    chain: def.chain || null,
    description: def.description || "",
    goldenStep: def.goldenStep || null,
    phases: Object.freeze(phases),
    ...(def.meta ? { meta: Object.freeze(def.meta) } : {}),
  });
}

/** Marker a phase may return to stop the lifecycle BEFORE the wallet/network. */
export function legSkip(reason) {
  return { __legSkip: true, reason: reason || "not needed" };
}

/** True when a phase result asks the runner to stop the leg. */
export function isLegSkip(result) {
  return Boolean(result && typeof result === "object" && result.__legSkip === true);
}

/**
 * Run a leg's lifecycle in contract order. Returns a trace of the phases that
 * ran plus where (if anywhere) the lifecycle stopped.
 *
 * @param {object} leg  a leg from createLeg()
 * @param {object} ctx  the route context the phases read (connections,
 *                      signers, quote, addresses — see the leg's docs)
 * @returns {Promise<{legId: string, results: object, stoppedAt: string|null}>}
 */
export async function runLeg(leg, ctx) {
  const results = {};
  let stoppedAt = null;
  for (const phase of LEG_PHASES) {
    const fn = leg.phases?.[phase];
    if (!fn) continue;
    // eslint-disable-next-line no-await-in-loop
    const result = await fn(ctx, results);
    results[phase] = result;
    if (isLegSkip(result)) {
      stoppedAt = phase;
      break;
    }
    // The sim gate: a non-ok simulation (SVM shape) or an explicit
    // skipSubmit marker blocks submit/confirm — a failed sim never reaches
    // the wallet or the network. (EVM legs THROW on sim failure instead —
    // the throw propagates and the leg stops here too.)
    if (
      phase === "simulate" &&
      result &&
      typeof result === "object" &&
      (result.ok === false || result.skipSubmit === true)
    ) {
      stoppedAt = phase;
      break;
    }
  }
  return { legId: leg.id, results, stoppedAt };
}
