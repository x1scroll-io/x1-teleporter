/**
 * teleportRail.js — the RAIL-SELECTION LAYER for the unified Teleport Console
 * (2026-09-04 UX pass — Mr. Esters: ONE flow, no rail tabs, no Buy tab).
 *
 * The user never chooses a rail. They pick a SOURCE ASSET (what they have)
 * and a DESTINATION (where it's going); this layer decides which engine path
 * carries the journey — invisibly, after the pick, before execution:
 *
 *   - BTC / DOGE / LTC / XRP  (native chains)  → the THORChain rail
 *       (deposit-address execution: vault address + memo + txid-paste —
 *        the send happens OUT-OF-BAND in the user's own external wallet).
 *       Phase 5: Rango is the silent FALLBACK rail for these sources when
 *       THORChain is unavailable (the SOL-halt lesson).
 *   - SUI / TRON (Rango-native sources — RANGO_CHAINS) → the Rango rail
 *       (Phase 5 registry: THORChain can't serve them; the console's source
 *        picker adopts them in a later phase).
 *   - EVM-chain stables (USDC/USDT/DAI on Ethereum/Arbitrum/Base/…) and X1
 *     tokens (USDC.x / wSOL.X)                  → the LiFi/Warp rail
 *       (wallet-connect execution: connect the source wallet and sign —
 *        LiFi legs + the Warp hop into/out of X1).
 *
 * The rail list is PRIORITY-ORDERED per source with silent failover: when
 * the top-priority rail cannot serve the route (e.g. a halted carrier),
 * pickRail falls through the candidates instead of erroring. The user only
 * ever sees the OUTCOME (a deposit-address step or a wallet-connect step) —
 * never a rail name.
 *
 * PHASE-5 (Rango — 2026-09-05): the Rango aggregator rail joins as (a) the
 * FALLBACK candidate for the native chains (BTC/DOGE/LTC/XRP) — the live
 * THORChain SOL-halt lesson: when THORChain is unavailable, Rango (which
 * wraps THORChain/Mayan + its own bridges for SUI/TRON/XRPL/…) can still
 * serve the source → SOL leg — and (b) the SERVING rail for the
 * Rango-native source chains THORChain can't serve at all (SUI / TRON —
 * RANGO_CHAINS below; the console's source picker adopts them in a later
 * phase; the registry is the seam, the rail layer never renders names).
 * Rango's execution is wallet-connect-shaped (its create-tx returns the
 * transaction the user signs); the exact step UI for each source chain is a
 * live-test open item (a Rango BTC route may surface a deposit-style step
 * when the best swapper is THORChain/Mayan — the console renders from the
 * create-tx response shape once the live lane lands).
 *
 * WANCHAIN-FAMILY (VERIFIED 2026-09-05 — see the COVERAGE_MATRIX below):
 * the Wanchain family's only public quote+buildTx HTTP API (XFlows v3)
 * was probed live for every source this console lists. Result: it quotes
 * EVM-chain pairs ONLY — every non-EVM route failed (ADA→SOL, ADA→WAN,
 * BTC→SOL, TRX→SOL, and even the EVM control USDC(ETH)→SOL: "no token
 * pair for SOL"). The docs' supported-chains matrix (Cardano/Sui/Polkadot/
 * Solana/Tron/UTXOs under "WanBridge") describes the bridge.wanchain.org
 * PORTAL product (storeman bridge-node group) whose quotes are on-chain
 * iWan calls, NOT a public REST API — so the Wanchain rail is registered
 * here (RAIL.WANCHAIN + RAIL_LABELS + executionFor) but appears in ZERO
 * per-source candidate lists: no console source is served by it today.
 * Evidence: test/fixtures/golden/wanchain-leg/VERIFICATION-2026-09-05.json.
 * When a route the app needs becomes quotable, RE-VERIFY live first, add
 * the source row to WANCHAIN_SOURCES (src/lib/wanchain/config.js) and to
 * the COVERAGE_MATRIX below — all three together.
 *
 * ⚠️ CONSOLE BOUNDARY (read before wiring the halt fallback): the console
 * (TeleportConsole.jsx) calls pickRail WITHOUT unavailableRails today, so
 * natives still resolve to THORCHAIN and NO console behavior changed with
 * this phase. Do NOT start passing unavailableRails: [THORCHAIN] at the
 * console until the Rango execution step UI exists — a RANGO rail result
 * currently has no console step behind it (its runQuote guards key off
 * RAIL.THORCHAIN and would mis-handle a RANGO rail as an EVM source). The
 * rail layer KNOWS Rango now; the console WIRES it in a later phase.
 *
 * "THORChain" is an ENGINE PATH ONLY here. Nothing in this module's data is
 * rendered to the user; RAIL_LABELS exists solely for diagnostics/logging.
 *
 * PURE MODULE: no DOM, no fetch, no wallet. Runnable under `node --test`.
 * This is console-layer routing (UI consolidation) — the engine's
 * RoutePlanner (planForward/planReverse/planThorchain/… + composeRoute)
 * is untouched; this layer only PICKS which planner path the console drives.
 */
