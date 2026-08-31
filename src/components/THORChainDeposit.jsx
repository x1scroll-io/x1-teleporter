/**
 * THORChainDeposit — the DEPOSIT-ADDRESS state of the THORChain tab (Step
 * 3.2; what the runbook called "Panel 1", adapted to the supersession: a
 * logic stage inside the ONE card's sequential flow — quote → deposit →
 * progress → done — never a mounted fork).
 *
 * WHAT THIS STAGE DOES (fork logic LIFTED, per docs/BRIEF.md):
 *   - Sources limited to BTC.BTC / DOGE.DOGE / LTC.LTC / XRP.XRP.
 *   - Destination pinned to SOL.SOL, prefilled from the Solana session in
 *     WalletContext (via props from the parent tab) and NOT editable (brief
 *     wallet rule 4: "the destination is the Solana session's public key,
 *     never the EVM address, never user-typed"). With no Solana wallet
 *     connected the whole stage blocks: "connect a Solana wallet first".
 *   - Inbound addresses fetched on mount + every 60s
 *     (createInboundAddressRefresher → /thorchain/inbound_addresses, no API
 *     key); halted chains grey out with "paused by THORChain". Vault
 *     addresses are never cached across sessions (in-memory only).
 *   - Deposit address + memo + QR displayed. The memo is the THORChain one
 *     from buildDepositMemo (memo.js — the exact scheme swap.thorchain
 *     uses; the wallet-layer deposit-address rows from Steps 2.3/2.4 feed
 *     the refund-address prefill from the connected source wallet session).
 *   - The SUBMIT HOOK: on "I've sent it" (user pastes their inbound txid —
 *     v1 deposit-address flow, no wallet signing), emits
 *     { inboundTxid, sourceChain, destination, expectedAmountOut } to the
 *     progress stage (Step 3.1's THORChainProgress consumes it).
 *
 * QUOTE STAGE (3.3) stays a marked placeholder — nothing here wires
 * THORCHAIN_API_KEY or aggregator quotes. expectedAmountOut is accepted as
 * an optional field (TODO: the 3.3 quote supplies it; until then it
 * defaults to the user's sent amount minus the affiliate bps — which is 0
 * until Franky registers the Teleporter THORName).
 *
 * The size cap (0.05 BTC-equivalent) is a CONFIG VALUE owned by the 3.3
 * fee/quote work — TODO only, never enforced here.
 *
 * ALL DEPENDENCIES ARE INJECTABLE (tests drive the refresher with a fake,
 * the QR with a stub, and the copy buttons with a stubbed clipboard).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createInboundAddressRefresher } from "../lib/thorchain/inboundAddresses.js";
import { buildDepositMemo, THORCHAIN_SOURCE_ASSETS, parseDepositMemo } from "../lib/thorchain/memo.js";
import { renderQrSvg } from "../lib/thorchain/qr.js";

/** The four allowed sources, with UI metadata. `family` maps to the
 *  WalletContext session that can prefill the refund address. */
export const THORCHAIN_SOURCES = Object.freeze([
  { id: "BTC", asset: THORCHAIN_SOURCE_ASSETS.BTC, label: "Bitcoin", family: "bitcoin", memoNote: "Attach the memo as an OP_RETURN output in your Bitcoin transaction." },
  { id: "DOGE", asset: THORCHAIN_SOURCE_ASSETS.DOGE, label: "Dogecoin", family: "dogecoin", memoNote: "Attach the memo as an OP_RETURN output in your Dogecoin transaction." },
  { id: "LTC", asset: THORCHAIN_SOURCE_ASSETS.LTC, label: "Litecoin", family: "litecoin", memoNote: "Attach the memo as an OP_RETURN output in your Litecoin transaction." },
  { id: "XRP", asset: THORCHAIN_SOURCE_ASSETS.XRP, label: "XRP", family: "xrp", memoNote: "The memo goes in the XRPL Memos field — NOT a destination tag." },
]);

/** TODO(3.3 + THORName): the affiliate bps from the brief (start 100) once
 *  Franky registers the Teleporter THORName. 0 until then — expectedAmountOut
 *  defaults to the sent amount unchanged. */
