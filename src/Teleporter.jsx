import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";

/**
 * TELEPORTER — any-chain → any-chain stablecoin aggregator + X1 on-ramp
 *
 * This is a UI shell wired to the real Teleporter routing model:
 *   routeType: 'direct' | 'x1' | 'x1_reverse' | 'sol_x1'
 *
 * It is FRONT-END ONLY and safe to click through with no wallet:
 *   - "Demo mode" (default) simulates quotes + the bridge animation so you can
 *     test the whole flow visually without LiFi keys or a live Warp Bridge.
 *   - When you wire the real backend, replace the functions marked  // <<< WIRE
 *     with calls to your /api/lifi/* proxy and the Warp Bridge instruction.
 *
 * Nothing here signs or moves funds. The Warp Bridge program ID + discriminator
 * are still UNVERIFIED — do not point this at mainnet money until the $1 capture
 * test confirms them.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG  (mirrors server.js — the canonical-ish token table)
// ─────────────────────────────────────────────────────────────────────────────

// ── FLAGS (must be defined BEFORE CHAINS/TOKENS, which reference them) ──
// DEMO_MODE: simulate quotes with no backend. Flip false when proxy is live.
const DEMO_MODE = false;
// ENABLE_TRON: website-only Tron support, bolt-on later. Flip true when ready.
const ENABLE_TRON = false;

const CHAINS = {
  x1:    { id: "x1",    name: "X1",          lifiKey: null,  chainId: null,  walletType: "solana", color: "#5B9DFF", glyph: "X1" },
  eth:   { id: "eth",   name: "Ethereum",    lifiKey: "eth", chainId: 1,     walletType: "evm",    color: "#627EEA", glyph: "Ξ" },
  bsc:   { id: "bsc",   name: "BNB Chain",   lifiKey: "bsc", chainId: 56,    walletType: "evm",    color: "#F0B90B", glyph: "B" },
  sol:   { id: "sol",   name: "Solana",      lifiKey: "SOL", chainId: "SOL", walletType: "solana", color: "#9945FF", glyph: "◎" },
  arb:   { id: "arb",   name: "Arbitrum",    lifiKey: "arb", chainId: 42161, walletType: "evm",    color: "#28A0F0", glyph: "A" },
  bas:   { id: "bas",   name: "Base",        lifiKey: "bas", chainId: 8453,  walletType: "evm",    color: "#0052FF", glyph: "□" },
  opt:   { id: "opt",   name: "Optimism",    lifiKey: "opt", chainId: 10,    walletType: "evm",    color: "#FF0420", glyph: "O" },
  pol:   { id: "pol",   name: "Polygon",     lifiKey: "pol", chainId: 137,   walletType: "evm",    color: "#8247E5", glyph: "⬡" },
  avax:  { id: "avax",  name: "Avalanche",   lifiKey: "ava", chainId: 43114, walletType: "evm",    color: "#E84142", glyph: "▲" },
  sonic: { id: "sonic", name: "Sonic",       lifiKey: "son", chainId: 146,   walletType: "evm",    color: "#5BC8F5", glyph: "S" },
  // TRON — gated. walletType 'tron' needs a TronLink connector (window.tronLink)
  // and TVM sign path. LiFi routes Tron, so quotes work; signing is the add.
  ...(ENABLE_TRON ? {
    tron: { id: "tron", name: "Tron", lifiKey: "tron", chainId: "TRON", walletType: "tron", color: "#EF0027", glyph: "T" },
  } : {}),
};

const TOKENS = {
  eth:   { USDC: { decimals: 6, address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }, USDT: { decimals: 6, address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" }, DAI: { decimals: 18, address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" } },
  bsc:   { USDC: { decimals: 18, address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" }, USDT: { decimals: 18, address: "0x55d398326f99059fF775485246999027B3197955" }, DAI: { decimals: 18, address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3" } },
  sol:   { USDC: { decimals: 6, address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, USDT: { decimals: 6, address: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" } },
  arb:   { USDC: { decimals: 6, address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" }, USDT: { decimals: 6, address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" }, DAI: { decimals: 18, address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" } },
  bas:   { USDC: { decimals: 6, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, DAI: { decimals: 18, address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb" } },
  opt:   { USDC: { decimals: 6, address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" }, USDT: { decimals: 6, address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" }, DAI: { decimals: 18, address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1" } },
  pol:   { USDC: { decimals: 6, address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" }, USDT: { decimals: 6, address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F" }, DAI: { decimals: 18, address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063" } },
  avax:  { USDC: { decimals: 6, address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" }, USDT: { decimals: 6, address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7" }, DAI: { decimals: 18, address: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70" } },
  sonic: { USDC: { decimals: 6, address: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894" }, USDT: { decimals: 6, address: "0xE5DA20F15420aD15DE0fa650600aFc998bbE3955" } },
  x1:    { "USDC.x": { decimals: 6, address: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq" } }, // X1 USDC.x (Token-2022 burn mint)
  // TRON tokens — USDT is the headline (huge volume). TRC-20 addresses.
  ...(ENABLE_TRON ? {
    tron: {
      USDT: { decimals: 6, address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
      USDC: { decimals: 6, address: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8" },
    },
  } : {}),
};


// ── PERSISTENCE ──
// Uses localStorage in a real deployment; falls back to an in-memory store in
// sandboxes/artifacts where storage is blocked. Same API either way.
const memStore = {};
const store = {
  get(key) {
    try {
      if (typeof localStorage !== "undefined") {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : null;
      }
    } catch { /* fall through */ }
    return memStore[key] ?? null;
  },
  set(key, val) {
    try {
      if (typeof localStorage !== "undefined") { localStorage.setItem(key, JSON.stringify(val)); return; }
    } catch { /* fall through */ }
    memStore[key] = val;
  },
  del(key) {
    try {
      if (typeof localStorage !== "undefined") { localStorage.removeItem(key); return; }
    } catch { /* fall through */ }
    delete memStore[key];
  },
};
const HISTORY_KEY = "teleporter.history";
const PENDING_KEY = "teleporter.pending";

const FEE = { flat: 1, pct: 0.01, threshold: 100 }; // legacy display model (unused once LiFi fee is live)

// ── LiFi integrator config ──
// IMPORTANT: INTEGRATOR must be your registered LiFi integrator string for fees
// to actually collect to your account. INTEGRATOR_FEE is a float: 0.01 = 1%.
// Fees are withdrawn later via /v1/integrators/{INTEGRATOR}/withdraw/{chainId}.
const INTEGRATOR = "x1-teleporter-labs"; // registered LiFi integrator string
const INTEGRATOR_FEE = 0.01;     // 1% — LiFi max is 10% (0.10)
// Proxy base — Vercel serves /api/* as serverless functions on the same origin.
const API_BASE = "";

// ── Warp Bridge (Solana ↔ X1) — VERIFIED from live mainnet tx ──
// Program 6JbPTuxVuoTgyQeXFb9MH8C8nUY8NBbLP1Lu4B13JfMD, instruction BridgeOut.
// The bridge charges a FLAT 1 USDC fee (hardcoded, not %), and rejects bridges
// under $10. We skim our 1% BEFORE the bridge, so the post-skim amount must
// still clear Warp's $10 floor. Hence a $25 minimum into X1 (after 1% = $24.75,
// safely above $10 even if the LiFi leg lands a little short).
const WARP_FLAT_FEE = 1;     // USDC, charged by the Warp bridge itself
const WARP_MIN = 10;         // Warp rejects bridges below this (USDC)
// Minimum into X1. 25 (post-1%-skim must clear Warp's $10 floor with a buffer
// for LiFi slippage on the EVM->X1 path). $25 post-skim = $24.75, safely above
// Warp's $10 floor even if the LiFi leg lands a little short.
const X1_MIN = 25;
// $25 minimum BOTH directions (in and out of X1). Out of X1 the $25 covers
// Warp's flat $1 fee + our 1% with room for a second LiFi leg if the user is
// bridging onward past Solana to another chain.
const X1_REVERSE_MIN = 25;
// WARP_LIVE gates the REAL Solana→X1 Warp execution (warpBridge.js).
// false (default) = stage 2 stays in safe demo animation; the real bridge code
// is NOT fired. Flip to true ONLY after runStage2({allowLive:false}) simulates
// clean against mainnet and you've confirmed the PDAs + seq. See STAGE2_README.
const WARP_LIVE = true;
// SECOND gate: even with WARP_LIVE true, this must ALSO be true to actually
// broadcast. ENABLED for operator mainnet validation — real bridge_out fires.
const WARP_LIVE_SEND = true;
// X1 HANDOFF MODE: when AUTO_X1_HOP is false, Teleporter hands users to the
// official Warp Bridge. TRUE = fire bridge_out ourselves (correct chain-
// discriminated seq) and let the official submitter auto-relay to X1.
// ENABLED for operator mainnet validation. Funds-at-risk: real bridge fires.
const AUTO_X1_HOP = true;
const WARP_BRIDGE_URL = "https://app.bridge.x1.xyz/";
// Solana RPC for the Warp leg. Use your own RPC for reliability in production.
// Solana RPC for reading on-chain state (seq counter) + sending the Warp hop.
// The PUBLIC endpoint (api.mainnet-beta.solana.com) rate-limits/403s account
// reads, so use a real RPC. Set VITE_SOLANA_RPC in your env to your own node
// (you run X1/Solana infra) or a provider (Helius/Triton/QuickNode/Alchemy).
const SOLANA_RPC =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_SOLANA_RPC) ||
  "https://berty-633y20-fast-mainnet.helius-rpc.com"; // Helius Secure URL (IP-rate-limited, no key exposed) — works without env var
// X1 mainnet RPC — the reverse (X1→Solana) burn happens on X1. The wallet
// broadcasts via its own RPC; this is for our reads/sim.
const X1_RPC =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_X1_RPC) ||
  "https://rpc.mainnet.x1.xyz";
// Your SVM fee wallet — where the Warp X1-hop 1% skim lands. (LiFi-collected
// fees go to the wallets you registered in the LiFi portal; this address is
// used ONLY for the pure Warp Solana→X1 skim that LiFi doesn't touch.)
const FEE_WALLET_SVM = "TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu"; // "tip" vanity SVM wallet

function calcFee(amountUsd) {
  const n = parseFloat(amountUsd);
  if (isNaN(n) || n <= 0) return 0;
  return n < FEE.threshold ? FEE.flat : n * FEE.pct;
}

// route type from a (from,to) pair — the core routing brain, mirrored
function determineRoute(from, to) {
  if (to === "x1") return from === "sol" ? "sol_x1" : "x1";
  if (from === "x1") {
    // X1 → Solana is a single Warp burn/release. X1 → any other chain is a
    // TWO-leg route: Warp burn (X1→Sol) then LiFi (Sol→destination).
    return to === "sol" ? "x1_reverse" : "x1_onward";
  }
  return "direct";
}

// Pre-quote advisory: flags combinations that are KNOWN to be thin on liquidity
// or route availability, so the user gets an instant heads-up instead of a quote
// failure. Returns null (route looks solid) or a short advisory string.
// This never BLOCKS — the quote still runs; it just sets expectations. USDC
// through the hub is always solid; the thin spots are non-USDC cross-VM hops.
function routeAdvisory(from, to, srcTok, dstTok, vmOf) {
  const rt = determineRoute(from, to);
  const crossVm = vmOf(from) !== vmOf(to);

  // USDC is the hub token — routes built on it are the best-supported. Any leg
  // that has to move a NON-USDC stable directly across the EVM<->Solana boundary
  // is the thin case (AllBridge/Mayan USDT support is chain-limited; DAI must be
  // DEX-swapped to USDC first, which needs liquidity on that chain).
  if (rt === "direct" && crossVm) {
    // Cross-VM direct (e.g. Solana<->BNB). The Solana side only has USDC/USDT.
    const solTok = from === "sol" ? srcTok : dstTok;
    if (solTok === "USDT") {
      return "USDT across Solana↔EVM can be thin — if the quote fails, try USDC.";
    }
  }
  // Into X1 from a non-USDC source, or out of X1 to a non-USDC dest: LiFi has to
  // DEX-swap on the EVM side. Solid on major chains; can be thin on smaller ones.
  const THIN_SWAP_CHAINS = new Set(["sonic", "avax"]);
  if (rt === "x1" && srcTok !== "USDC" && THIN_SWAP_CHAINS.has(from)) {
    return `${srcTok} on ${from.toUpperCase()} may have limited swap liquidity — USDC is most reliable into X1.`;
  }
  if (rt === "x1_onward" && dstTok !== "USDC" && THIN_SWAP_CHAINS.has(to)) {
    return `${dstTok} on ${to.toUpperCase()} may have limited swap liquidity — USDC is most reliable.`;
  }
  return null;
}


const ROUTE_LABEL = {
  direct:     "Direct bridge",
  x1:         "On-ramp to X1",
  x1_reverse: "Off-ramp from X1",
  x1_onward: "X1 → onward (2 hops)",
  sol_x1:     "Solana → X1",
};

function tokensFor(chain) {
  return Object.keys(TOKENS[chain] || {});
}

// ─────────────────────────────────────────────────────────────────────────────
//  ANIMATED BACKGROUND — lightweight canvas nebula (no Three.js dependency
//  so it runs anywhere; ~self-contained). Drifting particle field + glow.
// ─────────────────────────────────────────────────────────────────────────────