import { CHAINS, EVM_CHAINS, TOKENS, tokensFor } from "./teleportConstants.js";

/** The engine rails the console can drive. Internal names — never rendered. */
export const RAIL = Object.freeze({
  /** LiFi legs + the Warp hop (EVM stables → X1; X1 → EVM reverse). */
  LIFI_WARP: "lifi-warp",
  /** Native BTC/DOGE/LTC/XRP → SOL → X1 — the deposit-address lane. */
  THORCHAIN: "thorchain",
  /** Rango (the multi-chain aggregator — Phase 5): the fallback rail for
   *  the native sources when THORChain is unavailable, and the serving rail
   *  for the Rango-native sources (SUI/TRON — RANGO_CHAINS) THORChain
   *  can't serve. Execution is wallet-connect-shaped (create-tx → sign). */
  RANGO: "rango",
  /** Wanchain-family (XFlows v3 — VERIFIED 2026-09-05): registered so the
   *  rail layer + engine can name it, but NOT a candidate for any current
   *  console source (the live quote API serves EVM pairs only — see the
   *  COVERAGE_MATRIX). */
  WANCHAIN: "wanchain",
  /** ChangeNow (instant-swap, 2026-09-15): a non-custodial deposit-address
   *  swap service. Serves what THORChain can't — Cardano (ADA) and any pair
   *  below THORChain's per-chain minimum — and is the small-swap fallback when
   *  a pool rail's fees/slippage are worse. Centralised (trust the operator to
   *  complete); KYC above a threshold, surfaced BEFORE commit. */
  INSTANTSWAP: "instantswap",
  /** Circle CCTP (2026-09-15): permissionless burn-and-mint native USDC. The
   *  stablecoin lane for CCTP-supported chains (EVM + Solana + Aptos/Sui/Noble).
   *  No pool, no slippage; keyless (public Iris attestation). X1 is NOT a CCTP
   *  chain and is never advertised as one — the X1 hop stays Warp. */
  CCTP: "cctp",
});

/** Diagnostics only — never rendered to the user (rail names are invisible). */
export const RAIL_LABELS = Object.freeze({
  [RAIL.LIFI_WARP]: "LiFi/Warp",
  [RAIL.THORCHAIN]: "THORChain",
  [RAIL.RANGO]: "Rango",
  [RAIL.WANCHAIN]: "Wanchain",
  [RAIL.INSTANTSWAP]: "Instant-swap",
  [RAIL.CCTP]: "CCTP",
});

/** The two FINAL-EXECUTION shapes the console routes into. The user sees the
 *  shape, never the rail: a deposit-address step (copy the vault address +
 *  memo, send from their own wallet, paste the txid) or a wallet-connect
 *  step (connect + sign in-app). */
export const EXECUTION = Object.freeze({
  DEPOSIT_ADDRESS: "deposit-address",
  WALLET_CONNECT: "wallet-connect",
});

/** Native-source chains carried by the THORChain rail (their only rail).
 *  `asset` is the single token each chain carries; `family` maps to the
 *  WalletContext session family (refund-address prefill); `symbol` is the
 *  deposit-stage source id (BTC/DOGE/LTC/XRP — THORChain's own ids). */
