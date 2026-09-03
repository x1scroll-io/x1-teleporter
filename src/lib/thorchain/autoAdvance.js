/**
 * autoAdvance.js — the THORChain hop's auto-advance (Step 3.1).
 *
 * docs/BRIEF.md (Workstream A — Panel 2): "On `done`: detect SOL landing in
 * the connected wallet (balance delta ≥ expected − tolerance). Auto-advance
 * into the existing SOL→USDC same-chain swap, then the 0.5% skim, then Warp.
 * Reuse HoldingsPanel / TokenPicker; do not build new pickers."
 *
 * The existing SOL→USDC swap is the LI.Fi Solana execution path
 * (executeLiFiSolanaTx — extracted to src/lib/lifiSolanaTx.js so this flow
 * calls the SAME code as Teleporter.jsx; Teleporter.jsx now delegates to it).
 * The 0.5% skim + Warp hop are warpBridge.js `buildStage2`/`simulateStage2` and
 * `runStage2` (buildStage2 prepends the 0.5% pre-bridge SPL transfer to our fee
 * wallet, then calls the Warp BridgeOut instruction — runStage2 simulates and,
 * only when allowLive is true AND the WARP_LIVE_SEND gate is on, broadcasts).
 *
 * TWO LAYERS:
 *   1. `createAutoAdvancer({ actions })` — the pure sequencer. Runs
 *      swap → skim → warp strictly in order; a failure stops the chain at
 *      the failed step and reports which step failed. This is what the
 *      component uses and what tests drive with mocks.
 *   2. `createThorchainAdvanceActions(deps)` — the REAL wiring factory that
 *      binds the three steps to the existing execution paths. Keep the
 *      binding here (not in the component) so the component stays testable
 *      and the production wiring is covered by one focused test.
 *
 * SAFETY: no live funds by default. `allowLive` defaults to false, and the
 * production send gate (WARP_LIVE_SEND) stays false — runStage2 simulates
 * only. Step 3.4 flips the send gate after the operator mainnet test.
 *
 * PURE MODULE: no DOM, no window, no wallet — everything injected.
 */

export const ADVANCE_STEPS = Object.freeze(["swap", "skim", "warp"]);

import { FEE_WALLETS } from "../fees.ts";

/**
 * Create the sequential auto-advancer.
 *
 * @param {object} deps
 * @param {{swap:(ctx:object)=>Promise<unknown>,
 *          skim:(ctx:object)=>Promise<unknown>,
 *          warp:(ctx:object)=>Promise<unknown>}} deps.actions
 * @returns {{advance:Function, reset:Function}}
 */
export function createAutoAdvancer({ actions }) {
  if (!actions || typeof actions.swap !== "function" || typeof actions.skim !== "function" || typeof actions.warp !== "function") {
    throw new Error("createAutoAdvancer: actions.swap / actions.skim / actions.warp are required");
  }

  /** One advance run: swap → skim → warp. `ctx` is passed to every step
   *  (the hook payload + any runtime values the wiring needs). */
  async function advance(ctx) {
    const result = { ok: true, steps: [], failedStep: null, error: null };
    for (const step of ADVANCE_STEPS) {
      const record = { id: step, startedAt: Date.now(), finishedAt: null, detail: null };
      try {
        // eslint-disable-next-line no-await-in-loop
        record.detail = await actions[step](ctx);
        record.finishedAt = Date.now();
        result.steps.push(record);
      } catch (e) {
        record.finishedAt = Date.now();
        record.error = e instanceof Error ? e.message : String(e);
        result.steps.push(record);
        result.ok = false;
        result.failedStep = step;
        result.error = record.error;
        return result; // strict order — a failed step stops the chain
      }
    }
    return result;
  }

  return { advance, reset: () => {} };
}

