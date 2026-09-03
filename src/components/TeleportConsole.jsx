/**
 * TeleportConsole — the Teleport Console UI (the v2 card's visual front door).
 *
 * docs/CONSOLE-DESIGN.md is the design direction; docs/console-design-target.png
 * is the visual target. This is the REAL console — a hardware housing (beveled/
 * chamfered clip-path corners, cyan bezel rim, recessed "coordinate slot"
 * inputs, a raised glowing TELEPORT button, glass fill inside the bezel) set
 * against the astronaut ambient video, wired to the REAL routing engine
 * quote + send paths. No fakes: the same quote builders, the same
 * /api/lifi/quote proxy, the same computeFee/quoteFees fee model (Teleporter
 * 0.5% capped at $250 + per-asset Warp: flat $1 USDC.x / 0.25% others), the
 * same balance ladder reads, the same fail-closed sims + WARP_LIVE_SEND gate
 * as TeleportForm — the console is a new FRONT for the proven engine.
 *
 * INTEGRATION (how it mounts vs the old form):
 *   - BridgeCard variant="console" renders this component INSTEAD of the
 *     classic TeleportTab/TeleportForm stack. The tab strip is preserved
 *     (Teleport = the console swap surface; THORChain/Buy tabs unchanged —
 *     THORChainTab is reused verbatim when the THORCHAIN flag is on).
 *   - The classic card (BridgeCard default variant) stays byte-behavior-
 *     identical and remains the default on non-preview hosts — the frozen
 *     browser harnesses (forward/reverse/thorchain-leg.spec.js) keep
 *     measuring it. The console mounts by default on the x1scroll Vercel
 *     preview hosts (src/lib/uiVariant.js decides; main.jsx applies).
 *   - Phase/flow semantics mirror TeleportForm 1:1 (same phases, same
 *     fail-closed gates, same error strings, same testids for the shared
 *     elements) so the console-leg harness mirrors the frozen forward/
 *     reverse harness patterns and a future ruler update is mechanical.
 *
 * DIRECTION MODEL: route-first (docs/UX-VISION.md) — there is no direction
 * toggle. FROM and TO are the route coordinates: FROM an EVM chain → X1 is
 * the forward on-ramp; FROM X1 → an EVM chain is the reverse off-ramp. The
 * console derives the direction from the FROM slot.
 *
 * MOTION: numbers tick when quoting (readout feel), the TELEPORT button
 * pulses when armed, micro-interactions are ≤200ms ease-out, and the
 * teleport-sequence video plays when a leg actually BROADCASTS (tied to the
 * real tx stage — never in confirm/sim-only mode). No sound. Reduced-motion
 * and mobile (portrait) render the astronaut POSTER still instead of the
 * ambient video (design doc).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CHAINS, EVM_CHAINS, TOKENS, WARP_BRIDGE_URL, tokensFor } from "../lib/teleportConstants.js";
import { buildLifiQuoteParams, deriveQuoteFromLifi } from "../lib/teleportQuote.js";
import { buildReverseLifiQuoteParams, deriveReverseQuote, computeReverseLegs } from "../lib/reverseQuote.js";
import { SignerResolver, RoutePlanner, runForwardEvmStage } from "../engine/index.js";
import { SimulationError } from "../lib/simulateTx.js";
import { LiFiApprovalValidationError } from "../lib/lifiApproval.js";
import { WARP_LIVE_SEND } from "../lib/flags.ts";
import { solanaSessionCanSign } from "../lib/wallet/sessionProviders.js";
import { useWalletContext } from "../lib/wallet/WalletContext.jsx";
import { WALLET_FAMILIES, FAMILY_LABELS } from "../lib/wallet/families.js";
import { resolveEvmProvider } from "../lib/wallet/sessionProviders.js";
import {
  fetchEvmTokenBalance,
  fetchSvmTokenBalances,
  X1_MINTS,
  X1_RPC_LADDER,
  formatBalance,
} from "../lib/balances.js";
import { getPricesUSD, usdValue } from "../lib/prices.js";
import ConnectModal from "./ConnectModal.jsx";
import THORChainTab from "./THORChainTab.jsx";
// The REAL runners live on TeleportForm (unchanged, DI seams intact) — the
// console imports them so the send path is byte-the-same code as the classic
// form's, not a reimplementation. The form's default export is NOT used here.
import {
  defaultStage2Runner,
  defaultReverseStage1Runner,
  defaultReverseStage2Runner,
  defaultReleasePoller,
  truncateAddress,
} from "./TeleportForm.jsx";

// The console's quote freshness window (seconds) — after it elapses the
// console re-quotes automatically (the quote-status strip's refresh
// countdown). Export for tests.
export const QUOTE_REFRESH_SECONDS = 30;
/** Debounce before an auto-quote fires after route/amount edits. */
export const AUTO_QUOTE_DEBOUNCE_MS = 600;

// Defense-in-depth copy of the form's placeholder guard (TeleportForm keeps
// its own; both refuse to drive a real send toward a known demo address).
const PLACEHOLDER_EVM = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";