// Styles (defined before components that reference S)
const S = {
  root: { position: "relative", minHeight: "100vh", background: "#05070d", color: "#e8edf6", textShadow: "0 1px 6px rgba(0,0,0,0.7)",
    fontFamily: "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif", overflow: "hidden" },
  shell: { position: "relative", zIndex: 1, maxWidth: 620, margin: "0 auto", padding: "32px 20px 48px" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 22 },
  brand: { display: "flex", alignItems: "center", gap: 12 },
  brandMark: { width: 38, height: 38, borderRadius: 11, display: "grid", placeItems: "center",
    background: "linear-gradient(135deg,#2775E8,#5B9DFF)", color: "#ffffff", fontWeight: 800, fontSize: 15 },
  brandName: { fontWeight: 800, letterSpacing: 3, fontSize: 16 },
  brandSub: { fontSize: 11, color: "#7d8aa0", letterSpacing: 0.3 },
  walletBar: { display: "flex", gap: 8 },
  walletPill: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 999,
    background: "rgba(13,18,28,0.7)", border: "1px solid #28303f", color: "#e8edf6", cursor: "pointer" },
  dot: { width: 8, height: 8, borderRadius: 999 },
  routeBadge: { display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600,
    color: "#9aa6bb", padding: "6px 12px", borderRadius: 999, background: "rgba(13,18,28,0.6)",
    border: "1px solid #1d2433", marginBottom: 14 },
  routeDot: { width: 7, height: 7, borderRadius: 999 },
  twoStage: { marginLeft: 6, fontSize: 10, color: "#2775E8", border: "1px solid #1a3a6b",
    background: "rgba(39,117,232,0.08)", padding: "2px 7px", borderRadius: 999 },
  card: { background: "transparent", border: "1px solid rgba(39,117,232,0.25)", borderRadius: 20, padding: 22, boxShadow: "0 24px 80px rgba(0,0,0,0.5)" },
  fieldLabel: { fontSize: 11, color: "#7d8aa0", marginBottom: 6, fontWeight: 600, letterSpacing: 0.3 },
  selectWrap: { position: "relative" },
  select: { width: "100%", appearance: "none", background: "transparent", color: "#e8edf6",
    border: "1px solid #232c3c", borderRadius: 12, padding: "12px 14px", fontSize: 14, fontWeight: 600, cursor: "pointer" },
  // Option popups inherit the OS/browser default (white) unless styled. Give them
  // a dark background + light text so chain names are readable when the menu opens.
  opt: { background: "#0c1320", color: "#e8edf6" },
  amountInput: { width: "100%", boxSizing: "border-box", background: "transparent", color: "#e8edf6",
    border: "1px solid #232c3c", borderRadius: 12, padding: "12px 14px", fontSize: 18, fontWeight: 700, outline: "none" },
  swapBtn: { width: 42, height: 42, borderRadius: 12, background: "transparent", border: "1px solid #232c3c",
    color: "#2775E8", fontSize: 18, cursor: "pointer", marginBottom: 1 },
  vizWrap: { marginTop: 22, marginBottom: 4, padding: "8px 4px" },
  quoteBox: { marginTop: 10, background: "transparent", border: "1px solid #1a2130", borderRadius: 14, padding: "12px 14px" },
  maxBtn: { background: "rgba(39,117,232,0.1)", border: "1px solid #1a3a6b", color: "#2775E8",
    borderRadius: 6, padding: "1px 6px", fontSize: 10, fontWeight: 700, cursor: "pointer" },
  detailBox: { marginTop: 10, background: "transparent", border: "1px solid #1a2130", borderRadius: 14, padding: "12px 14px" },
  detailHead: { fontSize: 11, color: "#7d8aa0", marginBottom: 8, fontWeight: 600, letterSpacing: 0.3 },
  toolChip: { fontSize: 12, color: "#e8edf6", background: "transparent", border: "1px solid #1d2433",
    padding: "4px 9px", borderRadius: 8, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 },
  statusBox: { marginTop: 10, display: "flex", alignItems: "center", gap: 10, background: "transparent",
    border: "1px solid #1a2130", borderRadius: 14, padding: "12px 14px" },
  statusDot: { width: 10, height: 10, borderRadius: 999, flexShrink: 0 },
  recoverBanner: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12,
    background: "rgba(39,117,232,0.06)", border: "1px solid #1a3a6b", borderRadius: 14, padding: "12px 14px", marginBottom: 14 },
  recoverBtn: { background: "linear-gradient(90deg,#2775E8,#1B5FCC)", color: "#05070d", border: "none",
    borderRadius: 9, padding: "8px 14px", fontSize: 12, fontWeight: 800, cursor: "pointer" },
  recoverDismiss: { background: "transparent", color: "#7d8aa0", border: "1px solid #28303f",
    borderRadius: 9, padding: "8px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  historyPanel: { marginTop: 14, background: "transparent", border: "1px solid #1a2130",
    borderRadius: 20, padding: 18 },
  settingsPanel: { background: "transparent", border: "1px solid #1a2130",
    borderRadius: 20, padding: 18, marginBottom: 14 },
  slipBtn: { background: "transparent", border: "1px solid #232c3c", color: "#9aa6bb",
    borderRadius: 10, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer" },
  slipBtnActive: { background: "rgba(39,117,232,0.1)", borderColor: "#2775E8", color: "#2775E8" },
  slipInput: { width: 70, background: "transparent", border: "1px solid #232c3c", color: "#e8edf6",
    borderRadius: 10, padding: "8px 10px", fontSize: 13, fontWeight: 700, outline: "none", textAlign: "center" },
  histRow: { display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "10px 0", borderTop: "1px solid #141a26" },
  histStatus: { fontSize: 11, fontWeight: 700, border: "1px solid", borderRadius: 999, padding: "3px 9px", flexShrink: 0 },
  stepStrip: { display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" },
  stepChip: { fontSize: 11, color: "#9aa6bb", background: "transparent", border: "1px solid #1d2433",
    padding: "4px 9px", borderRadius: 999, fontWeight: 600 },
  cta: { width: "100%", padding: "15px", borderRadius: 14, border: "1px solid transparent",
    background: "linear-gradient(90deg,#2775E8,#1B5FCC)", color: "#05070d", fontSize: 15, fontWeight: 800,
    cursor: "pointer", letterSpacing: 0.3 },
  helper: { marginTop: 12, fontSize: 12, lineHeight: 1.5, color: "#9aa6bb", background: "rgba(39,117,232,0.05)",
    border: "1px solid #1a3a6b", borderRadius: 12, padding: "10px 12px" },
  foot: { textAlign: "center", fontSize: 11, color: "#475065", marginTop: 18, lineHeight: 1.5 },
  toast: { position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 10,
    background: "rgba(13,18,28,0.95)", border: "1px solid #28303f", borderRadius: 12, padding: "12px 18px",
    fontSize: 13, fontWeight: 600, boxShadow: "0 12px 40px rgba(0,0,0,0.5)" },
};

function PortalBackground() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let raf, w, h, t = 0;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

    const stars = [];
    function spawnStar(cx, cy, maxR) {
      // start near center with a random angle; warp outward
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * maxR * 0.15 + 4; // begin close to core
      return {
        angle,
        dist,
        speed: Math.random() * 0.6 + 0.4, // base radial speed factor
        len: 0,
        bright: Math.random() * 0.5 + 0.5,
      };
    }
    function resize() {
      w = canvas.width = canvas.offsetWidth * devicePixelRatio;
      h = canvas.height = canvas.offsetHeight * devicePixelRatio;
      stars.length = 0;
      const cx = w * 0.5, cy = h * 0.42;
      const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
      const count = Math.min(507, Math.floor((w * h) / 7179));
      for (let i = 0; i < count; i++) {
        const s = spawnStar(cx, cy, maxR);
        s.dist = Math.random() * maxR; // scatter initial positions so it's full immediately
        stars.push(s);
      }
    }
    resize();
    window.addEventListener("resize", resize);

    // draw a ring of dashed/segmented arcs at a given radius, rotated by `rot`
    function ringSegments(cx, cy, radius, rot, segs, gap, lineW, color, alpha) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rot);
      ctx.lineWidth = lineW * devicePixelRatio;
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      const step = (Math.PI * 2) / segs;
      for (let i = 0; i < segs; i++) {
        const a0 = i * step;
        const a1 = a0 + step * (1 - gap);
        ctx.beginPath();
        ctx.arc(0, 0, radius, a0, a1);
        ctx.stroke();
      }
      ctx.restore();
    }

    function draw() {
      t += reduced ? 0 : 0.0025;
      ctx.clearRect(0, 0, w, h);

      // deep radial backdrop
      const cx = w * 0.5, cy = h * 0.42;
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.7);
      bg.addColorStop(0, "rgba(10,18,34,0.9)");
      bg.addColorStop(1, "rgba(3,5,10,1)");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // WARP-SPEED STARS — streak radially outward from the core, accelerating
      const maxR = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy));
      ctx.lineCap = "round";
      for (const s of stars) {
        const prevDist = s.dist;
        if (!reduced) {
          // acceleration: speed scales with distance (faster as it nears edge)
          s.dist += (s.speed * (1.2 + (s.dist / maxR) * 7)) * devicePixelRatio;
        }
        // respawn when it flies off the edge
        if (s.dist > maxR) {
          const ns = spawnStar(cx, cy, maxR);
          Object.assign(s, ns);
          continue;
        }
        const cos = Math.cos(s.angle), sin = Math.sin(s.angle);
        const x1 = cx + cos * prevDist, y1 = cy + sin * prevDist;
        const x2 = cx + cos * s.dist,   y2 = cy + sin * s.dist;
        // streak gets longer + brighter + thicker as it moves out
        const f = s.dist / maxR;
        const alpha = Math.min(1, 0.15 + f * 0.95) * s.bright;
        ctx.strokeStyle = `rgba(200,222,255,${alpha})`;
        ctx.lineWidth = (0.4 + f * 1.8) * devicePixelRatio;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      // the portal: concentric glowing rings, counter-rotating HUD segments
      const base = Math.min(w, h) * 0.34;
      const teal = "rgba(39,117,232,1)";
      const tealDim = "rgba(39,117,232,1)";

      // inner glow disc
      const glow = ctx.createRadialGradient(cx, cy, base * 0.2, cx, cy, base * 1.15);
      glow.addColorStop(0, "rgba(39,117,232,0.06)");
      glow.addColorStop(0.7, "rgba(39,117,232,0.12)");
      glow.addColorStop(1, "rgba(39,117,232,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, base * 1.15, 0, Math.PI * 2);
      ctx.fill();

      // solid thin core ring
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.5 * devicePixelRatio;
      ctx.strokeStyle = teal;
      ctx.beginPath();
      ctx.arc(cx, cy, base * 0.62, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // rotating segmented rings at several radii (HUD look)
      ringSegments(cx, cy, base * 0.78,  t * 1.0,  18, 0.45, 2.5, tealDim, 0.55);
      ringSegments(cx, cy, base * 0.90, -t * 0.7,  6,  0.25, 6,   tealDim, 0.30);
      ringSegments(cx, cy, base * 1.00,  t * 0.5,  40, 0.6,  1.5, tealDim, 0.40);
      ringSegments(cx, cy, base * 1.12, -t * 0.35, 12, 0.55, 3,   tealDim, 0.25);

      // a few bright "tick" blocks on the outer ring
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 0.5);
      ctx.fillStyle = teal;
      ctx.globalAlpha = 0.7;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const rr = base * 1.05;
        const bx = Math.cos(a) * rr, by = Math.sin(a) * rr;
        ctx.save();
        ctx.translate(bx, by);
        ctx.rotate(a);
        ctx.fillRect(-1.5 * devicePixelRatio, -5 * devicePixelRatio, 3 * devicePixelRatio, 10 * devicePixelRatio);
        ctx.restore();
      }
      ctx.restore();

      raf = requestAnimationFrame(draw);
    }
    draw();
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize); };
  }, []);
  return <canvas ref={ref} style={{ position: "fixed", inset: 0, width: "100%", height: "100%", zIndex: 0 }} />;
}

// ─────────────────────────────────────────────────────────────────────────────
//  ROUTE VISUALIZER — the signature element. Draws the hop path and animates
//  a particle stream along it when a bridge is "in flight".
// ─────────────────────────────────────────────────────────────────────────────

function RouteVisualizer({ hops, active, progress }) {
  // hops: [{ name, color, glyph }]
  const n = hops.length;
  const pad = 48;
  const W = 560, H = 120;
  const xs = hops.map((_, i) => pad + (i * (W - pad * 2)) / Math.max(1, n - 1));
  const y = H / 2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <defs>
        <linearGradient id="pathgrad" x1="0" y1="0" x2="1" y2="0">
          {hops.map((hp, i) => (
            <stop key={i} offset={`${(i / Math.max(1, n - 1)) * 100}%`} stopColor={hp.color} />
          ))}
        </linearGradient>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* base track */}
      <line x1={xs[0]} y1={y} x2={xs[n - 1]} y2={y} stroke="#1d2433" strokeWidth="3" strokeLinecap="round" />
      {/* gradient path */}
      <line x1={xs[0]} y1={y} x2={xs[n - 1]} y2={y} stroke="url(#pathgrad)" strokeWidth="3"
            strokeLinecap="round" opacity={active ? 0.9 : 0.55} />

      {/* moving particle when active */}
      {active && (
        <circle r="5" fill="#fff" filter="url(#glow)">
          <animate attributeName="cx" values={`${xs[0]};${xs[n - 1]}`} dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="cy" values={`${y};${y}`} dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0;1;1;0" dur="1.6s" repeatCount="indefinite" />
        </circle>
      )}

      {/* progress fill */}
      {active && progress > 0 && (
        <line x1={xs[0]} y1={y} x2={xs[0] + (xs[n - 1] - xs[0]) * progress} y2={y}
              stroke="#fff" strokeWidth="3" strokeLinecap="round" opacity="0.85" />
      )}

      {/* nodes */}
      {hops.map((hp, i) => (
        <g key={i}>
          <circle cx={xs[i]} cy={y} r="22" fill="#0a0e16" stroke={hp.color} strokeWidth="2"
                  filter={active ? "url(#glow)" : undefined} />
          <text x={xs[i]} y={y + 6} textAnchor="middle" fontSize="18" fill={hp.color} fontWeight="700">{hp.glyph}</text>
          <text x={xs[i]} y={y + 44} textAnchor="middle" fontSize="11" fill="#7d8aa0" fontWeight="600">{hp.name}</text>
        </g>
      ))}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  SMALL UI PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

function ChainSelect({ label, value, onChange, exclude }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={S.fieldLabel}>{label}</div>
      <div style={S.selectWrap}>
        <select value={value} onChange={(e) => onChange(e.target.value)} style={S.select}>
          {Object.values(CHAINS)
            .filter((c) => c.id !== exclude)
            .map((c) => <option key={c.id} value={c.id} style={S.opt}>{c.glyph === c.name ? c.name : `${c.glyph}  ${c.name}`}</option>)}
        </select>
      </div>
    </div>
  );
}

