/**
 * THORChainProgress — the PROGRESS state of the THORChain tab (Step 3.1, the
 * hop stage built first because it reuses existing code).
 *
 * Per docs/BRIEF.md + the design supersession, the THORChain lane is ONE card
 * with sequential states inside the THORChain tab (quote → deposit address →
 * progress → done). This component IS the progress state: it receives the
 * hook payload shape `{ inboundTxid, sourceChain, destination,
 * expectedAmountOut }`, polls the THORChain tx-status endpoint every 15s
 * (max 90 min), renders the stage sequence with the teleport-branded motion
 * language (charging → in transit → rematerializing), detects the SOL landing
 * in the connected Solana wallet (balance delta ≥ expected − tolerance), then
 * auto-advances into the EXISTING SOL→USDC swap → 0.5% skim → Warp sequence.
 *
 * Closed-tab resume: every stage change persists `{inboundTxid, stage}` in
 * window.storage (keyed by txid, no server state). On mount, a pending entry
 * resumes polling from the persisted stage.
 *
 * ALL DEPENDENCIES ARE INJECTABLE (tests drive the poller, the landing
 * watcher, the storage backend, and the advance actions with mocks). The
 * defaults are the real wiring:
 *   - poller: createThorchainStatusPoller (statusEndpoint.js / pollStatus.js)
 *   - landing watcher: createSolLandingWatcher (landingDetection.js)
 *   - storage: createThorchainStorage (storage.js)
 *   - advance: the Step 3.1 wiring (autoAdvance.js) — simulate-only until the
 *     Step 3.2 deposit flow supplies the SOL→USDC quote and the operator
 *     flips the send gate. NEVER signs or moves funds on its own.
 *
 * The component never reads injected wallet globals (noWindowProbe rule):
 * the Solana wallet address + balance reader are props from the parent tab
 * (which reads them from WalletContext).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createThorchainStatusPoller } from "../lib/thorchain/pollStatus.js";
import { createSolLandingWatcher } from "../lib/thorchain/landingDetection.js";
import { createThorchainStorage } from "../lib/thorchain/storage.js";
import { createAutoAdvancer, createThorchainAdvanceActions, ADVANCE_STEPS } from "../lib/thorchain/autoAdvance.js";
import { FEE_WALLETS } from "../lib/fees.ts";

/** The stage sequence + the teleport-branded language (design direction:
 *  "progress states named and animated as a teleport sequence — charging →
 *  in transit → rematerializing on X1 — subtle, no cartoon"). */
export const STAGE_SEQUENCE = Object.freeze([
  { stage: "observed", label: "Charging", detail: "THORChain observed your deposit — preparing the swap" },
  { stage: "swapping", label: "In transit", detail: "Swapping through THORChain's liquidity network" },
  { stage: "outbound_signed", label: "Rematerializing", detail: "Outbound signed — SOL is on its way to your wallet" },
  { stage: "done", label: "Landed", detail: "SOL received — advancing to the X1 hop" },
]);

/** Default advance wiring (Step 3.1): real actions, simulate-only. The swap
 *  step needs ctx.lifiData (the SOL→USDC quote) which the Step 3.2 deposit
 *  flow supplies — until then the advance reports that clearly instead of
 *  guessing. skim + warp build/simulate the real instructions (no broadcast:
 *  allowLive=false and WARP_LIVE_SEND stays false). */
function defaultAdvance({ solAddress, solWallet, listSolProviders, connection, apiBase, allowLive = false }) {
  const actions = createThorchainAdvanceActions({
    solWallet,
    listSolProviders,
    connection,
    feeWalletSvm: FEE_WALLETS.SVM,
    apiBase,
    allowLive,
  });
  const advancer = createAutoAdvancer({ actions });
  return async (hop) => {
    const ctx = {
      ...hop,
      userPubkey: solAddress,
      amountHuman: hop.expectedAmountOut,
      // TODO(Step 3.2): the deposit flow emits the SOL→USDC LI.Fi quote and
      // this ctx carries it as lifiData — the swap step then executes the
      // existing SOL→USDC swap. Until then swap() reports the missing quote.
      lifiData: null,
    };
    return advancer.advance(ctx);
  };
}