const AFFILIATE_BPS = 0;

const S = {
  wrap: { padding: "16px 16px 20px" },
  title: { fontSize: 15, fontWeight: 700, color: "#e8edf6", marginBottom: 2 },
  subtitle: { fontSize: 12, color: "#7d8aa0", marginBottom: 14, lineHeight: 1.5 },
  sectionLabel: { fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#475065", margin: "14px 0 8px" },
  sources: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 },
  sourceBtn: {
    padding: "10px 6px", borderRadius: 10, border: "1px solid #1a2130",
    background: "rgba(13,18,28,0.5)", color: "#9aa6bb", cursor: "pointer",
    fontSize: 13, fontWeight: 700, display: "flex", flexDirection: "column", gap: 2, alignItems: "center",
  },
  sourceBtnActive: { borderColor: "rgba(63,211,232,0.6)", color: "#e8edf6", background: "rgba(63,211,232,0.07)" },
  sourceBtnHalted: { opacity: 0.45, cursor: "not-allowed", color: "#475065" },
  sourceTicker: { fontSize: 15 },
  sourcePaused: { fontSize: 9, fontWeight: 600, color: "#E8C04A", textTransform: "uppercase", letterSpacing: "0.05em" },
  destRow: {
    display: "flex", alignItems: "center", gap: 8, padding: "10px 12px",
    borderRadius: 10, border: "1px solid #1a2130", background: "rgba(13,18,28,0.5)",
  },
  destBadge: { fontSize: 12, fontWeight: 800, color: "#3fd3e8", whiteSpace: "nowrap" },
  destInput: {
    flex: 1, background: "transparent", border: "none", outline: "none",
    color: "#e8edf6", fontFamily: "monospace", fontSize: 12,
  },
  destLocked: { fontSize: 10, color: "#475065", whiteSpace: "nowrap" },
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
  depositCard: {
    marginTop: 12, padding: "12px", borderRadius: 12,
    border: "1px solid #1a2130", background: "rgba(13,18,28,0.5)",
  },
  rowLabel: { fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#475065", marginBottom: 4 },
  mono: {
    fontFamily: "monospace", fontSize: 11, color: "#e8edf6", wordBreak: "break-all",
    background: "rgba(0,0,0,0.25)", border: "1px solid #1a2130", borderRadius: 8,
    padding: "8px 10px", lineHeight: 1.5,
  },
  copyBtn: {
    marginTop: 6, padding: "4px 10px", borderRadius: 8, fontSize: 11, fontWeight: 600,
    border: "1px solid #1a2130", background: "rgba(63,211,232,0.08)", color: "#3fd3e8", cursor: "pointer",
  },
  qrBox: { display: "flex", justifyContent: "center", marginTop: 12 },
  qr: { background: "#0a1019", borderRadius: 10, padding: 8, border: "1px solid #1a2130", width: 168, height: 168 },
  qrErr: { fontSize: 11, color: "#f0a0a0" },
  note: { fontSize: 11, color: "#475065", lineHeight: 1.6, marginTop: 10 },
  input: {
    width: "100%", boxSizing: "border-box", marginTop: 8, padding: "9px 10px",
    borderRadius: 10, border: "1px solid #1a2130", background: "rgba(13,18,28,0.5)",
    color: "#e8edf6", fontFamily: "monospace", fontSize: 12, outline: "none",
  },
  submitBtn: {
    width: "100%", marginTop: 12, padding: "11px 12px", borderRadius: 10,
    background: "linear-gradient(180deg, rgba(63,211,232,0.22), rgba(63,211,232,0.12))",
    border: "1px solid rgba(63,211,232,0.45)", color: "#e8edf6", fontSize: 13,
    fontWeight: 700, cursor: "pointer",
  },
  submitBtnDisabled: { opacity: 0.45, cursor: "not-allowed" },
  backLink: {
    marginTop: 14, background: "none", border: "none", color: "#7d8aa0",
    fontSize: 12, cursor: "pointer", padding: 0,
  },
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
 * @param {string|null} props.solAddress connected Solana session public key
 * @param {boolean} [props.solConnected] whether a Solana wallet is connected
 * @param {object} [props.sourceSessions] { bitcoin?: {address}, litecoin?:
 *   {address}, dogecoin?: {address}, xrp?: {address} } — feeds the refund
 *   prefill (the wallet-layer deposit rows from Steps 2.3/2.4)
 * @param {Function} props.onSubmit ({inboundTxid, sourceChain, destination,
 *   expectedAmountOut}) => void — the hook emission to the progress stage
 * @param {Function} [props.onBack] () => void — back to the quote stage
 * @param {Function} [props.createInboundRefresher] DI (default real)
 * @param {string} [props.inboundBaseUrl] THORChain API base URL
 * @param {Function} [props.fetchImpl] fetch DI for the refresher
 * @param {number} [props.refreshIntervalMs] refresh cadence (default 60s)
 * @param {Function} [props.qrFactory] async (text) => svg string (DI)
 */
export default function THORChainDeposit({
  solAddress,
  solConnected = false,
  sourceSessions = {},
  onSubmit,
  onBack,
  createInboundRefresher = createInboundAddressRefresher,
  inboundBaseUrl,
  fetchImpl,
  refreshIntervalMs,
  qrFactory = renderQrSvg,
}) {
  const [selected, setSelected] = useState("BTC");
  const [inbound, setInbound] = useState(null); // { BTC: entry, ... } | null
  const [inboundError, setInboundError] = useState(null);
  const [refund, setRefund] = useState("");
  const [txid, setTxid] = useState("");
  const [amountSent, setAmountSent] = useState("");
  const [qr, setQr] = useState(null);
  const [qrError, setQrError] = useState(null);
  const [copied, setCopied] = useState(null);

  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  // Inbound-address refresher: fetch on mount + every 60s. In-memory only —
  // the refresher never persists vault addresses (never-cache rule).
  useEffect(() => {
    const refresher = createInboundRefresher({
      fetchImpl,
      baseUrl: inboundBaseUrl,
      intervalMs: refreshIntervalMs,
    });
    refresher.start({
      onUpdate: (entries) => {
        const byChain = {};
        for (const e of entries) byChain[e.chain] = e;
        setInbound(byChain);
        // A successful refresh clears the previous error — the banner
        // "surfaces and recovers on the next refresh" (spec).
        setInboundError(null);
      },
      onError: (msg) => setInboundError(msg),
    });
    return () => refresher.stop();
  }, [createInboundRefresher, fetchImpl, inboundBaseUrl, refreshIntervalMs]);

  const selectedMeta = THORCHAIN_SOURCES.find((s) => s.id === selected);
  const selectedEntry = inbound?.[selected] ?? null;
  const selectedHalted = selectedEntry?.halted === true;

  // Refund prefill: when the source chain changes, prefill from the
  // connected source-wallet session (Steps 2.3/2.4 deposit rows feed this).
  const handleSelect = (id) => {
    if (inbound?.[id]?.halted === true) return; // greyed out — not selectable
    setSelected(id);
  };

  // The prefill also applies on MOUNT (the default BTC selection) and
  // whenever the selected chain's connected session changes. Depends on the
  // primitive address string — not the sourceSessions object — so parent
  // re-renders never clobber a refund the user is mid-typing.
  const sessionRefundAddress = selectedMeta ? (sourceSessions[selectedMeta.family]?.address ?? "") : "";
  useEffect(() => {
    setRefund(sessionRefundAddress);
  }, [selected, sessionRefundAddress]);

  // The deposit memo — rebuilt whenever the destination or refund changes.
  const memo = useMemo(() => {
    if (!solAddress || !selectedMeta) return null;
    try {
      return buildDepositMemo({
        sourceChain: selectedMeta.id,
        destAddress: solAddress,
        refundAddress: refund.trim() !== "" ? refund.trim() : undefined,
      });
    } catch {
      return null;
    }
  }, [solAddress, selectedMeta, refund]);

  // QR for the deposit address (regenerate when the vault address changes).
  useEffect(() => {
    let cancelled = false;
    setQr(null);
    setQrError(null);
    const address = selectedEntry?.address;
    if (!address) return undefined;
    Promise.resolve(qrFactory(address))
      .then((svg) => {
        if (!cancelled) setQr(String(svg));
      })
      .catch((e) => {
        if (!cancelled) setQrError(e?.message || String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [qrFactory, selectedEntry?.address]);

  const handleCopy = (label, text) => {
    copyText(text).then(() => {
      setCopied(label);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(null), 1500);
    });
  };

  // Clear the copy-confirmation timer on unmount (no dangling timers).
  const copyTimerRef = useRef(null);
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const canSubmit =
    solConnected &&
    !!solAddress &&
    !!selectedEntry &&
    !selectedHalted &&
    txid.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit || !solAddress) return;
    // expectedAmountOut: optional — TODO(3.3) the aggregator quote supplies
    // it; until then default to the sent amount minus the affiliate bps
    // (0 until Franky registers the THORName).
    let expectedAmountOut;
    const sent = Number(amountSent);
    if (Number.isFinite(sent) && sent > 0) {
      expectedAmountOut = sent * (1 - AFFILIATE_BPS / 10_000);
    }
    onSubmitRef.current?.({
      inboundTxid: txid.trim(),
      sourceChain: selectedMeta.id,
      destination: solAddress,
      ...(expectedAmountOut !== undefined ? { expectedAmountOut } : {}),
    });
  };

  // ── NO SOLANA WALLET → BLOCK (brief wallet rule 4) ──
  if (!solConnected || !solAddress) {
    return (
      <div className="thorchain-deposit" role="tabpanel" aria-label="THORChain deposit" data-testid="tc-deposit" style={S.wrap}>
        <div style={S.title}>Deposit address</div>
        <div style={S.subtitle}>BTC · DOGE · LTC · XRP → SOL.SOL</div>
        <div style={S.block} data-testid="tc-deposit-no-solana">
          Connect a Solana wallet first — the destination is your Solana
          wallet's address and cannot be typed. Open the Teleport tab to
          connect one.
        </div>
        {onBack ? (
          <button type="button" style={S.backLink} data-testid="tc-back" onClick={onBack}>
            ← Back to quote
          </button>
        ) : null}
      </div>
    );
  }

  const memoParts = memo ? parseDepositMemo(memo) : null;

  return (
    <div className="thorchain-deposit" role="tabpanel" aria-label="THORChain deposit" data-testid="tc-deposit" style={S.wrap}>
      <div style={S.title}>Deposit address</div>
      <div style={S.subtitle}>Send native {selectedMeta.label} to THORChain — it lands on Solana as SOL, then hops to X1.</div>

      <div style={S.sectionLabel}>1 · Source chain</div>
      <div style={S.sources} data-testid="tc-sources">
        {THORCHAIN_SOURCES.map((src) => {
          const entry = inbound?.[src.id] ?? null;
          const halted = entry?.halted === true;
          const active = selected === src.id;
          return (
            <button
              key={src.id}
              type="button"
              data-testid={`tc-source-${src.id}`}
              data-halted={halted ? "true" : "false"}
              data-active={active ? "true" : "false"}
              disabled={halted}
              onClick={() => handleSelect(src.id)}
              style={{
                ...S.sourceBtn,
                ...(active ? S.sourceBtnActive : {}),
                ...(halted ? S.sourceBtnHalted : {}),
              }}
              title={halted ? "paused by THORChain" : src.label}
            >
              <span style={S.sourceTicker}>{src.id}</span>
              {halted ? <span style={S.sourcePaused}>paused</span> : <span style={{ fontSize: 9, color: "#475065" }}>{src.label}</span>}
            </button>
          );
        })}
      </div>

      <div style={S.sectionLabel}>2 · Destination (locked)</div>
      <div style={S.destRow} data-testid="tc-destination">
        <span style={S.destBadge}>SOL.SOL</span>
        <input
          style={S.destInput}
          data-testid="tc-destination-input"
          value={solAddress}
          readOnly
          tabIndex={-1}
          aria-label="Destination Solana address (from your connected wallet)"
        />
        <span style={S.destLocked}>from wallet</span>
      </div>

      {selectedHalted ? (
        <div style={S.banner} data-testid="tc-paused-banner">
          ⚠️ {selectedMeta.label} is paused by THORChain right now — deposits to this chain are halted. Choose another source or wait — this refreshes automatically.
        </div>
      ) : null}

      {inboundError ? (
        <div style={S.bannerErr} data-testid="tc-inbound-error">
          ⚠️ {inboundError} — retrying automatically.
        </div>
      ) : null}

      {selectedEntry?.address ? (
        <div style={S.depositCard} data-testid="tc-deposit-card">
          <div style={S.rowLabel}>Deposit address ({selectedMeta.id})</div>
          <div style={S.mono} data-testid="tc-deposit-address">{selectedEntry.address}</div>
          <button type="button" style={S.copyBtn} data-testid="tc-copy-address" onClick={() => handleCopy("address", selectedEntry.address)}>
            {copied === "address" ? "✓ Copied" : "Copy"}
          </button>

          <div style={{ ...S.rowLabel, marginTop: 12 }}>Memo (required)</div>
          <div style={S.mono} data-testid="tc-memo">{memo ?? "—"}</div>
          <button type="button" style={S.copyBtn} data-testid="tc-copy-memo" onClick={() => memo && handleCopy("memo", memo)}>
            {copied === "memo" ? "✓ Copied" : "Copy"}
          </button>
          <div style={S.note} data-testid="tc-memo-note">
            {selectedMeta.memoNote} Your deposit is refunded to the sending
            wallet{refund.trim() !== "" ? ` (or ${refund.trim().slice(0, 10)}… if the swap fails)` : ""}.
          </div>

          <div style={S.qrBox} data-testid="tc-qr">
            {qr ? (
              <div style={S.qr} dangerouslySetInnerHTML={{ __html: qr }} />
            ) : qrError ? (
              <span style={S.qrErr}>QR unavailable ({qrError})</span>
            ) : (
              <span style={S.note}>Generating QR…</span>
            )}
          </div>

          <div style={S.note}>
            Scan to send from a mobile wallet — the memo above must still be
            attached to the transaction ({selectedMeta.id === "XRP" ? "XRPL Memos field" : "OP_RETURN"}).
            {/* TODO(3.3): the 0.05 BTC-equivalent size cap is a config value
                owned by the quote/fee work — NOT enforced here. */}
          </div>
        </div>
      ) : inbound === null ? (
        <div style={S.note} data-testid="tc-deposit-loading">Loading deposit addresses…</div>
      ) : (
        <div style={S.bannerErr} data-testid="tc-deposit-unavailable">
          No deposit address for {selectedMeta.label} right now — retrying automatically.
        </div>
      )}

      <div style={S.sectionLabel}>3 · Refund address ({selectedMeta.id})</div>
      <input
        style={S.input}
        data-testid="tc-refund-input"
        placeholder={`Your ${selectedMeta.label} address — refunds return here if the swap fails (defaults to your sending wallet)`}
        value={refund}
        onChange={(e) => setRefund(e.target.value)}
        spellCheck={false}
      />

      <div style={S.sectionLabel}>4 · Confirm your send</div>
      <input
        style={S.input}
        data-testid="tc-txid-input"
        placeholder="Paste your inbound transaction ID (txid) after sending"
        value={txid}
        onChange={(e) => setTxid(e.target.value)}
        spellCheck={false}
      />
      <input
        style={S.input}
        data-testid="tc-amount-input"
        placeholder={`Amount sent in ${selectedMeta.id} (optional — helps detect the SOL landing)`}
        value={amountSent}
        onChange={(e) => setAmountSent(e.target.value)}
        inputMode="decimal"
      />
      <div style={S.note}>
        The estimated SOL output (expectedAmountOut) arrives with the Step 3.3
        quote — until then it defaults to your sent amount.
      </div>
      <button
        type="button"
        style={{ ...S.submitBtn, ...(!canSubmit ? S.submitBtnDisabled : {}) }}
        data-testid="tc-submit"
        disabled={!canSubmit}
        onClick={handleSubmit}
      >
        I've sent it — track my hop
      </button>

      {onBack ? (
        <button type="button" style={S.backLink} data-testid="tc-back" onClick={onBack}>
          ← Back to quote
        </button>
      ) : null}
    </div>
  );
}

export { THORCHAIN_SOURCE_ASSETS };