function WalletPill({ role, type, connected, addr, onClick, busy }) {
  const label = type === "evm" ? "EVM Wallet" : type === "solana" ? "SVM Wallet" : "Wallet";
  return (
    <button onClick={onClick} disabled={busy} style={{ ...S.walletPill, borderColor: connected ? "#2775E8" : "#28303f", opacity: busy ? 0.6 : 1 }}>
      <span style={{ ...S.dot, background: connected ? "#2775E8" : "#475065" }} />
      <span style={{ fontSize: 11, color: "#7d8aa0" }}>{role}</span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>
        {busy ? "Connecting…" : connected ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : `Connect ${label}`}
      </span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────

export default function Teleporter() {
  const [from, setFrom] = useState("eth");
  const [to, setTo] = useState("x1");
  const [token, setToken] = useState("USDC");
  const [toToken, setToToken] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle|quoting|quoted|bridging|relaying|step2|handoff|done|failed
  const [progress, setProgress] = useState(0);
  const [warpSig, setWarpSig] = useState(null);
  const [warpStatus, setWarpStatus] = useState(null);
  const [pendingRelay, setPendingRelay] = useState(null);
  const [relayLoading, setRelayLoading] = useState(false);
  const [bridgeStage, setBridgeStage] = useState(0); // 0-5 benchmark progress
  const [destTx, setDestTx] = useState(null);        // release/mint tx hash
  const [showSplash, setShowSplash] = useState(true); // landing page gate
  const [toast, setToast] = useState(null);

  // demo wallets (front-end only)
  const [evmWallet, setEvmWallet] = useState(null);
  const [solWallet, setSolWallet] = useState(null);
  const [connecting, setConnecting] = useState(null); // 'evm' | 'solana' | null

  // ── new feature state ──
  const [balances, setBalances] = useState({});      // { 'eth:USDC': '123.45', ... }
  const [loadingBal, setLoadingBal] = useState(false);
  const [routeDetail, setRouteDetail] = useState(null); // bridges/tools LiFi picked
  const [trackStatus, setTrackStatus] = useState(null); // live LiFi status
  const [pending, setPending] = useState(() => store.get(PENDING_KEY));         // remembered-intent recovery
  const [history, setHistory] = useState(() => store.get(HISTORY_KEY) || []);   // past bridges
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [slippage, setSlippage] = useState(0.5); // percent
  const trackTimer = useRef(null);

  // persist history + pending whenever they change
  useEffect(() => { store.set(HISTORY_KEY, history); }, [history]);
  useEffect(() => { if (pending) store.set(PENDING_KEY, pending); else store.del(PENDING_KEY); }, [pending]);

  // ── REAL WALLET CONNECT ──
  // MetaMask (and any EIP-1193 wallet) via window.ethereum.
  // Phantom via window.solana. Falls back to a demo address if no wallet is
  // present, so the UI stays usable in the preview/sandbox.
  const connectEvm = useCallback(async () => {
    if (evmWallet) { setEvmWallet(null); return; }
    if (connecting === "evm") return; // already trying — don't fire a second request

    // Resolve an EVM provider ROBUSTLY. With Backpack/MetaMask/Rabby all fighting
    // over window.ethereum, a bare window.ethereum grab can be blocked or point
    // at the wrong wallet. Prefer EIP-6963 discovery, then the providers array,
    // then window.ethereum.
    const pickEvmProvider = () => {
      if (typeof window === "undefined") return null;
      // 1) EIP-6963: collect announced providers
      const announced = [];
      const onAnnounce = (e) => { if (e?.detail?.provider) announced.push(e.detail); };
      window.addEventListener("eip6963:announceProvider", onAnnounce);
      window.dispatchEvent(new Event("eip6963:requestProvider"));
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      if (announced.length) {
        // Prefer a non-Backpack injected EVM wallet (Backpack often can't own window.ethereum)
        const pref = announced.find((a) => /rabby|metamask/i.test(a.info?.name || "")) || announced[0];
        return pref.provider;
      }
      // 2) window.ethereum.providers array (older multi-wallet)
      const eth = window.ethereum;
      if (eth?.providers?.length) {
        return eth.providers.find((p) => p.isRabby) || eth.providers.find((p) => p.isMetaMask) || eth.providers[0];
      }
      // 3) plain window.ethereum
      return eth || null;
    };

    const eth = pickEvmProvider();
    console.log("[connectEvm] provider resolved:", eth ? (eth.isRabby ? "Rabby" : eth.isMetaMask ? "MetaMask" : "generic EVM") : "NONE");
    if (!eth) {
      flash("No EVM wallet found. Install MetaMask, Rabby, or another EVM wallet.", "err");
      return;
    }
    try {
      setConnecting("evm");
      // First, check if already authorized (no popup) — avoids "already processing"
      // when a prior request connected but state didn't update.
      try {
        const existing = await eth.request({ method: "eth_accounts" });
        if (existing?.[0]) {
          setEvmWallet({ addr: existing[0], provider: eth });
          flash("EVM wallet connected", "success");
          setConnecting(null);
          return;
        }
      } catch { /* fall through to request */ }

      const accts = await eth.request({ method: "eth_requestAccounts" });
      if (accts?.[0]) {
        setEvmWallet({ addr: accts[0], provider: eth });
        flash("EVM wallet connected", "success");
      } else {
        flash("No account returned by the EVM wallet", "err");
      }
    } catch (e) {
      console.error("[connectEvm] error:", e);
      // -32002 = request already pending in the wallet
      if (e?.code === -32002 || /already processing/i.test(e?.message || "")) {
        flash("Check your wallet — a connection request is already open. Approve it there, then retry.", "err");
      } else if (e?.code === 4001) {
        flash("Connection rejected", "err");
      } else {
        flash(`EVM connect failed: ${e?.message || e}`, "err");
      }
    } finally { setConnecting(null); }
  }, [evmWallet, connecting]);

  // List ALL available SVM (Solana/X1) wallet providers, de-duplicated.
  // Backpack claims window.solana, so auto-picking "the first" hides X1 etc.
  // Instead we enumerate everything and let the user choose.
  const listSolProviders = useCallback(() => {
    if (typeof window === "undefined") return [];
    const w = window;

    // Identify a provider object by its self-reported flags.
    const labelOf = (p) => {
      if (!p) return null;
      if (p.isX1 || p.isX1Wallet) return "X1 Wallet";
      if (p.isBackpack) return "Backpack";
      if (p.isPhantom) return "Phantom";
      if (p.isSolflare) return "Solflare";
      return "Solana Wallet";
    };

    // Collect every candidate provider object from all known injection points.
    const candidates = [];
    const push = (p) => { if (p && typeof p === "object") candidates.push(p); };

    // Multi-provider arrays (modern wallets list ALL injected providers here)
    if (Array.isArray(w.solana?.providers)) w.solana.providers.forEach(push);
    if (Array.isArray(w.phantom?.solana?.providers)) w.phantom.solana.providers.forEach(push);

    // Named namespaces
    push(w.phantom?.solana);
    push(w.backpack?.solana); push(w.backpack);
    push(w.x1?.solana); push(w.x1Wallet); push(w.x1);
    push(w.solflare);
    push(w.solana); // X1 Wallet often injects HERE — caught by isX1 flag in labelOf

    // De-dupe by object identity AND by label, so we never drop a wallet the
    // user wants (e.g. X1 Wallet) just because another wallet shares window.solana.
    const seenObj = new Set();
    const seenLabel = new Set();
    const found = [];
    for (const p of candidates) {
      if (seenObj.has(p)) continue;
      seenObj.add(p);
      if (typeof p.connect !== "function" && p.isConnected === undefined) continue;
      const label = labelOf(p);
      if (seenLabel.has(label)) continue; // one entry per distinct wallet
      seenLabel.add(label);
      const key = label.toLowerCase().replace(/\s+/g, "");
      found.push({ key, label, provider: p });
    }
    return found;
  }, []);

  const [walletMenu, setWalletMenu] = useState(false);

  const connectSolProvider = useCallback(async (entry) => {
    try {
      setConnecting("solana");
      setWalletMenu(false);
      const sol = entry.provider;
      const res = await sol.connect();
      const addr = res?.publicKey?.toString?.() || sol.publicKey?.toString?.();
      if (addr) {
        setSolWallet({ addr, provider: sol, label: entry.label });
        flash(`${entry.label} connected`, "success");
      }
    } catch (e) {
      flash(e?.code === 4001 ? "Connection rejected" : `${entry.label} connect failed`, "err");
    } finally { setConnecting(null); }
  }, []);

  const connectSol = useCallback(async () => {
    if (solWallet) { setSolWallet(null); return; }
    const providers = listSolProviders();
    if (providers.length === 0) {
      flash("No Solana/X1 wallet found. Install Phantom, Backpack, or X1 Wallet.", "err");
      return;
    }
    if (providers.length === 1) {
      // only one wallet — connect it directly, no menu needed
      return connectSolProvider(providers[0]);
    }
    // multiple wallets — show the picker so Backpack can't hijack the choice
    setWalletMenu(true);
  }, [solWallet, listSolProviders, connectSolProvider]);

  // Reconnect on load — but do NOT silently auto-connect a wallet the user
  // didn't explicitly connect this session. We only wire up the account-change
  // listener; restoring a connection requires the user to click Connect.
  useEffect(() => {
    const eth = typeof window !== "undefined" ? window.ethereum : null;
    if (eth?.on) {
      // If the user IS connected and switches accounts, reflect it. This does
      // not initiate a connection — it only updates an already-connected one.
      eth.on("accountsChanged", (a) => {
        setEvmWallet((prev) => prev ? (a?.[0] ? { addr: a[0], provider: eth } : null) : prev);
      });
    }
    // Solana side: same principle — only restore if the wallet itself reports a
    // trusted prior connection (onlyIfTrusted never prompts and only resolves
    // for a wallet the user already approved). We keep this since it's gated by
    // the wallet's own trust state, but it will NOT auto-pick if you never
    // connected. If you prefer zero auto-restore, this can be removed too.
    const providers = listSolProviders();
    for (const entry of providers) {
      if (typeof entry.provider.connect !== "function") continue;
      entry.provider.connect({ onlyIfTrusted: true })
        .then((r) => {
          const a = r?.publicKey?.toString?.() || entry.provider.publicKey?.toString?.();
          if (a) setSolWallet((prev) => prev || { addr: a, provider: entry.provider, label: entry.label });
        })
        .catch(() => {});
    }
  }, [listSolProviders]);

  const routeType = useMemo(() => determineRoute(from, to), [from, to]);
  const advisory = useMemo(
    () => routeAdvisory(from, to, token, toToken, (c) => CHAINS[c]?.walletType),
    [from, to, token, toToken]
  );

  // keep token valid when chain changes
  useEffect(() => {
    const t = tokensFor(from);
    if (!t.includes(token)) setToken(t[0]);
  }, [from]); // eslint-disable-line
  useEffect(() => {
    const t = tokensFor(to);
    if (!t.includes(toToken)) setToToken(t[0]);
  }, [to]); // eslint-disable-line

  const flash = (msg, kind = "info") => { setToast({ msg, kind }); setTimeout(() => setToast(null), 3200); };

  // hops for the visualizer based on route type
  const hops = useMemo(() => {
    const node = (id) => ({ name: CHAINS[id].name, color: CHAINS[id].color, glyph: CHAINS[id].glyph });
    switch (routeType) {
      case "direct":     return [node(from), node(to)];
      case "x1":         return [node(from), node("sol"), node("x1")];
      case "x1_reverse": return [node("x1"), node("sol")];
      case "x1_onward": return [node("x1"), node("sol"), node(to)];
      case "sol_x1":     return [node("sol"), node("x1")];
      default:           return [node(from), node(to)];
    }
  }, [routeType, from, to]);

  const addHistory = useCallback((entry) => {
    setHistory((h) => [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: Date.now(), ...entry }, ...h].slice(0, 50));
  }, []);
  const updateHistory = useCallback((id, patch) => {
    setHistory((h) => h.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  // ── REAL LiFi TRANSACTION EXECUTION ──
  // Takes the LiFi quote's transactionRequest and sends it via the EVM wallet.
  // Returns the tx hash on success. Solana-origin LiFi steps would use the
  // Phantom provider instead (sketched but EVM is the primary path).
  function getOriginWallet() {
    const c = CHAINS[from];
    if (c.walletType === "evm") return evmWallet ? { ...evmWallet, type: "evm" } : null;
    if (c.walletType === "solana") return solWallet ? { ...solWallet, type: "solana" } : null;
    return null;
  }

  // Solana-source LiFi execution (for x1_onward leg 2: Solana USDC -> EVM dest).
  // LiFi returns the Solana tx as a base64 VersionedTransaction in the quote;
  // the connected Solana/X1 wallet signs + sends it via its own RPC.
  const executeLiFiSolanaTx = useCallback(async (lifiData) => {
    // LiFi returns the Solana tx in different shapes. Try direct locations first.
    let txReq = lifiData?.transactionRequest
      || lifiData?.steps?.[0]?.transactionRequest
      || lifiData?.transactionData
      || lifiData?.steps?.[0]?.transactionData;
    let b64 = txReq?.data || txReq?.transaction || (typeof txReq === "string" ? txReq : null);

    // If the quote didn't include the executable tx (common for Solana), ask
    // LiFi to materialize it via /advanced/stepTransaction using the step.
    if (!b64) {
      const step = lifiData?.includedSteps?.[0] || lifiData?.steps?.[0] || lifiData;
      console.log("[Onward leg2] no tx in quote — calling stepTransaction with step:", step?.id || "(quote)");
      try {
        const r = await fetch(`${API_BASE}/api/lifi/stepTransaction`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(step),
        });
        const stepData = await r.json();
        console.log("[Onward leg2] stepTransaction response keys:", Object.keys(stepData || {}));
        txReq = stepData?.transactionRequest || stepData?.steps?.[0]?.transactionRequest;
        b64 = txReq?.data || txReq?.transaction || (typeof txReq === "string" ? txReq : null);
      } catch (e) { console.error("[Onward leg2] stepTransaction failed:", e); }
    }

    if (!b64) {
      console.error("[Onward leg2] STILL no tx data. Quote keys:", Object.keys(lifiData || {}),
        "step0 keys:", Object.keys(lifiData?.steps?.[0] || {}),
        "transactionRequest:", lifiData?.transactionRequest);
      throw new Error("LiFi returned no executable Solana transaction for this route");
    }

    const sol = solWallet?.provider || listSolProviders()[0]?.provider || null;
    if (!sol?.signAndSendTransaction && !sol?.signTransaction) {
      throw new Error("Connect your Solana/X1 wallet to sign");
    }

    const { VersionedTransaction, Connection } = await import("@solana/web3.js");
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const vtx = VersionedTransaction.deserialize(raw);
    console.log("[Onward leg2] deserialized Solana tx, signing…");

    if (typeof sol.signAndSendTransaction === "function") {
      const res = await sol.signAndSendTransaction(vtx);
      const sig = res?.signature || res;
      console.log("[Onward leg2] sent, sig:", sig);
      return sig;
    }
    const signed = await sol.signTransaction(vtx);
    const conn = new Connection(SOLANA_RPC, "confirmed");
    const sig = await conn.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
    console.log("[Onward leg2] sent via RPC, sig:", sig);
    return sig;
  }, [solWallet, listSolProviders]);

  const executeLiFiTx = useCallback(async (lifiData) => {
    let txReq = lifiData?.transactionRequest || lifiData?.steps?.[0]?.transactionRequest;
    if (!txReq) throw new Error("No transaction data in quote");

    const w = getOriginWallet();
    if (!w || w.type !== "evm" || !w.provider) throw new Error("Connect an EVM wallet to sign");

    // ── ERC-20 APPROVAL (the step whose absence caused the Across V4 revert) ──
    // LiFi must be allowed to pull your token before it can bridge it. For any
    // ERC-20 source (i.e. not the chain's native coin), check the allowance for
    // the LiFi spender and approve if it's short. Native sends (value-based)
    // skip this. LiFi tells us the token + spender via the quote's estimate.
    try {
      const action = lifiData?.action || lifiData?.steps?.[0]?.action;
      const est = lifiData?.estimate || lifiData?.steps?.[0]?.estimate;
      const tokenAddr = action?.fromToken?.address;
      const spender = est?.approvalAddress || txReq.to; // LiFi gives approvalAddress
      const fromAmount = action?.fromAmount || est?.fromAmount;
      const isNative = !tokenAddr || /^0x0+$/.test(tokenAddr) ||
                       tokenAddr.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      if (!isNative && tokenAddr && spender && fromAmount) {
        const need = BigInt(fromAmount);
        // allowance(owner,spender) => 0xdd62ed3e
        const allowData = "0xdd62ed3e" +
          w.addr.slice(2).padStart(64, "0") +
          spender.slice(2).padStart(64, "0");
        const allowanceHex = await w.provider.request({
          method: "eth_call",
          params: [{ to: tokenAddr, data: allowData }, "latest"],
        });
        const current = BigInt(allowanceHex && allowanceHex !== "0x" ? allowanceHex : "0x0");
        if (current < need) {
          flash("Approve token spend first (1 of 2)…", "info");
          // approve(spender, max) => 0x095ea7b3
          const maxUint = "f".repeat(64);
          const approveData = "0x095ea7b3" +
            spender.slice(2).padStart(64, "0") + maxUint;
          const approveHash = await w.provider.request({
            method: "eth_sendTransaction",
            params: [{ from: w.addr, to: tokenAddr, data: approveData, value: "0x0" }],
          });
          // wait for the approval to confirm before bridging
          flash("Approval sent — waiting for confirmation…", "info");
          await waitForReceipt(w.provider, approveHash);
          flash("Approved ✓ — now confirm the bridge (2 of 2)", "info");
        }
      }
    } catch (e) {
      throw new Error("Token approval failed: " + (e?.message || e));
    }

    // ── BRIDGE TX ──
    const params = [{
      from: w.addr,
      to: txReq.to,
      data: txReq.data,
      value: txReq.value || "0x0",
      ...(txReq.gasLimit ? { gas: typeof txReq.gasLimit === "string" ? txReq.gasLimit : "0x" + BigInt(txReq.gasLimit).toString(16) } : {}),
    }];
    const txHash = await w.provider.request({ method: "eth_sendTransaction", params });
    return txHash;
  }, [evmWallet, solWallet]);

  // Poll for a tx receipt (used to wait for ERC-20 approval before bridging)
  async function waitForReceipt(provider, hash, tries = 40) {
    for (let i = 0; i < tries; i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await provider.request({ method: "eth_getTransactionReceipt", params: [hash] }).catch(() => null);
      if (r && r.blockNumber) {
        if (r.status && BigInt(r.status) === 0n) throw new Error("Approval tx reverted");
        return r;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => setTimeout(res, 2500));
    }
    throw new Error("Approval not confirmed in time");
  }

  // helper to resolve the origin wallet (used by executeLiFiTx + quote)
  const ERC20_BAL = "0x70a08231"; // balanceOf(address) selector

  const fetchBalance = useCallback(async (chainId, sym) => {
    const tk = TOKENS[chainId]?.[sym];
    if (!tk) return null;
    const c = CHAINS[chainId];

    if (DEMO_MODE) {
      // deterministic-ish fake balance so the UI feels alive
      const seed = (chainId + sym).split("").reduce((a, ch) => a + ch.charCodeAt(0), 0);
      return ((seed % 900) + 10 + (seed % 100) / 100).toFixed(2);
    }

    try {
      if (c.walletType === "evm" && evmWallet?.provider) {
        const data = ERC20_BAL + evmWallet.addr.slice(2).padStart(64, "0");
        const hex = await evmWallet.provider.request({
          method: "eth_call",
          params: [{ to: tk.address, data }, "latest"],
        });
        const raw = BigInt(hex || "0x0");
        return (Number(raw) / 10 ** tk.decimals).toFixed(2);
      }
      if (c.walletType === "solana" && solWallet?.addr) {
        // SPL balance via getTokenAccountsByOwner, with multi-RPC fallback so a
        // single endpoint 403/429 doesn't make it falsely show 0.00.
        const rpcs = [SOLANA_RPC, "https://berty-633y20-fast-mainnet.helius-rpc.com",
                      "https://solana-rpc.publicnode.com",
                      "https://rpc.ankr.com/solana", "https://solana.drpc.org"].filter(Boolean);
        const body = JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
          params: [solWallet.addr, { mint: tk.address }, { encoding: "jsonParsed" }],
        });
        for (const rpc of rpcs) {
          try {
            const r = await fetch(rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body });
            if (!r.ok) continue; // try next RPC on 403/429/etc
            const j = await r.json();
            if (j.error) continue;
            // sum across all token accounts for this mint (handles multiple ATAs)
            const accts = j?.result?.value || [];
            let total = 0;
            for (const a of accts) {
              const amt = a?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
              if (typeof amt === "number") total += amt;
            }
            return total.toFixed(2);
          } catch { /* try next rpc */ }
        }
        // All RPCs failed — return null (unknown), NOT "0.00", so the UI can
        // show "—" instead of falsely claiming an empty balance.
        return null;
      }
    } catch { return null; }
    return null;
  }, [evmWallet, solWallet]);

  // refresh the balance for the currently-selected from-chain token
  useEffect(() => {
    const c = CHAINS[from];
    const haveWallet = (c.walletType === "evm" && evmWallet) || (c.walletType === "solana" && solWallet);
    if (!haveWallet && !DEMO_MODE) { setBalances((b) => ({ ...b, [`${from}:${token}`]: null })); return; }
    let cancelled = false;
    setLoadingBal(true);
    fetchBalance(from, token).then((bal) => {
      if (!cancelled) { setBalances((b) => ({ ...b, [`${from}:${token}`]: bal })); setLoadingBal(false); }
    });
    return () => { cancelled = true; };
  }, [from, token, evmWallet, solWallet, fetchBalance]);

  const currentBalance = balances[`${from}:${token}`];
  const setMax = () => { if (currentBalance && currentBalance !== "0.00") setAmount(currentBalance); };

  // ───────────────────────────────────────────────────────────────────────────
  //  FEATURE 2 — ROUTE DETAIL  (which bridges/DEXes LiFi actually chose)
  // ───────────────────────────────────────────────────────────────────────────
  // Parses LiFi quote.includedSteps into a readable tool path.
  const extractRouteDetail = useCallback((lifiData) => {
    if (!lifiData) return null;
    const steps = lifiData.includedSteps || lifiData.steps || [];
    const tools = [];
    for (const s of steps) {
      const name = s.toolDetails?.name || s.tool || s.type;
      const type = s.type === "swap" ? "swap" : s.type === "cross" ? "bridge" : s.type;
      if (name) tools.push({ name, type });
    }
    // est. time + gas if present
    const est = lifiData.estimate || {};
    const seconds = est.executionDuration;
    const gasUsd = (est.gasCosts || []).reduce((a, g) => a + parseFloat(g.amountUSD || 0), 0);
    return { tools, seconds, gasUsd };
  }, []);

  // DEMO route detail so the panel shows something realistic
  const demoRouteDetail = useCallback(() => {
    const pool = ["Across", "Stargate", "Mayan", "CCTP", "Allbridge"];
    const pick = pool[(from.length + to.length) % pool.length];
    const tools = [];
    if (routeType !== "sol_x1") tools.push({ name: pick, type: "bridge" });
    if (routeType === "x1" || routeType === "sol_x1") tools.push({ name: "Warp Bridge", type: "bridge" });
    if (routeType === "x1_reverse") tools.unshift({ name: "Warp Bridge", type: "bridge" });
    if (routeType === "x1_onward") { tools.unshift({ name: "Warp Bridge", type: "bridge" }); tools.push({ name: "LiFi", type: "aggregator" }); }
    return { tools, seconds: 30 + ((from.length * 7) % 90), gasUsd: 0.4 + ((to.length % 5) / 10) };
  }, [from, to, routeType]);

  // ───────────────────────────────────────────────────────────────────────────
  //  FEATURE 3 — LIVE STATUS TRACKER  (poll LiFi /status after a real send)
  // ───────────────────────────────────────────────────────────────────────────
  const startStatusPoll = useCallback((txHash, fromKey, toKey, histId) => {
    clearInterval(trackTimer.current);
    setTrackStatus({ state: "PENDING", label: "Submitted — waiting for bridge…" });
    if (DEMO_MODE) {
      const seq = [
        { state: "PENDING", label: "Confirming on source chain…" },
        { state: "PENDING", label: "Bridging across…" },
        { state: "PENDING", label: "Arriving on destination…" },
        { state: "DONE", label: "Funds delivered" },
      ];
      let i = 0;
      trackTimer.current = setInterval(() => {
        setTrackStatus(seq[i]);
        if (seq[i].state === "DONE") {
          clearInterval(trackTimer.current); setPhase("done");
          if (histId) updateHistory(histId, { status: "done" });
        }
        i++;
      }, 1400);
      return;
    }
    trackTimer.current = setInterval(async () => {
      try {
        const qs = new URLSearchParams({ txHash, fromChain: fromKey, toChain: toKey });
        const r = await fetch(`${API_BASE}/api/lifi/status?${qs}`);
        const j = await r.json();
        const state = j.status || j.state;
        if (state === "DONE") {
          setTrackStatus({ state: "DONE", label: "Funds delivered" });
          clearInterval(trackTimer.current); setPhase("done");
          if (histId) updateHistory(histId, { status: "done" });
        } else if (state === "FAILED") {
          setTrackStatus({ state: "FAILED", label: "Bridge failed — funds safe at source" });
          clearInterval(trackTimer.current); setPhase("failed");
          if (histId) updateHistory(histId, { status: "failed" });
        } else {
          setTrackStatus({ state: "PENDING", label: j.substatusMessage || "Bridging…" });
        }
      } catch { /* keep polling */ }
    }, 5000);
  }, [updateHistory]);

  useEffect(() => () => clearInterval(trackTimer.current), []);

  // ───────────────────────────────────────────────────────────────────────────
  //  FEATURE 4 — REMEMBERED-INTENT RECOVERY  (finish an interrupted X1 hop)
  // ───────────────────────────────────────────────────────────────────────────
  // When a 2-stage X1 route reaches step2, we persist the intent in memory
  // (and would persist to disk/localStorage in prod — note: artifacts can't use
  // localStorage, so this uses in-memory state here; wire to storage in your app).
  // On load / wallet connect, if a pending intent exists, offer to finish it.

  const rememberIntent = useCallback((intent) => {
    setPending(intent);
    // In your real app: await window.storage?.set('pendingBridge', JSON.stringify(intent))
  }, []);

  const clearIntent = useCallback(() => {
    setPending(null);
    // In your real app: await window.storage?.delete('pendingBridge')
  }, []);

  const buildLifiQuery = useCallback((feeOverride, amountOverride) => {
    const effectiveFee = feeOverride != null ? feeOverride : INTEGRATOR_FEE;
    const amt = amountOverride != null ? amountOverride : parseFloat(amount);
    // NO PLACEHOLDERS. Quotes use ONLY the real connected wallet addresses.
    // If the wallet for a VM this route touches isn't connected, we return null
    // and the UI asks the user to connect. There is no fallback address anywhere
    // — so funds can never route to anything but the user's own connected wallet.
    const fromVmType = CHAINS[from].walletType;
    const toVmType = CHAINS[to].walletType;
    const needEvm = fromVmType === "evm" || toVmType === "evm";
    const needSol = fromVmType === "solana" || toVmType === "solana";
    const evmAddr = evmWallet?.addr || null;
    const solAddr = (solWallet?.addr && !solWallet?.demo) ? solWallet.addr : null;
    if (needEvm && !evmAddr) return null;
    if (needSol && !solAddr) return null;

    let fromChain, toChain, fromTok, toTok, fromAddr, toAddr, decimals;
    if (routeType === "direct") {
      fromChain = CHAINS[from].lifiKey; toChain = CHAINS[to].lifiKey;
      fromTok = TOKENS[from][token].address; toTok = TOKENS[to][toToken].address;
      fromAddr = CHAINS[from].walletType === "evm" ? evmAddr : solAddr;
      // destination VM determines which address receives
      toAddr = CHAINS[to].walletType === "evm" ? evmAddr : solAddr;
      decimals = TOKENS[from][token].decimals;
    } else if (routeType === "x1") {
      // from -> Solana USDC. Destination is SOLANA, so toAddress MUST be the
      // Solana/X1 wallet (Phantom), NOT the EVM source address.
      fromChain = CHAINS[from].lifiKey; toChain = CHAINS.sol.lifiKey;
      fromTok = TOKENS[from][token].address; toTok = TOKENS.sol.USDC.address;
      fromAddr = CHAINS[from].walletType === "evm" ? evmAddr : solAddr;
      toAddr = solAddr; // lands on Solana → must be the SVM address
      decimals = TOKENS[from][token].decimals;
    } else if (routeType === "x1_onward") {
      // x1_onward LEG 2: Solana USDC -> destination (EVM). Leg 1 (Warp burn,
      // X1->Sol) already landed USDC on Solana; this LiFi leg finishes the hop.
      fromChain = CHAINS.sol.lifiKey; toChain = CHAINS[to].lifiKey;
      fromTok = TOKENS.sol.USDC.address; toTok = TOKENS[to][toToken].address;
      fromAddr = solAddr;
      toAddr = CHAINS[to].walletType === "evm" ? evmAddr : solAddr;
      decimals = 6; // Solana USDC
    } else {
      return null; // sol_x1 + x1_reverse: no LiFi leg (pure Warp)
    }

    const rawAmount = BigInt(Math.floor(amt * 10 ** decimals)).toString();
    // Detect a cross-VM hop (EVM<->Solana). These MUST go direct via a real
    // cross-ecosystem bridge (allbridge/mayan/cctp) — NOT a multi-hop that
    // detours through another EVM chain (e.g. BNB->Ethereum->Solana via Relay),
    // which is fragile and was reverting on the intermediate leg.
    const fromVm = fromChain === CHAINS.sol.lifiKey ? "sol" : "evm";
    const toVm = toChain === CHAINS.sol.lifiKey ? "sol" : "evm";
    const crossVm = fromVm !== toVm;

    const qsObj = {
      fromChain, toChain, fromToken: fromTok, toToken: toTok,
      fromAmount: rawAmount, fromAddress: fromAddr,
      toAddress: toAddr, // explicit — required for cross-VM routes
      slippage: String(slippage / 100),
      integrator: INTEGRATOR,
      fee: String(effectiveFee), // dev fee, collected by LiFi to your account
      order: "CHEAPEST",
    };
    if (crossVm) {
      // Prevent LiFi from building a fragile multi-hop that detours through a
      // THIRD chain (e.g. BNB→Ethereum→Solana via Relay, which was reverting on
      // the intermediate leg). allowSwitchChain=false forces the cross-VM hop to
      // go source→Solana directly (LiFi may still DEX-swap on the source chain
      // first, e.g. BNB DAI→BNB USDC, then bridge — that's one chain, fine).
      // We do NOT hard-restrict allowBridges: per LiFi, Allbridge on BSC is
      // USDT-only, so over-restricting would kill valid DAI/USDC routes that
      // need Mayan/CCTP/Wormhole. Let LiFi pick among cross-VM bridges, just no
      // multi-chain detours.
      qsObj.allowSwitchChain = "false";
    }
    const qs = new URLSearchParams(qsObj);
    return { qs, decimals, feeUsed: effectiveFee };
  }, [amount, from, to, routeType, token, toToken, slippage, evmWallet, solWallet]);

  // ── QUOTE ──
  const getQuote = useCallback(async () => {
    if (!amount || parseFloat(amount) <= 0) return flash("Enter an amount", "err");
    if (from === to) return flash("Source and destination must differ", "err");

    // CONNECT FIRST: quotes use your real wallet address (no placeholders), so
    // require the wallet(s) this route needs before pricing.
    const fromVm = CHAINS[from].walletType, toVm = CHAINS[to].walletType;
    const needEvm = fromVm === "evm" || toVm === "evm";
    const needSol = fromVm === "solana" || toVm === "solana";
    if (needEvm && !evmWallet?.addr) return flash("Connect your EVM wallet to get a quote", "err");
    if (needSol && (!solWallet?.addr || solWallet?.demo)) return flash("Connect your Solana/X1 wallet to get a quote", "err");

    const amt = parseFloat(amount);

    // Routes that END in a Warp hop into X1 (x1 on-ramp + pure sol_x1) must clear
    // the bridge's $10 floor AFTER our 1% skim.
    const endsInX1 = routeType === "x1" || routeType === "sol_x1";
    if (endsInX1 && amt < X1_MIN) {
      return flash(`Bridge $${X1_MIN}+ into X1 to get started`, "err");
    }
    // Reverse (X1→Sol) and onward (X1→other): $25 floor, same as forward.
    if ((routeType === "x1_reverse" || routeType === "x1_onward") && amt < X1_REVERSE_MIN) {
      return flash(`Bridge $${X1_REVERSE_MIN}+ out of X1 to get started`, "err");
    }

    setPhase("quoting");

    // sol_x1 — pure Warp bridge, no LiFi leg. Our 1% skim. In HANDOFF mode we
    // land USDC on Solana and the user finishes on Warp Bridge (Warp charges
    // their own flat $1 there, so we don't deduct it on our side).
    if (routeType === "sol_x1") {
      await new Promise((r) => setTimeout(r, 400));
      const ourFee = amt * INTEGRATOR_FEE;          // our 1%, skimmed first
      const afterSkim = amt - ourFee;               // amount that reaches the user on Solana
      if (!AUTO_X1_HOP) {
        setQuote({
          amount: amt, feeUsd: ourFee, bridgeFee: 0,
          net: Math.max(0, afterSkim),
          recvToken: "USDC", recvChain: "Solana",
          note: "Land on Solana → finish on Warp Bridge",
          warpHandoff: true,
          steps: [{ name: "Solana", tool: "Teleporter" }, { name: "X1", tool: "Warp Bridge (manual)" }],
        });
        setPhase("quoted");
        return;
      }
      const net = Math.max(0, afterSkim - WARP_FLAT_FEE); // Warp takes flat $1
      setQuote({
        amount: amt, feeUsd: ourFee, bridgeFee: WARP_FLAT_FEE, net,
        recvToken: "USDC.x", recvChain: "X1",
        note: "Solana → X1 via Warp Bridge",
        steps: hops.map((h) => ({ name: h.name, tool: "Warp Bridge" })),
      });
      setPhase("quoted");
      return;
    }

    // x1_reverse — X1 → Solana via Warp BURN. No LiFi. Our 1% skim + Warp's
    // flat 1 USDC.x token fee (deducted inside bridge_out on mainnet).
    if (routeType === "x1_reverse") {
      await new Promise((r) => setTimeout(r, 300));
      const ourFee = amt * INTEGRATOR_FEE;
      const net = Math.max(0, amt - ourFee - WARP_FLAT_FEE); // Warp burns net after its $1 fee
      setQuote({
        amount: amt, feeUsd: ourFee, bridgeFee: WARP_FLAT_FEE, net,
        recvToken: "USDC", recvChain: "Solana",
        note: "X1 → Solana via Warp Bridge (burn → release)",
        steps: [{ name: "X1", tool: "Warp Bridge" }, { name: "Solana", tool: "Warp Bridge" }],
      });
      setPhase("quoted");
      return;
    }

    // x1_onward — X1 → other chain. Two legs: Warp burn (X1→Sol) + LiFi
    // (Sol→destination). Quote shows our 1% + Warp's $1; the LiFi leg's own
    // fee/slippage is quoted live when leg 2 fires.
    if (routeType === "x1_onward") {
      await new Promise((r) => setTimeout(r, 300));
      const ourFee = amt * INTEGRATOR_FEE;
      const afterLeg1 = Math.max(0, amt - ourFee - WARP_FLAT_FEE);
      setQuote({
        amount: amt, feeUsd: ourFee, bridgeFee: WARP_FLAT_FEE, net: afterLeg1,
        recvToken: toToken, recvChain: CHAINS[to]?.name || to,
        note: `X1 → Solana (Warp) → ${CHAINS[to]?.name || to} (LiFi)`,
        twoLeg: true,
        steps: [
          { name: "X1", tool: "Warp Bridge" },
          { name: "Solana", tool: "Warp Bridge" },
          { name: CHAINS[to]?.name || to, tool: "LiFi" },
        ],
      });
      setPhase("quoted");
      return;
    }

    // DEMO MODE — simulate, no backend needed
    if (DEMO_MODE) {
      await new Promise((r) => setTimeout(r, 650));
      const feeUsd = amt * INTEGRATOR_FEE;
      // x1 on-ramp ends in a Warp hop, so it also eats Warp's flat $1.
      const bridgeFee = routeType === "x1" ? WARP_FLAT_FEE : 0;
      const net = Math.max(0, amt - feeUsd - bridgeFee);
      const recvToken = routeType === "x1" ? "USDC.x" : toToken;
      const recvChain = routeType === "x1" ? "X1" : CHAINS[to].name;
      setQuote({
        amount: amt, feeUsd, bridgeFee, net, recvToken, recvChain, demo: true,
        steps: hops.map((h, i) => ({
          name: h.name,
          tool: h.name === "X1" ? "Warp Bridge" : (routeType === "sol_x1" ? "Warp Bridge" : "LiFi"),
        })),
      });
      setPhase("quoted");
      return;
    }

    // LIVE MODE — real LiFi call through your proxy.
    // Fee-cap resilience: some integrator tiers cap the fee (e.g. 0.5%). If a
    // quote is rejected in a way that looks fee-related, retry at lower fees so
    // a cap can never silently break the bridge. We surface which fee actually
    // worked so you know if you need to request a raise in the LiFi portal.
    try {
      const feeLadder = [INTEGRATOR_FEE, 0.005, 0.0025, 0]; // 1% → 0.5% → 0.25% → 0
      let data = null, usedFee = INTEGRATOR_FEE, lastErr = null;
      for (const f of feeLadder) {
        const built = buildLifiQuery(f);
        if (!built) {
          const needSol = CHAINS[from].walletType === "solana" || CHAINS[to].walletType === "solana";
          const needEvm = CHAINS[from].walletType === "evm" || CHAINS[to].walletType === "evm";
          let msg = "No route";
          if (!DEMO_MODE && needSol && (!solWallet?.addr || solWallet?.demo)) msg = "Connect your Solana/X1 wallet to get a quote";
          else if (!DEMO_MODE && needEvm && !evmWallet?.addr) msg = "Connect your EVM wallet to get a quote";
          flash(msg, "err"); setPhase("idle"); return;
        }
        const resp = await fetch(`${API_BASE}/api/lifi/quote?${built.qs}`);
        const d = await resp.json();
        const errMsg = (d.error || d.message || "").toString().toLowerCase();
        if (!d.error && !d.message) { data = d; usedFee = f; break; }
        lastErr = d.message || d.error;
        // only keep retrying if the error looks fee/integrator-related
        const feeRelated = errMsg.includes("fee") || errMsg.includes("integrator") ||
                           errMsg.includes("not configured") || errMsg.includes("exceed");
        if (!feeRelated) { flash(lastErr, "err"); setPhase("idle"); return; }
        // else loop to the next-lower fee
      }
      if (!data) { flash(lastErr || "Quote failed", "err"); setPhase("idle"); return; }
      if (usedFee < INTEGRATOR_FEE) {
        flash(`Fee capped at ${(usedFee*100).toFixed(2)}% by LiFi — request a raise in the portal to collect ${(INTEGRATOR_FEE*100).toFixed(0)}%`, "info");
      }
      const outDecimals = routeType === "x1"
        ? TOKENS.sol.USDC.decimals
        : (routeType === "x1_reverse" ? TOKENS[to][toToken].decimals : TOKENS[to][toToken].decimals);
      const out = parseFloat(data.estimate.toAmount) / 10 ** outDecimals;
      const feeUsd = amt * usedFee; // reflect the fee that actually applied
      const bridgeFee = routeType === "x1" ? WARP_FLAT_FEE : 0;
      const recvToken = routeType === "x1" ? "USDC.x" : toToken;
      const recvChain = routeType === "x1" ? "X1" : CHAINS[to].name;

      setQuote({
        amount: amt, feeUsd, bridgeFee, net: Math.max(0, out - bridgeFee), recvToken, recvChain, lifiData: data, feeUsed: usedFee,
        solanaAmount: out, // what LiFi delivers on Solana — Stage 2 Warp bridges THIS, not the original
        steps: hops.map((h) => ({
          name: h.name,
          tool: h.name === "X1" ? "Warp Bridge" : "LiFi",
        })),
      });
      setPhase("quoted");
    } catch (e) {
      flash("Quote request failed", "err"); setPhase("idle");
    }
  }, [amount, from, to, routeType, toToken, hops, buildLifiQuery, evmWallet, solWallet]);

  // ── HISTORY helpers ──
  // In your real app, persist with window.storage.set('history', ...) so it
  // survives reloads. Artifacts can't use localStorage, so this is in-memory.
  const executeStage2 = useCallback(async () => {
    setPhase("bridging"); setProgress(0);

    // ── LIVE PATH (gated) — real Solana→X1 Warp bridge via warpBridge.js ──
    if (WARP_LIVE && !DEMO_MODE) {
      try {
        // Use the SVM wallet the user actually connected (Phantom/Backpack/X1),
        // not a hardcoded window.solana.
        const sol = solWallet?.provider || listSolProviders()[0]?.provider || null;
        if (!sol?.publicKey) { flash("Connect your Solana/X1 wallet to finish the X1 hop", "err"); setPhase("quoted"); return; }
        if (solWallet?.demo) { flash("Connect a real wallet (not demo) to bridge", "err"); setPhase("quoted"); return; }
        const { Connection, PublicKey } = await import("@solana/web3.js");
        const { runStage2 } = await import("./warpBridge.js");
        const connection = new Connection(SOLANA_RPC, "confirmed");
        // Stage 2 bridges what LiFi actually delivered to Solana (solanaAmount),
        // NOT the original input — leg 1 took fees, so less arrived.
        const amountHuman = quote?.solanaAmount ?? pending?.solanaAmount ?? quote?.amount ?? pending?.amount;
        const res = await runStage2({
          connection,
          userPubkey: sol.publicKey,
          feeWalletSvm: new PublicKey(FEE_WALLET_SVM),
          amountHuman,
          allowLive: WARP_LIVE_SEND, // second gate: only truly sends if this is true too
          provider: sol, // the actual connected wallet (Backpack/Phantom/X1) — broadcasts via its own RPC
        });
        if (!res.success) {
          const logs = res.sim?.logs || [];
          // Full program logs to the console (reachable in-browser). These name
          // the EXACT failing assertion — seq mismatch, account/seed, privilege,
          // insufficient funds — which is what actually diagnoses a revert.
          console.group("[Teleporter] Stage2 simulation FAILED");
          console.log("err:", res.sim?.err);
          console.log("seq:", res.built?.seq?.toString?.());
          console.log("outgoing_msg PDA:", res.built?.outgoing_msg?.toBase58?.());
          console.log("skimBase:", res.built?.skimBase?.toString?.(), "bridgeBase:", res.built?.bridgeBase?.toString?.());
          console.log("program logs:\n" + logs.join("\n"));
          console.groupEnd();
          // Surface the most informative program-log line in the UI too.
          const key = logs.filter((l) => /error|failed|assert|seq|insufficient|invalid|constraint/i.test(l)).slice(-2).join(" | ");
          flash(`Bridge sim failed: ${JSON.stringify(res.sim?.err)}${key ? " — " + key : ""} (full logs in console)`, "err");
          setPhase("quoted");
          return;
        }
        clearIntent();
        if (pending?.histId) updateHistory(pending.histId, { status: "stage1_done" });
        setProgress(0.5);

        // If we actually broadcast, poll the Warp API to watch guardians sign
        // and the official submitter relay to X1. (Read-only; safe.)
        if (res.sent || res.signature) {
          const sig = res.signature;
          setWarpSig(sig);
          setPhase("relaying");
          flash(`bridge_out sent. Watching guardians + relay… (${sig?.slice(0,8)}…)`, "info");
          const { pollWarpStatus, WARP_API } = await import("./warpBridge.js");
          const result = await pollWarpStatus(sig, {
            api: WARP_API.mainnet,
            from: "sol",
            onUpdate: (stage, detail) => {
              setWarpStatus({ stage, detail });
              if (stage === "guardians_signing") flash(`Guardians signing: ${detail.count} collected`, "info");
              if (stage === "complete") flash("USDC.x minted on X1 ✓", "success");
              if (stage === "failed") flash("Warp relay reported failure — see status", "err");
            },
          });
          if (result.ok) {
            if (pending?.histId) updateHistory(pending.histId, { status: "done", destTx: result.destinationTx });
            setProgress(1); setPhase("done");
            flash(`Complete! USDC.x on X1${result.destinationTx ? ` (dest ${String(result.destinationTx).slice(0,8)}…)` : ""}`, "success");
          } else if (result.timedOut) {
            setPhase("relaying");
            flash(`Still relaying after 3min${result.sawSigs ? " (guardians signed)" : ""}. Guardians are working on it — check back in a few minutes. If this persists, the release may have already landed on-chain; verify at solscan or on-chain block explorers.`, "info");
          } else {
            setPhase("quoted");
            flash("Relay did not complete — capture the status JSON for the Warp team.", "err");
          }
          return;
        }

        // Simulated only (not sent)
        setProgress(1); setPhase("done");
        flash("Simulation passed ✓ (not sent)", "success");
        return;
      } catch (e) {
        flash(`Warp error: ${String(e.message || e)}`, "err");
        setPhase("quoted");
        return;
      }
    }

    // ── DEMO PATH (default, safe) — animated, no real bridge ──
    for (let p = 0; p <= 1.0001; p += 0.05) {
      setProgress(Math.min(1, p));
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 55));
    }
    clearIntent(); // hop completed — forget the pending intent
    if (pending?.histId) updateHistory(pending.histId, { status: "done" });
    setPhase("done");
    flash("Bridge complete — funds on destination", "success");
  }, [clearIntent, pending, updateHistory, quote, solWallet, listSolProviders]);

  // x1_onward LEG 2: after the Warp burn landed USDC on Solana, finish the hop
  // to the destination chain via LiFi (Solana USDC -> destination token).
  const executeOnwardLeg2 = useCallback(async () => {
    setPhase("bridging"); setProgress(0.6);
    try {
      // Leg 2 bridges what actually LANDED on Solana after leg 1 (Warp burn):
      // original − 1% skim − Warp flat $1. Use that net, not the original input,
      // or LiFi would quote/attempt more USDC than the wallet holds.
      const original = parseFloat(amount);
      const netOnSolana = quote?.net != null ? quote.net
        : Math.max(0, original - original * INTEGRATOR_FEE - WARP_FLAT_FEE);
      console.log("[Onward leg2] original:", original, "net on Solana:", netOnSolana);
      const built = buildLifiQuery(null, netOnSolana);
      if (!built) { flash("Couldn't build the onward route — is your EVM wallet connected?", "err"); setPhase("step2"); return; }
      const quoteUrl = `${API_BASE}/api/lifi/quote?${built.qs}`;
      console.log("[Onward leg2] LiFi quote URL:", quoteUrl);
      const resp = await fetch(quoteUrl);
      const d = await resp.json().catch(() => ({}));
      console.log("[Onward leg2] LiFi response:", d);
      if (d.error || d.message) {
        flash(`Onward route failed: ${d.message || d.error} — funds safe on Solana`, "err");
        setPhase("step2"); return;
      }
      if (!d.estimate && !d.transactionRequest) {
        flash("Onward route returned no executable quote — funds safe on Solana", "err");
        setPhase("step2"); return;
      }
      const txHash = await executeLiFiSolanaTx(d);
      setProgress(1); setPhase("done");
      if (pending?.histId) updateHistory(pending.histId, { status: "done", txHash });
      clearIntent();
      flash(`Complete! Funds bridged to ${CHAINS[to]?.name || to} ✓`, "success");
    } catch (e) {
      console.error("[Onward leg2] error:", e);
      setPhase("step2");
      flash(e?.message || "Onward leg failed — your USDC is safe on Solana, try again", "err");
    }
  }, [buildLifiQuery, executeLiFiSolanaTx, pending, updateHistory, clearIntent, to, amount, quote]);

  // Submit the self-relay for a stuck X1->Solana transfer when guardians have signed.
  const executeRelay = useCallback(async () => {
    if (!pendingRelay) { flash("No pending relay", "err"); return; }
    setRelayLoading(true);
    try {
      const { Connection } = await import("@solana/web3.js");
      const { submitReverseRelay } = await import("./warpBridge.js");
      const conn = new Connection(SOLANA_RPC || "https://api.mainnet-beta.solana.com", "confirmed");
      const solProv = solWallet?.provider || listSolProviders()[0]?.provider;
      if (!solProv?.publicKey) { flash("Connect your Solana wallet to complete the release", "err"); setRelayLoading(false); return; }
      
      flash("Simulating release…", "info");
      const { tx, sim } = await submitReverseRelay(conn, {
        signatures: pendingRelay.sigs,
        seq: pendingRelay.seq,
        sender: pendingRelay.sender,
        amount: pendingRelay.amount,
        timestamp: pendingRelay.timestamp,
        payer: solProv.publicKey,
        onProgress: (msg) => flash(msg, "info"),
      });
      
      if (!WARP_LIVE_SEND) {
        flash(`Release ready (sim OK) — set WARP_LIVE_SEND to true to execute`, "info");
        setRelayLoading(false);
        return;
      }
      
      flash("Signing and sending…", "info");
      tx.sign([solProv]);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction(sig, "confirmed");
      
      setPhase("done");
      setDestTx(sig);
      setPendingRelay(null);
      const histId = pendingRelay.histId;
      if (histId) updateHistory(histId, { status: "done", destTx: sig });
      flash(`Released ✓ — ${String(sig).slice(0, 8)}…`, "success");
    } catch (e) {
      console.error("[Relay] error:", e);
      flash(`Release failed: ${e?.message}`, "err");
    } finally {
      setRelayLoading(false);
    }
  }, [pendingRelay, solWallet, updateHistory]);

  // Dispatcher for the step2 button: x1_onward finishes via LiFi, everything
  // else (forward x1, sol_x1) finishes via the Warp Stage 2.
  const executeStep2 = useCallback(async () => {
    if (routeType === "x1_onward") return executeOnwardLeg2();
    return executeStage2();
  }, [routeType, executeOnwardLeg2, executeStage2]);

  const execute = useCallback(async () => {
    // SAFETY: require the RIGHT real wallet(s) for whatever VMs this route
    // touches, and NEVER let a placeholder address receive real funds.
    const PLACEHOLDER_SOL = "EAj1z4q6RN17BswMK38fADDEJQ5JTqy2WoTdky3drX6X";
    const PLACEHOLDER_EVM = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
    if (!DEMO_MODE) {
      const fromVm = CHAINS[from].walletType;
      const toVm = CHAINS[to].walletType;
      const needsEvm = fromVm === "evm" || toVm === "evm";
      const needsSol = fromVm === "solana" || toVm === "solana";
      if (needsEvm && !evmWallet?.addr) {
        flash("Connect your EVM wallet (e.g. Rabby/MetaMask) before bridging.", "err");
        return;
      }
      if (needsSol && (!solWallet?.addr || solWallet?.demo)) {
        flash("Connect your Solana/X1 wallet before bridging.", "err");
        return;
      }
      // Defense-in-depth: placeholders are fully removed from the code, but
      // keep this backstop so a real send can NEVER go to a known demo address
      // even if one is ever reintroduced by future code.
      if ((needsSol && solWallet?.addr === PLACEHOLDER_SOL) ||
          (needsEvm && evmWallet?.addr === PLACEHOLDER_EVM)) {
        flash("Refusing to bridge to a demo/placeholder address. Reconnect your real wallet.", "err");
        return;
      }
    }
    setRouteDetail(DEMO_MODE ? demoRouteDetail() : extractRouteDetail(quote?.lifiData));
    const twoStage = routeType === "x1" || routeType === "x1_reverse" || routeType === "x1_onward" || routeType === "sol_x1";

    // record a pending history entry up front
    const histId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setHistory((h) => [{
      id: histId, ts: Date.now(), from, to, token,
      recvToken: quote?.recvToken, recvChain: quote?.recvChain,
      amount: quote?.amount, routeType, status: "pending", txHash: null,
    }, ...h].slice(0, 50));

    if (!DEMO_MODE) {
      // PURE SOLANA → X1 (sol_x1): funds are already on Solana. If AUTO_X1_HOP
      // is off, we don't run the Warp hop ourselves — we hand the user to the
      // official Warp Bridge to finish. (If on, run Stage 2 directly.)
      if (routeType === "sol_x1") {
        if (!AUTO_X1_HOP) {
          updateHistory(histId, { status: "handoff" });
          setPhase("handoff");
          flash("Your USDC is on Solana. Finish on the official Warp Bridge.", "info");
          return;
        }
        try {
          rememberIntent({ routeType, from, to, token, toToken, amount: quote?.amount, solanaAmount: quote?.solanaAmount,
            recvToken: quote?.recvToken, recvChain: quote?.recvChain, stage: "awaiting_stage2",
            histId, ts: Date.now() });
          await executeStage2();
          updateHistory(histId, { status: "done" });
        } catch (e) {
          updateHistory(histId, { status: "failed" });
          setPhase("quoted");
          flash(e?.message || "Warp bridge failed", "err");
        }
        return;
      }

      // X1 → SOLANA (x1_reverse) or X1 → ONWARD (x1_onward): BURN USDC.x on X1,
      // release USDC on Solana via Warp. x1_reverse ends there; x1_onward then
      // continues with a LiFi leg (Sol → destination) as step 2.
      if (routeType === "x1_reverse" || routeType === "x1_onward") {
        const isOnward = routeType === "x1_onward";
        try {
          setBridgeStage(0); setDestTx(null); setWarpStatus(null); setPhase("relaying");
          const sol = solWallet?.provider || listSolProviders()[0]?.provider || null;
          if (!sol?.publicKey) { flash("Connect your X1 wallet to bridge from X1", "err"); setPhase("quoted"); return; }
          const { Connection } = await import("@solana/web3.js");
          const { runReverse, WARP_API, pollWarpStatus } = await import("./warpBridge.js");
          const connection = new Connection(X1_RPC, "confirmed");
          const amountHuman = quote?.amount ?? pending?.amount;
          console.log("[Reverse] starting runReverse amount:", amountHuman, "onward:", isOnward);
          const res = await runReverse({
            connection, userPubkey: sol.publicKey, amountHuman,
            allowLive: WARP_LIVE_SEND, provider: sol,
            onBuilt: () => setBridgeStage((s) => Math.max(s, 1)),
          });
          if (!res.success) {
            const simLogs = res.sim?.logs || [];
            const assertLine = simLogs.find((l) => /assert|Error|failed|panic/i.test(l)) || "";
            console.log("[Reverse] sim failed:", JSON.stringify(res.sim?.err), simLogs);
            flash(`Reverse sim failed: ${assertLine || JSON.stringify(res.sim?.err || "unknown")}`, "err");
            setPhase("quoted"); setBridgeStage(0); updateHistory(histId, { status: "failed" });
            return;
          }
          if (res.sent || res.signature) {
            const sig = res.signature;
            setWarpSig(sig); setBridgeStage((s) => Math.max(s, 2)); setPhase("relaying");
            flash(`X1 burn sent (${sig?.slice(0,8)}…) — awaiting guardians`, "info");
            // Every stage below is gated on the REAL Warp API. No optimistic
            // timers: "Guardians signed" / "Released on Solana" must NEVER show
            // unless the bridge actually reports guardian sigs and a dest tx.
            const poll = await pollWarpStatus(sig, {
              api: WARP_API.mainnet, from: "x1", maxMs: 300000,
              onUpdate: (stage, detail) => {
                setWarpStatus({ stage, detail });
                if (stage === "status") setBridgeStage((s) => Math.max(s, 3));               // detected on X1
                if (stage === "guardians_signing" && (detail.count || 0) >= 1) setBridgeStage((s) => Math.max(s, 4));
              },
            }).catch((e) => ({ ok: false, error: e?.message }));

            if (poll?.ok && poll.destinationTx) {
              // Real release confirmed by the bridge.
              setBridgeStage(5); setDestTx(poll.destinationTx);
              if (isOnward) {
                updateHistory(histId, { status: "stage1_done" });
                rememberIntent({ routeType, from, to, token, toToken, amount: quote?.amount, solanaAmount: quote?.solanaAmount,
                  recvToken: quote?.recvToken, recvChain: quote?.recvChain, stage: "awaiting_stage2", histId, ts: Date.now() });
                setPhase("step2");
                flash("USDC landed on Solana ✓ — continue to finish the hop to " + (CHAINS[to]?.name || to), "success");
              } else {
                updateHistory(histId, { status: "done" });
                setPhase("done");
                flash(`USDC released on Solana ✓ — dest ${String(poll.destinationTx).slice(0, 8)}…`, "success");
              }
            } else {
              // NOT released yet. If guardians signed, offer a self-relay button.
              updateHistory(histId, { status: poll?.terminal ? "failed" : "relaying" });
              rememberIntent({ routeType, from, to, token, toToken, amount: quote?.amount, solanaAmount: quote?.solanaAmount,
                recvToken: quote?.recvToken, recvChain: quote?.recvChain, stage: "awaiting_relay", histId, warpSig: sig, ts: Date.now() });
              
              // If guardians signed, allow user to complete the release.
              if (warpStatus?.stage === "guardians_signing" && (warpStatus?.detail?.sigs?.length || 0) > 0) {
                const sigs = warpStatus.detail.sigs;
                setPhase("relay_ready");
                flash(`Guardians signed (${sigs.length} sigs) — tap "Complete release" to finish`, "info");
                // Store relay params for the button handler
                setPendingRelay({ sigs, seq: BigInt(quote?.seq || 0), sender: Buffer.from(quote?.sender || "", "base64"), amount: quote?.amount || 0, timestamp: quote?.timestamp || 0, histId });
              } else {
                setPhase("relaying");
                flash(`Waiting for guardians to sign. Source: ${String(sig).slice(0, 10)}…`, "info");
              }
            }
          }
        } catch (e) {
          console.error("[Reverse] error:", e);
          updateHistory(histId, { status: "failed" });
          setPhase("quoted");
          flash(e?.message || "X1→Solana bridge failed", "err");
        }
        return;
      }

      // LIVE: sign and send the real LiFi transaction (x1, direct)
      try {
        setPhase("bridging"); setProgress(0.1);
        // Source-aware signing: if the origin chain is Solana (e.g. direct
        // Solana→EVM), sign the Solana tx with the SVM wallet. Otherwise EVM.
        const solSource = from === "sol";
        const txHash = solSource
          ? await executeLiFiSolanaTx(quote.lifiData)
          : await executeLiFiTx(quote.lifiData);
        const landsOnSolanaForX1 = routeType === "x1"; // EVM->...->Solana, then Warp
        if (landsOnSolanaForX1 && !AUTO_X1_HOP) {
          // Stage 1 done: funds are arriving on Solana. Hand off to Warp Bridge.
          updateHistory(histId, { txHash, status: "handoff" });
          startStatusPoll(txHash, CHAINS[from].lifiKey, "sol", histId);
          setPhase("handoff");
          flash("Bridging to Solana… then finish on the official Warp Bridge.", "info");
          return;
        }
        updateHistory(histId, { txHash, status: twoStage ? "stage1_done" : "bridging" });
        if (twoStage && AUTO_X1_HOP) {
          rememberIntent({ routeType, from, to, token, toToken, amount: quote?.amount, solanaAmount: quote?.solanaAmount,
            recvToken: quote?.recvToken, recvChain: quote?.recvChain, stage: "awaiting_stage2",
            histId, ts: Date.now() });
          setPhase("step2");
          flash("Stage 1 sent. Approve Stage 2 to finish.", "info");
        } else {
          startStatusPoll(txHash, CHAINS[from].lifiKey, CHAINS[to].lifiKey, histId);
          flash("Bridge submitted — tracking…", "info");
        }
      } catch (e) {
        updateHistory(histId, { status: "failed" });
        setPhase("quoted");
        flash(e?.message?.includes("reject") || e?.code === 4001 ? "Transaction rejected" : (e.message || "Send failed"), "err");
      }
      return;
    }

    // DEMO: animated path
    setPhase("bridging"); setProgress(0);
    for (let p = 0; p <= 1.0001; p += 0.04) {
      setProgress(Math.min(1, p));
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 60));
    }
    if (twoStage) {
      rememberIntent({ routeType, from, to, token, toToken, amount: quote?.amount, solanaAmount: quote?.solanaAmount,
        recvToken: quote?.recvToken, recvChain: quote?.recvChain, stage: "awaiting_stage2", histId, ts: Date.now() });
      updateHistory(histId, { status: "stage1_done" });
      setPhase("step2");
      flash("Stage 1 landed. Approve Stage 2 to finish.", "info");
      return;
    }
    startStatusPoll("0xdemoStage1Hash", CHAINS[from].lifiKey, CHAINS[to].lifiKey, histId);
    flash("Bridge submitted — tracking…", "info");
  }, [routeType, from, to, token, toToken, quote, demoRouteDetail, extractRouteDetail, rememberIntent, startStatusPoll, executeLiFiTx, executeLiFiSolanaTx, updateHistory, solWallet, evmWallet, executeStage2]);


  // resume an interrupted hop from the recovery banner
  const resumePending = useCallback(() => {
    if (!pending) return;
    // restore the form to the pending route and jump to stage 2
    setFrom(pending.from); setTo(pending.to);
    setToken(pending.token); setToToken(pending.toToken);
    setAmount(String(pending.amount || ""));
    setQuote({
      amount: pending.amount, feeUsd: (pending.amount || 0) * INTEGRATOR_FEE,
      net: (pending.amount || 0) * (1 - INTEGRATOR_FEE),
      recvToken: pending.recvToken, recvChain: pending.recvChain,
      steps: [], resumed: true,
    });
    setPhase("step2");
    flash("Resuming your X1 hop — approve Stage 2", "info");
  }, [pending]);

  const reset = () => { setPhase("idle"); setQuote(null); setProgress(0); setTrackStatus(null); setRouteDetail(null); };

  // ───────────────────────────────────────────────────────────────────────────
  //  FEATURE 1 — TOKEN BALANCES  (read the connected wallet)
  // ───────────────────────────────────────────────────────────────────────────
  // EVM: eth_call balanceOf on the token contract. SVM: getTokenAccountsByOwner.
  // In DEMO_MODE we synthesize believable balances so the UI is testable.
  const active = phase === "bridging" || phase === "step2" || phase === "handoff" || phase === "relaying";

  if (showSplash) {
    return (
      <div style={{
        minHeight: "100vh",
        background: "radial-gradient(ellipse 70% 55% at 50% -5%, rgba(63,211,232,.10), transparent 70%), #06101b",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: "48px 24px",
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      }}>
        <div style={{ width: "100%", maxWidth: 980, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <img
            src="/hero.png"
            alt="X1 Teleporter — Stables From Any-Chain to Any-Chain including X1"
            style={{
              width: "100%", height: "auto", borderRadius: 20, display: "block",
              boxShadow: "0 30px 90px rgba(0,0,0,.55), 0 0 90px rgba(63,211,232,.16)",
            }}
          />
          <div style={{ marginTop: 44, display: "flex", flexDirection: "column", alignItems: "center", gap: 22, width: "100%" }}>
            <button
              onClick={() => setShowSplash(false)}
              style={{
                background: "linear-gradient(90deg,#2775E8,#1e9fd4)", color: "#fff", border: "none",
                borderRadius: 14, padding: "19px 60px", fontSize: 20, fontWeight: 800, letterSpacing: ".03em",
                cursor: "pointer",
                boxShadow: "0 12px 40px rgba(39,117,232,.45), inset 0 0 0 1px rgba(63,211,232,.3)",
              }}
            >
              Launch App
            </button>
            <div style={{ color: "#8aa0bd", fontSize: 15, lineHeight: 1.65, maxWidth: 460 }}>
              Bridge stablecoins across chains — <b style={{ color: "#3fd3e8" }}>land on X1 as USDC.x</b>, or anywhere you need.
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
              {["Any chain → any chain", "Auto-routed", "X1 native (USDC.x)"].map((b) => (
                <span key={b} style={{ fontSize: 12, color: "#3fd3e8", border: "1px solid rgba(63,211,232,.25)", borderRadius: 999, padding: "7px 16px" }}>{b}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={S.root}>
      <style>{`@keyframes pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.8); } }`}</style>
      <PortalBackground />
      <div style={S.shell}>
        {/* header */}
        <header style={S.header}>
          <div style={S.brand}>
            <span style={S.brandMark}>X1</span>
            <div>
              <div style={S.brandName}>TELEPORTER</div>
              <div style={S.brandSub}>stablecoin routing · any chain → X1</div>
            </div>
          </div>
          <div style={S.walletBar}>
            <button onClick={() => setShowSettings((v) => !v)} style={{ ...S.walletPill, borderColor: "#28303f", padding: "8px 11px" }} title="Settings">
              <span style={{ fontSize: 15 }}>⚙</span>
            </button>
            {history.length > 0 && (
              <button onClick={() => setShowHistory((v) => !v)} style={{ ...S.walletPill, borderColor: "#28303f" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>History ({history.length})</span>
              </button>
            )}
            {(() => {
              const fromVm = CHAINS[from].walletType; // "evm" | "solana"
              const toVm = CHAINS[to].walletType;
              // ORIGIN wallet = whatever VM the source chain needs
              const originPill = fromVm === "evm"
                ? <WalletPill role="ORIGIN" type="evm" connected={!!evmWallet}
                    addr={evmWallet?.addr || ""} busy={connecting === "evm"} onClick={connectEvm} />
                : <WalletPill role="ORIGIN" type="solana" connected={!!solWallet}
                    addr={solWallet?.addr || ""} busy={connecting === "solana"} onClick={connectSol} />;
              // DEST wallet = whatever VM the destination chain needs.
              // If same VM as origin, the same wallet receives — show it as DEST
              // but it's already connected via origin (no separate connect needed).
              let destPill = null;
              if (toVm === fromVm) {
                // same VM end-to-end: destination = the origin wallet's address
                const w = fromVm === "evm" ? evmWallet : solWallet;
                destPill = <WalletPill role="DEST" type={toVm} connected={!!w}
                  addr={w?.addr || ""} busy={false}
                  onClick={fromVm === "evm" ? connectEvm : connectSol} />;
              } else {
                // cross-VM: destination needs the OTHER wallet
                destPill = toVm === "evm"
                  ? <WalletPill role="DEST" type="evm" connected={!!evmWallet}
                      addr={evmWallet?.addr || ""} busy={connecting === "evm"} onClick={connectEvm} />
                  : <WalletPill role="DEST" type="solana" connected={!!solWallet}
                      addr={solWallet?.addr || ""} busy={connecting === "solana"} onClick={connectSol} />;
              }
              return <>{originPill}{destPill}</>;
            })()}
          </div>
        </header>

        {/* route badge */}
        <div style={S.routeBadge}>
          <span style={{ ...S.routeDot, background: CHAINS[to]?.color || "#2775E8" }} />
          {ROUTE_LABEL[routeType]}
          {(routeType === "x1" || routeType === "x1_reverse") && (
            <span style={S.twoStage}>2 signatures</span>
          )}
        </div>

        {/* recovery banner — finish an interrupted X1 hop */}
        {pending && phase !== "step2" && phase !== "bridging" && (
          <div style={S.recoverBanner}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#2775E8" }}>Unfinished X1 hop</div>
              <div style={{ fontSize: 12, color: "#9aa6bb", marginTop: 2 }}>
                Your {pending.amount} {pending.token} reached Solana but didn't finish to {pending.recvChain}.
                Your funds are safe — resume any time.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              <button style={S.recoverBtn} onClick={resumePending}>Finish</button>
              <button style={S.recoverDismiss} onClick={clearIntent}>Dismiss</button>
            </div>
          </div>
        )}

        {/* settings panel */}
        {showSettings && (
          <div style={S.settingsPanel}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>Settings</span>
              <button onClick={() => setShowSettings(false)} style={S.recoverDismiss}>Close</button>
            </div>

            <div style={S.fieldLabel}>Slippage tolerance</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              {[0.1, 0.5, 1.0].map((s) => (
                <button key={s} onClick={() => setSlippage(s)}
                  style={{ ...S.slipBtn, ...(slippage === s ? S.slipBtnActive : {}) }}>
                  {s}%
                </button>
              ))}
              <input value={slippage} onChange={(e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0 && v <= 50) setSlippage(v); }}
                inputMode="decimal" style={S.slipInput} />
            </div>

            <div style={S.fieldLabel}>Bridge fee</div>
            <div style={{ fontSize: 13, color: "#9aa6bb", lineHeight: 1.5 }}>
              A {(INTEGRATOR_FEE * 100).toFixed(0)}% fee is included in every quote, collected by LiFi
              on routes through an EVM chain, and at mint on the Solana↔X1 hop.
              The quote's "you receive" already reflects it — no hidden charges.
            </div>
          </div>
        )}

        {/* card */}
        <div style={S.card}>
          {/* from / to selectors */}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
            <ChainSelect label="From" value={from} onChange={setFrom} exclude={to} />
            <button style={S.swapBtn} onClick={() => { const f = from; setFrom(to); setTo(f); }}>⇄</button>
            <ChainSelect label="To" value={to} onChange={setTo} exclude={from} />
          </div>

          {/* token + amount */}
          <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
            <div style={{ width: 130 }}>
              <div style={S.fieldLabel}>Token</div>
              <div style={S.selectWrap}>
                <select value={token} onChange={(e) => setToken(e.target.value)} style={S.select}>
                  {tokensFor(from).map((t) => <option key={t} value={t} style={S.opt}>{t}</option>)}
                </select>
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <div style={S.fieldLabel}>Amount</div>
                <div style={{ fontSize: 11, color: "#7d8aa0", display: "flex", gap: 6, alignItems: "center" }}>
                  {loadingBal ? "…" : currentBalance != null ? (
                    <>
                      <span>Bal: {currentBalance}</span>
                      <button onClick={setMax} style={S.maxBtn}>MAX</button>
                    </>
                  ) : (solWallet || evmWallet) ? (
                    <span title="Couldn't read balance — check your RPC (VITE_SOLANA_RPC)">Bal: —</span>
                  ) : null}
                </div>
              </div>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal"
                placeholder="0.00" style={S.amountInput} />
              {(routeType === "x1" || routeType === "sol_x1") && (
                <div style={{ fontSize: 11, color: "#5B9DFF", marginTop: 6, paddingLeft: 2 }}>
                  Bridge ${X1_MIN}+ into X1 to get started
                </div>
              )}
              {(routeType === "x1_reverse" || routeType === "x1_onward") && (
                <div style={{ fontSize: 11, color: "#5B9DFF", marginTop: 6, paddingLeft: 2 }}>
                  Bridge ${X1_REVERSE_MIN}+ out of X1 to get started
                </div>
              )}
            </div>
          </div>

          {/* destination token: direct + onward can choose; x1_reverse is fixed
              to Solana USDC (that's what the Warp bridge releases). */}
          {(routeType === "direct" || routeType === "x1_onward") && (
            <div style={{ marginTop: 12 }}>
              <div style={S.fieldLabel}>Receive token on {CHAINS[to]?.name || to}</div>
              <div style={{ ...S.selectWrap, maxWidth: 180 }}>
                <select value={toToken} onChange={(e) => setToToken(e.target.value)} style={S.select}>
                  {tokensFor(to).map((t) => <option key={t} value={t} style={S.opt}>{t}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* visualizer */}
          <div style={S.vizWrap}>
            <RouteVisualizer hops={hops} active={active} progress={progress} />
          </div>

          {/* quote panel */}
          {quote && (
            <div style={S.quoteBox}>
              <Row k="You send" v={`${quote.amount} ${token} on ${CHAINS[from].name}`} />
              <Row k={quote.feeUsd > 0 ? "Teleporter fee (1%)" : "Fee"} v={`$${(quote.feeUsd || 0).toFixed(2)}`} dim />
              {quote.bridgeFee > 0 && (
                <Row k="X1 bridge fee" v={`$${quote.bridgeFee.toFixed(2)}`} dim />
              )}
              <Row k="You receive" v={`≈ ${quote.net.toFixed(2)} ${quote.recvToken} on ${quote.recvChain}`} hi />
              {quote.note && <div style={{ fontSize: 11, color: "#7d8aa0", marginTop: 4 }}>{quote.note}</div>}
              <div style={S.stepStrip}>
                {quote.steps.map((s, i) => (
                  <span key={i} style={S.stepChip}>
                    {s.tool}<span style={{ color: "#475065" }}> · {s.name}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* route detail — which bridges LiFi chose */}
          {routeDetail && (phase === "bridging" || phase === "step2" || phase === "handoff" || phase === "done") && (
            <div style={S.detailBox}>
              <div style={S.detailHead}>Route</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {routeDetail.tools.map((t, i) => (
                  <React.Fragment key={i}>
                    <span style={S.toolChip}>
                      <span style={{ color: t.type === "bridge" ? "#2775E8" : "#9945FF" }}>●</span> {t.name}
                    </span>
                    {i < routeDetail.tools.length - 1 && <span style={{ color: "#475065" }}>→</span>}
                  </React.Fragment>
                ))}
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 11, color: "#7d8aa0" }}>
                {routeDetail.seconds != null && <span>~{routeDetail.seconds}s</span>}
                {routeDetail.gasUsd != null && <span>gas ≈ ${routeDetail.gasUsd.toFixed(2)}</span>}
              </div>
            </div>
          )}

          {/* live status tracker */}
          {trackStatus && (
            <div style={{ ...S.statusBox, borderColor: trackStatus.state === "DONE" ? "#1f6b3a" : trackStatus.state === "FAILED" ? "#6b1f1f" : "#1a2130" }}>
              <span style={{
                ...S.statusDot,
                background: trackStatus.state === "DONE" ? "#5ee08a" : trackStatus.state === "FAILED" ? "#E84142" : "#2775E8",
                animation: trackStatus.state === "PENDING" ? "pulse 1.2s infinite" : "none",
              }} />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{trackStatus.label}</span>
            </div>
          )}
          {/* pre-quote advisory: instant heads-up on thin combinations */}
          {advisory && (phase === "idle" || phase === "quoting") && (
            <div style={{
              marginTop: 14, padding: "10px 12px", borderRadius: 10,
              background: "rgba(240,185,11,.08)", border: "1px solid rgba(240,185,11,.28)",
              color: "#E8C04A", fontSize: 12, lineHeight: 1.5, display: "flex", gap: 8, alignItems: "flex-start",
            }}>
              <span style={{ flexShrink: 0 }}>⚠️</span>
              <span>{advisory}</span>
            </div>
          )}
          <div style={{ marginTop: 18 }}>
            {phase === "idle" || phase === "quoting" ? (
              <button style={S.cta} onClick={getQuote} disabled={phase === "quoting"}>
                {phase === "quoting" ? "Finding route…" : "Get quote"}
              </button>
            ) : phase === "quoted" ? (
              <button style={S.cta} onClick={execute}>
                {(routeType === "x1" || routeType === "sol_x1") && !AUTO_X1_HOP
                  ? "Bridge to Solana → then Warp"
                  : routeType === "x1" || routeType === "x1_onward" ? "Bridge — Step 1 of 2" : "Bridge now"}
              </button>
            ) : phase === "bridging" ? (
              <button style={{ ...S.cta, opacity: 0.7 }} disabled>Bridging… {(progress * 100).toFixed(0)}%</button>
            ) : phase === "step2" ? (
              <button style={{ ...S.cta, background: "linear-gradient(90deg,#1B5FCC,#5B9DFF)" }} onClick={executeStep2}>
                Step 2 of 2 — sign with {solWallet?.label || "your wallet"} →
              </button>
            ) : phase === "handoff" ? (
              <a href={WARP_BRIDGE_URL} target="_blank" rel="noopener noreferrer"
                 style={{ ...S.cta, background: "linear-gradient(90deg,#1B5FCC,#5B9DFF)", textDecoration: "none", display: "block", textAlign: "center" }}>
                🌉 Open Warp Bridge to finish → X1
              </a>
            ) : phase === "relay_ready" ? (
              <button style={{ ...S.cta, background: "linear-gradient(90deg,#1B5FCC,#5B9DFF)" }} onClick={executeRelay} disabled={relayLoading}>
                {relayLoading ? "Completing release…" : "✓ Complete release"}
              </button>
            ) : phase === "done" ? (
              <button style={{ ...S.cta, background: "#16321f", color: "#5ee08a", borderColor: "#1f6b3a" }} onClick={reset}>
                ✓ Complete — bridge again
              </button>
            ) : null}
            {phase === "handoff" && (
              <button style={{ ...S.cta, marginTop: 8, background: "transparent", color: "#7d8aa0", borderColor: "#1a2130" }} onClick={reset}>
                Done / bridge again
              </button>
            )}
          </div>

          {/* step2 helper note */}
          {phase === "step2" && (
            <div style={S.helper}>
              {routeType === "x1_onward" ? (
                <>Leg 1 confirmed — your USDC landed on Solana. Approve Leg 2 to finish
                the hop to {CHAINS[to]?.name || to}. If you stop here, your funds rest
                safely as USDC on Solana and you can finish any time.</>
              ) : (
                <>Stage 1 confirmed — your USDC landed on Solana. Approve Stage 2 to mint
                USDC.x on X1. If you stop here, your funds rest safely as USDC on Solana
                and you can finish any time.</>
              )}
            </div>
          )}

          {/* X1 handoff card — Teleporter brings you to Solana; Warp Bridge
              takes you the final hop to X1. */}
          {phase === "handoff" && (
            <div style={{ ...S.helper, borderColor: "#1f6b3a", lineHeight: 1.5 }}>
              <div style={{ fontWeight: 700, color: "#cfe0ff", marginBottom: 4 }}>🌉 Continue to X1</div>
              Your USDC is on Solana now. To get USDC.x on X1, finish the final hop on
              the official <b>Warp Bridge</b> — connect the same Solana wallet, pick
              Solana → X1, and bridge. Teleporter brings you to Solana; Warp Bridge
              takes you to X1.
              <div style={{ fontSize: 11, color: "#7d8aa0", marginTop: 6 }}>
                Solana ✓ ----- X1 (finish on Warp Bridge)
              </div>
            </div>
          )}

          {/* Bridge progress — 5 benchmark bars + success/tx hash */}
          {(phase === "relaying" || phase === "done") && (warpSig || bridgeStage > 0) && (
            <BridgeProgress
              stage={bridgeStage}
              sourceSig={warpSig}
              destTx={destTx}
              failed={phase === "failed"}
              reverse={routeType === "x1_reverse" || routeType === "x1_onward"}
              sigCount={warpStatus?.detail?.count || 0}
            />
          )}
        </div>

        {/* transaction history */}
        {showHistory && history.length > 0 && (
          <div style={S.historyPanel}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>Bridge history</span>
              <button onClick={() => setHistory([])} style={S.recoverDismiss}>Clear</button>
            </div>
            {history.map((h) => (
              <div key={h.id} style={S.histRow}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>
                    {h.amount} {h.token} · {CHAINS[h.from]?.name} → {h.recvChain || CHAINS[h.to]?.name}
                  </span>
                  <span style={{ fontSize: 11, color: "#7d8aa0" }}>
                    {new Date(h.ts).toLocaleString()} · {ROUTE_LABEL[h.routeType] || h.routeType}
                  </span>
                </div>
                <span style={{
                  ...S.histStatus,
                  color: h.status === "done" ? "#5ee08a" : h.status === "failed" ? "#E84142" : "#2775E8",
                  borderColor: h.status === "done" ? "#1f6b3a" : h.status === "failed" ? "#6b1f1f" : "#1a3a6b",
                }}>
                  {h.status === "done" ? "✓ done" : h.status === "failed" ? "✕ failed"
                    : h.status === "stage1_done" ? "● stage 2" : "● pending"}
                </span>
              </div>
            ))}
          </div>
        )}

        <div style={S.foot}>
          {DEMO_MODE
            ? "Demo mode · no funds move · simulated quotes & bridge"
            : WARP_LIVE_SEND
              ? "Live · real quotes, fees & bridging active"
              : "Live quotes & fees · Warp send in confirm-mode (simulates, awaiting final go-live)"}
        </div>
      </div>

      {walletMenu && (
        <div onClick={() => setWalletMenu(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(2,6,14,0.72)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()}
            style={{ background: "#0c1320", border: "1px solid #232c3c", borderRadius: 16,
              padding: 18, width: 300, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#e8edf6", marginBottom: 4 }}>
              Choose a wallet
            </div>
            <div style={{ fontSize: 12, color: "#7d8aa0", marginBottom: 14 }}>
              Select which Solana/X1 wallet to connect.
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {listSolProviders().map((entry) => (
                <button key={entry.key} onClick={() => connectSolProvider(entry)}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    background: "rgba(39,117,232,0.08)", border: "1px solid #1a3a6b",
                    borderRadius: 12, padding: "12px 14px", color: "#e8edf6",
                    fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
                  <span>{entry.label}</span>
                  <span style={{ color: "#5B9DFF", fontSize: 12 }}>Connect →</span>
                </button>
              ))}
            </div>
            <button onClick={() => setWalletMenu(false)}
              style={{ marginTop: 14, width: "100%", background: "transparent",
                border: "1px solid #232c3c", borderRadius: 10, padding: "9px",
                color: "#7d8aa0", fontSize: 13, cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div style={{ ...S.toast, borderColor: toast.kind === "err" ? "#E84142" : toast.kind === "success" ? "#1f6b3a" : "#28303f" }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// 5-benchmark bridge progress — bars fill green as each stage completes.
const BRIDGE_STEPS_FWD = [
  "Transaction built", "Bridge-out sent", "Detected on Solana",
  "Guardians signed", "Minted on X1",
];
const BRIDGE_STEPS_REV = [
  "Transaction built", "Burn sent on X1", "Detected on X1",
  "Guardians signed", "Released on Solana",
];
function BridgeProgress({ stage, sourceSig, destTx, failed, reverse, sigCount }) {
  const done = stage >= 5 && !failed;
  const STEPS = reverse ? BRIDGE_STEPS_REV : BRIDGE_STEPS_FWD;
  const activeTitle = reverse ? "⚡ Bridging X1 → Solana…" : "⚡ Bridging to X1…";
  return (
    <div style={{
      border: `1px solid ${done ? "#1f6b3a" : failed ? "#6b1f1f" : "#2775E8"}`,
      borderRadius: 14, padding: "16px 16px 14px", marginTop: 12,
      background: "linear-gradient(180deg, rgba(39,117,232,.05), transparent)",
    }}>
      <div style={{ fontWeight: 700, color: done ? "#5ee08a" : "#cfe0ff", fontSize: 14, marginBottom: 12 }}>
        {done ? "✅ Bridge successful" : failed ? "✗ Bridge failed" : activeTitle}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {STEPS.map((label, i) => {
          const isDone = stage > i;
          const isActive = stage === i && !done && !failed;
          // Guardian step (index 3): append the real signature count if we have it.
          const shownLabel = (i === 3 && sigCount > 0) ? `${label} (${sigCount})` : label;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 18, height: 18, borderRadius: 999, flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: isDone ? "#1f6b3a" : isActive ? "transparent" : "#161d2b",
                border: isDone ? "1px solid #5ee08a" : isActive ? "2px solid #2775E8" : "1px solid #28303f",
                animation: isActive ? "pulse 1.2s infinite" : "none",
              }}>{isDone && <span style={{ color: "#5ee08a", fontSize: 11, fontWeight: 800 }}>✓</span>}</div>
              <div style={{ flex: 1 }}>
                <div style={{ height: 6, borderRadius: 999, overflow: "hidden", background: "#161d2b" }}>
                  <div style={{
                    height: "100%", borderRadius: 999,
                    width: isDone ? "100%" : isActive ? "55%" : "0%",
                    background: isDone ? "linear-gradient(90deg,#1f6b3a,#5ee08a)" : "linear-gradient(90deg,#1B5FCC,#5B9DFF)",
                    transition: "width .5s ease",
                  }} />
                </div>
              </div>
              <div style={{
                fontSize: 11.5, width: 130, textAlign: "right",
                color: isDone ? "#5ee08a" : isActive ? "#cfe0ff" : "#5d6b82",
                fontWeight: isDone || isActive ? 600 : 400,
              }}>{shownLabel}</div>
            </div>
          );
        })}
      </div>
      {(sourceSig || destTx) && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #1a2130", fontSize: 11, lineHeight: 1.6 }}>
          {sourceSig && (
            <div style={{ color: "#7d8aa0", wordBreak: "break-all" }}>
              <span style={{ color: "#5d6b82" }}>{reverse ? "X1 burn tx:" : "source tx:"}</span>{" "}
              {reverse ? <span style={{ color: "#5B9DFF" }}>{sourceSig}</span>
                : <a href={`https://solscan.io/tx/${sourceSig}`} target="_blank" rel="noopener noreferrer" style={{ color: "#5B9DFF", textDecoration: "none" }}>{sourceSig}</a>}
            </div>
          )}
          {destTx && (
            <div style={{ color: "#7d8aa0", wordBreak: "break-all", marginTop: 4 }}>
              <span style={{ color: "#5d6b82" }}>{reverse ? "Solana release tx:" : "X1 mint tx:"}</span>{" "}
              {reverse ? <a href={`https://solscan.io/tx/${destTx}`} target="_blank" rel="noopener noreferrer" style={{ color: "#5ee08a", textDecoration: "none" }}>{destTx}</a>
                : <span style={{ color: "#5ee08a" }}>{destTx}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ k, v, dim, hi }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0" }}>
      <span style={{ color: "#7d8aa0", fontSize: 13 }}>{k}</span>
      <span style={{ color: hi ? "#2775E8" : dim ? "#9aa6bb" : "#e8edf6", fontSize: 13, fontWeight: hi ? 700 : 600 }}>{v}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  STYLES
// ─────────────────────────────────────────────────────────────────────────────