// ─────────────────────────────────────────────────────────────────────────────
// CONSOLE STYLESHEET — keyframes + responsive structure (classes only; the
// per-element styles ride inline below). Unique `tc-` prefix, no 3D libs.
// ─────────────────────────────────────────────────────────────────────────────
const CONSOLE_CSS = `
.tc-page{position:relative;min-height:100vh;min-height:100dvh;background:#03060c;overflow:hidden;color:#e8ecf3}
.tc-bg{position:fixed;inset:0;z-index:0;background:radial-gradient(120% 90% at 50% 36%,#0a1424 0%,#050a14 46%,#02040a 100%)}
.tc-bg video,.tc-bg img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.55}
.tc-bg img{opacity:.6}
.tc-scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(3,6,12,.55) 0%,rgba(3,6,12,.38) 42%,rgba(3,6,12,.78) 100%)}
.tc-portal{position:absolute;left:50%;top:42%;width:min(920px,120vw);height:min(920px,120vw);transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(63,211,232,.14) 0%,rgba(63,211,232,.05) 34%,transparent 66%);pointer-events:none}
.tc-scroll{position:relative;z-index:1;height:100vh;height:100dvh;overflow-y:auto;display:flex;align-items:center;justify-content:center;padding:18px}
.tc-shell-wrap{width:min(700px,94vw);margin:auto;filter:drop-shadow(0 0 26px rgba(63,211,232,.20)) drop-shadow(0 22px 60px rgba(0,0,0,.55))}
.tc-shell-rim{clip-path:polygon(0 18px,18px 0,calc(100% - 18px) 0,100% 18px,100% calc(100% - 18px),calc(100% - 18px) 100%,18px 100%,0 calc(100% - 18px));background:linear-gradient(150deg,#6487a8 0%,#22364d 20%,rgba(63,211,232,.75) 50%,#1b2b3f 78%,#52799b 100%);padding:1.5px}
.tc-shell-glass{clip-path:polygon(18px 1.5px,calc(100% - 18px) 1.5px,calc(100% - 1.5px) 18px,calc(100% - 1.5px) calc(100% - 18px),calc(100% - 18px) calc(100% - 1.5px),18px calc(100% - 1.5px),1.5px calc(100% - 18px),1.5px 18px);background:linear-gradient(180deg,rgba(14,22,35,.9),rgba(7,12,22,.84));backdrop-filter:blur(18px) saturate(1.15);-webkit-backdrop-filter:blur(18px) saturate(1.15)}
.tc-header{padding:12px 18px 8px;border-bottom:1px solid rgba(63,211,232,.18);background:linear-gradient(180deg,rgba(63,211,232,.07),rgba(63,211,232,0))}
.tc-body{padding:14px 18px 20px}
.tc-title{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700;letter-spacing:.22em;font-size:15px;color:#dff6fb}
.tc-subheader{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;letter-spacing:.3em;color:#6e93ad;text-transform:uppercase}
.tc-status{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.14em;color:#9fd8e6;display:flex;align-items:center;gap:7px;white-space:nowrap}
.tc-status-dot{width:8px;height:8px;border-radius:50%;background:#3fd3e8;box-shadow:0 0 8px rgba(63,211,232,.9);animation:tcBlink 2.4s ease-in-out infinite}
.tc-tabs{display:flex;gap:4px;padding:0 18px;border-bottom:1px solid rgba(63,211,232,.12)}
.tc-tab{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:none;border:none;border-bottom:2px solid transparent;color:#6e93ad;font-size:12px;letter-spacing:.18em;padding:10px 12px 8px;cursor:pointer;text-transform:uppercase}
.tc-tab-active{color:#3fd3e8;border-bottom-color:#3fd3e8;text-shadow:0 0 12px rgba(63,211,232,.5)}
.tc-label{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;letter-spacing:.24em;color:#6e93ad;text-transform:uppercase;display:block;margin-bottom:5px}
.tc-slot{background:rgba(4,9,16,.72);border:1px solid rgba(63,211,232,.22);box-shadow:inset 0 2px 10px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.04);border-radius:10px;padding:10px 12px;min-height:56px;display:flex;flex-direction:column;justify-content:center;transition:border-color 140ms ease-out,box-shadow 140ms ease-out}
.tc-slot:focus-within{border-color:rgba(63,211,232,.65);box-shadow:inset 0 2px 10px rgba(0,0,0,.5),0 0 0 1px rgba(63,211,232,.35),0 0 18px rgba(63,211,232,.18)}
.tc-coords{display:flex;align-items:stretch;gap:10px}
.tc-slot-grow{flex:1;min-width:0}
.tc-arrow{display:flex;align-items:center;justify-content:center;color:#3fd3e8;font-size:22px;padding:0 2px;text-shadow:0 0 10px rgba(63,211,232,.8);animation:tcTravel 1.6s ease-in-out infinite}
.tc-select{width:100%;background:transparent;border:none;outline:none;color:#e8ecf3;font-size:15px;font-weight:700;appearance:none;-webkit-appearance:none;cursor:pointer;padding:0;font-family:inherit}
.tc-select option{background:#0b1422;color:#e8ecf3;font-weight:400}
.tc-sub{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;color:#5f7f99;letter-spacing:.1em;margin-top:3px;text-transform:uppercase}
.tc-amount{width:100%;background:transparent;border:none;outline:none;color:#eaf7fb;font-size:30px;font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.02em;padding:0}
.tc-amount::placeholder{color:#3c5570;font-weight:600}
.tc-max{background:rgba(63,211,232,.12);border:1px solid rgba(63,211,232,.4);color:#3fd3e8;border-radius:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:700;letter-spacing:.14em;padding:8px 12px;cursor:pointer;transition:all 140ms ease-out}
.tc-max:hover{background:rgba(63,211,232,.22)}
.tc-max:disabled{opacity:.35;cursor:default}
.tc-strip{margin-top:12px;border:1px solid rgba(63,211,232,.14);background:rgba(4,9,16,.5);border-radius:10px;padding:10px 12px;min-height:54px}
.tc-strip-hint{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.08em;color:#5f7f99;line-height:1.6}
.tc-strip-hint b{color:#9fd8e6;font-weight:600}
.tc-fire{width:100%;margin-top:14px;border:none;cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:800;font-size:15px;letter-spacing:.3em;color:#eafcff;padding:16px 0 14px;clip-path:polygon(0 10px,10px 0,calc(100% - 10px) 0,100% 10px,100% calc(100% - 10px),calc(100% - 10px) 100%,10px 100%,0 calc(100% - 10px));background:linear-gradient(180deg,#1cc6e4 0%,#0f8fb2 55%,#0b6f8e 100%);transition:filter 140ms ease-out,opacity 140ms ease-out}
.tc-fire:active{transform:translateY(1px)}
.tc-fire:disabled{opacity:.38;cursor:default;animation:none}
.tc-fire-armed{animation:tcPulse 2.2s ease-in-out infinite}
.tc-fire-armed:hover{filter:brightness(1.1)}
.tc-wallets{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;min-height:30px}
.tc-chip{display:inline-flex;align-items:center;gap:7px;background:rgba(63,211,232,.08);border:1px solid rgba(63,211,232,.28);color:#bfeef7;border-radius:999px;padding:5px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.tc-chip-x{background:none;border:none;color:#6e93ad;cursor:pointer;font-size:13px;padding:0 2px;line-height:1}
.tc-chip-x:hover{color:#ff8f85}
.tc-connect{background:transparent;border:1px dashed rgba(63,211,232,.5);color:#3fd3e8;border-radius:999px;padding:6px 14px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.12em;cursor:pointer;transition:all 140ms ease-out}
.tc-connect:hover{background:rgba(63,211,232,.12)}
.tc-quote-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:4px 0;font-size:13px}
.tc-quote-key{color:#6e93ad;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase}
.tc-quote-val{color:#b9c9dc;font-weight:600;font-size:13px}
.tc-quote-hi{color:#3fd3e8;font-weight:800;font-size:17px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-shadow:0 0 12px rgba(63,211,232,.45)}
.tc-refresh{background:none;border:1px solid rgba(63,211,232,.35);color:#3fd3e8;border-radius:6px;font-size:11px;padding:3px 10px;cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.1em}
.tc-steps{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.tc-step{font-size:10px;padding:3px 9px;border-radius:999px;color:#9fd8e6;border:1px solid rgba(63,211,232,.3);background:rgba(63,211,232,.06);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em}
.tc-note{font-size:11px;color:#6e93ad;margin-top:6px;line-height:1.5}
.tc-box{margin-top:12px;border:1px solid rgba(63,211,232,.2);background:rgba(63,211,232,.05);border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.6;color:#d7e4ef}
.tc-ok{border-color:rgba(95,211,138,.4);background:rgba(95,211,138,.06)}
.tc-err{margin-top:12px;border:1px solid rgba(232,65,66,.4);background:rgba(232,65,66,.08);border-radius:10px;padding:10px 12px;font-size:12.5px;color:#f2b8b5;line-height:1.5}
.tc-ghost{width:100%;margin-top:8px;background:transparent;border:1px solid rgba(63,211,232,.25);color:#9fd8e6;border-radius:8px;padding:9px 0;font-size:12.5px;cursor:pointer}
.tc-link{color:#3fd3e8;text-decoration:none;font-size:12.5px}
.tc-overlay{position:fixed;inset:0;z-index:20;background:rgba(2,5,10,.72);backdrop-filter:blur(6px);display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:4vh 12px 24px}
.tc-modal{width:min(440px,94vw);background:#0a1019;border:1px solid rgba(63,211,232,.25);border-radius:14px;box-shadow:0 0 0 1px rgba(0,0,0,.6),0 24px 70px rgba(0,0,0,.6),0 0 34px rgba(63,211,232,.15);overflow:hidden}
.tc-modal-close{display:block;width:100%;text-align:left;background:none;border:none;color:#3fd3e8;cursor:pointer;padding:10px 16px 0;font-size:13px}
.tc-seq{position:fixed;inset:0;z-index:30;background:#020409;display:flex;align-items:center;justify-content:center;flex-direction:column}
.tc-seq video{width:100%;height:100%;object-fit:contain}
.tc-seq-skip{position:absolute;top:14px;right:14px;background:rgba(63,211,232,.12);border:1px solid rgba(63,211,232,.4);color:#3fd3e8;border-radius:999px;padding:7px 16px;cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;letter-spacing:.12em}
.tc-seq-label{position:absolute;bottom:18px;left:0;right:0;text-align:center;color:#9fd8e6;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;letter-spacing:.24em}
.tc-tab-body{max-width:560px;margin:0 auto;padding:14px 0 4px}
@keyframes tcBlink{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes tcTravel{0%,100%{transform:translateX(0);opacity:.95}50%{transform:translateX(5px);opacity:.45}}
@keyframes tcPulse{0%,100%{box-shadow:0 0 0 0 rgba(63,211,232,0),0 6px 22px rgba(63,211,232,.25)}50%{box-shadow:0 0 0 6px rgba(63,211,232,.10),0 6px 34px rgba(63,211,232,.55)}}
@keyframes tcScan{0%{background-position:0 0}100%{background-position:200px 0}}
@media (max-width:767px){
  .tc-page{overflow-y:auto}
  .tc-scroll{height:auto;min-height:100vh;min-height:100dvh;align-items:flex-start;padding:10px}
  .tc-shell-wrap{width:100%;margin:0}
  .tc-coords{flex-direction:column;gap:8px}
  .tc-arrow{transform:rotate(90deg);align-self:center;margin:-2px 0;font-size:18px;animation:tcTravelY 1.6s ease-in-out infinite}
  .tc-body{padding:12px 12px 16px}
  .tc-header{padding:10px 12px 8px}
  .tc-tabs{padding:0 12px}
  .tc-title{font-size:13px}
  .tc-amount{font-size:26px}
}
@keyframes tcTravelY{0%,100%{transform:rotate(90deg) translateX(0);opacity:.95}50%{transform:rotate(90deg) translateX(4px);opacity:.45}}
`;