export const NATIVE_CHAINS = Object.freeze({
  btc: { id: "btc", name: "Bitcoin", glyph: "₿", asset: "BTC", decimals: 8, family: "bitcoin" },
  doge: { id: "doge", name: "Dogecoin", glyph: "Ð", asset: "DOGE", decimals: 8, family: "dogecoin" },
  ltc: { id: "ltc", name: "Litecoin", glyph: "Ł", asset: "LTC", decimals: 8, family: "litecoin" },
  xrp: { id: "xrp", name: "XRP", glyph: "✕", asset: "XRP", decimals: 6, family: "xrp" },
});

/** The native chain ids, in display order. */
export const NATIVE_CHAIN_IDS = Object.freeze(Object.keys(NATIVE_CHAINS));

/** True when the chain is a native (THORChain-rail) source. */
export function isNativeChain(chain) {
  return Object.prototype.hasOwnProperty.call(NATIVE_CHAINS, chain);
}

/**
 * The Rango-NATIVE source chains (Phase 5): sources THORChain can't serve
 * that Rango does — their only rail is Rango. `asset` is the canonical
 * Rango asset string (verified live 2026-09-05 — /basic/meta + real
 * quotes); `family` notes the wallet family a future console phase would
 * map. CARDANO/Polkadot are NOT here — Rango does not serve them today
 * (verified live; re-add only when Rango's /basic/meta lists them).
 */
export const RANGO_CHAINS = Object.freeze({
  sui: { id: "sui", name: "Sui", glyph: "", asset: "SUI.SUI", family: "sui" },
  tron: { id: "tron", name: "Tron", glyph: "", asset: "TRON.TRX", family: "tron" },
});

/** The Rango-native chain ids. */
export const RANGO_CHAIN_IDS = Object.freeze(Object.keys(RANGO_CHAINS));

/** True when the chain is a Rango-native source (Rango is its only rail). */
export function isRangoChain(chain) {
  return Object.prototype.hasOwnProperty.call(RANGO_CHAINS, chain);
}

/**
 * The LONG-TAIL source chains (2026-09-26 — the ChangeNOW rail): the sources
 * the DEX rails CANNOT serve — the privacy coins (XMR/ZEC/DASH; a DEX cannot
 * route them) and chains with no native rail wired (ADA/ATOM/NEAR/BCH + the
 * second wave: ALGO/XTZ/FIL/HBAR/VET/THETA/OSMO). They are NOT DEX-routable,
 * so they FALL THROUGH to ChangeNOW (RAIL.INSTANTSWAP — deposit-address
 * execution: the user sends from their own external wallet; the console never
 * signs). This is the "any token anywhere" tail the DEX rails leave behind —
 * ChangeNOW is their SERVING rail, not a fallback behind a DEX.
 *
 * VERIFIED LIVE against ChangeNOW's /v1/currencies + /v2/exchange/estimated-amount
 * (2026-09-26): xmr, ada, atom, near, zec, dash and bch are all listed and
 * quotable. SECOND WAVE (2026-09-27) VERIFIED LIVE against ChangeNOW's
 * /v1/currencies + /v2/exchange/currencies (flow=standard): algo, xtz, fil,
 * hbar, vet, theta and osmo are all listed; their NATIVE network equals the
 * ticker (ChangeNOW keys the native token to the ticker — e.g. fromNetwork="algo"
 * for Algorand, NOT "algorand"). XTZ/FIL/VET also carry a `bsc` WRAPPED
 * variant — pinning fromNetwork is what keeps the rail off the wrong token.
 * Polkadot (DOT) is NOT supported as a native source by ChangeNOW (only bsc /
 * assethub WRAPPED rows exist, no native DOT) — it stays unofferable
 * (COVERAGE_MATRIX.polkadot = []) and is deliberately absent here.
 *
 *   `ticker`   = the ChangeNOW `fromCurrency` (its canonical code),
 *   `network`  = the `fromNetwork` query/body param. These are single-network
 *                assets — a same-name ticker on another chain is a DIFFERENT
 *                asset — so the network is PINNED and always sent by the rail
 *                (see src/lib/changenow/index.js). Omitting it lets ChangeNOW
 *                guess, which can price the wrong asset: never omit it.
 *   `asset`    = the console's single-token id on the chain,
 *   `decimals` = display-only (the wallet never signs — the send is out-of-band),
 *   `family`   = the wallet family an external-wallet connect would map to.
 */
