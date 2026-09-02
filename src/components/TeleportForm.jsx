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
 *   receive" net) → Bridge — Step 1 of 2 (the ROUTING-ENGINE's EVM stage:
 *   the exact-amount approval leg + the sim-gated LiFi bridge leg — see
 *   docs/ROUTING-ENGINE.md) → Step 2 of 2 (the engine's SVM stage: the X1
 *   ATA-prep leg + the Warp lock leg, gated by
 *   WARP_LIVE_SEND for real broadcasts) → relaying / done / handoff.
 *
 * WALLET WIRING (v2 wallet layer, NOT v1's getOriginWallet):
 *   - EVM session (sessions.evm): its provider/address drive the quote's
 *     fromAddress and the stage-1 send. The sign-capable EIP-1193 provider is
 *     resolved via the engine's SignerResolver (evm → resolveEvmProvider —
 *     the session provider is the connect adapter; the raw provider sits
 *     behind discovered.provider.getProvider).
 *   - Solana session (sessions.solana): its address is the LiFi leg's
 *     toAddress (the hop lands USDC on Solana) and its adapter signs the
 *     stage-2 Warp tx via SignerResolver (svm → resolveSolanaAdapter).
 *     NO PLACEHOLDERS — quotes use only real connected
 *     addresses (v1 policy, kept verbatim).
 *
 * GATES (kept from v1, unchanged):
 *   - Simulation gates: the engine legs' simulate phases (stage 1 EVM legs
 *     throw SimulationError on a revert; the SVM stage runners fail closed)
 *     block doomed txs and surface the reason.
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

import { useEffect, useState } from "react";
import {
  CHAINS, EVM_CHAINS, X1_MIN, X1_REVERSE_MIN, WARP_BRIDGE_URL, SOLANA_RPC, X1_RPC,
  TOKENS, tokensFor,
} from "../lib/teleportConstants.js";
import { buildLifiQuoteParams, deriveQuoteFromLifi } from "../lib/teleportQuote.js";
import { buildReverseLifiQuoteParams, deriveReverseQuote, computeReverseLegs, checkReverseMin } from "../lib/reverseQuote.js";
import { resolveSolanaAdapter, solanaSessionCanSign } from "../lib/wallet/sessionProviders.js";
import { SignerResolver, RoutePlanner, runForwardEvmStage, runForwardSvmStage } from "../engine/index.js";
import { SimulationError } from "../lib/simulateTx.js";
import { LiFiApprovalValidationError } from "../lib/lifiApproval.js";
import { WARP_LIVE_SEND } from "../lib/flags.ts";
import { FEE_WALLETS } from "../lib/fees.ts";
import BalancesLine from "./BalancesLine.jsx";

/**
 * truncateAddress — display helper for the destination-address lines.
 * The reverse LiFi leg delivers USDC to the connected EVM wallet; the UI
 * MUST show that address before the user signs (a wrong EVM address is
 * IRREVERSIBLE — the funds land somewhere they can't get back). Displays
 * first 6 + last 4 chars with "..." between; the FULL address rides in the
 * title attr (hover). Same shape as the LiFi toAddress — the source of
 * truth is the connected session (evmSession.address reverse,
 * solSession.address forward). Fail-soft: null/empty/short input is
 * returned as-is, never a bogus truncation.
 */
