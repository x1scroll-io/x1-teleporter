/**
 * TeleportForm — the Phase 3 bridge form inside the v2 Teleport tab
 * (replaces the "Phase 3" placeholder in TeleportTab's ConnectedBody).
 *
 * Ported from the v1 quote/swap form (src/Teleporter.jsx — untouched, the
 * flag-restorable safety net). Scope: EVM → X1 (the hop's route). The
 * from-chain picker lists EVM chains; the destination is fixed to X1; the
 * reverse/onward paths stay out (flag-gated; step 1.2 removed the relay).
 *
 * THE FLOW (per docs/BRIEF.md — one card, sequential states, quiet honest
 * fee lines):
 *   idle → Get Quote → quoting → quoted (fee lines from computeFee via
 *   quoteFees: Teleporter fee 1% + Warp bridge fee $1 on X1 routes + "you
 *   receive" net) → Bridge — Step 1 of 2 (the simulation-gated EVM LiFi leg,
 *   guardedSendEvmTx) → Step 2 of 2 (the Warp Solana→X1 hop, gated by
 *   WARP_LIVE_SEND for real broadcasts) → relaying / done / handoff.
 *
 * WALLET WIRING (v2 wallet layer, NOT v1's getOriginWallet):
 *   - EVM session (sessions.evm): its provider/address drive the quote's
 *     fromAddress and the stage-1 send. The sign-capable EIP-1193 provider is
 *     resolved via resolveEvmProvider (the session provider is the connect
 *     adapter; the raw provider sits behind discovered.provider.getProvider).
 *   - Solana session (sessions.solana): its address is the LiFi leg's
 *     toAddress (the hop lands USDC on Solana) and its adapter signs the
 *     stage-2 Warp tx. NO PLACEHOLDERS — quotes use only real connected
 *     addresses (v1 policy, kept verbatim).
 *
 * GATES (kept from v1, unchanged):
 *   - Simulation gates: guardedSendEvmTx (stage 1) + runStage2's fail-closed
 *     simulate (stage 2) block doomed txs and surface the reason.
 *   - WARP_LIVE_SEND (VITE_WARP_LIVE_SEND): stage 2 broadcasts for real only
 *     when the flag is true; otherwise it runs in confirm-mode (simulates,
 *     shows "not sent").
 *   - Placeholder-address backstop: refuses to bridge to a known demo
 *     address even if one is ever reintroduced.
 *
 * HONEST DEAD-ENDS (no silent failures): missing wallet → explicit prompt;
 * quote failure → explicit error; stage 1 sent but no Solana wallet → handoff
 * state (funds rest safely on Solana; finish on the official Warp Bridge or
 * connect the Solana wallet); stage 2 failure → handoff with the surfaced
 * reason + Retry.
 */

import { useState } from "react";
import {
  CHAINS, TOKENS, EVM_CHAINS, X1_MIN, WARP_BRIDGE_URL, SOLANA_RPC, tokensFor,
} from "../lib/teleportConstants.js";
import { buildLifiQuoteParams, deriveQuoteFromLifi } from "../lib/teleportQuote.js";
import { executeLiFiEvmTx } from "../lib/teleportExecute.js";
import { resolveEvmProvider, resolveSolanaAdapter, solanaSessionCanSign } from "../lib/wallet/sessionProviders.js";
import { SimulationError } from "../lib/simulateTx.js";
import { LiFiApprovalValidationError } from "../lib/lifiApproval.js";
import { WARP_LIVE_SEND } from "../lib/flags.ts";
import { FEE_WALLETS } from "../lib/fees.ts";

/**
 * The real stage-2 (Warp Solana→X1) runner. Default for the form; tests
 * inject a fake to pin the WARP_LIVE_SEND gate without touching a chain.
 * The form passes `allowLive: WARP_LIVE_SEND` — the flag is read here only
 * as a forwarded value, so the gate stays testable and visible.
 */
export async function defaultStage2Runner({ solAdapter, amountHuman, allowLive }) {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const { runStage2 } = await import("../warpBridge.js");
  const connection = new Connection(SOLANA_RPC, "confirmed");
  return runStage2({
    connection,
    userPubkey: solAdapter.publicKey,
    feeWalletSvm: new PublicKey(FEE_WALLETS.SVM),
    amountHuman,
    allowLive, // WARP_LIVE_SEND gate — passed by the form (never hardcoded)
    provider: solAdapter,
  });
}

