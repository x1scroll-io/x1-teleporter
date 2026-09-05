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
 *     classic TeleportTab/TeleportForm stack. The classic card (BridgeCard
 *     default variant) stays byte-behavior-identical and remains the default
 *     on non-preview hosts — the frozen browser harnesses (forward/reverse/
 *     thorchain-leg.spec.js) keep measuring it. The console mounts by default
 *     on the x1scroll Vercel preview hosts (src/lib/uiVariant.js decides;
 *     main.jsx applies).
 *   - Phase/flow semantics mirror TeleportForm 1:1 (same phases, same
 *     fail-closed gates, same error strings, same testids for the shared
 *     elements) so the console-leg harness mirrors the frozen forward/
 *     reverse harness patterns and a future ruler update is mechanical.
 *
 * UNIFIED FLOW (2026-09-04 UX pass — Mr. Esters): NO rail tabs, NO Buy tab.
 *   One clean flow: pick what you have (source asset), where it's going
 *   (destination), TELEPORT. The source picker is the UNION of what every
 *   engine rail can carry — EVM-chain stables (USDC/USDT/DAI — the LiFi/Warp
 *   rail), native BTC/DOGE/LTC/XRP (the THORChain rail), and X1's own tokens
 *   (USDC.x/wSOL.X — the reverse off-ramp). A rail-selection layer
 *   (src/lib/teleportRail.js — pickRail) decides the engine path INVISIBLY
 *   after the asset pick and before execution, with silent failover; the
 *   user never sees a rail name. The two execution shapes route into their
 *   own final steps: deposit-address (vault address + memo + txid-paste —
 *   rendered by THORChainDeposit/THORChainProgress with neutral copy, the
 *   word "THORChain" never rendered) vs wallet-connect (the EVM/X1 sign
 *   stages below). The THORChain engine code, tests, fixtures and fees are
 *   untouched — this is UI consolidation only.
 *
 * DIRECTION MODEL: route-first (docs/UX-VISION.md) — there is no direction
 * toggle. FROM and TO are the route coordinates: FROM an EVM chain or a
 * native chain (BTC/DOGE/LTC/XRP) → X1 is the forward on-ramp; FROM X1 → an
 * EVM chain is the reverse off-ramp. The console derives the direction from
 * the FROM slot.
 *
 * MOTION: numbers tick when quoting (readout feel), the TELEPORT button
 * pulses when armed, micro-interactions are ≤200ms ease-out, and the
 * teleport-sequence video plays when a leg actually BROADCASTS (tied to the
 * real tx stage — never in confirm/sim-only mode). No sound. Reduced-motion
 * and mobile (portrait) render the astronaut POSTER still instead of the
 * ambient video (design doc).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CHAINS, TOKENS, WARP_BRIDGE_URL } from "../lib/teleportConstants.js";
import {
  RAIL,
  NATIVE_CHAINS,
  SOURCE_CHAINS,
  chainName,
  chainGlyph,
  tokensOn,
  isNativeChain,
  pickRail,
} from "../lib/teleportRail.js";
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
import { createBtcBalanceFetcher } from "../lib/wallet/bitcoinBalance.js";
import { createLtcBalanceFetcher, createDogeBalanceFetcher } from "../lib/wallet/altcoinBalance.js";
import { createXrpBalanceFetcher } from "../lib/wallet/xrpBalance.js";
import {
  fetchEvmTokenBalance,
  fetchSvmTokenBalances,
  X1_MINTS,
  X1_RPC_LADDER,
  formatBalance,
} from "../lib/balances.js";
import { getPricesUSD, usdValue } from "../lib/prices.js";
import ConnectModal from "./ConnectModal.jsx";
import THORChainDeposit from "./THORChainDeposit.jsx";
import THORChainProgress from "./THORChainProgress.jsx";
// The deposit-address rail's storage/balance handles arrive through the
// lane's public doorway component — the lane internals stay contained
// behind it (the containment gate enforces the boundary).
import { createThorchainStorage, createSolBalanceReader } from "./THORChainTab.jsx";
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

// ── Neutral copy for the deposit-address rail (the THORChain ENGINE path
//    rendered inside the unified flow). Mr. Esters: the user picks an asset
//    and destination — they NEVER see a rail name. These overrides rename
//    every rail-naming string the shared deposit/progress components render;
//    the components' OWN defaults (used by the classic THORChain tab) are
//    untouched. {label} is the source asset's human name.
const DEPOSIT_NEUTRAL_COPY = Object.freeze({
  subtitle: "Send native {label} to the deposit address below — it arrives in your wallet, then hops to X1 as USDC.x.",
  pausedBanner: "⚠️ {label} deposits are paused right now — pick another source or wait; this refreshes automatically.",
  pausedBy: "paused right now",
  // The DESTINATION-route halt (the SOL pool the deposit lands on is paused
  // on the bridge network's side — their maintenance, NOT the user's fault):
  // calm + honest, no rail name, and it promises the automatic re-check the
  // 60s inbound refresh performs.
  destPaused: "⚠️ The {label} → Solana leg is temporarily paused by the bridge network (maintenance) — it resumes automatically, nothing to fix on your end. This panel re-checks by itself and the deposit address appears the moment the route is live.",
  noSolana: "Connect your Solana/X1 wallet first — the deposit destination is your wallet address and can't be typed. Use CONNECT WALLET above to connect one.",
  destBadge: "Solana/X1 wallet",
  feeLabels: { "thorchain-affiliate": "Network protocol fee" },
});
const TRACKING_NEUTRAL_COPY = Object.freeze({
  paused: "Deposits are paused right now — your funds are safe; polling continues and this clears automatically.",
  stageDetail: {
    observed: "Deposit observed — preparing the swap",
    swapping: "Swapping through the bridge network",
  },
});

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
.tc-bg video,.tc-bg img{position:absolute;left:0;top:-16%;width:100%;height:116%;object-fit:cover;opacity:.62}
.tc-bg img{opacity:.72}
.tc-scrim{position:absolute;inset:0;background:linear-gradient(180deg,rgba(2,5,10,.46) 0%,rgba(2,5,10,.24) 30%,rgba(2,5,10,.34) 55%,rgba(2,4,9,.68) 100%)}
.tc-portal{position:absolute;left:50%;top:40%;width:min(1080px,130vw);height:min(1080px,130vw);transform:translate(-50%,-50%);background:radial-gradient(circle,rgba(0,240,255,.17) 0%,rgba(63,211,232,.07) 36%,transparent 68%);pointer-events:none}
.tc-scroll{position:relative;z-index:1;height:100vh;height:100dvh;overflow-y:auto;display:flex;align-items:center;justify-content:center;padding:18px}
.tc-shell-wrap{position:relative;width:min(700px,94vw);margin:auto;isolation:isolate;box-shadow:0 0 18px rgba(63,211,232,.26),0 30px 64px rgba(0,0,0,.6),0 3px 12px rgba(0,0,0,.5)}
/* NOTE: the housing glow/depth shadows are box-shadow here — plain shadows,
   no ancestor filter or opacity layer sits between the video and the glass
   (the card interior must stay genuinely see-through to the sharp scene). */