/**
 * The REAL wiring — binds the three auto-advance steps to the existing
 * execution paths (the extracted LI.Fi Solana executor + warpBridge.js).
 *
 * Module resolution is lazy: injected modules win (tests pass mocks);
 * otherwise the real modules are imported on first use — so the production
 * default wiring needs no setup beyond the wallet + connection.
 *
 * @param {object} deps
 * @param {object} [deps.liFiSolanaTx] the shared executor module (default: real import)
 * @param {object} [deps.warpBridge] the warpBridge.js module (default: real import)
 * @param {object|null} [deps.solWallet] connected Solana wallet session ({provider})
 * @param {() => Array<{provider:object}>} [deps.listSolProviders]
 * @param {object} [deps.connection] @solana/web3.js Connection (Solana RPC)
 * @param {string} [deps.feeWalletSvm] our SVM fee wallet address (default: FEE_WALLETS.SVM)
 * @param {string} [deps.apiBase] API base for the stepTransaction proxy
 * @param {boolean} [deps.allowLive] runStage2 send gate (default: false — simulate only)
 * @returns {{swap:Function, skim:Function, warp:Function}}
 */
export function createThorchainAdvanceActions(deps = {}) {
  const {
    liFiSolanaTx,
    warpBridge,
    solWallet,
    listSolProviders,
    connection,
    feeWalletSvm = FEE_WALLETS.SVM,
    apiBase = "",
    allowLive = false,
  } = deps;

  // Lazy module resolution (injected wins; real modules imported on first use).
  let lifiPromise = null;
  let warpPromise = null;
  const getLifi = () => liFiSolanaTx ?? (lifiPromise ??= import("../lifiSolanaTx.js"));
  const getWarp = () => warpBridge ?? (warpPromise ??= import("../../warpBridge.js"));

  return {
    /**
     * Step 1 — the existing SOL→USDC same-chain swap (LI.Fi Solana path).
     * ctx.lifiData is the LI.Fi quote for the SOL→USDC leg (produced by the
     * Step 3.2 deposit flow / the existing quote path in a later wiring).
     */
    async swap(ctx) {
      const lifi = await getLifi();
      if (!ctx?.lifiData) throw new Error("auto-advance swap: ctx.lifiData (the SOL→USDC quote) is required");
      return lifi.executeLiFiSolanaTx({
        lifiData: ctx.lifiData,
        solWallet,
        listSolProviders,
        apiBase,
      });
    },

    /**
     * Step 2 — the 0.5% pre-bridge skim. Builds the stage-2 transaction
     * (buildStage2 prepends the 0.5% SPL transfer to our fee wallet, then the
     * Warp BridgeOut) and SIMULATES it. No broadcast — this proves the skim
     * instruction is executable before the Warp hop runs. Returns
     * { built, sim } so the warp step (and the UI) can reuse the built tx.
     */
    async skim(ctx) {
      const warp = await getWarp();
      if (!ctx?.userPubkey) throw new Error("auto-advance skim: ctx.userPubkey is required");
      const built = await warp.buildStage2({
        connection,
        userPubkey: ctx.userPubkey,
        feeWalletSvm: ctx.feeWalletSvm ?? feeWalletSvm,
        amountHuman: ctx.amountHuman,
      });
      const sim = await warp.simulateStage2(connection, built.transaction);
      return { built, sim };
    },

    /**
     * Step 3 — the Warp hop (Solana → X1). runStage2 rebuilds + simulates
     * and, only when allowLive is true, broadcasts via the connected wallet.
     * amountHuman should be the POST-skim amount (what the Warp hop carries).
     */
    async warp(ctx) {
      const warp = await getWarp();
      if (!ctx?.userPubkey) throw new Error("auto-advance warp: ctx.userPubkey is required");
      return warp.runStage2({
        connection,
        userPubkey: ctx.userPubkey,
        feeWalletSvm: ctx.feeWalletSvm ?? feeWalletSvm,
        amountHuman: ctx.amountHuman,
        allowLive,
        provider: solWallet?.provider ?? null,
      });
    },
  };
}