export const LONGTAIL_CHAINS = Object.freeze({
  xmr:  { id: "xmr",  name: "Monero",       glyph: "ɱ", asset: "XMR",  decimals: 12, ticker: "xmr",  network: "xmr",  family: "monero" },
  ada:  { id: "ada",  name: "Cardano",      glyph: "₳", asset: "ADA",  decimals: 6,  ticker: "ada",  network: "ada",  family: "cardano" },
  atom: { id: "atom", name: "Cosmos",       glyph: "⚛", asset: "ATOM", decimals: 6,  ticker: "atom", network: "atom", family: "cosmos" },
  near: { id: "near", name: "NEAR",         glyph: "Ⓝ", asset: "NEAR", decimals: 24, ticker: "near", network: "near", family: "near" },
  zec:  { id: "zec",  name: "Zcash",        glyph: "ⓩ", asset: "ZEC",  decimals: 8,  ticker: "zec",  network: "zec",  family: "zcash" },
  dash: { id: "dash", name: "Dash",         glyph: "Đ", asset: "DASH", decimals: 8,  ticker: "dash", network: "dash", family: "dash" },
  bch:  { id: "bch",  name: "Bitcoin Cash", glyph: "Ƀ", asset: "BCH",  decimals: 8,  ticker: "bch",  network: "bch",  family: "bitcoincash" },
  // ── Second wave (2026-09-27): verified live against ChangeNOW's currencies
  //    API. Each is single-network and the NATIVE network string equals the
  //    ticker; XTZ/FIL/VET also have a bsc WRAPPED variant, so the pinned
  //    network is what prevents a cross to the wrong asset.
  algo: { id: "algo", name: "Algorand",     glyph: "Ⓐ", asset: "ALGO",  decimals: 6,  ticker: "algo",  network: "algo",  family: "algorand" },
  xtz:  { id: "xtz",  name: "Tezos",        glyph: "ꜩ", asset: "XTZ",   decimals: 6,  ticker: "xtz",   network: "xtz",   family: "tezos" },
  fil:  { id: "fil",  name: "Filecoin",     glyph: "⨎", asset: "FIL",   decimals: 18, ticker: "fil",   network: "fil",   family: "filecoin" },
  hbar: { id: "hbar", name: "Hedera",       glyph: "ℏ", asset: "HBAR",  decimals: 8,  ticker: "hbar",  network: "hbar",  family: "hedera" },
  vet:  { id: "vet",  name: "VeChain",      glyph: "Ⓥ", asset: "VET",   decimals: 18, ticker: "vet",   network: "vet",   family: "vechain" },
  theta:{ id: "theta",name: "Theta",        glyph: "θ", asset: "THETA", decimals: 18, ticker: "theta", network: "theta", family: "theta" },
  osmo: { id: "osmo", name: "Osmosis",      glyph: "Ⓞ", asset: "OSMO",  decimals: 6,  ticker: "osmo",  network: "osmo",  family: "osmosis" },
  ton:  { id: "ton",  name: "TON",          glyph: "Ⓣ", asset: "TON",   decimals: 9,  ticker: "ton",   network: "ton",   family: "ton" },
});

/** The long-tail chain ids, in display order. */
export const LONGTAIL_CHAIN_IDS = Object.freeze(Object.keys(LONGTAIL_CHAINS));

/** True when the chain is a long-tail source (ChangeNOW is its serving rail). */
export function isLongtailChain(chain) {
  return Object.prototype.hasOwnProperty.call(LONGTAIL_CHAINS, chain);
}