.tc-halo{position:absolute;inset:-74px;z-index:-1;pointer-events:none;background:radial-gradient(60% 54% at 50% 50%,rgba(0,240,255,.22) 0%,rgba(63,211,232,.09) 42%,rgba(63,211,232,0) 70%)}
.tc-shell-rim{position:relative;clip-path:polygon(0 24px,24px 0,calc(100% - 24px) 0,100% 24px,100% calc(100% - 24px),calc(100% - 24px) 100%,24px 100%,0 calc(100% - 24px));background:transparent;padding:2px}
/* The metallic bezel is painted ONLY as the 2px frame (housing): the old
   background covered the WHOLE card under the translucent glass — the
   astronaut could never show through, and the backdrop-blur was actually
   frosting the bezel's own metallic gradient (the "teal mush"). The frame
   now lives on a ::before masked to the padding ring (content knocked out),
   so the card interior stays genuinely see-through to the sharp video. */
.tc-shell-rim::before{content:"";position:absolute;inset:0;padding:2px;background:linear-gradient(150deg,#a8c6e0 0%,#4a6c8c 10%,#17293d 26%,rgba(0,240,255,.95) 42%,rgba(63,211,232,.35) 50%,#0d1e30 62%,rgba(0,240,255,.8) 80%,#5d8db0 92%,#93b8d6 100%);clip-path:inherit;pointer-events:none;box-shadow:inset 0 1px 0 rgba(255,255,255,.28),inset 0 -1px 0 rgba(0,0,0,.6);-webkit-mask:linear-gradient(#fff 0 0) border-box,linear-gradient(#fff 0 0) content-box;-webkit-mask-composite:xor;mask:linear-gradient(#fff 0 0) border-box,linear-gradient(#fff 0 0) content-box;mask-composite:exclude}
/* SEE-THROUGH GLASS (v4): NO backdrop blur — the astronaut behind the card
   stays CLEAR and SHARP (blur(36px) over the live video is what turned the
   figure into teal mush AND starved the mobile compositor into a frozen
   frame). Readability rides a low ~5-9% dark tint + the dark text-shadow
   stacks on every glyph — never a background block, never a frost. The top
   sheen that used to live in the gradient rides the inset highlight shadow. */
.tc-shell-glass{clip-path:polygon(24px 2px,calc(100% - 24px) 2px,calc(100% - 2px) 24px,calc(100% - 2px) calc(100% - 24px),calc(100% - 24px) calc(100% - 2px),24px calc(100% - 2px),2px calc(100% - 24px),2px 24px);background:linear-gradient(180deg,rgba(8,24,38,.085) 0%,rgba(6,17,29,.06) 55%,rgba(5,14,25,.05) 100%);box-shadow:inset 0 1px 0 rgba(160,235,255,.1),inset 0 -1px 0 rgba(0,0,0,.3)}
.tc-bolt{position:absolute;width:13px;height:13px;border-radius:50%;background:radial-gradient(circle at 34% 30%,#e2f0fa 0%,#9dbed8 16%,#3a5a74 48%,#10202f 78%,#060d15 100%);box-shadow:0 0 0 1px rgba(0,0,0,.65),0 1px 3px rgba(0,0,0,.55),0 0 9px rgba(63,211,232,.5);z-index:2}
.tc-bolt::before,.tc-bolt::after{content:"";position:absolute;left:50%;top:50%;border-radius:1px}
.tc-bolt::before{width:9px;height:2px;transform:translate(-50%,-50%) rotate(45deg);background:linear-gradient(90deg,rgba(4,8,13,.9) 0%,rgba(4,8,13,.9) 38%,rgba(170,210,235,.55) 50%,rgba(4,8,13,.9) 62%,rgba(4,8,13,.9) 100%)}
.tc-bolt::after{width:2px;height:9px;transform:translate(-50%,-50%) rotate(45deg);background:linear-gradient(180deg,rgba(4,8,13,.9) 0%,rgba(4,8,13,.9) 38%,rgba(170,210,235,.55) 50%,rgba(4,8,13,.9) 62%,rgba(4,8,13,.9) 100%)}
.tc-bolt-nw{top:-5px;left:-5px}
.tc-bolt-ne{top:-5px;right:-5px}
.tc-bolt-sw{bottom:-5px;left:-5px}
.tc-bolt-se{bottom:-5px;right:-5px}
.tc-header{padding:12px 18px 8px;border-bottom:1px solid rgba(63,211,232,.16);box-shadow:inset 0 1px 0 rgba(140,240,255,.06)}
.tc-body{padding:14px 18px 20px}
.tc-title{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700;letter-spacing:.22em;font-size:15px;color:#aef6ff;text-shadow:1px 0 0 rgba(1,4,9,.92),-1px 0 0 rgba(1,4,9,.92),0 1px 0 rgba(1,4,9,.92),0 -1px 0 rgba(1,4,9,.92),0 0 2px rgba(1,4,9,.95),0 0 5px rgba(1,4,9,.55),0 1px 3px rgba(1,4,9,.9),0 0 10px rgba(0,240,255,.3),0 0 24px rgba(0,240,255,.15)}
.tc-subheader{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;letter-spacing:.3em;color:#9fdcf0;text-shadow:1px 0 0 rgba(1,4,9,.92),-1px 0 0 rgba(1,4,9,.92),0 1px 0 rgba(1,4,9,.92),0 -1px 0 rgba(1,4,9,.92),0 0 2px rgba(1,4,9,.92),0 0 4px rgba(1,4,9,.5),0 1px 2px rgba(1,4,9,.85),0 0 10px rgba(0,240,255,.12);text-transform:uppercase}
.tc-status{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:700;letter-spacing:.14em;color:#c8f6ff;text-shadow:1px 0 0 rgba(1,4,9,.92),-1px 0 0 rgba(1,4,9,.92),0 1px 0 rgba(1,4,9,.92),0 -1px 0 rgba(1,4,9,.92),0 0 2px rgba(1,4,9,.95),0 0 4px rgba(1,4,9,.55),0 1px 2px rgba(1,4,9,.85),0 0 8px rgba(0,240,255,.2),0 0 16px rgba(0,240,255,.08);display:flex;align-items:center;gap:7px;white-space:nowrap}
.tc-status-dot{width:8px;height:8px;border-radius:50%;background:#3fd3e8;box-shadow:0 0 8px rgba(63,211,232,.95),0 0 18px rgba(63,211,232,.5);animation:tcBlink 2.4s ease-in-out infinite}
.tc-tabs{display:flex;gap:4px;padding:0 18px;border-bottom:1px solid rgba(63,211,232,.12)}
.tc-tab{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:none;border:none;border-bottom:2px solid transparent;color:#8fc4d8;text-shadow:1px 0 0 rgba(1,4,9,.88),-1px 0 0 rgba(1,4,9,.88),0 1px 0 rgba(1,4,9,.88),0 -1px 0 rgba(1,4,9,.88),0 0 2px rgba(1,4,9,.92),0 0 4px rgba(1,4,9,.5),0 1px 2px rgba(1,4,9,.85),0 0 8px rgba(0,240,255,.08);font-size:12px;letter-spacing:.18em;padding:10px 12px 8px;cursor:pointer;text-transform:uppercase}
.tc-tab-active{color:#7ff3ff;border-bottom-color:rgba(0,240,255,.9);text-shadow:1px 0 0 rgba(1,4,9,.92),-1px 0 0 rgba(1,4,9,.92),0 1px 0 rgba(1,4,9,.92),0 -1px 0 rgba(1,4,9,.92),0 0 2px rgba(1,4,9,.95),0 0 4px rgba(1,4,9,.55),0 1px 2px rgba(1,4,9,.85),0 0 10px rgba(0,240,255,.5),0 0 24px rgba(0,240,255,.2)}
.tc-label{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;letter-spacing:.24em;color:#8fe0f2;text-shadow:1px 0 0 rgba(1,4,9,.92),-1px 0 0 rgba(1,4,9,.92),0 1px 0 rgba(1,4,9,.92),0 -1px 0 rgba(1,4,9,.92),0 0 2px rgba(1,4,9,.92),0 0 4px rgba(1,4,9,.5),0 1px 2px rgba(1,4,9,.85),0 0 6px rgba(0,240,255,.15),0 0 14px rgba(0,240,255,.06);text-transform:uppercase;display:block;margin-bottom:5px}
.tc-slot{background:linear-gradient(180deg,rgba(9,26,42,.08) 0%,rgba(6,18,30,.055) 100%);border:1px solid rgba(63,211,232,.26);box-shadow:inset 0 1px 0 rgba(255,255,255,.07),inset 0 2px 10px rgba(0,0,0,.12),inset 0 -1px 0 rgba(255,255,255,.05),0 1px 0 rgba(255,255,255,.04);border-radius:8px;padding:10px 12px;min-height:56px;display:flex;flex-direction:column;justify-content:center;transition:border-color 140ms ease-out,box-shadow 140ms ease-out}
.tc-slot:focus-within{border-color:rgba(0,240,255,.75);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 2px 10px rgba(0,0,0,.22),inset 0 -1px 0 rgba(255,255,255,.05),0 0 0 1px rgba(0,240,255,.3),0 0 20px rgba(0,240,255,.2)}
.tc-coords{display:flex;align-items:stretch;gap:10px}
.tc-slot-grow{flex:1;min-width:0}
.tc-arrow{display:flex;align-items:center;justify-content:center;color:#3fd3e8;font-size:22px;padding:0 2px;text-shadow:0 0 2px rgba(1,4,9,.95),0 0 6px rgba(1,4,9,.55),0 0 10px rgba(63,211,232,.8);animation:tcTravel 1.6s ease-in-out infinite}
.tc-select{width:100%;background:transparent;border:none;outline:none;color:#e8ecf3;font-size:15px;font-weight:700;appearance:none;-webkit-appearance:none;cursor:pointer;padding:0;font-family:inherit;text-shadow:1px 0 0 rgba(1,4,9,.92),-1px 0 0 rgba(1,4,9,.92),0 1px 0 rgba(1,4,9,.92),0 -1px 0 rgba(1,4,9,.92),0 0 2px rgba(1,4,9,.95),0 0 5px rgba(1,4,9,.6),0 1px 3px rgba(1,4,9,.9)}
.tc-select option{background:#0b1422;color:#e8ecf3;font-weight:400}
.tc-sub{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;color:#8ab8cf;text-shadow:1px 0 0 rgba(1,4,9,.88),-1px 0 0 rgba(1,4,9,.88),0 1px 0 rgba(1,4,9,.88),0 -1px 0 rgba(1,4,9,.88),0 0 2px rgba(1,4,9,.9),0 0 4px rgba(1,4,9,.45),0 1px 2px rgba(1,4,9,.8),0 0 6px rgba(0,240,255,.08);letter-spacing:.1em;margin-top:3px;text-transform:uppercase}
.tc-amount{width:100%;background:transparent;border:none;outline:none;color:#f2feff;font-size:30px;font-weight:700;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.02em;padding:0;text-shadow:1px 0 0 rgba(1,4,9,.92),-1px 0 0 rgba(1,4,9,.92),0 1px 0 rgba(1,4,9,.92),0 -1px 0 rgba(1,4,9,.92),0 0 2px rgba(1,4,9,.95),0 0 5px rgba(1,4,9,.6),0 1px 3px rgba(1,4,9,.9)}
.tc-amount::placeholder{color:#3c5570;font-weight:600}
.tc-max{background:linear-gradient(180deg,rgba(63,211,232,.16),rgba(63,211,232,.08));border:1px solid rgba(0,240,255,.5);color:#7ff3ff;text-shadow:1px 0 0 rgba(1,4,9,.9),-1px 0 0 rgba(1,4,9,.9),0 1px 0 rgba(1,4,9,.9),0 -1px 0 rgba(1,4,9,.9),0 0 2px rgba(1,4,9,.92),0 1px 2px rgba(1,4,9,.85),0 0 8px rgba(0,240,255,.5);border-radius:7px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:700;letter-spacing:.14em;padding:7px 12px;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 2px 5px rgba(0,0,0,.35);transition:all 140ms ease-out}
.tc-max:hover:not(:disabled){background:linear-gradient(180deg,rgba(63,211,232,.3),rgba(63,211,232,.14));box-shadow:inset 0 1px 0 rgba(255,255,255,.2),0 0 12px rgba(0,240,255,.25)}
.tc-max:active:not(:disabled){transform:translateY(1px);box-shadow:inset 0 2px 4px rgba(0,0,0,.35)}
.tc-max:disabled{opacity:.35;cursor:default}
.tc-strip{margin-top:12px;border:1px solid rgba(63,211,232,.15);background:linear-gradient(180deg,rgba(7,21,34,.07) 0%,rgba(5,15,26,.05) 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),inset 0 -1px 0 rgba(255,255,255,.04);border-radius:8px;padding:10px 12px;min-height:54px}
.tc-strip-hint{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.08em;color:#7fabc2;line-height:1.6;text-shadow:1px 0 0 rgba(1,4,9,.92),-1px 0 0 rgba(1,4,9,.92),0 1px 0 rgba(1,4,9,.92),0 -1px 0 rgba(1,4,9,.92),0 0 2px rgba(1,4,9,.92),0 0 4px rgba(1,4,9,.5),0 1px 3px rgba(1,4,9,.9)}
.tc-strip-hint b{color:#aee4f2;text-shadow:1px 0 0 rgba(1,4,9,.92),-1px 0 0 rgba(1,4,9,.92),0 1px 0 rgba(1,4,9,.92),0 -1px 0 rgba(1,4,9,.92),0 0 2px rgba(1,4,9,.95),0 0 4px rgba(1,4,9,.55),0 0 8px rgba(0,240,255,.15);font-weight:600}
.tc-fire{width:100%;margin-top:14px;border:none;cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:800;font-size:15px;letter-spacing:.3em;color:#f4feff;text-shadow:0 1px 2px rgba(0,30,50,.55),0 0 14px rgba(0,240,255,.35);padding:16px 0 14px;clip-path:polygon(0 12px,12px 0,calc(100% - 12px) 0,100% 12px,100% calc(100% - 12px),calc(100% - 12px) 100%,12px 100%,0 calc(100% - 12px));background:linear-gradient(180deg,#3be6ff 0%,#17b8dd 40%,#0e93b8 68%,#0a7194 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.45),inset 0 -3px 6px rgba(0,35,55,.55),0 5px 16px rgba(0,0,0,.5),0 9px 28px rgba(0,0,0,.3),0 0 16px rgba(0,240,255,.35);transition:filter 140ms ease-out,opacity 140ms ease-out,box-shadow 140ms ease-out,transform 90ms ease-out}
.tc-fire:not(:disabled):hover{filter:brightness(1.12) saturate(1.08);box-shadow:inset 0 1px 0 rgba(255,255,255,.45),inset 0 -3px 6px rgba(0,35,55,.55),0 6px 18px rgba(0,0,0,.5),0 0 26px rgba(0,240,255,.55),0 12px 34px rgba(0,240,255,.25)}
.tc-fire:active{transform:translateY(2px);box-shadow:inset 0 2px 5px rgba(0,35,55,.6),0 2px 8px rgba(0,0,0,.5),0 0 12px rgba(0,240,255,.3)}
.tc-fire:disabled{opacity:.62;filter:saturate(.3) brightness(.78);cursor:default;animation:none;box-shadow:inset 0 1px 0 rgba(255,255,255,.22),inset 0 -3px 6px rgba(0,35,55,.5),0 3px 10px rgba(0,0,0,.4)}
.tc-fire-armed{animation:tcPulse 2.2s ease-in-out infinite}
.tc-fire-armed:hover{filter:brightness(1.1)}
.tc-wallets{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;min-height:30px}
.tc-chip{display:inline-flex;align-items:center;gap:7px;background:linear-gradient(180deg,rgba(63,211,232,.07),rgba(63,211,232,.03));border:1px solid rgba(63,211,232,.35);color:#c8f2fa;text-shadow:1px 0 0 rgba(1,4,9,.9),-1px 0 0 rgba(1,4,9,.9),0 1px 0 rgba(1,4,9,.9),0 -1px 0 rgba(1,4,9,.9),0 0 2px rgba(1,4,9,.92),0 0 6px rgba(0,240,255,.25);border-radius:999px;padding:5px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 1px 3px rgba(0,0,0,.3)}
.tc-chip-x{background:none;border:none;color:#6e93ad;cursor:pointer;font-size:13px;padding:0 2px;line-height:1;text-shadow:0 0 2px rgba(1,4,9,.9)}
.tc-chip-x:hover{color:#ff8f85}
.tc-connect{background:linear-gradient(180deg,rgba(63,211,232,.06),rgba(63,211,232,0));border:1px solid rgba(0,240,255,.55);color:#7ff3ff;text-shadow:1px 0 0 rgba(1,4,9,.9),-1px 0 0 rgba(1,4,9,.9),0 1px 0 rgba(1,4,9,.9),0 -1px 0 rgba(1,4,9,.9),0 0 2px rgba(1,4,9,.92),0 1px 2px rgba(1,4,9,.85),0 0 8px rgba(0,240,255,.45);border-radius:999px;padding:6px 14px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.12em;cursor:pointer;box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 1px 3px rgba(0,0,0,.3);transition:all 140ms ease-out}
.tc-connect:hover{background:rgba(63,211,232,.14);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 0 14px rgba(0,240,255,.25)}
.tc-quote-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:4px 0;font-size:13px}
.tc-quote-key{color:#8ab8cf;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;text-shadow:1px 0 0 rgba(1,4,9,.92),-1px 0 0 rgba(1,4,9,.92),0 1px 0 rgba(1,4,9,.92),0 -1px 0 rgba(1,4,9,.92),0 0 2px rgba(1,4,9,.92),0 0 4px rgba(1,4,9,.5),0 1px 3px rgba(1,4,9,.9)}
.tc-quote-val{color:#b9c9dc;font-weight:600;font-size:13px;text-shadow:1px 0 0 rgba(1,4,9,.92),-1px 0 0 rgba(1,4,9,.92),0 1px 0 rgba(1,4,9,.92),0 -1px 0 rgba(1,4,9,.92),0 0 2px rgba(1,4,9,.92),0 0 4px rgba(1,4,9,.5),0 1px 3px rgba(1,4,9,.9)}
.tc-quote-hi{color:#3fd3e8;font-weight:800;font-size:17px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-shadow:1px 0 0 rgba(1,4,9,.92),-1px 0 0 rgba(1,4,9,.92),0 1px 0 rgba(1,4,9,.92),0 -1px 0 rgba(1,4,9,.92),0 0 2px rgba(1,4,9,.95),0 0 5px rgba(1,4,9,.55),0 1px 3px rgba(1,4,9,.9),0 0 12px rgba(63,211,232,.3)}
.tc-refresh{background:rgba(63,211,232,.05);border:1px solid rgba(0,240,255,.45);color:#7ff3ff;text-shadow:1px 0 0 rgba(1,4,9,.9),-1px 0 0 rgba(1,4,9,.9),0 1px 0 rgba(1,4,9,.9),0 -1px 0 rgba(1,4,9,.9),0 0 2px rgba(1,4,9,.92),0 0 6px rgba(0,240,255,.4);border-radius:6px;font-size:11px;padding:3px 10px;cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.1em;box-shadow:inset 0 1px 0 rgba(255,255,255,.1)}
.tc-bal-retry{background:rgba(63,211,232,.06);border:1px solid rgba(0,240,255,.4);color:#7ff3ff;text-shadow:0 0 2px rgba(1,4,9,.9);border-radius:999px;font-size:11px;line-height:1;padding:3px 7px;cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
.tc-bal-retry:hover{background:rgba(63,211,232,.18)}
.tc-steps{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.tc-step{font-size:10px;padding:3px 9px;border-radius:999px;color:#9fd8e6;border:1px solid rgba(63,211,232,.3);background:rgba(63,211,232,.06);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.06em;text-shadow:0 0 2px rgba(1,4,9,.9),0 0 4px rgba(1,4,9,.55)}
.tc-note{font-size:11px;color:#6e93ad;margin-top:6px;line-height:1.5;text-shadow:0 0 2px rgba(1,4,9,.85),0 1px 2px rgba(1,4,9,.7)}
.tc-box{margin-top:12px;border:1px solid rgba(63,211,232,.2);background:linear-gradient(180deg,rgba(7,21,34,.065) 0%,rgba(5,15,26,.05) 100%);border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.6;color:#d7e4ef}
.tc-ok{border-color:rgba(95,211,138,.35);background:linear-gradient(180deg,rgba(24,78,57,.10) 0%,rgba(17,55,40,.075) 100%)}
.tc-err{margin-top:12px;border:1px solid rgba(232,65,66,.35);background:linear-gradient(180deg,rgba(118,28,36,.13) 0%,rgba(92,22,30,.10) 100%);border-radius:10px;padding:10px 12px;font-size:12.5px;color:#f2b8b5;line-height:1.5;text-shadow:1px 0 0 rgba(25,3,5,.9),-1px 0 0 rgba(25,3,5,.9),0 1px 0 rgba(25,3,5,.9),0 -1px 0 rgba(25,3,5,.9),0 0 2px rgba(25,3,5,.92),0 0 4px rgba(25,3,5,.5),0 1px 2px rgba(10,1,2,.9)}
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
@keyframes tcPulse{0%,100%{box-shadow:inset 0 1px 0 rgba(255,255,255,.45),inset 0 -3px 6px rgba(0,35,55,.55),0 5px 16px rgba(0,0,0,.5),0 0 0 0 rgba(0,240,255,0),0 8px 26px rgba(0,240,255,.3)}50%{box-shadow:inset 0 1px 0 rgba(255,255,255,.45),inset 0 -3px 6px rgba(0,35,55,.55),0 5px 16px rgba(0,0,0,.5),0 0 0 7px rgba(0,240,255,.12),0 8px 40px rgba(0,240,255,.6)}}
@keyframes tcScan{0%{background-position:0 0}100%{background-position:200px 0}}
@media (max-width:767px){
  .tc-page{overflow-y:auto;overflow-x:hidden}
  /* Breathing room: the console FLOATS in the portal scene — margins above and
     below (the astronaut stays visible around the card, never edge-to-edge). */
  .tc-scroll{height:auto;min-height:100vh;min-height:100dvh;align-items:flex-start;padding:44px 18px 60px}
  .tc-shell-wrap{width:100%;margin:0}
  /* Astronaut composition on PORTRAIT phones — OPEN FRAMING (2026-09-04 pass):
     the earlier ~170% zoom cropped the figure down to body/legs; the video now
     renders at near-natural scale (~1.1-1.3x depending on phone height) so the
     FULL astronaut figure, the portal ring, the cyan aura and the surrounding
     space all sit in frame, with the subject biased slightly below center so it
     still floats in the open portal beneath the console. The band shows the
     middle ~90% of the footage vertically (rows ~5-95%) — nothing important is
     cropped, and the drifting loop + transparency are untouched. */
  .tc-bg video,.tc-bg img{top:-7%;height:114%;object-position:50% 42%}
  .tc-scrim{background:linear-gradient(180deg,rgba(2,5,10,.52) 0%,rgba(2,5,10,.27) 26%,rgba(2,5,10,.28) 52%,rgba(2,5,10,.32) 76%,rgba(2,4,9,.44) 100%)}
  .tc-portal{top:76%;width:min(1080px,152vw);height:min(1080px,152vw)}
  .tc-halo{inset:-26px}
  .tc-bolt{width:11px;height:11px}
  .tc-coords{flex-direction:column;gap:8px}
  .tc-arrow{transform:rotate(90deg);align-self:center;margin:-2px 0;font-size:18px;animation:tcTravelY 1.6s ease-in-out infinite}
  .tc-body{padding:12px 12px 16px}
  .tc-header{padding:10px 12px 8px}
  .tc-tabs{padding:0 12px}
  .tc-title{font-size:13px}
  .tc-amount{font-size:26px}
}
/* LANDSCAPE PHONES / SHORT VIEWPORTS (2026-09-04 pass) — the enhanced
   cinematic view. Rotating the phone reflows the console: the coordinates go
   back to a HORIZONTAL row (wider, more centered, readable on the short
   axis), the shell is centered and the page scrolls only as needed, and the
   astronaut footage — which IS landscape — shows FULLER/UNCROPPED: the
   horizontal crop that portrait forces (a narrow vertical slice of the wide
   shot) disappears, revealing the complete astronaut-in-portal composition
   at near-natural scale. Portrait stays the primary/default layout; this
   block ONLY reframes when the device is actually rotated (both axes
   required: landscape orientation AND a short viewport, so desktop wide
   screens are untouched). The moving loop + transparency are unchanged. */
@media (orientation:landscape) and (max-height:640px){
  .tc-page{overflow-y:auto;overflow-x:hidden}
  .tc-scroll{height:auto;min-height:100vh;min-height:100dvh;align-items:flex-start;justify-content:center;padding:12px 16px 20px}
  .tc-shell-wrap{width:min(720px,94vw);margin:0 auto}
  .tc-halo{inset:-36px}
  /* The wide shot, full width: the video is scaled by WIDTH here (it matches
     the phone's own landscape orientation), so the horizontal crop that
     portrait forces is gone — the whole astronaut-in-portal scene shows. */
  .tc-bg video,.tc-bg img{left:0;right:auto;top:50%;width:100%;height:132%;object-position:50% 50%;transform:translateY(-50%)}
  .tc-scrim{background:linear-gradient(180deg,rgba(2,5,10,.5) 0%,rgba(2,5,10,.22) 26%,rgba(2,5,10,.26) 55%,rgba(2,4,9,.6) 100%)}
  .tc-portal{top:52%;width:min(1080px,115vw);height:min(1080px,115vw)}
  .tc-coords{flex-direction:row;gap:10px}
  .tc-arrow{transform:none;align-self:center;margin:0;font-size:20px;animation:tcTravel 1.6s ease-in-out infinite}
  .tc-header{padding:8px 16px 6px}
  .tc-body{padding:10px 16px 14px}
  .tc-tabs{padding:0 16px}
  .tc-title{font-size:13px}
  .tc-subheader{font-size:9.5px}
  .tc-amount{font-size:24px}
  .tc-bolt{width:11px;height:11px}
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

/** The ambient astronaut layer: the drifting VIDEO everywhere — desktop AND
 *  mobile. The static unlock is `autoPlay muted loop playsInline` (all four
 *  present); the imperative engine below covers the REAL-WORLD stalls that
 *  leave a phone stuck on a frozen frame:
 *   1. a second play() once metadata arrives (engines that reject the first
 *      autoplay before the resource is ready);
 *   2. resume when the tab becomes visible again (mobile Safari suspends
 *      media in backgrounded tabs and doesn't always restart it);
 *   3. one user-gesture retry (WebViews / stricter engines that block even
 *      muted autoplay until the first interaction);
 *   4. the poster attribute is DROPPED as soon as the first frame plays — a
 *      stale poster can never sit on top of live video (poster is only the
 *      pre-load placeholder now). The reduced-motion <img> still (a11y) and
 *      an all-sources-failed fallback are the ONLY poster states left.
 *  Pure presentational; the video paints the astronaut sharp behind the card.
 */
function AstronautBackdrop() {
  const [usePoster, setUsePoster] = useState(() => prefersReducedMotion());
  const [videoLive, setVideoLive] = useState(false); // first frame rendered
  const videoRef = useRef(null);

  // Reduced-motion preference: the poster still replaces the video (a11y).
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const rmq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setUsePoster(prefersReducedMotion());
    rmq.addEventListener?.("change", update);
    return () => rmq.removeEventListener?.("change", update);
  }, []);

  // Playback engine — only meaningful in a real browser (jsdom unit runs
  // have no media pipeline; navigator.userAgent contains "jsdom").
  useEffect(() => {
    if (usePoster) return undefined;
    const v = videoRef.current;
    if (!v || typeof v.play !== "function") return undefined;
    if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent)) return undefined;
    let alive = true;
    let metaRetried = false;
    const tryPlay = () => {
      if (!alive || !v.paused) return;
      try {
        const p = v.play();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        /* autoplay policy — the gesture retry below is the unlock */
      }
    };
    tryPlay();
    const onMeta = () => {
      if (!metaRetried) {
        metaRetried = true;
        tryPlay();
      }
    };
    const onVis = () => {
      if (!document.hidden) tryPlay();
    };
    const unlock = () => tryPlay();
    v.addEventListener("loadedmetadata", onMeta);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => {
      alive = false;
      v.removeEventListener("loadedmetadata", onMeta);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointerdown", unlock);
    };
  }, [usePoster]);

  const posterSrc = "/assets/teleporter-astronaut-poster.jpg";
  return (
    <div className="tc-bg" aria-hidden="true">
      {usePoster ? (
        <img src={posterSrc} alt="" data-testid="console-poster" />
      ) : (
        <video
          ref={videoRef}
          data-testid="console-video"
          autoPlay
          muted
          loop
          playsInline
          poster={videoLive ? undefined : posterSrc}
          preload="auto"
          aria-hidden="true"
          onPlaying={() => setVideoLive(true)}
          onError={() => setUsePoster(true)}
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
  if (phase === "deposit") return "DEPOSIT";
  if (phase === "tracking" || phase === "relaying" || phase === "step2") return "IN FLIGHT";
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
  // from: an EVM chain | a native chain (btc/doge/ltc/xrp — THORChain rail)
  //       | "x1" (reverse). The rail is derived (pickRail) — never chosen.
  const [from, setFrom] = useState("eth");
  const [to, setTo] = useState("eth"); // reverse destination (EVM chains)
  const [token, setToken] = useState("USDC"); // the SOURCE token
  const [x1Token, setX1Token] = useState("USDC.x"); // forward: land-as on X1 (EVM sources)
  const [toToken, setToToken] = useState("USDC"); // reverse: receive on the EVM destination
  const [amount, setAmount] = useState("");
  const direction = from === "x1" ? "reverse" : "forward";
  // THE RAIL DECISION (post-pick, pre-execution — invisible to the user):
  // native sources → the THORChain engine path (deposit-address execution);
  // EVM/X1 sources → the LiFi/Warp engine path (wallet-connect execution).
  const railMeta = pickRail({ fromChain: from });
  const rail = railMeta.rail;
  const nativeMeta = isNativeChain(from) ? NATIVE_CHAINS[from] : null;
  const nativeAsset = nativeMeta ? nativeMeta.asset : null;

  // ── Flow state (mirrors TeleportForm's phase machine exactly; the native
  //    deposit-address rail adds two phases — "deposit" (the vault-address +
  //    memo + txid step) and "tracking" (the hop progress tracker)):
  //    idle|quoting|quoted|bridging|step2|relaying|handoff|done|deposit|tracking ──
  const [phase, setPhase] = useState("idle");
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
  const [connecting, setConnecting] = useState(false);
  const [seqVisible, setSeqVisible] = useState(false);
  const [sourceBalance, setSourceBalance] = useState(null); // { balance, symbol, usd } | null
  // True when the LATEST balance read failed (transport/HTTP) — the readout
  // shows "BAL —" plus a cheap ↻ retry instead of a silent dead read. Cleared
  // at the start of every read and on reset.
  const [balanceFailed, setBalanceFailed] = useState(false);
  // Native-rail hop (the THORChain engine path — deposit → tracking): the
  // submit payload from the deposit step, fed to the progress tracker.
  const [hop, setHop] = useState(null); // { inboundTxid, sourceChain, destination, expectedAmountOut } | null

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
    setBalanceFailed(false);
    setHop(null);
  }, []);

  const changeFrom = useCallback((c) => {
    setFrom(c);
    if (c === "x1") {
      // Reverse: source becomes an X1 token, destination an EVM chain.
      setToken((prev) => (tokensOn("x1").includes(prev) ? prev : "USDC.x"));
      setTo("eth");
      setToToken((prev) => (tokensOn("eth").includes(prev) ? prev : "USDC"));
    } else if (isNativeChain(c)) {
      // Native source (BTC/DOGE/LTC/XRP) → the deposit-address rail, dest X1.
      // The rail lands USDC.x on X1 (the auto-advance's Warp leg) — the
      // land-as choice is fixed for this rail (no token picker ambiguity).
      setToken(NATIVE_CHAINS[c].asset);
      setTo("x1");
      setToToken((prev) => (tokensOn("eth").includes(prev) ? prev : "USDC"));
    } else {
      // Forward: source is an EVM stable that exists on the chain; dest = X1.
      setToken((prev) => (tokensOn(c).includes(prev) ? prev : Object.keys(TOKENS[c] || {})[0] || "USDC"));
      setTo("x1");
    }
    setQuote(null); setError(null); setPhase("idle"); setWarpSig(null); setStage1Hash(null);
    setConfirmMode(false); setReverseStage(0); setHandoffReason(null); setHop(null);
  }, []);

  const changeTo = useCallback((c) => {
    setTo(c);
    setToToken((prev) => (tokensOn(c).includes(prev) ? prev : Object.keys(TOKENS[c] || {})[0] || "USDC"));
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

  // ── Source-balance read (the "BAL" readout + MAX). Live reads, the same
  //    fetchers/fallbacks the site uses. Fail-soft: "—", never blocks.
  //    NATIVE sources (BTC/DOGE/LTC/XRP — the deposit-address rail) read the
  //    connected source-family session's address through the wallet layer's
  //    OWN public-chain fetchers (mempool.space / LitecoinSpace / BlockCypher
  //    / XRPL — bitcoinBalance/altcoinBalance/xrpBalance), spendable-only
  //    (confirmed, never pending) so BAL + MAX can never count funds that
  //    aren't spendable yet. No native session connected → no read (the
  //    honest "BAL —"); a failed read is a dead readout + the cheap ↻
  //    retry, never a block. ─
  const balanceDeps = formProps.balancesDeps || {};
  const evmBalanceFetcher = balanceDeps.evmBalanceFetcher || fetchEvmTokenBalance;
  const svmBalanceFetcher = balanceDeps.solBalanceFetcher || fetchSvmTokenBalances;
  const priceFetcher = balanceDeps.priceFetcher || getPricesUSD;
  const resolveEvmProviderFn = balanceDeps.resolveEvmProviderFn || resolveEvmProvider;
  // Per-family NATIVE fetchers — DI-able for tests, the REAL wallet-layer
  // fetchers by default (spendable/confirmed reads). Held in a ref so the
  // per-render defaults never churn the read effect's dependency list; the
  // effect re-runs on route/session/refresh changes and always sees the
  // latest fetchers.
  const nativeFetchersRef = useRef(null);
  nativeFetchersRef.current = {
    bitcoin: balanceDeps.bitcoinBalanceFetcher || createBtcBalanceFetcher({ spendableOnly: true }),
    litecoin: balanceDeps.litecoinBalanceFetcher || createLtcBalanceFetcher({ spendableOnly: true }),
    dogecoin: balanceDeps.dogecoinBalanceFetcher || createDogeBalanceFetcher({ spendableOnly: true }),
    // The XRPL account_info Balance is already the confirmed/spendable read.
    xrp: balanceDeps.xrpBalanceFetcher || createXrpBalanceFetcher(),
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setSourceBalance(null);
      setBalanceFailed(false);
      // Which source does the readout read? Forward: the EVM source wallet
      // (LiFi/Warp rail) OR the connected NATIVE source-family session
      // (BTC/DOGE/LTC/XRP — the deposit-address rail; the send itself is
      // out-of-band, but a connected source wallet makes the read live);
      // reverse: the X1 (Solana session) balance. No matching session → no
      // read — the honest "BAL —".
      const nativeFamily = direction === "forward" && nativeMeta ? nativeMeta.family : null;
      const nativeAddr = nativeFamily ? sessions[nativeFamily]?.address : null;
      const evmAddr = evmSession?.address;
      const solAddr = solSession?.address;
      if (!evmAddr && !solAddr && !nativeAddr) return;
      let priceMap = null;
      try { priceMap = await priceFetcher(); } catch { priceMap = null; }
      try {
        if (nativeFamily && nativeAddr) {
          // Native source: the wallet layer's public-chain fetcher for the
          // family resolves base units (sats/drops); the readout divides by
          // the chain's own decimals. Spendable-only fetchers (confirmed,
          // not pending) keep BAL and the MAX fill honest.
          const fetcher = nativeFetchersRef.current?.[nativeFamily];
          if (!fetcher) { if (!cancelled) setBalanceFailed(true); return; }
          const baseUnits = await fetcher(nativeAddr);
          if (cancelled) return;
          const human = baseUnits / 10 ** nativeMeta.decimals;
          const price = priceMap?.[nativeMeta.asset];
          setSourceBalance(Number.isFinite(human) && human >= 0
            ? { balance: human, symbol: nativeMeta.asset, usd: price != null ? human * price : null }
            : null);
        } else if (direction === "forward" && evmAddr && TOKENS[from]?.[token]) {
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
        if (!cancelled) { setSourceBalance(null); setBalanceFailed(true); } // fail-soft: "BAL —" + ↻ retry
      }
    };
    load();
    return () => { cancelled = true; };
  }, [direction, from, token, evmSession, solSession, sessions, nativeMeta, balanceRefresh, evmBalanceFetcher, svmBalanceFetcher, priceFetcher, resolveEvmProviderFn]);

  const maxFromBalance = () => {
    if (!sourceBalance || !(sourceBalance.balance > 0)) return;
    // Native assets carry their own base-unit decimals (BTC/LTC/DOGE 8, XRP
    // 6 — NATIVE_CHAINS); EVM/X1 tokens read their registered decimals.
    const decimals = nativeMeta?.decimals ?? TOKENS[from]?.[token]?.decimals ?? (token === "wSOL.X" ? 9 : 6);
    const trimmed = sourceBalance.balance.toFixed(Math.min(decimals, 6)).replace(/\.?0+$/, "");
    changeAmount(trimmed);
  };

  // ── THE REAL QUOTE PATH (forward + reverse — same builders the classic
  //    form uses; no fakes) ─────────────────────────────────────────────────
  const runQuote = useCallback(async () => {
    // The native deposit-address rail never quotes over LiFi — its quote gate
    // lives in the deposit step (THORChainDeposit). TELEPORT on that rail
    // routes straight to the deposit-address step instead of runQuote.
    if (rail === RAIL.THORCHAIN) return;
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
  }, [amount, direction, from, to, token, x1Token, toToken, rail, evmReady, solReady, evmSession, solSession]);

  // Auto-quote: route/amount edits (debounced) re-quote when idle. The
  // native deposit-address rail has no LiFi quote to fetch (its quote gate
  // is the deposit step's own) — never auto-fire it.
  useEffect(() => {
    if (phase !== "idle") return;
    if (rail === RAIL.THORCHAIN) return;
    const amt = parseFloat(amount);
    if (!amount || !(amt > 0)) return;
    const t = setTimeout(() => { runQuote(); }, debounceMs);
    return () => clearTimeout(t);
  }, [amount, from, to, token, x1Token, toToken, direction, rail, evmReady, solReady, phase, runQuote, debounceMs]);

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
    // THE DEPOSIT-ADDRESS-vs-WALLET-CONNECT DECISION POINT: the rail was
    // picked (invisibly) the moment the source asset was chosen; TELEPORT
    // now routes the user into the right FINAL EXECUTION step:
    //   - native sources (THORChain rail)   → the deposit-address step
    //     (vault address + memo + txid — send out-of-band, no signing),
    //   - EVM/X1 sources (LiFi/Warp rail)   → wallet-connect sign stages
    //     (quote first, then the engine stage runners below).
    if (rail === RAIL.THORCHAIN) {
      setPhase("deposit");
      return;
    }
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

  // ── Deposit-address rail (native sources — THORChain engine path) ────────
  // Storage: same persisted-hop store the classic THORChain tab uses (the
  // progress tracker writes its stages into it; closed-tab resume is the
  // classic tab's job — the console keeps the store handle shared so the
  // tracker's "saved on close" semantics hold within a journey).
  const depositStoreRef = useRef(null);
  if (!depositStoreRef.current) depositStoreRef.current = createThorchainStorage();
  const depositDeps = consoleProps.depositDeps || {};
  // Source-family sessions prefill the deposit step's refund address (the
  // wallet layer's deposit rows for BTC/DOGE/LTC/XRP — same read as the
  // classic THORChain tab).
  const sourceSessions = useMemo(() => {
    const session = (s) => (s?.status === "connected" ? { address: s.address ?? null } : null);
    return {
      bitcoin: session(sessions.bitcoin),
      litecoin: session(sessions.litecoin),
      dogecoin: session(sessions.dogecoin),
      xrp: session(sessions.xrp),
    };
  }, [sessions]);

  // Deposit-step submit → persist the hop (resume parity with the classic
  // lane) and advance to the tracking phase.
  const handleDepositSubmit = useCallback((payload) => {
    if (!payload?.inboundTxid) return;
    setHop(payload);
    try {
      depositStoreRef.current.saveHop({
        inboundTxid: payload.inboundTxid,
        stage: "observed",
        payload,
      });
    } catch { /* storage failure must never block the flow */ }
    setPhase("tracking");
  }, []);

  // Tracking-phase arrival → the console's done panel (progress stays mounted
  // until then — it removes the hop from storage on success itself).
  const handleTrackingState = useCallback((s) => {
    if (s?.phase === "arrived") setPhase("done");
  }, []);

  // Native-SOL balance reader for the tracking phase's landing detection
  // (created once per connected address, like the classic tab).
  const getSolBalance = useMemo(() => {
    if (!solReady || !solSession?.address) return null;
    return createSolBalanceReader({ connection: depositDeps.connection });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solReady, solSession?.address]);

  const busy = phase === "bridging" || phase === "quoting" || step2Busy;
  const armed = phase === "quoted" && Boolean(quote);
  const tickerDisplay = useTicker(quote?.net ?? 0, { active: phase === "quoted" });
  const routeReadout = direction === "reverse" ? `X1 → ${chainName(to)}` : `${chainName(from)} → X1`;
  // The destination token the DONE readout names — the native rail always
  // lands USDC.x on X1 (its Warp leg is USDC.x-fixed); LiFi/Warp rails land
  // the chosen land-as/receive token.
  const doneTokenLabel = rail === RAIL.THORCHAIN ? "USDC.x" : (quote?.recvToken || x1Token);

  // Wallet guidance (which wallet the CURRENT route needs next).
  const missingWallets = [];
  if (rail === RAIL.THORCHAIN) {
    // The deposit-address rail needs ONLY the Solana/X1 wallet — the deposit
    // destination (funds land there before the X1 hop). The source send is
    // out-of-band from the user's own BTC/DOGE/LTC/XRP wallet — never asked
    // for in-app.
    if (!solReady) missingWallets.push("Solana/X1 (Phantom / Backpack) — where your deposit lands before X1");
  } else if (direction === "forward") {
    if (!evmReady) missingWallets.push("EVM (Rabby / MetaMask) — the source wallet");
    if (!solReady) missingWallets.push("Solana/X1 (Phantom / Backpack) — where it lands on X1");
  } else {
    if (!solReady) missingWallets.push("Solana/X1 (Phantom / Backpack) — the burn happens on X1");
    if (!evmReady) missingWallets.push("EVM (Rabby / MetaMask) — the destination wallet");
  }

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
            : <>✓ Bridge complete — {doneTokenLabel}{direction === "reverse" ? ` on ${CHAINS[quote?.to || to]?.name}` : " on X1"}.</>}
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
    if (rail === RAIL.THORCHAIN && amount && parseFloat(amount) > 0) {
      return (
        <div className="tc-strip-hint">
          <b>DEPOSIT ROUTE READY</b> — press TELEPORT to reveal your deposit
          address + memo; the network fees are shown before you send.
        </div>
      );
    }
    if (!amount || !(parseFloat(amount) > 0)) {
      return <div className="tc-strip-hint"><b>SET YOUR JOURNEY COORDINATES</b> — pick a source asset, destination and amount, then TELEPORT.</div>;
    }
    return <div className="tc-strip-hint"><b>ROUTE READY</b> — calculating…</div>;
  };

  return (
    <div className="tc-page" data-testid="teleport-console-page">
      <style data-console-css="1" dangerouslySetInnerHTML={{ __html: CONSOLE_CSS }} />
      <AstronautBackdrop />
      <div className="tc-scroll">
        <div className="tc-shell-wrap">
          <div className="tc-halo" aria-hidden="true" />
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
                  <span className="tc-subheader" style={{ opacity: 0.6 }}>{routeReadout}</span>
                </div>
              </div>

              {/* ONE UNIFIED FLOW — no rail tabs, no Buy tab (2026-09-04 UX
                  pass, Mr. Esters): the body below is the single surface —
                  pick what you have (the source-asset union), where it's
                  going, TELEPORT. The engine path is decided invisibly. */}
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

                  {phase === "deposit" ? (
                    /* ── DEPOSIT-ADDRESS FINAL STEP (native sources — the rail
                       decision landed here invisibly): the vault address + memo
                       + txid-paste step rendered by the shared deposit stage
                       with NEUTRAL copy (the rail is never named). ── */
                    <div className="tc-tab-body" data-testid="deposit-step" role="tabpanel" aria-label="Deposit step">
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 6 }}>
                        <span className="tc-sub" style={{ marginTop: 0 }} data-testid="deposit-step-context">
                          {nativeMeta ? `Sending ${nativeMeta.asset} from ${nativeMeta.name} → X1` : "Deposit route"}
                        </span>
                        <button type="button" data-testid="back-to-route" className="tc-ghost" style={{ width: "auto", padding: "4px 12px", marginTop: 0 }} onClick={() => setPhase("idle")}>
                          ← Adjust route
                        </button>
                      </div>
                      <THORChainDeposit
                        solAddress={solSession?.address ?? null}
                        solConnected={solReady}
                        sourceSessions={sourceSessions}
                        onSubmit={handleDepositSubmit}
                        createInboundRefresher={depositDeps.createInboundRefresher}
                        inboundBaseUrl={depositDeps.inboundBaseUrl}
                        fetchImpl={depositDeps.fetchImpl}
                        refreshIntervalMs={depositDeps.refreshIntervalMs}
                        qrFactory={depositDeps.qrFactory}
                        fetchQuote={depositDeps.fetchQuote}
                        maxSwapBtcEquivalent={depositDeps.maxSwapBtcEquivalent}
                        btcEquivalentRates={depositDeps.btcEquivalentRates}
                        initialSource={nativeAsset}
                        sourceLocked
                        initialAmount={amount}
                        copy={DEPOSIT_NEUTRAL_COPY}
                      />
                    </div>
                  ) : phase === "tracking" ? (
                    /* ── HOP TRACKING (the deposit was sent out-of-band; the
                       tracker polls the network, watches the landing, and
                       auto-advances the hop into X1). ── */
                    <div className="tc-tab-body" data-testid="tracking-step" role="tabpanel" aria-label="Hop tracking">
                      {hop && (
                        <THORChainProgress
                          hop={hop}
                          storage={depositStoreRef.current}
                          createPoller={depositDeps.createPoller}
                          createLandingWatcher={depositDeps.createLandingWatcher}
                          advance={depositDeps.advance}
                          getSolBalance={getSolBalance}
                          solAddress={solSession?.address ?? null}
                          solWallet={solSession?.provider ? { provider: solSession.provider } : null}
                          connection={depositDeps.connection}
                          fetchImpl={depositDeps.fetchImpl}
                          statusBaseUrl={depositDeps.statusBaseUrl}
                          pollIntervalMs={depositDeps.pollIntervalMs}
                          pollMaxMs={depositDeps.pollMaxMs}
                          landingIntervalMs={depositDeps.landingIntervalMs}
                          landingMaxMs={depositDeps.landingMaxMs}
                          tolerance={depositDeps.tolerance}
                          onStateChange={handleTrackingState}
                          copy={TRACKING_NEUTRAL_COPY}
                        />
                      )}
                      <button data-testid="reset" className="tc-ghost" onClick={reset}>Done / bridge again</button>
                    </div>
                  ) : (
                    <>

                  {/* Route coordinates — FROM → TO (the source picker is the
                      union of every engine rail's assets: EVM-chain stables,
                      native BTC/DOGE/LTC/XRP, and X1's tokens for the reverse
                      off-ramp. The rail itself is never shown.) */}
                  <div className="tc-coords" data-testid="console-coords" style={{ marginTop: 12 }}>
                    <div className="tc-slot tc-slot-grow" data-testid="from-slot">
                      <span className="tc-label">From chain</span>
                      <select data-testid="from-chain" value={from} onChange={(e) => changeFrom(e.target.value)} className="tc-select" aria-label="From chain">
                        {SOURCE_CHAINS.map((c) => (
                          <option key={c} value={c}>{chainGlyph(c)} {chainName(c)}</option>
                        ))}
                      </select>
                      {direction === "forward" && (
                        <span className="tc-sub">source · {token} on {chainName(from)}</span>
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
                            <option value="x1">X1 {chainGlyph("x1")}</option>
                          </select>
                          <span className="tc-sub">{rail === RAIL.THORCHAIN ? "destination · arrives as USDC.x on X1" : `destination · land as ${x1Token}`}</span>
                        </>
                      ) : (
                        <>
                          <select data-testid="to-chain" value={to} onChange={(e) => changeTo(e.target.value)} className="tc-select" aria-label="To chain">
                            {SOURCE_CHAINS.filter((c) => !isNativeChain(c) && c !== "x1").map((c) => (
                              <option key={c} value={c}>{chainGlyph(c)} {chainName(c)}</option>
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
                        <select data-testid="token" value={token} onChange={(e) => changeToken(e.target.value)} className="tc-select" aria-label="Token" disabled={Boolean(nativeMeta)}>
                          {tokensOn(from).map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      ) : (
                        <select data-testid="token" value={token} onChange={(e) => changeToken(e.target.value)} className="tc-select" aria-label="Token to burn on X1">
                          {tokensOn("x1").map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      )}
                    </div>
                    {direction === "forward" && !nativeMeta && (
                      <div className="tc-slot" style={{ flex: "0 0 auto", minWidth: 120 }} data-testid="x1-token-slot">
                        <span className="tc-label">Land as</span>
                        <select data-testid="x1-token" value={x1Token} onChange={(e) => changeX1Token(e.target.value)} className="tc-select" aria-label="Token on X1">
                          {tokensOn("x1").map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                    )}
                    {direction === "reverse" && (
                      <div className="tc-slot" style={{ flex: "0 0 auto", minWidth: 120 }} data-testid="to-token-slot">
                        <span className="tc-label">Receive</span>
                        <select data-testid="to-token" value={toToken} onChange={(e) => changeToToken(e.target.value)} className="tc-select" aria-label="Receive token">
                          {tokensOn(to).map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                    )}
                    <div className="tc-slot tc-slot-grow" style={{ flex: 2 }} data-testid="amount-slot">
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className="tc-label" style={{ marginBottom: 0 }}>Amount</span>
                        <span style={{ flex: 1 }} />
                        <span className="tc-sub" style={{ marginTop: 0, display: "inline-flex", alignItems: "center", gap: 6 }} data-testid="source-balance">
                          {sourceBalance ? <>BAL {formatBalance(sourceBalance.balance)} {sourceBalance.symbol}{sourceBalance.usd != null ? ` ($${sourceBalance.usd.toFixed(2)})` : ""}</> : "BAL —"}
                          {balanceFailed && (
                            <button type="button" data-testid="balance-retry" className="tc-bal-retry" title="Balance read failed — retry" aria-label="Retry balance read" onClick={() => setBalanceRefresh((n) => n + 1)}>↻</button>
                          )}
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
                      {phase === "quoting"
                        ? "CALCULATING ROUTE…"
                        : phase === "quoted" || (rail === RAIL.THORCHAIN && amount && parseFloat(amount) > 0)
                          ? "◉ TELEPORT"
                          : "TELEPORT"}
                    </button>
                  )}

                  {phasePanel()}
                    </>
                  )}
                </div>
            </div>
          </div>
          {/* Corner hardware — the bezel's mounting bolts (visual only). */}
          <span className="tc-bolt tc-bolt-nw" aria-hidden="true" />
          <span className="tc-bolt tc-bolt-ne" aria-hidden="true" />
          <span className="tc-bolt tc-bolt-sw" aria-hidden="true" />
          <span className="tc-bolt tc-bolt-se" aria-hidden="true" />
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