// ─────────────────────────────────────────────────────────────────────────────
// Small pieces: motion-gated helpers + the animated readout (ticker).
// ─────────────────────────────────────────────────────────────────────────────
function prefersReducedMotion() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Is this a phone-ish (portrait/small) screen? Poster replaces the video. */
function isCompactScreen() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(max-width: 767px)").matches;
}

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

const defaultTickerFormat = (v) => v.toFixed(2);

/**
 * Animated readout — numbers tick/count toward the latest value (the console
 * "live readout" feel, design doc). ≤ ~480ms ease-out; reduced-motion and
 * environments without rAF set the value instantly. Pure display helper.
 *
 * Implementation note: the effect deps are ONLY [value, active] — format/ms
 * ride in refs so unrelated re-renders (the quote strip's 1s refresh
 * countdown) never cancel a running animation mid-flight.
 */
export function useTicker(value, { format = defaultTickerFormat, durationMs = 480, active = true } = {}) {
  const [display, setDisplay] = useState(() => format(value));
  const formatRef = useRef(format);
  formatRef.current = format;
  const durationRef = useRef(durationMs);
  durationRef.current = durationMs;
  // The numeric value the CURRENT display corresponds to — the animation
  // eases from here toward `value`.
  const lastValueRef = useRef(value);
  useEffect(() => {
    const fmt = formatRef.current;
    const dur = durationRef.current;
    if (!active || prefersReducedMotion() || typeof requestAnimationFrame === "undefined") {
      lastValueRef.current = value;
      setDisplay(fmt(value));
      return;
    }
    const from = lastValueRef.current;
    if (from === value) return;
    let raf;
    let cancelled = false;
    const start = performance.now();
    const step = (now) => {
      if (cancelled) return;
      const t = Math.min(1, (now - start) / dur);
      const v = from + (value - from) * easeOutCubic(t);
      setDisplay(fmt(v));
      if (t < 1) raf = requestAnimationFrame(step);
      else lastValueRef.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [value, active]);
  return display;
}

/** The ambient astronaut layer: video on desktop, poster still on mobile/
 *  reduced-motion (design doc). Pure presentational. */
function AstronautBackdrop() {
  const [poster, setPoster] = useState(() => isCompactScreen() || prefersReducedMotion());
  useEffect(() => {
    const update = () => setPoster(isCompactScreen() || prefersReducedMotion());
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mq = window.matchMedia("(max-width: 767px)");
    const rmq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener?.("change", update);
    rmq.addEventListener?.("change", update);
    window.addEventListener("resize", update);
    return () => {
      mq.removeEventListener?.("change", update);
      rmq.removeEventListener?.("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  const posterSrc = "/assets/teleporter-astronaut-poster.jpg";
  return (
    <div className="tc-bg" aria-hidden="true">
      {poster ? (
        <img src={posterSrc} alt="" data-testid="console-poster" />
      ) : (
        <video
          data-testid="console-video"
          autoPlay
          muted
          loop
          playsInline
          poster={posterSrc}
          preload="metadata"
          aria-hidden="true"
        >
          <source src="/assets/teleporter-astronaut.webm" type="video/webm" />
          <source src="/assets/teleporter-astronaut.mp4" type="video/mp4" />
        </video>
      )}
      <div className="tc-scrim" />
      <div className="tc-portal" />
    </div>
  );
}

/** STATUS label for the console header readout strip. */
function statusFor(phase, armed, busy) {
  if (busy || phase === "bridging") return "IN FLIGHT";
  if (phase === "quoting") return "CALCULATING";
  if (phase === "quoted") return armed ? "ARMED" : "READY";
  if (phase === "done") return "COMPLETE";
  if (phase === "handoff") return "HANDOFF";
  if (phase === "relaying" || phase === "step2") return "IN FLIGHT";
  return "READY";
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CONSOLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{flags?: {THORCHAIN?: boolean}, initialTab?: string,
 *          formProps?: object, consoleProps?: object}} props
 *   formProps/consoleProps: DI seams mirroring TeleportForm (stage2Runner,
 *   reverseStage1Runner, reverseStage2Runner, releasePoller, balancesDeps,
 *   autoQuoteDebounceMs). The runners default to the REAL TeleportForm
 *   defaults — the same fail-closed, WARP_LIVE_SEND-gated code the classic
 *   form runs.
 */
export default function TeleportConsole({
  flags = { THORCHAIN: false },
  initialTab = "teleport",
  formProps = {},
  consoleProps = {},
}) {
  const { sessions, disconnect } = useWalletContext();
  const evmSession = sessions.evm;
  const solSession = sessions.solana;

  // ── Route coordinates ────────────────────────────────────────────────────
  const [from, setFrom] = useState("eth"); // EVM chain | "x1"
  const [to, setTo] = useState("eth"); // reverse destination (EVM chains)
  const [token, setToken] = useState("USDC"); // the SOURCE token (forward: EVM stable; reverse: X1 token)
  const [x1Token, setX1Token] = useState("USDC.x"); // forward: land-as on X1
  const [toToken, setToToken] = useState("USDC"); // reverse: receive on the EVM destination
  const [amount, setAmount] = useState("");
  const direction = from === "x1" ? "reverse" : "forward";

  // ── Flow state (mirrors TeleportForm's phase machine exactly) ────────────
  const [phase, setPhase] = useState("idle"); // idle|quoting|quoted|bridging|step2|relaying|handoff|done
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [warpSig, setWarpSig] = useState(null);
  const [stage1Hash, setStage1Hash] = useState(null);
  const [confirmMode, setConfirmMode] = useState(false);
  const [step2Busy, setStep2Busy] = useState(false);
  const [reverseStage, setReverseStage] = useState(0);
  const [releaseNote, setReleaseNote] = useState(null);
  const [polling, setPolling] = useState(false);
  const [handoffReason, setHandoffReason] = useState(null);
  const [refreshLeft, setRefreshLeft] = useState(QUOTE_REFRESH_SECONDS);
  const [balanceRefresh, setBalanceRefresh] = useState(0);

  // ── UI chrome state ──────────────────────────────────────────────────────
  const [tab, setTab] = useState(initialTab);
  const [connecting, setConnecting] = useState(false);
  const [seqVisible, setSeqVisible] = useState(false);
  const [sourceBalance, setSourceBalance] = useState(null); // { balance, symbol, usd } | null

  const evmReady = Boolean(evmSession?.address);
  const solReady = Boolean(solSession?.address);
  const quoteSeq = useRef(0);
  const canStage2 = solanaSessionCanSign(solSession);
  const debounceMs = consoleProps.autoQuoteDebounceMs ?? AUTO_QUOTE_DEBOUNCE_MS;

  const stage2Runner = formProps.stage2Runner || defaultStage2Runner;
  const reverseStage1Runner = formProps.reverseStage1Runner || defaultReverseStage1Runner;
  const reverseStage2Runner = formProps.reverseStage2Runner || defaultReverseStage2Runner;
  const releasePoller = formProps.releasePoller || defaultReleasePoller;

  // ── Reset helpers (port of TeleportForm.reset) ───────────────────────────
  const reset = useCallback(() => {
    setPhase("idle"); setQuote(null); setError(null); setStatus(null);
    setWarpSig(null); setStage1Hash(null); setConfirmMode(false); setStep2Busy(false);
    setReverseStage(0); setReleaseNote(null); setPolling(false); setHandoffReason(null);
    setRefreshLeft(QUOTE_REFRESH_SECONDS);
    setBalanceRefresh((n) => n + 1);
  }, []);

  const changeFrom = useCallback((c) => {
    setFrom(c);
    if (c === "x1") {
      // Reverse: source becomes an X1 token, destination an EVM chain.
      setToken((prev) => (tokensFor("x1").includes(prev) ? prev : "USDC.x"));
      setTo("eth");
      setToToken((prev) => (tokensFor("eth").includes(prev) ? prev : "USDC"));
    } else {
      // Forward: source is an EVM stable that exists on the chain; dest = X1.
      setToken((prev) => (tokensFor(c).includes(prev) ? prev : Object.keys(TOKENS[c] || {})[0] || "USDC"));
      setTo("x1");
    }
    setQuote(null); setError(null); setPhase("idle"); setWarpSig(null); setStage1Hash(null);
    setConfirmMode(false); setReverseStage(0); setHandoffReason(null);
  }, []);

  const changeTo = useCallback((c) => {
    setTo(c);
    setToToken((prev) => (tokensFor(c).includes(prev) ? prev : Object.keys(TOKENS[c] || {})[0] || "USDC"));
    setQuote(null); setError(null); setPhase("idle"); setWarpSig(null); setStage1Hash(null);
    setConfirmMode(false); setReverseStage(0); setHandoffReason(null);
  }, []);

  const changeToken = useCallback((t) => {
    setToken(t); setQuote(null); setError(null); setPhase("idle");
  }, []);
  const changeX1Token = useCallback((t) => {
    setX1Token(t); setQuote(null); setError(null); setPhase("idle");
  }, []);
  const changeToToken = useCallback((t) => {
    setToToken(t); setQuote(null); setError(null); setPhase("idle");
  }, []);
  const changeAmount = useCallback((v) => {
    setAmount(v); setQuote(null); setError(null); setPhase("idle");
  }, []);

  // ── Source-balance read (the "BAL" readout + MAX). Live ladder reads, the
  //    same fetchers/fallbacks the site uses. Fail-soft: "—", never blocks. ─
  const balanceDeps = formProps.balancesDeps || {};
  const evmBalanceFetcher = balanceDeps.evmBalanceFetcher || fetchEvmTokenBalance;
  const svmBalanceFetcher = balanceDeps.solBalanceFetcher || fetchSvmTokenBalances;
  const priceFetcher = balanceDeps.priceFetcher || getPricesUSD;
  const resolveEvmProviderFn = balanceDeps.resolveEvmProviderFn || resolveEvmProvider;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setSourceBalance(null);
      const evmAddr = evmSession?.address;
      const solAddr = solSession?.address;
      if (!evmAddr && !solAddr) return;
      let priceMap = null;
      try { priceMap = await priceFetcher(); } catch { priceMap = null; }
      try {
        if (direction === "forward" && evmAddr && TOKENS[from]?.[token]) {
          const provider = await resolveEvmProviderFn(evmSession);
          const bal = await evmBalanceFetcher({ provider, wallet: evmAddr, token: TOKENS[from][token] });
          if (cancelled) return;
          const price = priceMap?.[token];
          setSourceBalance(bal == null ? null : { balance: bal, symbol: token, usd: price != null ? bal * price : null });
        } else if (direction === "reverse" && solAddr) {
          const res = await svmBalanceFetcher({ rpcs: X1_RPC_LADDER, wallet: solAddr, mints: X1_MINTS });
          if (cancelled) return;
          const bal = res?.[token];
          const price = priceMap?.[token];
          setSourceBalance(bal == null ? null : { balance: bal, symbol: token, usd: price != null ? bal * price : null });
        }
      } catch {
        if (!cancelled) setSourceBalance(null); // fail-soft
      }
    };
    load();
    return () => { cancelled = true; };
  }, [direction, from, token, evmSession, solSession, balanceRefresh, evmBalanceFetcher, svmBalanceFetcher, priceFetcher, resolveEvmProviderFn]);

  const maxFromBalance = () => {
    if (!sourceBalance || !(sourceBalance.balance > 0)) return;
    const decimals = TOKENS[from]?.[token]?.decimals ?? (token === "wSOL.X" ? 9 : 6);
    const trimmed = sourceBalance.balance.toFixed(Math.min(decimals, 6)).replace(/\.?0+$/, "");
    changeAmount(trimmed);
  };

  // ── THE REAL QUOTE PATH (forward + reverse — same builders the classic
  //    form uses; no fakes) ─────────────────────────────────────────────────
  const runQuote = useCallback(async () => {
    const amt = parseFloat(amount);
    if (!amount || !(amt > 0)) { setError("Enter an amount"); setPhase("idle"); return; }
    if (direction === "forward") {
      if (!evmReady) { setError("Connect your EVM wallet to get a quote"); setPhase("idle"); return; }
      if (!solReady) { setError("Connect your Solana/X1 wallet to get a quote"); setPhase("idle"); return; }
      const built = buildLifiQuoteParams({
        from, token, amount: amt,
        fromAddress: evmSession.address,
        toAddress: solSession.address,
        destToken: x1Token,
      });
      if (!built) { setError("No route for the selected chain/token"); setPhase("idle"); return; }
      const seq = ++quoteSeq.current;
      setPhase("quoting"); setError(null); setStatus(null);
      try {
        const resp = await fetch(`/api/lifi/quote?${built.qs}`);
        const d = await resp.json();
        if (seq !== quoteSeq.current) return;
        if (d?.error || d?.message) { setError(d.message || d.error); setPhase("idle"); return; }
        const derived = deriveQuoteFromLifi({ data: d, from, token, amount: amt, destToken: x1Token });
        setQuote({ amount: amt, ...derived, lifiData: d });
        setRefreshLeft(QUOTE_REFRESH_SECONDS);
        setPhase("quoted");
      } catch (e) {
        console.error("[Teleport Console] quote failed:", e);
        if (seq !== quoteSeq.current) return;
        setError("Quote request failed"); setPhase("idle");
      }
    } else {
      if (!solReady) { setError("Connect your Solana/X1 wallet to get a quote"); setPhase("idle"); return; }
      if (!evmReady) { setError("Connect your EVM wallet to get a quote"); setPhase("idle"); return; }
      const legs = computeReverseLegs({ amount: amt, token });
      const built = buildReverseLifiQuoteParams({
        to,
        toTokenSymbol: toToken,
        netOnSolana: legs.netOnSolana,
        fromAddress: solSession.address,
        toAddress: evmSession.address,
        token,
      });
      const seq = ++quoteSeq.current;
      setPhase("quoting"); setError(null); setStatus(null);
      try {
        let lifiData = null;
        if (built) {
          const resp = await fetch(`/api/lifi/quote?${built.qs}`);
          const d = await resp.json();
          if (seq !== quoteSeq.current) return;
          if (!(d?.error || d?.message) && d?.estimate?.toAmount) lifiData = d;
        }
        const derived = deriveReverseQuote({ data: lifiData, to, amount: amt, token, toToken });
        setQuote({ amount: amt, to, toToken, ...derived, lifiData });
        setRefreshLeft(QUOTE_REFRESH_SECONDS);
        setPhase("quoted");
      } catch (e) {
        console.error("[Teleport Console] reverse quote failed:", e);
        if (seq !== quoteSeq.current) return;
        setError("Quote request failed"); setPhase("idle");
      }
    }
  }, [amount, direction, from, to, token, x1Token, toToken, evmReady, solReady, evmSession, solSession]);

  // Auto-quote: route/amount edits (debounced) re-quote when idle.
  useEffect(() => {
    if (phase !== "idle") return;
    const amt = parseFloat(amount);
    if (!amount || !(amt > 0)) return;
    const t = setTimeout(() => { runQuote(); }, debounceMs);
    return () => clearTimeout(t);
  }, [amount, from, to, token, x1Token, toToken, direction, evmReady, solReady, phase, runQuote, debounceMs]);

  // Refresh countdown: while quoted, re-quote when the window elapses.
  useEffect(() => {
    if (phase !== "quoted") return;
    const t = setInterval(() => {
      setRefreshLeft((n) => {
        if (n <= 1) { runQuote(); return QUOTE_REFRESH_SECONDS; }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [phase, runQuote]);

  // ── Forward send (stage 1 = engine EVM stage; stage 2 = engine SVM stage,
  //    WARP_LIVE_SEND-gated). Port of TeleportForm's handlers — same gates,
  //    same fail-closed sim policy, same error strings. ─────────────────────
  async function executeStage1() {
    if (!quote?.lifiData) return;
    setError(null); setStatus(null);
    if (!evmReady) { setError("Connect your EVM wallet (e.g. Rabby/MetaMask) before bridging."); return; }
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
      console.group("[Teleport Console] Stage 1 FAILED");
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
        amountHuman: quote.solanaAmount ?? quote.amount,
        allowLive: WARP_LIVE_SEND,
        destToken: x1Token,
      });
      if (!res.success) {
        if (res.sim?.simUnavailable) {
          setError(`Bridge sim couldn't run (RPC: ${res.sim?.rpcError || "unknown"}) — send blocked. Retry when the RPC is reachable.`);
        } else {
          const logs = res.sim?.logs || [];
          const key = logs.filter((l) => /error|failed|assert|seq|insufficient|invalid|constraint/i.test(l)).slice(-2).join(" | ");
          setError(`Bridge sim failed: ${JSON.stringify(res.sim?.err)}${key ? " — " + key : ""} (full logs in console)`);
        }
        setPhase("handoff");
        return;
      }
      if (res.sent || res.signature) {
        setWarpSig(res.signature);
        setPhase("relaying");
        setSeqVisible(true); // a REAL broadcast — the console fires
      } else {
        setConfirmMode(true);
        setPhase("done");
      }
    } catch (e) {
      console.error("[Teleport Console] stage 2 error:", e);
      setError(`Warp error: ${String(e?.message || e)}`);
      setPhase("handoff");
    } finally {
      setStep2Busy(false);
    }
  }

  // ── Reverse send (burn → release poll → LiFi out). Port of the classic
  //    reverse handlers. ────────────────────────────────────────────────────
  async function executeReverseStage1() {
    if (!quote) return;
    if (polling || step2Busy) return;
    setError(null); setStatus(null);
    const solAdapter = await SignerResolver.resolve("svm", solSession);
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
        amountHuman: quote.amount,
        allowLive: WARP_LIVE_SEND,
        token,
      });
      if (!res.success) {
        if (res.sim?.simUnavailable) {
          setError(`Burn sim couldn't run (RPC: ${res.sim?.rpcError || "unknown"}) — send blocked. Retry when the RPC is reachable.`);
        } else {
          const logs = res.sim?.logs || [];
          const key = logs.filter((l) => /error|failed|assert|seq|insufficient|invalid|constraint/i.test(l)).slice(-2).join(" | ");
          setError(`Burn sim failed: ${JSON.stringify(res.sim?.err)}${key ? " — " + key : ""} (full logs in console)`);
        }
        setPhase("quoted");
        return;
      }
      if (res.sent || res.signature) {
        setWarpSig(res.signature);
        setReverseStage(2);
        setPhase("relaying");
        pollRelease(res.signature);
      } else {
        setConfirmMode(true);
        setPhase("done");
      }
    } catch (e) {
      console.error("[Teleport Console] reverse stage 1 error:", e);
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
        setPhase("step2");
        await executeReverseStage2();
      } else if (res?.terminal) {
        setError("The Warp release failed terminally — your USDC.x is safe on X1. Contact support.");
        setHandoffReason("terminal");
        setPhase("handoff");
      } else {
        setReleaseNote("Still awaiting the release — the Warp guardians can take a few minutes.");
      }
    } catch (e) {
      console.error("[Teleport Console] release poll error:", e);
      setReleaseNote("Could not reach the Warp status API — check again in a moment.");
    } finally {
      setPolling(false);
    }
  }

  async function executeReverseStage2() {
    if (!quote || step2Busy) return;
    setError(null); setStatus(null);
    setStep2Busy(true);
    const solAdapter = await SignerResolver.resolve("svm", solSession);
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
        toTokenSymbol: quote.toToken || "USDC",
        netOnSolana: quote.solanaAmount ?? quote.legs?.netOnSolana,
        onStatus: (msg) => setStatus(msg),
        token,
      });
      setStage1Hash(txHash);
      setPhase("done");
      setSeqVisible(true); // the final leg broadcast for real — the console fires
    } catch (e) {
      console.error("[Teleport Console] reverse stage 2 error:", e);
      setError(`${e?.message || "The Solana → EVM leg failed"}. Your USDC is safe on Solana.`);
      setHandoffReason("lifi");
      setPhase("handoff");
    } finally {
      setStep2Busy(false);
    }
  }

  // ── Fire: TELEPORT pressed. Unquoted → run the quote (never fires
  //    blind); quoted → the real send (direction-correct stage 1). ─────────
  const onFire = () => {
    setError(null);
    if (phase === "quoting" || phase === "bridging") return;
    if (!amount || !(parseFloat(amount) > 0)) { setError("Enter an amount to teleport"); return; }
    if (phase !== "quoted") { runQuote(); return; }
    if (direction === "forward") executeStage1();
    else executeReverseStage1();
  };

  // Connected wallets → auto-close the connect overlay (same pattern as the
  // classic ConnectedBody: a NEW family connecting closes the modal).
  const connectedCount = WALLET_FAMILIES.filter((f) => sessions[f]?.status === "connected").length;
  const prevConnected = useRef(connectedCount);
  useEffect(() => {
    if (connecting && connectedCount > prevConnected.current) setConnecting(false);
    prevConnected.current = connectedCount;
  }, [connecting, connectedCount]);

  // Post-bridge refresh bump on done (wallets changed).
  useEffect(() => {
    if (phase === "done") setBalanceRefresh((n) => n + 1);
  }, [phase]);

  const busy = phase === "bridging" || phase === "quoting" || step2Busy;
  const armed = phase === "quoted" && Boolean(quote);
  const tickerDisplay = useTicker(quote?.net ?? 0, { active: phase === "quoted" });

  // Wallet guidance (which wallet the CURRENT route needs next).
  const missingWallets = [];
  if (direction === "forward") {
    if (!evmReady) missingWallets.push("EVM (Rabby / MetaMask) — the source wallet");
    if (!solReady) missingWallets.push("Solana/X1 (Phantom / Backpack) — where it lands on X1");
  } else {
    if (!solReady) missingWallets.push("Solana/X1 (Phantom / Backpack) — the burn happens on X1");
    if (!evmReady) missingWallets.push("EVM (Rabby / MetaMask) — the destination wallet");
  }

  const thorchainEnabled = flags.THORCHAIN === true;

  // Shared phase panel (same testids/semantics as the classic form, styled
  // to the console) — forward + reverse branches mirror TeleportForm.
  const phasePanel = () => {
    if (phase === "bridging") {
      return (
        <div style={{ marginTop: 12 }}>
          <div data-testid="bridging" className="tc-box" style={{ textAlign: "center" }}>
            <b>TELEPORTING…</b> {status ? `(${status})` : ""}
            <div style={{ fontSize: 11, color: "#6e93ad", marginTop: 6 }}>stage in flight — your funds are safe at every step</div>
          </div>
        </div>
      );
    }
    if (phase === "step2") {
      return (
        <>
          <div className="tc-box" style={{ marginTop: 12 }}>
            <b>Stage 1 sent</b> — {stage1Hash ? `tx ${String(stage1Hash).slice(0, 10)}…` : ""} your {x1Token === "wSOL.X" ? "WSOL" : "USDC"} is on its way to Solana.
            Approve Stage 2 to mint {x1Token} on X1. If you stop here, your funds rest safely as {x1Token === "wSOL.X" ? "WSOL" : "USDC"} on Solana.
          </div>
          <button data-testid="bridge-step2" className="tc-fire" style={step2Busy ? { opacity: 0.5 } : {}} onClick={executeStage2} disabled={step2Busy}>
            {step2Busy ? "BRIDGING TO X1…" : "STAGE 2 OF 2 — FINISH THE HOP TO X1"}
          </button>
        </>
      );
    }
    if (phase === "relaying") {
      return (
        <div data-testid="relaying" className="tc-box" style={{ marginTop: 12 }}>
          {direction === "reverse" ? (
            <>
              <b>X1 burn sent</b> {warpSig ? `(${String(warpSig).slice(0, 10)}…)` : ""} — {token} is burning on X1; the Warp guardians release {token === "wSOL.X" ? "WSOL" : "USDC"} on Solana.
              {releaseNote && <div data-testid="release-note" style={{ marginTop: 6 }}>{releaseNote}</div>}
              {!polling && !String(releaseNote || "").includes("Released") && warpSig && (
                <button data-testid="check-release" className="tc-ghost" onClick={() => pollRelease(warpSig)}>
                  Check release status again
                </button>
              )}
            </>
          ) : (
            <>
              <b>bridge_out sent</b> {warpSig ? `(${String(warpSig).slice(0, 10)}…)` : ""} — the official submitter relays it to X1. Your funds are safe.
            </>
          )}
          <button data-testid="reset" className="tc-ghost" onClick={reset}>Done / bridge again</button>
        </div>
      );
    }
    if (phase === "handoff") {
      return (
        <div data-testid="handoff" className="tc-box" style={{ marginTop: 12 }}>
          {direction === "reverse" && handoffReason === "burn" && (
            <>Stage 1 didn't start — nothing was sent. Your USDC.x stays safe on X1. Connect your Solana/X1 wallet to burn, then retry.</>
          )}
          {direction === "reverse" && handoffReason === "terminal" && (
            <>The Warp release failed terminally — your USDC.x is safe on X1. Contact support.</>
          )}
          {direction === "reverse" && handoffReason === "lifi" && (
            <>
              <b>Your {token === "wSOL.X" ? "WSOL" : "USDC"} is safe on Solana</b>{stage1Hash ? ` (final leg tx ${String(stage1Hash).slice(0, 10)}…)` : ""}.
              The Solana → {CHAINS[quote?.to || to]?.name} hop didn't complete.{" "}
              {canStage2 && (
                <button data-testid="retry-stage2" style={{ ...{ marginTop: 8 }, width: "auto", padding: "5px 14px", borderRadius: 8, background: "transparent", border: "1px solid rgba(63,211,232,.35)", color: "#3fd3e8", cursor: "pointer", fontSize: 12.5 }} onClick={executeReverseStage2} disabled={step2Busy}>
                  Retry the hop to {CHAINS[quote?.to || to]?.name}
                </button>
              )}
            </>
          )}
          {direction === "forward" && (
            <>
              <b>Stage 1 sent</b> — your USDC is on Solana{stage1Hash ? ` (tx ${String(stage1Hash).slice(0, 10)}…)` : ""}.
              {canStage2 && (
                <>
                  {" "}Stage 2 didn't complete.{" "}
                  <button data-testid="retry-stage2" style={{ width: "auto", padding: "5px 14px", borderRadius: 8, background: "transparent", border: "1px solid rgba(63,211,232,.35)", color: "#3fd3e8", cursor: "pointer", fontSize: 12.5 }} onClick={executeStage2} disabled={step2Busy}>
                    Retry stage 2
                  </button>
                </>
              )}
              {!canStage2 && (
                <> Connect a Solana/X1 wallet (Phantom / Backpack) to finish the hop to X1, or finish on the official Warp Bridge.</>
              )}
            </>
          )}
          <div style={{ marginTop: 8 }}>
            <a href={WARP_BRIDGE_URL} target="_blank" rel="noopener noreferrer" className="tc-link">🌉 Open Warp Bridge to finish → X1</a>
          </div>
          <button data-testid="reset" className="tc-ghost" onClick={reset}>Done / bridge again</button>
        </div>
      );
    }
    if (phase === "done") {
      return (
        <div data-testid="done" className="tc-box tc-ok" style={{ marginTop: 12 }}>
          {confirmMode
            ? <>✓ Simulation passed — <b>not sent</b> (live Warp sends are OFF; set VITE_WARP_LIVE_SEND=true to arm).</>
            : <>✓ Bridge complete — {quote?.recvToken || x1Token}{direction === "reverse" ? ` on ${CHAINS[quote?.to || to]?.name}` : " on X1"}.</>}
          <button data-testid="reset" className="tc-ghost" onClick={reset}>Bridge again</button>
        </div>
      );
    }
    return null;
  };

  const quoteBox = quote && (
    <div className="quote-box" data-testid="quote-box">
      <div className="tc-quote-row">
        <span className="tc-quote-key">You send</span>
        <span className="tc-quote-val">{quote.amount} {token} on {direction === "forward" ? CHAINS[from].name : "X1"}</span>
      </div>
      {(quote.feeLines || []).map((l) => (
        <div key={l.id} data-testid={`fee-line-${l.id}`} className="tc-quote-row">
          <span className="tc-quote-key">{l.label}</span>
          <span className="tc-quote-val">${l.amountUsd.toFixed(2)}</span>
        </div>
      ))}
      <div className="tc-quote-row">
        <span className="tc-quote-key">Est. received</span>
        <span data-testid="you-receive" className="tc-quote-hi">≈ {tickerDisplay} {quote.recvToken} on {quote.recvChain}</span>
      </div>
      {direction === "forward" && solSession?.address && (
        <div className="tc-quote-row" data-testid="dest-address-forward">
          <span className="tc-quote-key">To</span>
          <span className="tc-quote-val" title={solSession.address}>{truncateAddress(solSession.address)} ({CHAINS.x1.name})</span>
        </div>
      )}
      {direction === "reverse" && evmSession?.address && (
        <div className="tc-quote-row" data-testid="dest-address">
          <span className="tc-quote-key">To</span>
          <span className="tc-quote-val" title={evmSession.address}>{truncateAddress(evmSession.address)} ({CHAINS[quote?.to || to]?.name})</span>
        </div>
      )}
      {direction === "reverse" && !quote.lifiQuoted && (
        <div className="tc-note" data-testid="reverse-lifi-note">
          The Solana → {CHAINS[quote.to]?.name} leg couldn't be quoted right now — stage 1 (the X1 burn) still works; your {token === "wSOL.X" ? "WSOL" : "USDC"} will rest safely on Solana and you can finish the hop later.
        </div>
      )}
      {quote.steps?.length > 0 && (
        <div className="tc-steps">
          {quote.steps.map((s, i) => (
            <span key={i} className="tc-step">{s.tool} · {s.name}</span>
          ))}
        </div>
      )}
    </div>
  );

  const stripBody = () => {
    if (error) {
      return (
        <div data-testid="form-error" className="tc-err" style={{ marginTop: 0 }}>⚠️ {error}</div>
      );
    }
    if (busy && phase === "quoting") {
      return (
        <div className="tc-strip-hint" data-testid="quoting">
          <b>CALCULATING ROUTE</b> — pinging the rails… <span style={{ color: "#3fd3e8" }}>▍▍▍</span>
        </div>
      );
    }
    if (armed && quote) {
      return (
        <>
          <div className="tc-quote-row">
            <span className="tc-quote-key">Route fresh · refresh in 0:{String(Math.max(0, refreshLeft)).padStart(2, "0")}</span>
            <button data-testid="refresh-quote" className="tc-refresh" onClick={() => runQuote()} disabled={busy}>REFRESH</button>
          </div>
          {quoteBox}
        </>
      );
    }
    if (phase === "quoted" && !quote) {
      return <div className="tc-strip-hint">Quote cleared — adjust your route coordinates.</div>;
    }
    // idle-ish: guidance
    if (missingWallets.length > 0) {
      return (
        <div className="tc-strip-hint">
          <b>CONNECT WALLETS TO ARM THE ROUTE</b>
          <br />needs: {missingWallets.join(" · ")}
        </div>
      );
    }
    if (!amount || !(parseFloat(amount) > 0)) {
      return <div className="tc-strip-hint"><b>SET YOUR JOURNEY COORDINATES</b> — pick chains, token and amount, then TELEPORT.</div>;
    }
    return <div className="tc-strip-hint"><b>ROUTE READY</b> — calculating…</div>;
  };

  return (
    <div className="tc-page" data-testid="teleport-console-page">
      <style data-console-css="1" dangerouslySetInnerHTML={{ __html: CONSOLE_CSS }} />
      <AstronautBackdrop />
      <div className="tc-scroll">
        <div className="tc-shell-wrap">
          <div className="tc-shell-rim">
            <div className="tc-shell-glass" data-testid="teleport-console">
              {/* Header readout strip */}
              <div className="tc-header">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <span data-testid="console-header" className="tc-title">⬢ TELEPORT CONSOLE</span>
                  <span className="tc-status" data-testid="console-status">
                    <span className="tc-status-dot" />
                    STATUS: {statusFor(phase, armed, busy)}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 5 }}>
                  <span data-testid="console-subheader" className="tc-subheader">Route · set your journey coordinates</span>
                  <span className="tc-subheader" style={{ opacity: 0.6 }}>{direction === "forward" ? "EVM → X1" : "X1 → EVM"}</span>
                </div>
              </div>

              {/* Tabs — the console is the primary swap surface; THORChain/Buy
                  keep existing in the same shell (BridgeCard parity). */}
              <nav className="tc-tabs" role="tablist" aria-label="Teleport console">
                {["teleport", "thorchain", "buy"].map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    data-tab={id}
                    className={tab === id ? "tc-tab tc-tab-active" : "tc-tab"}
                    onClick={() => setTab(id)}
                  >
                    {id === "teleport" ? "Teleport" : id === "thorchain" ? "THORChain" : "Buy"}
                  </button>
                ))}
              </nav>

              {tab === "thorchain" ? (
                <div className="tc-tab-body">
                  {thorchainEnabled ? <THORChainTab /> : (
                    <div role="tabpanel" data-testid="thorchain-tab" style={{ color: "#6e93ad", fontSize: 13, padding: "10px 0" }}>
                      THORChain swap flow arrives in a later step.
                    </div>
                  )}
                </div>
              ) : tab === "buy" ? (
                <div className="tc-tab-body">
                  <div role="tabpanel" data-testid="buy-tab" style={{ color: "#6e93ad", fontSize: 13, padding: "10px 0" }}>
                    Buy flow arrives in a later step.
                  </div>
                </div>
              ) : (
                <div className="tc-body" role="tabpanel" aria-label="Teleport console">
                  {/* Wallet chips */}
                  <div className="tc-wallets" data-testid="console-wallets">
                    {WALLET_FAMILIES.filter((f) => sessions[f]?.status === "connected").map((f) => (
                      <span key={f} className="tc-chip" data-testid={`wallet-chip-${f}`}>
                        {FAMILY_LABELS[f]} · <span style={{ color: "#8ea0b8" }}>{truncateAddress(sessions[f].address)}</span>
                        <button type="button" className="tc-chip-x" aria-label={`Disconnect ${FAMILY_LABELS[f]}`} onClick={() => disconnect(f)}>×</button>
                      </span>
                    ))}
                    <button type="button" className="tc-connect" data-testid="connect-open" onClick={() => setConnecting(true)}>
                      + CONNECT WALLET
                    </button>
                  </div>

                  {/* Route coordinates — FROM → TO */}
                  <div className="tc-coords" data-testid="console-coords" style={{ marginTop: 12 }}>
                    <div className="tc-slot tc-slot-grow" data-testid="from-slot">
                      <span className="tc-label">From chain</span>
                      <select data-testid="from-chain" value={from} onChange={(e) => changeFrom(e.target.value)} className="tc-select" aria-label="From chain">
                        {EVM_CHAINS.map((c) => (
                          <option key={c} value={c}>{CHAINS[c].glyph} {CHAINS[c].name}</option>
                        ))}
                        <option value="x1">X1 {CHAINS.x1.glyph}</option>
                      </select>
                      {direction === "forward" && (
                        <span className="tc-sub">source · {token} on {CHAINS[from].name}</span>
                      )}
                      {direction === "reverse" && (
                        <span className="tc-sub">burn on X1 · {token}</span>
                      )}
                    </div>
                    <div className="tc-arrow" data-testid="route-arrow" aria-hidden="true">➜</div>
                    <div className="tc-slot tc-slot-grow" data-testid="to-slot">
                      <span className="tc-label">To chain</span>
                      {direction === "forward" ? (
                        <>
                          <select data-testid="to-chain" value="x1" onChange={() => {}} className="tc-select" aria-label="Destination chain (fixed: X1)" disabled style={{ opacity: 0.9 }}>
                            <option value="x1">X1 {CHAINS.x1.glyph}</option>
                          </select>
                          <span className="tc-sub">destination · land as {x1Token}</span>
                        </>
                      ) : (
                        <>
                          <select data-testid="to-chain" value={to} onChange={(e) => changeTo(e.target.value)} className="tc-select" aria-label="To chain">
                            {EVM_CHAINS.map((c) => (
                              <option key={c} value={c}>{CHAINS[c].glyph} {CHAINS[c].name}</option>
                            ))}
                          </select>
                          <span className="tc-sub">destination · receive {toToken}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Token + Amount (recessed coordinate slots) */}
                  <div style={{ display: "flex", gap: 10, marginTop: 10, flexDirection: "row", flexWrap: "wrap" }}>
                    <div className="tc-slot" style={{ flex: "0 0 auto", minWidth: 150 }} data-testid="token-slot">
                      <span className="tc-label">{direction === "forward" ? "Token" : "Burn token"}</span>
                      {direction === "forward" ? (
                        <select data-testid="token" value={token} onChange={(e) => changeToken(e.target.value)} className="tc-select" aria-label="Token">
                          {tokensFor(from).map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      ) : (
                        <select data-testid="token" value={token} onChange={(e) => changeToken(e.target.value)} className="tc-select" aria-label="Token to burn on X1">
                          {tokensFor("x1").map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      )}
                    </div>
                    {direction === "forward" && (
                      <div className="tc-slot" style={{ flex: "0 0 auto", minWidth: 120 }} data-testid="x1-token-slot">
                        <span className="tc-label">Land as</span>
                        <select data-testid="x1-token" value={x1Token} onChange={(e) => changeX1Token(e.target.value)} className="tc-select" aria-label="Token on X1">
                          {tokensFor("x1").map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                    )}
                    {direction === "reverse" && (
                      <div className="tc-slot" style={{ flex: "0 0 auto", minWidth: 120 }} data-testid="to-token-slot">
                        <span className="tc-label">Receive</span>
                        <select data-testid="to-token" value={toToken} onChange={(e) => changeToToken(e.target.value)} className="tc-select" aria-label="Receive token">
                          {tokensFor(to).map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                    )}
                    <div className="tc-slot tc-slot-grow" style={{ flex: 2 }} data-testid="amount-slot">
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className="tc-label" style={{ marginBottom: 0 }}>Amount</span>
                        <span style={{ flex: 1 }} />
                        <span className="tc-sub" style={{ marginTop: 0 }} data-testid="source-balance">
                          {sourceBalance ? <>BAL {formatBalance(sourceBalance.balance)} {sourceBalance.symbol}{sourceBalance.usd != null ? ` ($${sourceBalance.usd.toFixed(2)})` : ""}</> : "BAL —"}
                        </span>
                        <button type="button" className="tc-max" data-testid="max-button" onClick={maxFromBalance} disabled={!sourceBalance || !(sourceBalance.balance > 0)}>
                          MAX
                        </button>
                      </div>
                      <input
                        data-testid="amount"
                        value={amount}
                        onChange={(e) => changeAmount(e.target.value)}
                        inputMode="decimal"
                        placeholder="0.00"
                        aria-label="Amount"
                        className="tc-amount"
                        style={{ marginTop: 4 }}
                      />
                    </div>
                  </div>

                  {/* Quote-status strip */}
                  <div className="tc-strip" data-testid="quote-strip">{stripBody()}</div>

                  {/* The fire control — hidden once a journey is in flight; the
                      phase panel below takes over (same shape as the classic). */}
                  {!["bridging", "step2", "relaying", "handoff", "done"].includes(phase) && (
                    <button
                      type="button"
                      data-testid="teleport-now"
                      className={armed ? "tc-fire tc-fire-armed" : "tc-fire"}
                      onClick={onFire}
                      disabled={busy || !amount || !(parseFloat(amount) > 0)}
                    >
                      {phase === "quoting" ? "CALCULATING ROUTE…" : phase === "quoted" ? "◉ TELEPORT" : "TELEPORT"}
                    </button>
                  )}

                  {phasePanel()}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Connect overlay — the SAME ConnectModal the classic flow uses. */}
      {connecting && (
        <div className="tc-overlay" data-testid="connect-overlay">
          <div className="tc-modal">
            <button type="button" className="tc-modal-close" data-testid="cancel-connect" onClick={() => setConnecting(false)}>
              ← Back to console
            </button>
            <ConnectModal />
          </div>
        </div>
      )}

      {/* Teleport-sequence overlay — plays ONLY when a leg really broadcast
          (real tx stage); sim-only journeys never fire it. */}
      {seqVisible && (
        <div className="tc-seq" data-testid="sequence-overlay" role="dialog" aria-label="Teleport complete">
          <button type="button" className="tc-seq-skip" data-testid="sequence-skip" onClick={() => setSeqVisible(false)}>SKIP ▸</button>
          <video autoPlay muted playsInline data-testid="sequence-video" onEnded={() => setSeqVisible(false)}>
            <source src="/assets/teleport-sequence.webm" type="video/webm" />
            <source src="/assets/teleport-sequence.mp4" type="video/mp4" />
          </video>
          <div className="tc-seq-label">TELEPORT COMPLETE — WELCOME TO X1</div>
        </div>
      )}
    </div>
  );
}
