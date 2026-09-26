/**
 * ChangeNowDeposit — the DEPOSIT-ADDRESS step for the ChangeNOW long-tail rail
 * (XMR/ADA/ATOM/NEAR/ZEC/DASH/BCH → USDC on Solana → Warp → X1).
 *
 * WHAT THIS DOES (mirrors the wallet's src/changenow.ts + src/changenowRail.ts,
 * on the console's server-proxy boundary):
 *   1. CREATE the exchange (POST /api/changenow/create) with the pinned source
 *      identity (fromCurrency + fromNetwork), the destination (`toCurrency` on
 *      `toNetwork`, default USDC on Solana) and the user's payout address.
 *      ChangeNOW returns the payin (deposit) address + id.
 *   2. RENDER the deposit panel: the exact amount to send, the payin address
 *      (with a copy button), and — for the memo-required assets (XMR payment
 *      id, ATOM/NEAR memo) — the payinExtraId, loudly marked REQUIRED. The
 *      send happens OUT-OF-BAND from the user's own external wallet; the
 *      console never signs.
 *   3. POLL the exchange status (GET /api/changenow/status?id=…) and map the
 *      lifecycle (waiting → confirming → exchanging → sending → finished /
 *      failed) to readable copy + a progress bar. The poller STOPS on a
 *      terminal status.
 *
 * FAIL-CLOSED (the whole point):
 *   - no connected destination wallet → the stage blocks (never a typed
 *     address — the payout must be the user's own session);
 *   - create fails / has no payin address / a memo-required source came back
 *     without its memo → an honest error + Retry, NEVER a fabricated address;
 *   - a status blip keeps polling and shows a calm "reconnecting" note — it
 *     never invents a milestone.
 *
 * ALL DEPENDENCIES ARE INJECTABLE (createExchange, createPoller, fetchImpl,
 * statusBaseUrl, pollIntervalMs, initialDeposit) so the DOM tests drive it with
 * no live upstream.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChangeNowDeposit,
  createStatusPoller,
  changeNowNeedsExtraId,
  changeNowExtraIdLabel,
  changeNowStatusLabel,
  changeNowStatusProgress,
  isChangeNowFinishedStatus,
  isChangeNowTerminalStatus,
} from "../lib/changenow/deposit.js";

const S = {
  wrap: { padding: "16px 16px 20px" },
  title: { fontSize: 15, fontWeight: 700, color: "#e8edf6", marginBottom: 2 },
  subtitle: { fontSize: 12, color: "#7d8aa0", marginBottom: 14, lineHeight: 1.5 },
  sectionLabel: { fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#475065", margin: "14px 0 8px" },
  block: {
    padding: 16, borderRadius: 12, border: "1px solid rgba(240,185,11,0.3)",
    background: "rgba(240,185,11,0.06)", color: "#E8C04A", fontSize: 13, lineHeight: 1.6,
  },
  banner: {
    marginTop: 12, padding: "10px 12px", borderRadius: 10, fontSize: 12, lineHeight: 1.5,
    border: "1px solid rgba(240,185,11,0.28)", background: "rgba(240,185,11,0.08)", color: "#E8C04A",
  },
  bannerErr: {
    marginTop: 12, padding: "10px 12px", borderRadius: 10, fontSize: 12, lineHeight: 1.5,
    border: "1px solid rgba(232,65,66,0.35)", background: "rgba(232,65,66,0.08)", color: "#f0a0a0",
  },
  bannerOk: {
    marginTop: 12, padding: "10px 12px", borderRadius: 10, fontSize: 12, lineHeight: 1.5,
    border: "1px solid rgba(63,211,232,0.4)", background: "rgba(63,211,232,0.08)", color: "#8ff0ff",
  },
  card: {
    marginTop: 12, padding: "12px", borderRadius: 12,
    border: "1px solid #1a2130", background: "rgba(13,18,28,0.5)",
  },
  rowLabel: { fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#475065", marginBottom: 4 },
  mono: {
    fontFamily: "monospace", fontSize: 11, color: "#e8edf6", wordBreak: "break-all",
    background: "rgba(0,0,0,0.25)", border: "1px solid #1a2130", borderRadius: 8,
    padding: "8px 10px", lineHeight: 1.5,
  },
  amount: { fontSize: 18, fontWeight: 800, color: "#e8edf6", fontFamily: "monospace" },
  copyBtn: {
    marginTop: 6, padding: "4px 10px", borderRadius: 8, fontSize: 11, fontWeight: 600,
    border: "1px solid #1a2130", background: "rgba(63,211,232,0.08)", color: "#3fd3e8", cursor: "pointer",
  },
  retryBtn: {
    marginTop: 8, padding: "7px 12px", borderRadius: 8, fontSize: 12, fontWeight: 700,
    background: "rgba(63,211,232,0.08)", border: "1px solid rgba(63,211,232,0.45)",
    color: "#3fd3e8", cursor: "pointer",
  },
  note: { fontSize: 11, color: "#475065", lineHeight: 1.6, marginTop: 10 },
  statusRow: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, color: "#9aa6bb", marginTop: 6 },
  track: { height: 8, borderRadius: 6, background: "rgba(255,255,255,0.06)", marginTop: 10, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 6, background: "linear-gradient(90deg, rgba(63,211,232,0.5), #3fd3e8)", transition: "width .3s ease-out" },
  fillFail: { height: "100%", borderRadius: 6, background: "linear-gradient(90deg, rgba(232,65,66,0.5), #e84142)" },
};

/** Best-effort copy with a clipboard fallback — never throws in tests/jsdom. */
function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      return Promise.resolve(navigator.clipboard.writeText(text)).catch(() => {});
    }
  } catch {
    /* no clipboard in this environment */
  }
  return Promise.resolve();
}