/**
 * THE COVERAGE MATRIX — VERIFIED LIVE 2026-09-05 (no guessing; evidence:
 * test/fixtures/golden/wanchain-leg/VERIFICATION-2026-09-05.json + the
 * rango-leg fixtures). For every source the console can list, which rails
 * ACTUALLY serve it — priority-ordered [THORChain, Rango, Wanchain]
 * filtered by coverage. This matrix drives railCandidates() below.
 *
 *   btc/doge/ltc/xrp → THORChain, Rango   (XFlows: BTC→SOL probe FAILED,
 *       no DOGE/LTC/XRPL rows at all → Wanchain absent)
 *   sui              → Rango               (THORChain can't; Rango serves
 *       (verified fixture); XFlows has no native SUI token — SUI-USDC only)
 *   tron             → Rango               (THORChain can't; XFlows TRX→SOL
 *       probe FAILED → Wanchain absent)
 *   xmr/ada/atom/near/zec/dash/bch → INSTANTSWAP  (the LONG-TAIL group,
 *       2026-09-26 — ChangeNOW verified live via /v1/currencies +
 *       /v2/exchange/estimated-amount; NONE of them is DEX-routable (privacy
 *       coins can't go through a DEX; ADA/ATOM/NEAR/BCH have no DEX rail
 *       wired). ADA was NO-RAIL before ChangeNOW; it is a ChangeNOW source now.)
 *   algo/xtz/fil/hbar/vet/theta/osmo → INSTANTSWAP (the long-tail SECOND
 *       wave, 2026-09-27 — verified live via ChangeNOW /v1/currencies +
 *       /v2/exchange/currencies; native network == ticker. XTZ/FIL/VET also
 *       have a bsc-wrapped row — the pinned network keeps the native token.)
 *   polkadot         → NO RAIL             (Rango ❌; THORChain ❌; XFlows has
 *       no Polkadot row at all; ChangeNOW has no NATIVE DOT — only bsc/
 *       assethub WRAPPED rows). Do NOT list as a console source.
 *   evm stables/x1    → LiFi/Warp          (unchanged; Wanchain EVM routes
 *       land EVM/Wanchain-L1 — never Solana/X1 — so no overlap)
 *
 * ⚠️ SINGLE-RAIL SOURCES (the sui/tron rows above) — SINGLE POINT OF
 * FAILURE (2026-09-06 SUI COVERAGE CHECK): sui and tron have exactly ONE
 * serving rail (Rango) — no fallback candidate behind it, unlike
 * btc/doge/ltc/xrp ([THORChain, Rango]). When Rango is down / a Sui route
 * is halted / the Rango API errors, pickRail({ fromChain: "sui" }) answers
 * { rail: null } (the loop exhausts the one candidate and has nothing to
 * fail over to) — the Sui lane goes fully dark. Any consumer (the console's
 * future Sui source phase) MUST translate that failure class into the CALM
 * route-unavailable state via src/lib/rango/routeState.js
 * (isRangoRouteUnavailable + rangoRouteUnavailableMessage — the Rango
 * mirror of the THORChain SOL-halt UX: gate disabled, calm copy, auto
 * re-check on the next attempt/refresh) — never a raw error. Evidence +
 * verdicts: docs/ROUTING-ENGINE.md §11.7.
 *
 * 🔭 THORCHAIN-SUI ROADMAP (2026-09-06 — the future SECOND Sui rail):
 * THORChain's roadmap ships SOL/TON/Cardano/Sui via EdDSA. The moment
 * THORChain enables SUI (its public inbound_addresses endpoint starts
 * listing a "SUI" chain entry — watch: tools/thorchain-sui-launch-watch.mjs),
 * RE-VERIFY a live SUI→SOL quote, then add THORCHAIN to this sui row
 * ([THORChain, Rango]) — THORChain becomes the Sui fallback rail AND the
 * X1TP affiliate earns on it (the affiliate pair rides the deposit memo,
 * same as the native rows). Until then sui stays Rango-only.
 *
 * The registry is the seam: when a rail's live API starts serving a source
 * (re-verify FIRST), update this map + railCandidates() + the engine's
 * source registry in the same change.
 */