const S = {
  form: { padding: 16 },
  row: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: 12, background: "#0d1420", border: "1px solid #1c2a3f", borderRadius: 8,
    padding: "12px 14px", marginBottom: 8, color: "#e8ecf3",
  },
  rowCol: { display: "flex", flexDirection: "column", gap: 4 },
  label: { fontSize: 11, color: "#7d8aa0", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".04em" },
  select: {
    background: "#0a1019", color: "#e8ecf3", border: "1px solid #1c2a3f",
    borderRadius: 6, padding: "6px 10px", fontSize: 13, minWidth: 150,
  },
  input: {
    width: "100%", background: "#0a1019", color: "#e8ecf3",
    border: "1px solid #1c2a3f", borderRadius: 6, padding: "8px 10px",
    fontSize: 15, boxSizing: "border-box",
  },
  hint: { fontSize: 11, color: "#5B9DFF", marginTop: 6, lineHeight: 1.5 },
  warn: { fontSize: 11, color: "#E8C04A", marginTop: 6, lineHeight: 1.5 },
  cta: {
    width: "100%", marginTop: 14, padding: "13px 0", borderRadius: 10,
    border: "none", cursor: "pointer", fontWeight: 700, fontSize: 14,
    background: "linear-gradient(90deg,#2775E8,#1e9fd4)", color: "#fff",
  },
  ctaDisabled: { opacity: 0.6, cursor: "default" },
  quoteBox: {
    marginTop: 14, padding: "12px 14px", borderRadius: 10,
    background: "#0d1420", border: "1px solid #1c2a3f",
  },
  quoteRow: { display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 13 },
  quoteKey: { color: "#7d8aa0" },
  quoteVal: { color: "#9aa6bb", fontWeight: 600 },
  quoteValHi: { color: "#3fd3e8", fontWeight: 700 },
  note: { fontSize: 11, color: "#7d8aa0", marginTop: 6, lineHeight: 1.5 },
  steps: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 },
  stepChip: {
    fontSize: 11, padding: "3px 8px", borderRadius: 999, color: "#9aa6bb",
    border: "1px solid #28303f",
  },
  box: {
    marginTop: 14, padding: "12px 14px", borderRadius: 10, fontSize: 13,
    lineHeight: 1.5, border: "1px solid #1c2a3f", background: "#0d1420", color: "#e8ecf3",
  },
  boxOk: { borderColor: "#1f6b3a" },
  error: {
    marginTop: 14, padding: "10px 12px", borderRadius: 10, fontSize: 12.5,
    lineHeight: 1.5, color: "#f2b8b5", background: "rgba(232,65,66,.08)",
    border: "1px solid rgba(232,65,66,.35)",
  },
  status: { marginTop: 10, fontSize: 12, color: "#7d8aa0" },
  link: { color: "#3fd3e8", textDecoration: "none" },
  ghostBtn: {
    marginTop: 8, width: "100%", padding: "10px 0", borderRadius: 8,
    background: "transparent", border: "1px solid #1a2130", color: "#7d8aa0",
    fontSize: 13, cursor: "pointer",
  },
};

const PLACEHOLDER_EVM = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

/**
 * The bridge form. Renders whenever the Teleport tab has ANY connected
 * session (the tab's second sequential state) and guides the user to the
 * wallets the EVM→X1 route needs.
 *
 * @param {{evmSession: object, solSession: object,
 *          stage2Runner?: (args) => Promise<object>}} props
 *   evmSession / solSession: the WalletContext sessions (sessions.evm /
 *   sessions.solana). stage2Runner: DI'd Warp stage-2 runner for tests
 *   (default: defaultStage2Runner — the real runStage2 path).
 */