const S = {
  wrap: { padding: "16px 16px 20px" },
  title: { fontSize: 15, fontWeight: 700, color: "#e8edf6", marginBottom: 2 },
  subtitle: { fontSize: 12, color: "#7d8aa0", marginBottom: 14, lineHeight: 1.5 },
  stages: { display: "flex", flexDirection: "column", gap: 10 },
  stageRow: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "10px 12px", borderRadius: 12,
    border: "1px solid #1a2130", background: "rgba(13,18,28,0.5)",
  },
  stageRowActive: { borderColor: "rgba(63,211,232,0.5)", background: "rgba(63,211,232,0.06)" },
  stageRowDone: { borderColor: "rgba(94,224,138,0.35)", background: "rgba(94,224,138,0.05)" },
  dot: { width: 10, height: 10, borderRadius: 999, flexShrink: 0, background: "#28303f" },
  dotActive: { background: "#3fd3e8", animation: "tc-pulse 1.4s ease-in-out infinite" },
  dotDone: { background: "#5ee08a" },
  stageLabel: { fontSize: 13, fontWeight: 700, color: "#9aa6bb" },
  stageLabelActive: { color: "#3fd3e8" },
  stageLabelDone: { color: "#e8edf6" },
  stageDetail: { fontSize: 11, color: "#7d8aa0", marginTop: 1 },
  banner: {
    marginTop: 14, padding: "10px 12px", borderRadius: 10, fontSize: 12, lineHeight: 1.5,
    border: "1px solid", display: "flex", gap: 8, alignItems: "flex-start",
  },
  bannerInfo: { background: "rgba(39,117,232,0.08)", borderColor: "#1a3a6b", color: "#9aa6bb" },
  bannerWarn: { background: "rgba(240,185,11,0.08)", borderColor: "rgba(240,185,11,0.28)", color: "#E8C04A" },
  bannerErr: { background: "rgba(232,65,66,0.08)", borderColor: "rgba(232,65,66,0.35)", color: "#f0a0a0" },
  bannerOk: { background: "rgba(94,224,138,0.08)", borderColor: "rgba(94,224,138,0.3)", color: "#9fe8b8" },
  meta: { marginTop: 12, fontSize: 11, color: "#475065", lineHeight: 1.6 },
};

/**
 * @param {object} props
 * @param {{inboundTxid:string, sourceChain:string, destination:string,
 *          expectedAmountOut:number}} props.hop the hook payload
 * @param {object} [props.storage] createThorchainStorage() handle
 * @param {Function} [props.createPoller] poller factory (DI)
 * @param {Function} [props.createLandingWatcher] landing watcher factory (DI)
 * @param {Function} [props.advance] async ({hop}) => advance result (DI; default
 *   is the real Step 3.1 wiring, simulate-only)
 * @param {Function} [props.getSolBalance] async (address) => native SOL balance
 * @param {string|null} [props.solAddress] connected Solana wallet address
 * @param {object|null} [props.solWallet] connected Solana wallet session
 * @param {Function} [props.listSolProviders] fallback provider lister
 * @param {object} [props.connection] @solana/web3.js Connection (Solana RPC)
 * @param {Function} [props.fetchImpl] fetch for the poller (DI)
 * @param {string} [props.statusBaseUrl] THORChain status API base URL
 * @param {number} [props.pollIntervalMs] poll interval (default 15s)
 * @param {number} [props.pollMaxMs] max poll window (default 90 min)
 * @param {number} [props.landingIntervalMs] landing check interval (default 5s)
 * @param {number} [props.landingMaxMs] landing arrival window (default 30 min)
 * @param {number} [props.tolerance] SOL landing shortfall tolerance
 * @param {Function} [props.onStateChange] ({stage, phase, error}) => void
 * @param {object} [props.copy] neutral-copy overrides for a host surface
 *   that must not name the rail (default: THIS component's own copy, so the
 *   classic THORChain tab renders byte-identically without it). Keys:
 *   { paused: string, stageDetail: { observed?: string, swapping?: string } }.
 */