/**
 * @param {object} props
 * @param {object} props.source LONGTAIL_CHAINS[chain] meta ({asset, name, id, …})
 * @param {string|number} props.amount the route amount (source units)
 * @param {string|null} props.destination the payout address (the connected
 *   Solana/X1 session — where USDC lands before the Warp hop)
 * @param {boolean} [props.destinationConnected] whether that wallet is connected
 * @param {string} [props.refundAddress] optional source-chain refund address
 * @param {string} [props.toCurrency] payout currency ticker (default "usdc")
 * @param {string} [props.toNetwork] payout network (default "sol")
 * @param {Function} [props.createExchange] create DI (default real)
 * @param {Function} [props.createPoller] status-poller DI (default real)
 * @param {Function} [props.fetchImpl] fetch DI
 * @param {string} [props.statusBaseUrl] status-proxy base (default /api/changenow/status)
 * @param {number} [props.pollIntervalMs] status poll cadence
 * @param {object} [props.initialDeposit] an already-created deposit (tests)
 * @param {object} [props.copy] neutral-copy overrides ({label}, {asset})
 * @param {Function} [props.onStatusChange] called with each normalized status
 * @param {Function} [props.onFinished] called once when the exchange finishes
 */
export default function ChangeNowDeposit({
  source,
  amount,
  destination,
  destinationConnected = false,
  refundAddress,
  toCurrency = "usdc",
  toNetwork = "sol",
  createExchange = createChangeNowDeposit,
  createPoller = createStatusPoller,
  fetchImpl,
  statusBaseUrl,
  pollIntervalMs,
  initialDeposit = null,
  copy = {},
  onStatusChange,
  onFinished,
}) {
  const asset = source?.asset ?? "";
  const label = source?.name ?? asset;

  const [deposit, setDeposit] = useState(initialDeposit ?? null);
  const [createState, setCreateState] = useState(initialDeposit ? "ready" : "idle"); // idle|creating|ready|error
  const [createError, setCreateError] = useState(null);
  const [status, setStatus] = useState(initialDeposit?.status ?? null);
  const [statusError, setStatusError] = useState(null);
  const [copied, setCopied] = useState(null);

  const amountNum = Number(amount);
  const hasValidAmount = Number.isFinite(amountNum) && amountNum > 0;

  // The deposit is creatable only with a connected destination wallet + a
  // valid amount — the payout address is never typed.
  const canCreate = Boolean(destinationConnected && destination && hasValidAmount);

  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  // One create per (source, amount, destination) signature — guards against
  // StrictMode/re-render double-creates, and re-creates when the route moves.
  const signature = `${source?.id ?? ""}|${amountNum}|${destination ?? ""}`;
  const createdForRef = useRef(initialDeposit ? signature : null);

  const runCreate = useCallback(async () => {
    if (!canCreate) return;
    createdForRef.current = signature;
    setCreateState("creating");
    setCreateError(null);
    const res = await createExchange(
      {
        fromChain: source?.id,
        toCurrency,
        toNetwork,
        amount: amountNum,
        address: destination,
        refundAddress: refundAddress || undefined,
      },
      fetchImpl ? { fetchImpl } : {},
    );
    if (!res?.ok) {
      setDeposit(null);
      setCreateState("error");
      setCreateError(res?.reason || "create_failed");
      return;
    }
    setDeposit(res.deposit);
    setCreateState("ready");
  }, [canCreate, signature, createExchange, source?.id, toCurrency, toNetwork, amountNum, destination, refundAddress, fetchImpl]);

  // Create on mount / when the route signature changes (once per signature).
  useEffect(() => {
    if (!canCreate) return;
    if (createdForRef.current === signature) return;
    runCreate();
  }, [canCreate, signature, runCreate]);

  // Status poller — starts once a deposit exists, stops on a terminal status.
  useEffect(() => {
    if (!deposit?.id) return undefined;
    const poller = createPoller({
      id: deposit.id,
      fetchImpl,
      baseUrl: statusBaseUrl,
      intervalMs: pollIntervalMs,
      onUpdate: (s) => {
        setStatus(s);
        setStatusError(null);
        onStatusChangeRef.current?.(s);
        if (isChangeNowFinishedStatus(s.status)) onFinishedRef.current?.(s);
      },
      onError: (reason) => setStatusError(reason),
    });
    poller.start();
    return () => poller.stop();
  }, [deposit?.id, createPoller, fetchImpl, statusBaseUrl, pollIntervalMs]);

  const handleCopy = (labelName, text) => {
    copyText(text).then(() => {
      setCopied(labelName);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(null), 1500);
    });
  };
  const copyTimerRef = useRef(null);
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const needsExtra = changeNowNeedsExtraId(source?.id);
  const extraLabel = changeNowExtraIdLabel(source?.id) ?? "memo";
  const sendAmount = deposit?.amountFrom ?? (hasValidAmount ? amountNum : null);
  const statusText = status ? changeNowStatusLabel(status.status) : null;
  const progress = status ? changeNowStatusProgress(status.status) : null;
  const finished = status ? isChangeNowFinishedStatus(status.status) : false;
  const failed = status ? isChangeNowTerminalStatus(status.status) && !finished : false;

  const subtitleText = (copy.subtitle ?? "Send {asset} from your external {label} wallet to the deposit address below — it lands as USDC, then hops to X1.")
    .replace(/\{asset\}/g, asset)
    .replace(/\{label\}/g, label);

  // ── NO DESTINATION WALLET → BLOCK (the payout must be the user's session) ──
  if (!destinationConnected || !destination) {
    const noWallet = (copy.noWallet ?? "Connect a Solana/X1 wallet first — your deposit lands in that wallet before it hops to X1. Open the console's connect button to add one.")
      .replace(/\{label\}/g, label);
    return (
      <div className="changenow-deposit" role="tabpanel" aria-label="Deposit step" data-testid="cn-deposit" style={S.wrap}>
        <div style={S.title}>Deposit address</div>
        <div style={S.subtitle}>{subtitleText}</div>
        <div style={S.block} data-testid="cn-no-wallet">{noWallet}</div>
      </div>
    );
  }

  return (
    <div className="changenow-deposit" role="tabpanel" aria-label="Deposit step" data-testid="cn-deposit" style={S.wrap}>
      <div style={S.title}>Deposit address</div>
      <div style={S.subtitle}>{subtitleText}</div>

      {createState === "creating" ? (
        <div style={S.note} data-testid="cn-create-loading">Creating your deposit address…</div>
      ) : null}

      {createState === "error" ? (
        <div>
          <div style={S.bannerErr} data-testid="cn-create-error">
            ⚠️ We couldn't create a deposit address for this route{createError ? ` (${createError})` : ""} —
            no address is shown, so nothing can be misrouted. Try again.
          </div>
          <button type="button" style={S.retryBtn} data-testid="cn-retry-create" onClick={runCreate}>
            Retry
          </button>
        </div>
      ) : null}

      {createState === "ready" && deposit ? (
        <>
          <div style={S.sectionLabel}>1 · Send exactly this</div>
          <div style={S.card} data-testid="cn-amount-card">
            <div style={S.rowLabel}>Amount to send</div>
            <div style={S.amount} data-testid="cn-amount-to-send">
              {sendAmount != null ? sendAmount : "—"} {asset}
            </div>
            <div style={S.note} data-testid="cn-instructions">
              Send {sendAmount != null ? sendAmount : "the amount"} {asset} to the deposit address
              below, from your own external {label} wallet.
            </div>
          </div>

          <div style={S.sectionLabel}>2 · Deposit address ({asset})</div>
          <div style={S.card} data-testid="cn-deposit-card">
            <div style={S.rowLabel}>Deposit address</div>
            <div style={S.mono} data-testid="cn-payin-address">{deposit.payinAddress}</div>
            <button type="button" style={S.copyBtn} data-testid="cn-copy-payin" onClick={() => handleCopy("payin", deposit.payinAddress)}>
              {copied === "payin" ? "✓ Copied" : "Copy"}
            </button>

            {deposit.payinExtraId ? (
              <>
                <div style={{ ...S.rowLabel, marginTop: 12 }}>
                  {extraLabel} (required){needsExtra ? " — this asset needs it" : ""}
                </div>
                <div style={S.mono} data-testid="cn-extra-id">{deposit.payinExtraId}</div>
                <button type="button" style={S.copyBtn} data-testid="cn-copy-extra" onClick={() => handleCopy("extra", deposit.payinExtraId)}>
                  {copied === "extra" ? "✓ Copied" : "Copy"}
                </button>
                <div style={S.note} data-testid="cn-extra-note">
                  ⚠️ You MUST include this {extraLabel} with your send — a deposit without it can be lost.
                </div>
              </>
            ) : needsExtra ? (
              <div style={S.bannerErr} data-testid="cn-extra-missing">
                ⚠️ This asset requires a {extraLabel}, but none was returned — do not send until a
                deposit address with its {extraLabel} appears. Retry above.
              </div>
            ) : null}

            <div style={{ ...S.rowLabel, marginTop: 12 }}>Delivered to</div>
            <div style={S.mono} data-testid="cn-payout-address">{deposit.payoutAddress || destination}</div>
          </div>

          <div style={S.sectionLabel}>3 · Status</div>
          <div style={S.card} data-testid="cn-status">
            <div style={S.statusRow}>
              <span data-testid="cn-status-label">{statusText ?? "Waiting for your deposit…"}</span>
              {progress ? <span>{progress.total > 0 ? `${progress.step}/${progress.total}` : ""}</span> : null}
            </div>
            <div style={S.track}>
              <div
                data-testid="cn-progress"
                data-fraction={progress ? String(progress.fraction) : "0"}
                style={{ ...(failed ? S.fillFail : S.fill), width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }}
              />
            </div>

            {statusError ? (
              <div style={S.note} data-testid="cn-status-error">Reconnecting to check your deposit… ({statusError})</div>
            ) : null}

            {finished ? (
              <div style={S.bannerOk} data-testid="cn-done">✓ Deposit complete — your USDC is on its way to X1.</div>
            ) : null}
            {failed ? (
              <div style={S.bannerErr} data-testid="cn-failed">This exchange didn't complete ({status?.status}). No further progress will happen — check your refund address.</div>
            ) : null}

            <div style={S.note}>
              This panel updates automatically until the exchange finishes. Keep it open — the deposit is
              sent from your own wallet; nothing here moves your funds.
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