export const COVERAGE_MATRIX = Object.freeze({
  btc: Object.freeze([RAIL.THORCHAIN, RAIL.RANGO]),
  doge: Object.freeze([RAIL.THORCHAIN, RAIL.RANGO]),
  ltc: Object.freeze([RAIL.THORCHAIN, RAIL.RANGO]),
  xrp: Object.freeze([RAIL.THORCHAIN, RAIL.RANGO]),
  sui: Object.freeze([RAIL.RANGO]),
  tron: Object.freeze([RAIL.RANGO]),
  // The long-tail group (2026-09-26): NOT DEX-routable → ChangeNOW serves.
  xmr: Object.freeze([RAIL.INSTANTSWAP]),
  ada: Object.freeze([RAIL.INSTANTSWAP]),
  atom: Object.freeze([RAIL.INSTANTSWAP]),
  near: Object.freeze([RAIL.INSTANTSWAP]),
  zec: Object.freeze([RAIL.INSTANTSWAP]),
  dash: Object.freeze([RAIL.INSTANTSWAP]),
  bch: Object.freeze([RAIL.INSTANTSWAP]),
  // Second wave (2026-09-27) — same long-tail group: verified live listed by
  // ChangeNOW (native network, no DEX rail wired) → ChangeNOW serves.
  algo: Object.freeze([RAIL.INSTANTSWAP]),
  xtz: Object.freeze([RAIL.INSTANTSWAP]),
  fil: Object.freeze([RAIL.INSTANTSWAP]),
  hbar: Object.freeze([RAIL.INSTANTSWAP]),
  vet: Object.freeze([RAIL.INSTANTSWAP]),
  theta: Object.freeze([RAIL.INSTANTSWAP]),
  osmo: Object.freeze([RAIL.INSTANTSWAP]),
  ton: Object.freeze([RAIL.INSTANTSWAP]),
  // Polkadot: NO RAIL — ChangeNOW has no NATIVE DOT (only bsc/assethub
  // WRAPPED rows); nothing else serves it.
  polkadot: Object.freeze([]),
});

/** The source-chain picker's full option list: EVM chains (LiFi/Warp stables
 *  + the native gas tokens when the engine grows them), the native chains
 *  (THORChain rail), the LONG-TAIL chains (ChangeNOW rail — XMR/ADA/ATOM/NEAR/
 *  ZEC/DASH/BCH + ALGO/XTZ/FIL/HBAR/VET/THETA/OSMO), then X1 (the reverse
 *  off-ramp source). */
export const SOURCE_CHAINS = Object.freeze([...EVM_CHAINS, ...NATIVE_CHAIN_IDS, ...LONGTAIL_CHAIN_IDS, "x1"]);

/** Human chain name for any source/destination option. */
export function chainName(chain) {
  return CHAINS[chain]?.name || NATIVE_CHAINS[chain]?.name || RANGO_CHAINS[chain]?.name
    || LONGTAIL_CHAINS[chain]?.name || String(chain);
}

/** Chain glyph for any source/destination option. */
export function chainGlyph(chain) {
  return CHAINS[chain]?.glyph || NATIVE_CHAINS[chain]?.glyph || RANGO_CHAINS[chain]?.glyph
    || LONGTAIL_CHAINS[chain]?.glyph || "";
}

/** The token options a source chain's picker offers. Native + long-tail chains
 *  carry exactly their one asset; EVM/X1 chains their registered tokens. */
export function tokensOn(chain) {
  if (isNativeChain(chain)) return [NATIVE_CHAINS[chain].asset];
  if (isLongtailChain(chain)) return [LONGTAIL_CHAINS[chain].asset];
  return tokensFor(chain);
}

/**
 * The rail candidates for a route, in priority order (the failover chain).
 *
 * DRIVEN BY THE COVERAGE_MATRIX (verified live 2026-09-05 — see its
 * comment block): the global preference order is [THORChain, Rango,
 * Wanchain], FILTERED to the rails that actually serve the source.
 *
 *   - Native chains (BTC/DOGE/LTC/XRP): THORChain first (deposit-address),
 *     Rango second (Phase 5 fallback — the SOL-halt lesson: Rango wraps
 *     THORChain/Mayan + its own rails and can still serve the source → SOL
 *     leg when THORChain is unavailable). Wanchain NOT in the list — the
 *     live XFlows probe of BTC→SOL failed and DOGE/LTC/XRPL have no
 *     Wanchain-family rows (COVERAGE_MATRIX).
 *   - Rango-native chains (SUI/TRON — RANGO_CHAINS): Rango only (their
 *     serving rail; THORChain can't serve them).
 *   - Long-tail chains (XMR/ADA/ATOM/NEAR/ZEC/DASH/BCH + ALGO/XTZ/FIL/HBAR/
 *     VET/THETA/OSMO — LONGTAIL_CHAINS): ChangeNOW (RAIL.INSTANTSWAP,
 *     deposit-address) — they are NOT DEX-routable, so ChangeNOW is their
 *     serving rail.
 *   - EVM/X1 sources: the LiFi/Warp rail (unchanged).
 *
 * @param {{fromChain: string}} route
 * @returns {Array<{rail: string, execution: string}>}
 */