export default function THORChainProgress({
  hop,
  storage,
  createPoller = createThorchainStatusPoller,
  createLandingWatcher = createSolLandingWatcher,
  advance,
  getSolBalance,
  solAddress = null,
  solWallet = null,
  listSolProviders,
  connection,
  fetchImpl,
  statusBaseUrl,
  pollIntervalMs,
  pollMaxMs,
  landingIntervalMs,
  landingMaxMs,
  tolerance,
  onStateChange,
  copy = {},
}) {
  if (!hop?.inboundTxid) {
    throw new Error("THORChainProgress: hop.inboundTxid is required");
  }

  const hopRef = useRef(hop);
  const storeRef = useRef(null);
  if (!storeRef.current) storeRef.current = storage ?? createThorchainStorage();
  // The advance runner: an injected `advance` prop wins; otherwise the real
  // Step 3.1 wiring (simulate-only) is used — see defaultAdvance above.
  const advanceRef = useRef(null);
  advanceRef.current =
    advance ??
    defaultAdvance({ solAddress, solWallet, listSolProviders, connection, apiBase: "" });

  // Resume: a pending persisted entry restarts from its persisted stage, and
  // its payload wins over the freshly-passed prop.
  const [stage, setStage] = useState(() => {
    try {
      const persisted = storeRef.current.loadHop(hop.inboundTxid);
      if (persisted?.stage && persisted.stage !== "done") {
        if (persisted.payload) hopRef.current = persisted.payload;
        return persisted.stage;
      }
    } catch {
      /* storage failure must never block the component */
    }
    return null;
  });

  const stageRef = useRef(stage);
  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  const [phase, setPhase] = useState("polling"); // polling | paused | error | timeout | landing | advancing | arrived | advance-failed | needs-wallet
  const [error, setError] = useState(null);
  const [landed, setLanded] = useState(false);
  const pollerRef = useRef(null);
  const watcherRef = useRef(null);

  const emit = useCallback((nextStage, nextPhase, nextError) => {
    onStateChange?.({ stage: nextStage, phase: nextPhase, error: nextError ?? null });
  }, [onStateChange]);

  const persist = useCallback((txid, nextStage, payload) => {
    try {
      storeRef.current.saveHop({ inboundTxid: txid, stage: nextStage, payload });
    } catch {
      /* storage failure must never break the poll loop */
    }
  }, []);

  const finishAdvance = useCallback((result) => {
    if (result?.ok) {
      setPhase("arrived");
      emit("done", "arrived", null);
      try {
        storeRef.current.removeHop(hopRef.current.inboundTxid);
      } catch { /* ignore */ }
    } else {
      const step = result?.failedStep;
      const msg =
        step === "swap"
          ? "The SOL→USDC quote isn't wired yet (arrives with the Step 3.2 deposit flow). Your SOL is safe on Solana — the hop is saved and will resume."
          : `The X1 hop stopped at "${step}" — ${result?.error || "unknown error"}. Your SOL is safe on Solana; the hop is saved.`;
      setError(msg);
      setPhase("advance-failed");
      emit("done", "advance-failed", msg);
    }
  }, [emit]);

  const beginLanding = useCallback((txid, payload) => {
    // No wallet connected / no balance reader → the SOL is (or will be) on
    // Solana but we can't watch for it or advance. Persist stage=done so a
    // later visit (with a connected wallet) resumes from here.
    if (!solAddress || typeof getSolBalance !== "function" || !advanceRef.current) {
      setPhase("needs-wallet");
      emit("done", "needs-wallet", null);
      return;
    }
    setPhase("landing");
    Promise.resolve(getSolBalance(solAddress))
      .then((bal) => {
        const balanceBefore = Number.isFinite(bal) ? bal : 0;
        const watcher = createLandingWatcher({
          getBalance: () => getSolBalance(solAddress),
          intervalMs: landingIntervalMs,
          maxMs: landingMaxMs,
          tolerance,
        });
        watcherRef.current = watcher;
        watcher.start({
          balanceBefore,
          expectedAmountOut: payload?.expectedAmountOut ?? hopRef.current.expectedAmountOut,
          onLanded: (balanceNow) => {
            setLanded(true);
            setPhase("advancing");
            emit("done", "advancing", null);
            Promise.resolve(advanceRef.current(hopRef.current))
              .then(finishAdvance)
              .catch((e) => {
                const msg = `Auto-advance failed: ${e?.message || String(e)}. Your SOL is safe on Solana.`;
                setError(msg);
                setPhase("advance-failed");
                emit("done", "advance-failed", msg);
              });
          },
          onTimeout: () => {
            setPhase("timeout");
            emit("done", "timeout", null);
          },
          onError: (msg) => {
            setError(msg);
            setPhase("error");
          },
        });
      })
      .catch((e) => {
        setError(`Balance check failed: ${e?.message || String(e)}`);
        setPhase("error");
      });
  }, [solAddress, getSolBalance, createLandingWatcher, landingIntervalMs, landingMaxMs, tolerance, emit, finishAdvance]);

  // Latest beginLanding via ref — the poll loop starts once and must not
  // capture a stale closure (e.g. the user connects the Solana wallet AFTER
  // mount, mid-poll).
  const beginLandingRef = useRef(beginLanding);
  beginLandingRef.current = beginLanding;

  // ── POLL LOOP (starts once per mount) ──
  useEffect(() => {
    const txid = hopRef.current.inboundTxid;
    let cancelled = false;

    const poller = createPoller({
      fetchImpl,
      baseUrl: statusBaseUrl,
      intervalMs: pollIntervalMs,
      maxMs: pollMaxMs,
    });
    pollerRef.current = poller;

    poller.start({
      inboundTxid: txid,
      initialStage: stageRef.current,
      onStage: (nextStage) => {
        if (cancelled) return;
        setStage(nextStage);
        setPhase("polling");
        emit(nextStage, "polling", null);
        persist(txid, nextStage, hopRef.current);
      },
      onHalted: () => {
        if (cancelled) return;
        setPhase("paused");
        emit(stageRef.current, "paused", null);
      },
      onError: (msg) => {
        if (cancelled) return;
        setError(msg);
        setPhase("error");
      },
      onTimeout: () => {
        if (cancelled) return;
        setPhase("timeout");
        emit(stageRef.current, "timeout", null);
      },
      onDone: () => {
        if (cancelled) return;
        // stage "done" was persisted by onStage; now watch for the SOL landing.
        beginLandingRef.current(txid, hopRef.current);
      },
    });

    return () => {
      cancelled = true;
      poller.stop();
      watcherRef.current?.stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── RENDER ──
  const stageIndex = STAGE_SEQUENCE.findIndex((s) => s.stage === stage);
  const reached = (s) => {
    const i = STAGE_SEQUENCE.findIndex((x) => x.stage === s);
    return stageIndex >= i && stageIndex !== -1;
  };

  const banner =
    phase === "paused" ? (
      <div style={{ ...S.banner, ...S.bannerWarn }} data-testid="tc-banner-paused">
        <span>⚠️</span>
        <span>{copy.paused ?? "Paused by THORChain — the chain is halted right now. Your deposit is safe; polling continues and this clears automatically."}</span>
      </div>
    ) : phase === "timeout" ? (
      <div style={{ ...S.banner, ...S.bannerWarn }} data-testid="tc-banner-timeout">
        <span>⏳</span>
        <span>Still waiting. Your funds are safe — progress is saved, so you can close this tab and return anytime.</span>
      </div>
    ) : phase === "error" ? (
      <div style={{ ...S.banner, ...S.bannerErr }} data-testid="tc-banner-error">
        <span>⚠️</span>
        <span>{error || "Status check hiccup — retrying automatically."}</span>
      </div>
    ) : phase === "advance-failed" ? (
      <div style={{ ...S.banner, ...S.bannerErr }} data-testid="tc-banner-advance-failed">
        <span>⚠️</span>
        <span>{error}</span>
      </div>
    ) : phase === "needs-wallet" ? (
      <div style={{ ...S.banner, ...S.bannerInfo }} data-testid="tc-banner-needs-wallet">
        <span>◎</span>
        <span>SOL has arrived on Solana. Connect your Solana wallet to finish the X1 hop — this progress is saved.</span>
      </div>
    ) : phase === "arrived" ? (
      <div style={{ ...S.banner, ...S.bannerOk }} data-testid="tc-banner-arrived">
        <span>✓</span>
        <span>Hop complete — your funds are on X1.</span>
      </div>
    ) : phase === "advancing" ? (
      <div style={{ ...S.banner, ...S.bannerInfo }} data-testid="tc-banner-advancing">
        <span>◈</span>
        <span>SOL landed — executing the X1 hop: SOL→USDC swap, 0.5% skim, then Warp.</span>
      </div>
    ) : null;

  return (
    <div className="thorchain-progress" data-testid="thorchain-progress" style={S.wrap}>
      <div style={S.title}>Hop in progress</div>
      <div style={S.subtitle}>
        {hopRef.current.sourceChain} → Solana → X1 · tx{" "}
        <span style={{ fontFamily: "monospace" }}>{hopRef.current.inboundTxid.slice(0, 12)}…</span>
      </div>

      <div style={S.stages} data-testid="tc-stage-list">
        {STAGE_SEQUENCE.map((s) => {
          const done = reached(s.stage);
          const active = stage === s.stage && phase !== "arrived";
          const detail = copy.stageDetail?.[s.stage] ?? s.detail;
          return (
            <div
              key={s.stage}
              data-testid={`tc-stage-${s.stage}`}
              data-state={active ? "active" : done ? "done" : "pending"}
              style={{ ...S.stageRow, ...(done ? S.stageRowDone : {}), ...(active ? S.stageRowActive : {}) }}
            >
              <span style={{ ...S.dot, ...(done ? S.dotDone : {}), ...(active ? S.dotActive : {}) }} />
              <div>
                <div style={{ ...S.stageLabel, ...(done ? S.stageLabelDone : {}), ...(active ? S.stageLabelActive : {}) }}>
                  {s.label}
                </div>
                <div style={S.stageDetail}>{detail}</div>
              </div>
            </div>
          );
        })}
      </div>

      {banner}

      <div style={S.meta} data-testid="tc-meta">
        {Number.isFinite(Number(hopRef.current.expectedAmountOut)) && Number(hopRef.current.expectedAmountOut) > 0
          ? `Expected arrival ≈ ${hopRef.current.expectedAmountOut} SOL · `
          : ""}
        checks every 15s · saved on close
      </div>
    </div>
  );
}

/** The step names of the auto-advance sequence (exported for tests/UI). */
export { ADVANCE_STEPS };