export function truncateAddress(addr) {
  if (!addr) return null;
  const s = String(addr);
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

/**
 * The real stage-2 (Warp Solana→X1) runner. Default for the form; tests
 * inject a fake to pin the WARP_LIVE_SEND gate without touching a chain.
 * The form passes `allowLive: WARP_LIVE_SEND` — the flag is read here only
 * as a forwarded value, so the gate stays testable and visible.
 */
export async function defaultStage2Runner({ solAdapter, amountHuman, allowLive, destToken = "USDC.x" }) {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  // The routing engine runs the SVM stage (stage 2 of 2): the X1 ATA-prep leg
  // (recipient USDC.x/wSOL.X ATA — idempotent, payer = the connected wallet)
  // then the Warp lock leg, exactly as runStage2 did — now as LegContract legs.
  const route = RoutePlanner.planForward({ direction: "forward" });
  const connection = new Connection(SOLANA_RPC, "confirmed");
  const x1Connection = new Connection(X1_RPC, "confirmed");
  return runForwardSvmStage({
    route,
    solAdapter,
    feeWalletSvm: new PublicKey(FEE_WALLETS.SVM),
    amountHuman,
    allowLive, // WARP_LIVE_SEND gate — passed by the form (never hardcoded)
    destToken, // the X1 destination token — drives the Solana source (USDC | WSOL)
    connections: { solana: connection, x1: x1Connection },
  });
}

/**
 * The real REVERSE stage-1 runner (Warp X1→Solana burn). Default for the
 * form; tests inject a fake to pin the WARP_LIVE_SEND gate + amount without
 * touching a chain. The form passes `allowLive: WARP_LIVE_SEND` — the flag
 * is read here only as a forwarded value, so the gate stays testable.
 *
 * Fee policy (1% once, x1_onward class): the skim is computed from SKIM_BPS
 * (sourced from fees.ts) on the GROSS input — runReverse prepends the 1%
 * USDC.x transfer to FEE_WALLETS.X1 and burns the remainder. The burn amount
 * is therefore gross − skim, exactly what the quote box showed.
 */
export async function defaultReverseStage1Runner({ solAdapter, amountHuman, allowLive, token = "USDC.x" }) {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const { runReverse, SKIM_BPS } = await import("../warpBridge.js");
  // X1 RPC: the burn executes on X1 mainnet (SVM-compatible) — sim + send
  // both go through this connection (the PR #30 deterministic-broadcast
  // pattern: signTransaction + app broadcast via the chain RPC).
  const connection = new Connection(X1_RPC, "confirmed");
  const skim = (amountHuman * Number(SKIM_BPS)) / 10_000; // 1% of the gross
  return runReverse({
    connection,
    userPubkey: solAdapter.publicKey,
    amountHuman: amountHuman - skim, // bridge_out burns the net
    feeAmount: skim,                 // 1% skim to OUR X1 fee wallet (in the token's own units)
    feeWallet: new PublicKey(FEE_WALLETS.X1),
    allowLive, // WARP_LIVE_SEND gate — passed by the form (never hardcoded)
    provider: solAdapter,
    token, // "USDC.x" | "wSOL.X" — mint/decimals/fee account for the burn
  });
}

/**
 * The real REVERSE stage-2 runner (LiFi Solana→EVM leg). Default for the
 * form; tests inject a fake. Bridges the net that actually LANDED on Solana
 * (deterministic: X − 1% − Warp's $1): fresh LiFi quote at execute time
 * (fail-closed — a quote failure surfaces instead of guessing), then the
 * simulation-gated Solana tx via executeLiFiSolanaTx (the v1 x1_onward leg-2
 * executor, already in the codebase). The SVM wallet signs; the EVM address
 * is the destination. NOT a Warp broadcast — no WARP_LIVE_SEND gate here: it
 * is only reachable after a REAL burn released USDC on Solana (stage 1 is the
 * gated step).
 */
export async function defaultReverseStage2Runner({ solAdapter, evmAddress, to, toTokenSymbol = "USDC", netOnSolana, onStatus = () => {}, token = "USDC.x" }) {
  const { executeLiFiSolanaTx } = await import("../lib/lifiSolanaTx.js");
  const built = buildReverseLifiQuoteParams({
    to,
    toTokenSymbol, // the user-selected destination stable (USDC/USDT/DAI) — the LiFi leg delivers THIS
    netOnSolana,
    fromAddress: solAdapter.publicKey?.toBase58 ? solAdapter.publicKey.toBase58() : String(solAdapter.publicKey),
    toAddress: evmAddress, // the connected EVM session's address (no placeholders)
    token, // "USDC.x" → LiFi fromToken USDC (6 dec); "wSOL.X" → fromToken WSOL (9 dec)
  });
  if (!built) throw new Error("No route for the selected destination chain");
  onStatus("Quoting the Solana → " + to + " leg…");
  const resp = await fetch(`/api/lifi/quote?${built.qs}`);
  const d = await resp.json();
  if (d?.error || d?.message) throw new Error(d.message || d.error);
  onStatus("Sending the Solana → " + to + " leg…");
  return executeLiFiSolanaTx({ lifiData: d, solWallet: solAdapter });
}

/**
 * The real REVERSE release poller: after the X1 burn is broadcast, the Warp
 * guardians release USDC on Solana. Polls the app's OWN serverless proxy
 * (/api/warp/* — same-origin, deterministic; fix/proxy-warp-poll) with
 * from=x1 and reports progress via onUpdate; resolves { ok, destinationTx }
 * when the release is confirmed. Default for the form; tests inject a fake.
 */
export async function defaultReleasePoller(sig, { onUpdate = () => {} } = {}) {
  const { pollWarpStatus } = await import("../warpBridge.js");
  return pollWarpStatus(sig, {
    from: "x1", // reverse direction: source chain is X1
    maxMs: 300_000,
    onUpdate,
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
  warnBtn: {
    width: "100%", marginTop: 6, padding: "8px 10px", borderRadius: 8,
    background: "transparent", border: "1px dashed #8a6d1a", color: "#E8C04A",
    fontSize: 11, cursor: "pointer", textAlign: "left", lineHeight: 1.5,
  },
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
  dirBtn: {
    background: "transparent", border: "1px solid #1c2a3f", color: "#7d8aa0",
    borderRadius: 6, padding: "6px 12px", fontSize: 13, cursor: "pointer",
  },
  dirActive: {
    background: "rgba(63,211,232,.12)", border: "1px solid #3fd3e8", color: "#3fd3e8",
    borderRadius: 6, padding: "6px 12px", fontSize: 13, cursor: "pointer", fontWeight: 700,
  },
};

const PLACEHOLDER_EVM = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

/**
 * The bridge form. Renders whenever the Teleport tab has ANY connected
 * session (the tab's second sequential state) and guides the user to the
 * wallets the EVM→X1 route needs.
 *
 * @param {{evmSession: object, solSession: object,
 *          stage2Runner?: (args) => Promise<object>,
 *          onConnectWallet?: () => void,
 *          initialPhase?: string}} props
 *   evmSession / solSession: the WalletContext sessions (sessions.evm /
 *   sessions.solana). stage2Runner: DI'd Warp stage-2 runner for tests
 *   (default: defaultStage2Runner — runs the engine's forward SVM stage:
 *   the X1 ATA-prep leg + the Warp lock leg; see docs/ROUTING-ENGINE.md).
 *   onConnectWallet: when provided (the tab renders the form inside its
 *   ConnectedBody), the missing-wallet warnings become actionable buttons
 *   that open the connect modal — the multi-wallet fix: after the first
 *   connect the modal is gone, so the form's "connect your wallet" prompts
 *   must be able to bring it back.
 *   initialPhase: TEST/RESTORE seam — mount directly into a given phase
 *   ("step2" renders the final-leg confirm box without driving the whole
 *   burn→release→auto-fire journey; the reverse step2 commit is otherwise
 *   transient and unobservable). Defaults to "idle"; no behavior change
 *   when omitted. Also the natural hook for resuming a mid-journey state
 *   after a refresh.
 *   initialDirection: TEST/RESTORE seam — mount directly in a direction
 *   (the toggle resets the phase, so a reverse-phase test needs the
 *   direction set at mount). Defaults to "forward".
 */
export default function TeleportForm({ evmSession, solSession, stage2Runner = defaultStage2Runner, reverseStage1Runner = defaultReverseStage1Runner, reverseStage2Runner = defaultReverseStage2Runner, releasePoller = defaultReleasePoller, onConnectWallet, balancesDeps = {}, initialPhase, initialDirection }) {
  // direction: "forward" = EVM → X1 (the proven on-ramp), "reverse" = X1 → EVM
  // (the off-ramp: Warp burn X1→Solana, then LiFi Solana→EVM). The forward
  // flow is byte-identical in behavior — the toggle only adds the reverse path.
  const [direction, setDirection] = useState(initialDirection || "forward");
  const [from, setFrom] = useState("eth");
  const [to, setTo] = useState("eth"); // reverse destination (EVM chains)
  // The user's chosen stable: the SOURCE token on the forward leg (EVM → X1,
  // what they send in) and the DESTINATION token on the reverse leg (X1 → EVM,
  // what they receive). Options come from TOKENS[chain] (USDC/USDT/DAI as
  // defined per chain — e.g. base has no USDT, sol has no DAI).
  const [token, setToken] = useState("USDC");
  // The X1 side is user-selectable too (both tokens are bridged by Warp):
  // reverseToken = the X1 source for the reverse burn (USDC.x | wSOL.X),
  // destToken = the X1 destination for the forward hop (USDC.x | wSOL.X).
  const [reverseToken, setReverseToken] = useState("USDC.x");
  const [destToken, setDestToken] = useState("USDC.x");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState(null);
  const [phase, setPhase] = useState(initialPhase || "idle"); // idle|quoting|quoted|bridging|step2|relaying|handoff|done
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [warpSig, setWarpSig] = useState(null);
  const [stage1Hash, setStage1Hash] = useState(null);
  const [confirmMode, setConfirmMode] = useState(false); // stage 2 simulated, not sent
  const [step2Busy, setStep2Busy] = useState(false);
  const [reverseStage, setReverseStage] = useState(0); // reverse progress: 0..5 (burn sent → released)
  const [releaseNote, setReleaseNote] = useState(null); // Warp release poll progress text
  const [polling, setPolling] = useState(false);
  const [handoffReason, setHandoffReason] = useState(null); // reverse handoff: burn|lifi|terminal
  // Bumped after a bridge completes — BalancesLine refetches so the user sees
  // the post-bridge wallet state (what's left, and what it's now worth).
  const [balanceRefresh, setBalanceRefresh] = useState(0);

  const evmReady = Boolean(evmSession?.address);
  const solReady = Boolean(solSession?.address);

  const changeDirection = (d) => {
    setDirection(d); setQuote(null); setError(null); setStatus(null);
    setPhase("idle"); setWarpSig(null); setStage1Hash(null); setConfirmMode(false);
    setReverseStage(0); setReleaseNote(null); setHandoffReason(null);
  };

  // changeToken restores the user's stablecoin choice: forward picks what they
  // send in on the source EVM chain; reverse picks what they receive on the
  // destination EVM chain. The X1-side tokens are user-selectable too —
  // changeReverseToken picks the reverse burn source (USDC.x | wSOL.X),
  // changeDestToken the forward X1 destination (USDC.x | wSOL.X).
  const changeToken = (t) => {
    setToken(t); setQuote(null); setError(null); setPhase("idle");
  };
  const changeFrom = (c) => {
    setFrom(c);
    // The token must exist on the new chain (e.g. DAI missing on sol, USDT
    // missing on base) — reset to a valid one for that chain.
    if (!TOKENS[c]?.[token]) setToken(Object.keys(TOKENS[c] || {})[0] || "USDC");
    setQuote(null); setError(null); setPhase("idle");
  };
  const changeTo = (c) => {
    setTo(c);
    // Same guard on the reverse destination: reset to a stable the new chain
    // actually defines.
    if (!TOKENS[c]?.[token]) setToken(Object.keys(TOKENS[c] || {})[0] || "USDC");
    setQuote(null); setError(null); setPhase("idle");
  };
  const changeReverseToken = (t) => { setReverseToken(t); setQuote(null); setError(null); setPhase("idle"); };
  const changeDestToken = (t) => { setDestToken(t); setQuote(null); setError(null); setPhase("idle"); };
  const changeAmount = (v) => { setAmount(v); setQuote(null); setError(null); setPhase("idle"); };
  const reset = () => {
    setPhase("idle"); setQuote(null); setError(null); setStatus(null);
    setWarpSig(null); setStage1Hash(null); setConfirmMode(false); setStep2Busy(false);
    setReverseStage(0); setReleaseNote(null); setPolling(false); setHandoffReason(null);
    setBalanceRefresh((n) => n + 1); // bridge done → show the post-bridge wallet state
  };

  // Manual refresh after a bridge completes: when the journey reaches the
  // "done" phase the wallets changed, so bump the balance line's refresh
  // signal (reset() also bumps, covering "Bridge again").
  useEffect(() => {
    if (phase === "done") setBalanceRefresh((n) => n + 1);
  }, [phase]);

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
      destToken, // USDC.x default; wSOL.X lands WSOL on Solana for the Warp leg
    });
    if (!built) { setError("No route for the selected chain/token"); return; }
    setPhase("quoting");
    try {
      const resp = await fetch(`/api/lifi/quote?${built.qs}`);
      const d = await resp.json();
      if (d?.error || d?.message) { setError(d.message || d.error); setPhase("idle"); return; }
      const derived = deriveQuoteFromLifi({ data: d, from, token, amount: amt, destToken });
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
    const provider = await SignerResolver.resolve("evm", evmSession);
    if (!provider) {
      setError("The connected EVM wallet can't sign transactions — reconnect your EVM wallet (e.g. Rabby/MetaMask).");
      return;
    }
    setPhase("bridging");
    try {
      // The routing engine runs the EVM stage (stage 1 of 2): the exact-amount
      // approval leg then the LiFi bridge leg (quote forwarded verbatim) — the
      // same sim-gated flow executeLiFiEvmTx ran, as LegContract legs.
      const route = RoutePlanner.planForward({ direction: "forward" });
      const { txHash } = await runForwardEvmStage({
        route,
        lifiData: quote.lifiData,
        provider,
        address: evmSession.address,
        onStatus: (msg) => setStatus(msg),
      });
      setStage1Hash(txHash);
      const solAdapter = await SignerResolver.resolve("svm", solSession);
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
    const solAdapter = await SignerResolver.resolve("svm", solSession);
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
        destToken, // the X1 destination token (USDC.x | wSOL.X)
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

  // ── REVERSE (X1 → EVM) ────────────────────────────────────────────────────
  // Stage 1: burn USDC.x on X1 (Warp bridge_out) → USDC released on Solana.
  // Stage 2: LiFi Solana→EVM on the net that landed. Mirrors the forward
  // stages: sim fail-closed everywhere, WARP_LIVE_SEND gates the burn send,
  // honest handoffs at every dead-end (funds safe on Solana / X1).

  async function getReverseQuote() {
    setError(null); setStatus(null);
    const amt = parseFloat(amount);
    if (!amount || !(amt > 0)) { setError("Enter an amount"); return; }
    if (!solReady) { setError("Connect your Solana/X1 wallet to get a quote"); return; }
    if (!evmReady) { setError("Connect your EVM wallet to get a quote"); return; }
    setPhase("quoting");
    try {
      // The stage-1 math is deterministic (1% skim + the Warp fee — the token
      // drives the fee shape: USDC.x flat $1, wSOL.X 25 bps — fees.ts + live
      // Warp config); the LiFi SOL→EVM leg is quoted LIVE on the net that will
      // land on Solana (USDC 6-dec for a USDC.x burn, WSOL 9-dec for a wSOL.X
      // burn — LiFi quotes WSOL→EVM stables directly, no Jupiter swap). If the
      // leg can't be quoted, the quote is still honest: stage 1 (the X1 burn)
      // is fully priced and the Solana→EVM hop becomes the handoff stage
      // (funds rest safely on Solana).
      const legs = computeReverseLegs({ amount: amt, token: reverseToken });
      const built = buildReverseLifiQuoteParams({
        to,
        toTokenSymbol: token, // the selected destination stable (USDC/USDT/DAI)
        netOnSolana: legs.netOnSolana,
        fromAddress: solSession.address,
        toAddress: evmSession.address,
        token: reverseToken,
      });
      let lifiData = null;
      if (built) {
        const resp = await fetch(`/api/lifi/quote?${built.qs}`);
        const d = await resp.json();
        if (!(d?.error || d?.message) && d?.estimate?.toAmount) lifiData = d;
      }
      // USD-AWARE minimum (the live-bug fix — the old check compared the RAW
      // TOKEN COUNT to the $25 floor, so 0.3 wSOL.X ≈ $30 was blocked because
      // 0.3 < 25). The floor is a USD VALUE: gross input × the LIVE source
      // price (LiFi's fromToken.priceUSD — the token the SOL→EVM leg carries,
      // 1:1 with the X1 source — or the Coingecko fallback; never hardcoded).
      // Fails OPEN when no price resolves: a missing price must not block a
      // valid user — the burn preflight still guards an actually-too-small
      // amount. The quote runs FIRST so the gate uses the freshest price.
      const minCheck = await checkReverseMin({ amount: amt, token: reverseToken, lifiData });
      if (minCheck.blocked) {
        setError(`Bridge $${X1_REVERSE_MIN}+ out of X1 to get started`);
        setPhase("idle");
        return;
      }
      const derived = deriveReverseQuote({ data: lifiData, to, amount: amt, token: reverseToken, toToken: token });
      setQuote({ amount: amt, to, toToken: token, ...derived, lifiData });
      setPhase("quoted");
    } catch (e) {
      console.error("[Teleport v2] reverse quote failed:", e);
      setError("Quote request failed"); setPhase("idle");
    }
  }

  async function executeReverseStage1() {
    if (!quote) return;
    // Double-fire guard: a burn/poll/auto-fired stage 2 is in flight — never
    // start a second burn (the busy/polling flags are the single source of
    // truth for the whole reverse journey).
    if (polling || step2Busy) return;
    setError(null); setStatus(null);
    const solAdapter = await resolveSolanaAdapter(solSession);
    if (!solAdapter) {
      setError("Connect your Solana/X1 wallet (Phantom/Backpack) to burn USDC.x on X1");
      setHandoffReason("burn");
      setPhase("handoff");
      return;
    }
    setPhase("bridging");
    setStep2Busy(true);
    try {
      const res = await reverseStage1Runner({
        solAdapter,
        amountHuman: quote.amount, // gross — the runner skims 1% + burns the net
        allowLive: WARP_LIVE_SEND, // the gate: real burns only when VITE_WARP_LIVE_SEND=true
        token: reverseToken,       // "USDC.x" | "wSOL.X" — the burn's mint/decimals/fee account
      });
      if (!res.success) {
        if (res.sim?.simUnavailable) {
          setError(`Burn sim couldn't run (RPC: ${res.sim?.rpcError || "unknown"}) — send blocked. Retry when the RPC is reachable.`);
        } else {
          const logs = res.sim?.logs || [];
          const key = logs.filter((l) => /error|failed|assert|seq|insufficient|invalid|constraint/i.test(l)).slice(-2).join(" | ");
          setError(`Burn sim failed: ${JSON.stringify(res.sim?.err)}${key ? " — " + key : ""} (full logs in console)`);
        }
        // Funds never left X1 (nothing was broadcast) — back to quoted, never
        // to a state that could re-send anything.
        setPhase("quoted");
        return;
      }
      if (res.sent || res.signature) {
        setWarpSig(res.signature);
        setReverseStage(2);
        setPhase("relaying");
        // Poll the Warp release (X1 burn → USDC on Solana) in the background;
        // the relaying state shows progress and unlocks stage 2 on release.
        pollRelease(res.signature);
      } else {
        // Simulated only — the WARP_LIVE_SEND gate held (confirm-mode).
        setConfirmMode(true);
        setPhase("done");
      }
    } catch (e) {
      console.error("[Teleport v2] reverse stage 1 error:", e);
      setError(`Warp error: ${String(e?.message || e)}`);
      setPhase("quoted");
    } finally {
      setStep2Busy(false);
    }
  }

  async function pollRelease(sig) {
    setPolling(true); setReleaseNote("Burn sent — awaiting the Warp release on Solana…");
    try {
      const res = await releasePoller(sig, {
        onUpdate: (stage, detail) => {
          if (stage === "guardians_signing") {
            setReleaseNote(`Guardians signing (${detail?.count || "?"} sigs) — USDC release in progress…`);
            setReverseStage(3);
          } else if (stage === "complete") {
            setReleaseNote("Released on Solana ✓");
            setReverseStage(5);
          } else if (stage === "failed") {
            setReleaseNote("Release failed — your USDC.x is safe on X1. Contact support.");
          } else if (stage === "awaiting_guardians") {
            setReleaseNote("Burn detected — waiting for guardians to sign…");
          }
        },
      });
      if (res?.ok && res.destinationTx) {
        setReleaseNote("Released on Solana ✓");
        setReverseStage(5);
        setPhase("step2"); // unlock the LiFi Solana→EVM leg
        // AUTO-FIRE: the release is confirmed on Solana — continue the
        // journey IMMEDIATELY (LiFi Solana→EVM), no manual stage-2 click.
        // One continuous flow: burn → guardians signing → released → LiFi
        // sending → done. Failure lands in the handoff state with a Retry
        // button (executeReverseStage2 is the retry path) — exactly ONE auto
        // attempt, never a loop (the step2Busy guard serializes re-entry).
        await executeReverseStage2();
      } else if (res?.terminal) {
        setError("The Warp release failed terminally — your USDC.x is safe on X1. Contact support.");
        setHandoffReason("terminal");
        setPhase("handoff");
      } else {
        // Timed out / still relaying — stay in the relaying state; the user
        // can check again (funds are safe: the burn is on X1, the release is
        // pending on the Warp side).
        setReleaseNote("Still awaiting the release — the Warp guardians can take a few minutes.");
      }
    } catch (e) {
      console.error("[Teleport v2] release poll error:", e);
      setReleaseNote("Could not reach the Warp status API — check again in a moment.");
    } finally {
      setPolling(false);
    }
  }

  async function executeReverseStage2() {
    if (!quote || step2Busy) return; // one LiFi send at a time (auto-fire or manual retry)
    setError(null); setStatus(null);
    setStep2Busy(true);
    const solAdapter = await resolveSolanaAdapter(solSession);
    if (!solAdapter) {
      setError("Connect your Solana/X1 wallet to finish the hop");
      setHandoffReason("lifi");
      setPhase("handoff");
      setStep2Busy(false);
      return;
    }
    setPhase("bridging");
    try {
      const txHash = await reverseStage2Runner({
        solAdapter,
        evmAddress: evmSession?.address,
        to: quote.to,
        toTokenSymbol: quote.toToken || "USDC", // deliver the SELECTED destination stable
        netOnSolana: quote.solanaAmount ?? quote.legs?.netOnSolana,
        onStatus: (msg) => setStatus(msg),
        token: reverseToken, // drives the LiFi fromToken (USDC | WSOL) + decimals
      });
      setStage1Hash(txHash); // reuse the slot — it's the final leg hash
      setPhase("done");
    } catch (e) {
      console.error("[Teleport v2] reverse stage 2 error:", e);
      // The USDC is ALREADY on Solana (the burn released it) — the LiFi leg
      // failed. Honest handoff: funds safe, retry the hop or finish elsewhere.
      setError(`${e?.message || "The Solana → EVM leg failed"}. Your USDC is safe on Solana.`);
      setHandoffReason("lifi");
      setPhase("handoff");
    } finally {
      setStep2Busy(false);
    }
  }

  const canStage2 = solanaSessionCanSign(solSession); // hint-level only; executeStage2 re-checks via resolver
  // The missing-wallet prompts render as ACTIONABLE buttons when the form
  // lives inside the tab's ConnectedBody (onConnectWallet opens the connect
  // modal); standalone renders (tests) keep the plain warning text.
  const WarnTag = onConnectWallet ? "button" : "div";
  const warnProps = (testId) =>
    onConnectWallet
      ? { type: "button", "data-testid": testId, onClick: onConnectWallet, style: { ...S.warn, ...S.warnBtn } }
      : { "data-testid": testId, style: S.warn };
  // ── FORWARD RENDER (EVM → X1) — the proven on-ramp; content byte-identical ──
  const renderForward = () => (
    <>
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
            <option value="x1" style={{ background: "#0a1019" }}>X1 {CHAINS.x1.glyph}</option>
          </select>
        </span>
        <span style={S.rowCol}>
          <span style={S.label}>Receive</span>
          <select data-testid="x1-token" value={destToken} onChange={(e) => changeDestToken(e.target.value)} style={S.select} aria-label="Token on X1">
            {tokensFor("x1").map((t) => (
              <option key={t} value={t} style={{ background: "#0a1019" }}>{t}</option>
            ))}
          </select>
        </span>
      </div>

      {/* token + amount — the SOURCE token is the user's choice (the stables
          TOKENS[from] defines: USDC/USDT/DAI where available) */}
      <div style={S.row}>
        <span style={S.rowCol}>
          <span style={S.label}>Token</span>
          <select data-testid="token" value={token} onChange={(e) => changeToken(e.target.value)} style={S.select} aria-label="Token">
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
      {/* wallet balances with live USD values — what the connected wallets
          actually hold, and what it's worth, before bridging (Mr. Esters'
          directive). Fail-soft: "—" per side, never blocks the form. */}
      <BalancesLine
        direction="forward"
        from={from}
        to={to}
        token={token}
        reverseToken={reverseToken}
        destToken={destToken}
        amount={amount}
        evmSession={evmSession}
        solSession={solSession}
        refreshSignal={balanceRefresh}
        {...balancesDeps}
      />
      <div style={S.hint}>Bridge ${X1_MIN}+ into X1 to get started — land as USDC.x (flat $1 Warp fee) or wSOL.X (0.25% Warp fee).</div>

      {/* wallet guidance — honest, never a silent dead-end; actionable
          (opens the connect modal) when the tab wires onConnectWallet */}
      {!evmReady && (
        <WarnTag {...warnProps("warn-evm")}>
          Connect your EVM wallet (Rabby / MetaMask) to bridge from an EVM chain.
        </WarnTag>
      )}
      {!solReady && (
        <WarnTag {...warnProps("warn-solana")}>
          Connect your Solana/X1 wallet (Phantom / Backpack) to get a quote — the hop lands USDC on Solana first.
        </WarnTag>
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
              {/* SAFETY parity: the forward hop mints on X1 — the user's
                  Solana wallet. Same value that flows into the LiFi stage-1
                  toAddress (solSession.address); fail-soft: no session → no
                  line. */}
              {solSession?.address && (
                <div style={S.quoteRow} data-testid="dest-address-forward">
                  <span style={S.quoteKey}>To</span>
                  <span style={S.quoteVal} title={solSession.address}>{truncateAddress(solSession.address)} ({CHAINS.x1.name})</span>
                </div>
              )}
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
            <b>Stage 1 sent</b> — {stage1Hash ? `tx ${String(stage1Hash).slice(0, 10)}…` : ""} your {destToken === "wSOL.X" ? "WSOL" : "USDC"} is on its way to Solana.
            Approve Stage 2 to mint {destToken} on X1. If you stop here, your funds rest safely as {destToken === "wSOL.X" ? "WSOL" : "USDC"} on Solana.
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
            : <>✓ Bridge complete — {quote?.recvToken || destToken} on X1.</>}
          <button data-testid="reset" style={S.ghostBtn} onClick={reset}>Bridge again</button>
        </div>
      ) : null}
    </>
  );

  // ── REVERSE RENDER (X1 → EVM) — the off-ramp: Warp burn X1→Solana, then
  // LiFi Solana→EVM. Mirrors the forward structure (same testids, same
  // phases) so the two directions share the wallet guidance + quote/stage UX.
  const renderReverse = () => (
    <>
      {/* from / to — reverse: X1 fixed source, EVM destination */}
      <div style={S.row}>
        <span style={S.rowCol}>
          <span style={S.label}>From</span>
          <select data-testid="from-chain" value="x1" onChange={() => {}} style={S.select} aria-label="Source chain (fixed: X1)">
            <option value="x1" style={{ background: "#0a1019" }}>X1 {CHAINS.x1.glyph}</option>
          </select>
        </span>
        <span style={S.rowCol}>
          <span style={S.label}>Burn</span>
          <select data-testid="x1-token" value={reverseToken} onChange={(e) => changeReverseToken(e.target.value)} style={S.select} aria-label="Token burned on X1">
            {tokensFor("x1").map((t) => (
              <option key={t} value={t} style={{ background: "#0a1019" }}>{t}</option>
            ))}
          </select>
        </span>
        <span style={S.rowCol}>
          <span style={S.label}>To</span>
          <select data-testid="to-chain" value={to} onChange={(e) => changeTo(e.target.value)} style={S.select}>
            {EVM_CHAINS.map((c) => (
              <option key={c} value={c} style={{ background: "#0a1019" }}>
                {CHAINS[c].glyph} {CHAINS[c].name}
              </option>
            ))}
          </select>
          {/* destination token — the user chooses WHICH stable they receive on
              the destination EVM chain (USDC / USDT / DAI as TOKENS[to] defines) */}
          <select data-testid="to-token" value={token} onChange={(e) => changeToken(e.target.value)} style={S.select} aria-label="Receive token">
            {tokensFor(to).map((t) => (
              <option key={t} value={t} style={{ background: "#0a1019" }}>{t}</option>
            ))}
          </select>
        </span>
      </div>

      {/* token + amount — the X1 burn token (USDC.x | wSOL.X) */}
      <div style={S.row}>
        <span style={S.rowCol}>
          <span style={S.label}>Token</span>
          <select data-testid="token" value={reverseToken} onChange={(e) => changeReverseToken(e.target.value)} style={S.select} aria-label="Token to burn on X1">
            {tokensFor("x1").map((t) => (
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
      {/* wallet balances with live USD values — reverse: X1 burn source
          (USDC.x/wSOL.X), Solana landing (USDC/WSOL), EVM destination. */}
      <BalancesLine
        direction="reverse"
        from={from}
        to={to}
        token={token}
        reverseToken={reverseToken}
        destToken={destToken}
        amount={amount}
        evmSession={evmSession}
        solSession={solSession}
        refreshSignal={balanceRefresh}
        {...balancesDeps}
      />
      <div style={S.hint}>Bridge ${X1_REVERSE_MIN}+ out of X1 — {reverseToken} burns on X1, {reverseToken === "wSOL.X" ? "WSOL" : "USDC"} lands on Solana, then LiFi carries it to {CHAINS[to].name} as {token}.</div>

      {/* wallet guidance — honest, never a silent dead-end; actionable when
          the tab wires onConnectWallet */}
      {!solReady && (
        <WarnTag {...warnProps("warn-solana")}>
          Connect your Solana/X1 wallet (Phantom / Backpack) — the USDC.x burn happens on X1.
        </WarnTag>
      )}
      {!evmReady && (
        <WarnTag {...warnProps("warn-evm")}>
          Connect your EVM wallet (Rabby / MetaMask) to receive {token} on {CHAINS[to].name}.
        </WarnTag>
      )}

      {/* quote + send */}
      {phase === "idle" || phase === "quoting" ? (
        <button data-testid="get-quote" style={phase === "quoting" ? { ...S.cta, ...S.ctaDisabled } : S.cta} onClick={getReverseQuote} disabled={phase === "quoting"}>
          {phase === "quoting" ? "Finding route…" : "Get quote"}
        </button>
      ) : phase === "quoted" ? (
        <>
          {quote && (
            <div className="quote-box" data-testid="quote-box" style={S.quoteBox}>
              <div style={S.quoteRow}>
                <span style={S.quoteKey}>You send</span>
                <span style={S.quoteVal}>{quote.amount} {reverseToken} on X1</span>
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
              {/* SAFETY: the LiFi leg delivers to the CONNECTED EVM wallet —
                  show that address pre-sign (a wrong EVM address is
                  irreversible). Same value that flows into the stage-2
                  toAddress (evmSession.address); fail-soft: no session →
                  no line. */}
              {evmSession?.address && (
                <div style={S.quoteRow} data-testid="dest-address">
                  <span style={S.quoteKey}>To</span>
                  <span style={S.quoteVal} title={evmSession.address}>{truncateAddress(evmSession.address)} ({CHAINS[quote?.to || to].name})</span>
                </div>
              )}
              {!quote.lifiQuoted && (
                <div style={S.note} data-testid="reverse-lifi-note">
                  The Solana → {CHAINS[quote.to].name} leg couldn't be quoted right now — stage 1 (the X1 burn) still works; your {reverseToken === "wSOL.X" ? "WSOL" : "USDC"} will rest safely on Solana and you can finish the hop later.
                </div>
              )}
              <div style={S.steps}>
                {(quote.steps || []).map((s, i) => (
                  <span key={i} style={S.stepChip}>{s.tool} · {s.name}</span>
                ))}
              </div>
            </div>
          )}
          <button data-testid="bridge-now" style={S.cta} onClick={executeReverseStage1}>
            Bridge — Step 1 of 2
          </button>
        </>
      ) : phase === "bridging" ? (
        <button data-testid="bridging" style={{ ...S.cta, ...S.ctaDisabled }} disabled>
          Bridging… {status ? `(${status})` : ""}
        </button>
      ) : phase === "relaying" ? (
        <div data-testid="relaying" style={S.box}>
          <b>X1 burn sent</b> {warpSig ? `(${String(warpSig).slice(0, 10)}…)` : ""} — {reverseToken} is burning on X1; the Warp guardians release {reverseToken === "wSOL.X" ? "WSOL" : "USDC"} on Solana.
          {releaseNote && <div data-testid="release-note" style={{ marginTop: 6 }}>{releaseNote}</div>}
          {!polling && !String(releaseNote || "").includes("Released") && warpSig && (
            <button data-testid="check-release" style={S.ghostBtn} onClick={() => pollRelease(warpSig)}>
              Check release status again
            </button>
          )}
          <button data-testid="reset" style={S.ghostBtn} onClick={reset}>Done / bridge again</button>
        </div>
      ) : phase === "step2" ? (
        <>
          <div style={S.box}>
            <b>{reverseToken === "wSOL.X" ? "WSOL" : "USDC"} released on Solana ✓</b> — now finish the hop — {quote?.recvToken || token} on {CHAINS[quote?.to || to].name} — via LiFi.
            {/* SAFETY: the final LiFi sign delivers to the CONNECTED EVM
                wallet — repeat the destination here, at the moment of the
                irreversible sign (same value that flows into the stage-2
                toAddress). Fail-soft: no session → no line. */}
            {evmSession?.address && (
              <div data-testid="dest-address-step2" title={evmSession.address} style={{ marginTop: 6 }}>
                To: {truncateAddress(evmSession.address)} ({CHAINS[quote?.to || to].name})
              </div>
            )}
            If you stop here, your funds rest safely as {reverseToken === "wSOL.X" ? "WSOL" : "USDC"} on Solana.
          </div>
          <button data-testid="bridge-step2" style={step2Busy ? { ...S.cta, ...S.ctaDisabled } : S.cta} onClick={executeReverseStage2} disabled={step2Busy}>
            {step2Busy ? "Bridging to " + CHAINS[quote?.to || to].name + "…" : "Step 2 of 2 — finish the hop to " + CHAINS[quote?.to || to].name}
          </button>
        </>
      ) : phase === "handoff" ? (
        <div data-testid="handoff" style={S.box}>
          {handoffReason === "burn" && (
            <>Stage 1 didn't start — nothing was sent. Your USDC.x stays safe on X1. Connect your Solana/X1 wallet to burn, then retry.</>
          )}
          {handoffReason === "terminal" && (
            <>The Warp release failed terminally — your USDC.x is safe on X1. Contact support.</>
          )}
          {handoffReason === "lifi" && (
            <>
              <b>Your {reverseToken === "wSOL.X" ? "WSOL" : "USDC"} is safe on Solana</b>{stage1Hash ? ` (final leg tx ${String(stage1Hash).slice(0, 10)}…)` : ""}.
              The Solana → {CHAINS[quote?.to || to].name} hop didn't complete.{" "}
              {canStage2 && (
                <button data-testid="retry-stage2" style={{ ...S.ghostBtn, marginTop: 0, width: "auto", padding: "4px 12px" }} onClick={executeReverseStage2} disabled={step2Busy}>
                  Retry the hop to {CHAINS[quote?.to || to].name}
                </button>
              )}
            </>
          )}
          <div style={{ marginTop: 8 }}>
            <a href={WARP_BRIDGE_URL} target="_blank" rel="noopener noreferrer" style={S.link}>🌉 Open Warp Bridge to check the Solana release</a>
          </div>
          <button data-testid="reset" style={S.ghostBtn} onClick={reset}>Done / bridge again</button>
        </div>
      ) : phase === "done" ? (
        <div data-testid="done" style={{ ...S.box, ...S.boxOk }}>
          {confirmMode
            ? <>✓ Simulation passed — <b>not sent</b> (live Warp sends are OFF; set VITE_WARP_LIVE_SEND=true to arm).</>
            : <>✓ Bridge complete — {quote?.recvToken || token} on {CHAINS[quote?.to || to].name}.</>}
          <button data-testid="reset" style={S.ghostBtn} onClick={reset}>Bridge again</button>
        </div>
      ) : null}
    </>
  );

  return (
    <div className="teleport-form" data-testid="teleport-form" style={S.form}>
      {/* direction toggle — ETH→X1 (on-ramp) / X1→ETH (off-ramp). The forward
          flow is unchanged; the reverse path is the new direction. */}
      <div style={S.row} data-testid="direction-toggle">
        <span style={S.rowCol}>
          <span style={S.label}>Direction</span>
          <span style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button type="button" data-testid="dir-forward" onClick={() => changeDirection("forward")} style={direction === "forward" ? S.dirActive : S.dirBtn}>
              ETH → X1
            </button>
            <button type="button" data-testid="dir-reverse" onClick={() => changeDirection("reverse")} style={direction === "reverse" ? S.dirActive : S.dirBtn}>
              X1 → ETH
            </button>
          </span>
        </span>
      </div>
      {direction === "reverse" ? renderReverse() : renderForward()}
      {status && phase === "quoted" && <div data-testid="form-status" style={S.status}>{status}</div>}
      {error && (
        <div data-testid="form-error" style={S.error}>⚠️ {error}</div>
      )}
    </div>
  );
}