export default function TeleportForm({ evmSession, solSession, stage2Runner = defaultStage2Runner }) {
  const [from, setFrom] = useState("eth");
  const [token, setToken] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle|quoting|quoted|bridging|step2|relaying|handoff|done
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [warpSig, setWarpSig] = useState(null);
  const [stage1Hash, setStage1Hash] = useState(null);
  const [confirmMode, setConfirmMode] = useState(false); // stage 2 simulated, not sent
  const [step2Busy, setStep2Busy] = useState(false);

  const evmReady = Boolean(evmSession?.address);
  const solReady = Boolean(solSession?.address);

  const changeFrom = (c) => {
    setFrom(c);
    if (!TOKENS[c]?.[token]) setToken(Object.keys(TOKENS[c] || {})[0] || "USDC");
    setQuote(null); setError(null); setPhase("idle");
  };
  const changeToken = (t) => { setToken(t); setQuote(null); setError(null); setPhase("idle"); };
  const changeAmount = (v) => { setAmount(v); setQuote(null); setError(null); setPhase("idle"); };
  const reset = () => {
    setPhase("idle"); setQuote(null); setError(null); setStatus(null);
    setWarpSig(null); setStage1Hash(null); setConfirmMode(false); setStep2Busy(false);
  };

  async function getQuote() {
    setError(null); setStatus(null);
    const amt = parseFloat(amount);
    if (!amount || !(amt > 0)) { setError("Enter an amount"); return; }
    if (amt < X1_MIN) { setError(`Bridge $${X1_MIN}+ into X1 to get started`); return; }
    if (!evmReady) { setError("Connect your EVM wallet to get a quote"); return; }
    if (!solReady) { setError("Connect your Solana/X1 wallet to get a quote"); return; }
    const built = buildLifiQuoteParams({
      from, token, amount: amt,
      fromAddress: evmSession.address,
      toAddress: solSession.address,
    });
    if (!built) { setError("No route for the selected chain/token"); return; }
    setPhase("quoting");
    try {
      const resp = await fetch(`/api/lifi/quote?${built.qs}`);
      const d = await resp.json();
      if (d?.error || d?.message) { setError(d.message || d.error); setPhase("idle"); return; }
      const derived = deriveQuoteFromLifi({ data: d, from, token, amount: amt });
      setQuote({ amount: amt, ...derived, lifiData: d });
      setPhase("quoted");
    } catch (e) {
      console.error("[Teleport v2] quote failed:", e);
      setError("Quote request failed"); setPhase("idle");
    }
  }

  async function executeStage1() {
    if (!quote?.lifiData) return;
    setError(null); setStatus(null);
    if (!evmReady) { setError("Connect your EVM wallet (e.g. Rabby/MetaMask) before bridging."); return; }
    // Defense-in-depth: never let a real send go to a known demo address even
    // if one is ever reintroduced by future code.
    if (evmSession.address === PLACEHOLDER_EVM) {
      setError("Refusing to bridge to a demo/placeholder address. Reconnect your real wallet.");
      return;
    }
    const provider = await resolveEvmProvider(evmSession);
    if (!provider) {
      setError("The connected EVM wallet can't sign transactions — reconnect your EVM wallet (e.g. Rabby/MetaMask).");
      return;
    }
    setPhase("bridging");
    try {
      const txHash = await executeLiFiEvmTx({
        lifiData: quote.lifiData, provider, address: evmSession.address,
        onStatus: (msg) => setStatus(msg),
      });
      setStage1Hash(txHash);
      const solAdapter = await resolveSolanaAdapter(solSession);
      setPhase(solAdapter ? "step2" : "handoff");
    } catch (e) {
      console.group("[Teleport v2] Stage 1 FAILED");
      console.error(e);
      console.groupEnd();
      setPhase("quoted");
      if (e instanceof SimulationError || e instanceof LiFiApprovalValidationError) { setError(e.message); return; }
      const isReject = e?.message?.includes("reject") || e?.code === 4001 || e?.message?.includes("User rejected");
      setError(`${isReject ? "Transaction rejected by wallet" : (e?.message || "Send failed")}. Check console for full error.`);
    }
  }

  async function executeStage2() {
    if (!quote) return;
    setError(null); setStatus(null);
    const solAdapter = await resolveSolanaAdapter(solSession);
    if (!solAdapter) {
      setError("Connect your Solana/X1 wallet (Phantom/Backpack) to finish the X1 hop");
      setPhase("handoff");
      return;
    }
    setStep2Busy(true);
    try {
      const res = await stage2Runner({
        solAdapter,
        amountHuman: quote.solanaAmount ?? quote.amount, // bridge what LiFi DELIVERED
        allowLive: WARP_LIVE_SEND, // the gate: real Warp broadcasts only when VITE_WARP_LIVE_SEND=true
      });
      if (!res.success) {
        // Step 1.3A fail-closed: a failed simulation (or one we couldn't run)
        // BLOCKS the send and surfaces the reason.
        if (res.sim?.simUnavailable) {
          setError(`Bridge sim couldn't run (RPC: ${res.sim?.rpcError || "unknown"}) — send blocked. Retry when the RPC is reachable.`);
        } else {
          const logs = res.sim?.logs || [];
          const key = logs.filter((l) => /error|failed|assert|seq|insufficient|invalid|constraint/i.test(l)).slice(-2).join(" | ");
          setError(`Bridge sim failed: ${JSON.stringify(res.sim?.err)}${key ? " — " + key : ""} (full logs in console)`);
        }
        // Funds rest safely on Solana — go to handoff (Retry / Warp Bridge),
        // never back to a state that could re-send stage 1.
        setPhase("handoff");
        return;
      }
      if (res.sent || res.signature) {
        setWarpSig(res.signature);
        setPhase("relaying");
      } else {
        // Simulated only — the WARP_LIVE_SEND gate held (confirm-mode).
        setConfirmMode(true);
        setPhase("done");
      }
    } catch (e) {
      console.error("[Teleport v2] stage 2 error:", e);
      setError(`Warp error: ${String(e?.message || e)}`);
      setPhase("handoff");
    } finally {
      setStep2Busy(false);
    }
  }

  const canStage2 = solanaSessionCanSign(solSession); // hint-level only; executeStage2 re-checks via resolver

  return (
    <div className="teleport-form" data-testid="teleport-form" style={S.form}>
      {/* from / to */}
      <div style={S.row}>
        <span style={S.rowCol}>
          <span style={S.label}>From</span>
          <select data-testid="from-chain" value={from} onChange={(e) => changeFrom(e.target.value)} style={S.select}>
            {EVM_CHAINS.map((c) => (
              <option key={c} value={c} style={{ background: "#0a1019" }}>
                {CHAINS[c].glyph} {CHAINS[c].name}
              </option>
            ))}
          </select>
        </span>
        <span style={S.rowCol}>
          <span style={S.label}>To</span>
          <select data-testid="to-chain" value="x1" onChange={() => {}} style={S.select} aria-label="Destination chain (fixed: X1)">
            <option value="x1" style={{ background: "#0a1019" }}>X1 {CHAINS.x1.glyph} · USDC.x</option>
          </select>
        </span>
      </div>

      {/* token + amount */}
      <div style={S.row}>
        <span style={S.rowCol}>
          <span style={S.label}>Token</span>
          <select data-testid="token" value={token} onChange={(e) => changeToken(e.target.value)} style={S.select}>
            {tokensFor(from).map((t) => (
              <option key={t} value={t} style={{ background: "#0a1019" }}>{t}</option>
            ))}
          </select>
        </span>
        <span style={{ ...S.rowCol, flex: 1 }}>
          <span style={S.label}>Amount</span>
          <input
            data-testid="amount"
            value={amount}
            onChange={(e) => changeAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            style={S.input}
          />
        </span>
      </div>
      <div style={S.hint}>Bridge ${X1_MIN}+ into X1 to get started (the flat $1 Warp fee would be ~11% of a $10 bridge).</div>

      {/* wallet guidance — honest, never a silent dead-end */}
      {!evmReady && (
        <div style={S.warn}>Connect your EVM wallet (Rabby / MetaMask) to bridge from an EVM chain.</div>
      )}
      {!solReady && (
        <div style={S.warn}>Connect your Solana/X1 wallet (Phantom / Backpack) to get a quote — the hop lands USDC on Solana first.</div>
      )}

      {/* quote + send */}
      {phase === "idle" || phase === "quoting" ? (
        <button data-testid="get-quote" style={phase === "quoting" ? { ...S.cta, ...S.ctaDisabled } : S.cta} onClick={getQuote} disabled={phase === "quoting"}>
          {phase === "quoting" ? "Finding route…" : "Get quote"}
        </button>
      ) : phase === "quoted" ? (
        <>
          {quote && (
            <div className="quote-box" data-testid="quote-box" style={S.quoteBox}>
              <div style={S.quoteRow}>
                <span style={S.quoteKey}>You send</span>
                <span style={S.quoteVal}>{quote.amount} {token} on {CHAINS[from].name}</span>
              </div>
              {(quote.feeLines || []).map((l) => (
                <div key={l.id} data-testid={`fee-line-${l.id}`} style={S.quoteRow}>
                  <span style={S.quoteKey}>{l.label}</span>
                  <span style={S.quoteVal}>${l.amountUsd.toFixed(2)}</span>
                </div>
              ))}
              <div style={S.quoteRow}>
                <span style={S.quoteKey}>You receive</span>
                <span data-testid="you-receive" style={S.quoteValHi}>≈ {quote.net.toFixed(2)} {quote.recvToken} on {quote.recvChain}</span>
              </div>
              {quote.note && <div style={S.note}>{quote.note}</div>}
              <div style={S.steps}>
                {(quote.steps || []).map((s, i) => (
                  <span key={i} style={S.stepChip}>{s.tool} · {s.name}</span>
                ))}
              </div>
            </div>
          )}
          <button data-testid="bridge-now" style={S.cta} onClick={executeStage1}>
            Bridge — Step 1 of 2
          </button>
        </>
      ) : phase === "bridging" ? (
        <button data-testid="bridging" style={{ ...S.cta, ...S.ctaDisabled }} disabled>
          Bridging… {status ? `(${status})` : ""}
        </button>
      ) : phase === "step2" ? (
        <>
          <div style={S.box}>
            <b>Stage 1 sent</b> — {stage1Hash ? `tx ${String(stage1Hash).slice(0, 10)}…` : ""} your USDC is on its way to Solana.
            Approve Stage 2 to mint USDC.x on X1. If you stop here, your funds rest safely as USDC on Solana.
          </div>
          <button data-testid="bridge-step2" style={step2Busy ? { ...S.cta, ...S.ctaDisabled } : S.cta} onClick={executeStage2} disabled={step2Busy}>
            {step2Busy ? "Bridging to X1…" : "Step 2 of 2 — finish the hop to X1"}
          </button>
        </>
      ) : phase === "relaying" ? (
        <div data-testid="relaying" style={S.box}>
          <b>bridge_out sent</b> {warpSig ? `(${String(warpSig).slice(0, 10)}…)` : ""} — the official submitter relays it to X1.
          Your funds are safe. Watch the Warp status for the X1 mint.
          <button data-testid="reset" style={S.ghostBtn} onClick={reset}>Done / bridge again</button>
        </div>
      ) : phase === "handoff" ? (
        <div data-testid="handoff" style={S.box}>
          <b>Stage 1 sent</b> — your USDC is on Solana
          {stage1Hash ? ` (tx ${String(stage1Hash).slice(0, 10)}…)` : ""}.
          {canStage2 && (
            <>
              {" "}Stage 2 didn't complete.{" "}
              <button data-testid="retry-stage2" style={{ ...S.ghostBtn, marginTop: 0, width: "auto", padding: "4px 12px" }} onClick={executeStage2} disabled={step2Busy}>
                Retry stage 2
              </button>
            </>
          )}
          {!canStage2 && (
            <> Connect a Solana/X1 wallet (Phantom / Backpack) to finish the hop to X1, or finish on the official Warp Bridge — connect the same Solana wallet and bridge Solana → X1.</>
          )}
          <div style={{ marginTop: 8 }}>
            <a href={WARP_BRIDGE_URL} target="_blank" rel="noopener noreferrer" style={S.link}>🌉 Open Warp Bridge to finish → X1</a>
          </div>
          <button data-testid="reset" style={S.ghostBtn} onClick={reset}>Done / bridge again</button>
        </div>
      ) : phase === "done" ? (
        <div data-testid="done" style={{ ...S.box, ...S.boxOk }}>
          {confirmMode
            ? <>✓ Simulation passed — <b>not sent</b> (live Warp sends are OFF; set VITE_WARP_LIVE_SEND=true to arm).</>
            : <>✓ Bridge complete — USDC.x on X1.</>}
          <button data-testid="reset" style={S.ghostBtn} onClick={reset}>Bridge again</button>
        </div>
      ) : null}

      {status && phase === "quoted" && <div data-testid="form-status" style={S.status}>{status}</div>}
      {error && (
        <div data-testid="form-error" style={S.error}>⚠️ {error}</div>
      )}
    </div>
  );
}