export function railCandidates({ fromChain }) {
  const covered = COVERAGE_MATRIX[fromChain];
  if (covered) {
    if (covered.length === 0) return [];
    return covered.map((rail) => ({
      rail,
      execution: executionFor(rail),
    }));
  }
  if (isNativeChain(fromChain)) {
    return [
      { rail: RAIL.THORCHAIN, execution: EXECUTION.DEPOSIT_ADDRESS },
      { rail: RAIL.INSTANTSWAP, execution: EXECUTION.DEPOSIT_ADDRESS }, // ChangeNow fallback (sub-minimum / halted)
    ];
  }
  // SUI/TRON/ADA-style chains: ChangeNow (instant-swap) is the serving rail
  // (Rango was the old path — dropped; its surface is covered by ChangeNow).
  if (isRangoChain(fromChain)) {
    return [{ rail: RAIL.INSTANTSWAP, execution: EXECUTION.DEPOSIT_ADDRESS }];
  }
  // Long-tail chains (XMR/ADA/ATOM/NEAR/ZEC/DASH/BCH + ALGO/XTZ/FIL/HBAR/VET/
  // THETA/OSMO): NOT DEX-routable, so ChangeNOW is their SERVING rail
  // (deposit-address execution — the send is out-of-band from the user's own
  // external wallet). The COVERAGE_MATRIX already lists them as [INSTANTSWAP];
  // this branch keeps the serving rail explicit if the matrix ever drifts.
  if (isLongtailChain(fromChain)) {
    return [{ rail: RAIL.INSTANTSWAP, execution: EXECUTION.DEPOSIT_ADDRESS }];
  }
  return [{ rail: RAIL.LIFI_WARP, execution: EXECUTION.WALLET_CONNECT }];
}

/**
 * pickRail — THE decision point. Given the route coordinates (what the user
 * picked), return the serving rail + its final-execution shape. Called AFTER
 * the asset pick, BEFORE execution; the console routes the user into the
 * matching final step and never shows this module's names.
 *
 * Silent failover: when the first candidate's rail is unavailable (the
 * `unavailableRails` set — e.g. a halted carrier), the next candidate
 * serves. With no candidate left, { rail: null } returns and the caller
 * surfaces an honest "no route for this source right now".
 *
 * @param {{fromChain: string, unavailableRails?: Set<string>}} opts
 * @returns {{rail: string|null, execution: string|null}}
 */
export function pickRail({ fromChain, unavailableRails } = {}) {
  const candidates = railCandidates({ fromChain });
  for (const c of candidates) {
    if (unavailableRails?.has?.(c.rail)) continue; // silent failover
    return c;
  }
  return { rail: null, execution: null };
}

/** The final-execution shape for a rail (the two step types the console
 *  renders). Mirrors pickRail's execution — kept as the single mapping. */
export function executionFor(rail) {
  if (rail === RAIL.THORCHAIN) return EXECUTION.DEPOSIT_ADDRESS;
  if (rail === RAIL.INSTANTSWAP) return EXECUTION.DEPOSIT_ADDRESS; // ChangeNow: send to payin address
  if (rail === RAIL.CCTP) return EXECUTION.WALLET_CONNECT; // burn + mint are wallet-sign steps
  if (rail === RAIL.LIFI_WARP) return EXECUTION.WALLET_CONNECT;
  if (rail === RAIL.RANGO) return EXECUTION.WALLET_CONNECT;
  if (rail === RAIL.WANCHAIN) return EXECUTION.WALLET_CONNECT;
  return null;
}

/** Whether a route is a reverse off-ramp (source X1 → EVM destination). */
export function isReverse({ fromChain }) {
  return fromChain === "x1";
}

/** Whether a route lands on X1 (forward: EVM stables or native assets). */
export function isToX1({ fromChain }) {
  return fromChain !== "x1";
}
