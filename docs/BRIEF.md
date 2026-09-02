# Teleporter v2 — Agent Brief

Two workstreams. Ship in the order below. Do not start Workstream B until Workstream 0 is merged.

- **Workstream 0** — Close the audit criticals (gate)
- **Workstream A** — THORChain lane: two-panel field (fork panel → X1 hop)
- **Workstream B** — Any-swap / any-bridge: open LI.FI routing to every chain, not just X1

Repo: x1teleporter (Vite, Vercel; canonical source is the July 3 reference at commit b4548c8). Integrator string `x1-teleporter-labs`. Warp program `6JbPTuxVuoTgyQeXFb9MH8C8nUY8NBbLP1Lu4B13JfMY`. **Fee model (SUPERSEDED 2026-09-02 by fee-model v2 — see docs/ROUTING-ENGINE.md §0): the historical PR #8/#9 model was exactly 1% of route total, charged once per journey, with a $25 minimum on X1 routes; fee-model v2 replaces it with 0.5% capped at $250 and removes the $25 floor.** Under the original model: on X1-bound routes the LI.FI integrator fee param is OMITTED and the stage-2 skim is the only Teleporter fee; Warp's $1 flat fee (USDC.x — verified on-chain 2026-09-02, still flat $1, NOT 0.25%) is a third-party pass-through shown as its own line; wSOL.X charges 25bps instead; Escape Hatch is a separate rescue product at 5% (named exception).

Operating rule: **no infra on us.** Everything below runs client-side or on Vercel serverless. No daemons, no watchers, no pager.

---

## Workstream 0 — Audit gate (do first)

Workstream B multiplies route surface by ~50×. These have to be closed before that.

1. **Unlimited ERC-20 approvals.** Replace `MaxUint256` approvals with exact-amount approvals to the `approvalAddress` returned by LI.FI. Validate that address against LI.FI's `/v1/tools` or known Diamond/Executor addresses per chain before signing. Fail closed.
2. **X1→Solana self-relay path.** Four independent bugs. Fix or remove the path; a dead route in the picker is worse than no route.
3. **Silent simulation bypass.** Simulation failure must block the send and surface the reason.
4. **Open CORS on `api/lifi/`.** Restrict to the production origins.
5. **Dead-code fee ladder + double-fee routes.** Consolidate to one fee function, `computeFee(route)`, with unit tests for: same-chain, X1 hop, Escape Hatch, THORChain leg (Workstream A), non-X1 bridge (Workstream B).

Acceptance: audit items closed with a test per item; `api/lifi/` fee enforcement verified in a Vercel preview deploy (the `api-lifi/` naming bug must not recur — add a build-time check that the route exists).

---

## Design direction (applies to every v2 screen)

One card, ambient video behind it, glass on top. Calm, dark, premium. The bar is: a stranger screenshots it because it looks good.

### Layout
- **One focused card**, centered, max ~460px wide. Tabs across the top of the card (Teleport / THORChain / Buy when it exists). No dashboard, no sidebars, nothing else competing on the page. The two-panel THORChain flow lives *inside* the card as sequential steps, not side-by-side panels.
- Fees, floor, and estimated output always visible on the card before signing — quiet, small, honest.

### Video background
- Source: Franky supplies the ad footage. Convert to **ambient**: pick the most visual 6–10s, strip ALL text/logo/CTA frames, no audio track at all, slow to 0.5–0.75x, crossfade the loop point so the restart is invisible.
- Encode: WebM (VP9 or AV1) + MP4 (H.265) fallback, 1080p max, target < 4 MB, `<video autoplay muted loop playsinline preload="metadata" poster={firstFrame}>`.
- Treatment: `position: fixed; inset: 0; object-fit: cover;` with a dark scrim on top (`rgba(8,10,14,0.55)` minimum — raise it until card text passes WCAG AA contrast). Optional slight blur or brightness(0.45) on the video itself.
- Behavior: pause via IntersectionObserver / `visibilitychange` when tab is hidden; static poster image instead of video when `prefers-reduced-motion`, on `saveData`, or on mobile viewports < 768px. The site must look complete with the poster alone.

### Glass card
- `background: rgba(12,14,18,0.55); backdrop-filter: blur(24px) saturate(1.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 20px;` soft large shadow. Test backdrop-filter fallback (solid `rgba(12,14,18,0.92)`) for browsers without support.
- Text on glass: near-white primary, 60%-alpha secondary. No pure #000/#fff.
- One accent color for actions and the progress states — pick from the ad footage so card and background feel like one world.

### Motion & tone
- The teleport is the brand: progress states named and animated as a teleport sequence (charging → in transit → rematerializing on X1), subtle, no cartoon. This is what makes the 10–60 min THORChain wait feel intentional.
- Micro-interactions ≤ 200ms, ease-out. Nothing bounces. Nothing autoplays sound. Ever.
- Read the frontend-design guidance available to the building agent before implementing; do not default to component-library grey.

### Acceptance
- Lighthouse perf ≥ 85 on mobile with the video enabled; CLS ≈ 0 (poster reserves the space).
- Card text passes AA contrast over the brightest frame of the loop.
- Screenshot test: swap card over video, THORChain wait state, and connect modal all share the same visual language.

## Cross-cutting — Wallet layer (applies to A and B)

Users connect with browser-extension wallets. A user doing BTC → X1 will have Xverse **and** Phantom installed; one doing EVM → X1 will have MetaMask **and** Phantom, possibly Rabby too. Multiple extensions injecting into the same page is the #1 cause of "connect button does nothing." This must be solved once, centrally, not per panel.

**The explicit wallet list, per family, with detection keys and adapters, is in `teleporter-wallet-registry.md`. Build from that list — not from a generic "injected" connector.**

### Rules
1. **Never read `window.ethereum`, `window.solana`, `window.BitcoinProvider`, or `window.tronLink` directly.** Legacy globals get overwritten by whichever extension loads last. Use the discovery standards:
   - **EVM:** EIP-6963 (`eip6963:announceProvider` events). Every announced provider gets its own entry in the wallet modal, even when three extensions all claim `window.ethereum`. wagmi/viem handle this out of the box — use them; do not hand-roll.
   - **Solana:** Wallet Standard via `@solana/wallet-adapter` with `autoDetect`. Phantom, Solflare, Backpack, and Starport all register through it without colliding.
   - **Bitcoin:** `sats-connect` (Xverse) and Wallet Standard for Bitcoin (Unisat, Leather, OKX register here). Enumerate what's installed; never assume one.
   - **XRP:** GemWallet and Crossmark are extensions and inject their own APIs; Xaman is mobile-only (QR/deep link). Support at least one extension wallet plus deposit-address fallback.
   - **Tron:** TronLink via its adapter, isolated from the EVM path (it also injects `window.ethereum`-like objects in some versions — do not let it appear in the EVM list).
2. **One wallet session per chain family, held in a single `WalletContext`.** Panel 1 and Panel 2 read from the same context. A user connects a BTC wallet and a Solana wallet independently; neither disconnects the other. Switching the EVM wallet must not reset the Solana connection.
3. **Chain-family isolation.** The BTC connect flow never touches the EVM provider list and vice versa. If a discovery call throws (one broken extension), catch it and continue — never let one wallet's error block the others from appearing.
4. **Address ownership is explicit.** Panel 1's destination address is the *Solana* session's public key, never the EVM address, never user-typed. If no Solana wallet is connected, Panel 1 blocks with "connect a Solana wallet first."
5. **Phantom's multi-chain injection.** Phantom registers as a Solana wallet, an EVM wallet, and a Bitcoin wallet. It should appear in all three lists (that's correct) but connecting it for Solana must not auto-select it for EVM/BTC. Treat each as a separate session.
6. **No wallet = deposit address.** For the THORChain lane, if no BTC/DOGE/LTC/XRP extension is detected, fall through to the deposit-address + memo flow (v1). Do not show a dead connect button.

### Acceptance
- Test matrix run in a real browser profile with **all** of these installed at once: MetaMask, Rabby, Phantom, Solflare, Xverse, Unisat, TronLink, GemWallet. Every wallet appears in the correct list(s); connecting any one does not disconnect or hide another; no console errors from provider collisions.
- Repeat with only Phantom installed: it appears under Solana, EVM, and BTC; connecting under Solana leaves EVM and BTC disconnected until chosen.
- Repeat with no wallets: every chain shows the deposit-address path or a clear "install a wallet" state. Nothing is a silent no-op.

---

## Workstream A — THORChain lane (two-panel field)

> **SUPERSESSION (design decision):** "Panel 1" and "Panel 2" below are LOGIC STAGES, not layout. Per the Design direction section, the UI is ONE card; the THORChain flow is sequential states inside it (quote → deposit address → progress → done). The swap.thorchain fork is a logic source only — lift its memo construction, inbound-address refresh, halted checks, and status polling; never mount its UI.

### Outcome
A user with native BTC, DOGE, LTC, or XRP lands on X1 holding USDC.x (default) or XNT (toggle). One screen, two panels, no CEX, no wrapped assets on the source side.

### Architecture
```
Panel 1 (THORChain fork)             Panel 2 (Teleporter hop — existing)
BTC/DOGE/LTC/XRP → SOL.SOL   ──txid──▶  poll status → SOL→USDC (Jupiter via LI.FI)
destination = connected Solana wallet   → 1% skim → Warp → X1 → optional swap to XNT
```

### Panel 1 — forked `swap.thorchain` UI
- Fork `github.com/thorchain/swap.thorchain`. Mount as a **component** (not iframe) so it shares the Solana wallet session with Panel 2. Fall back to iframe + `postMessage` only if the component mount fights our bundler.
- Restrict sources to `BTC.BTC`, `DOGE.DOGE`, `LTC.LTC`, `XRP.XRP`. Hard-pin destination to `SOL.SOL`. Prefill destination address from the connected Solana wallet; disallow edits.
- Affiliate: set our THORName + `affiliate_bps` (start 100) in fork config. Preferred payout asset: USDC. (Franky registers the THORName; agent wires the config.)
- Fetch `/thorchain/inbound_addresses` on mount and every 60s. If `halted` is true for a source chain, grey it out with "paused by THORChain." Never cache vault addresses across sessions.
- Quote via THORChain's free aggregator API (key from `integrate-thorchain` Discord; env `THORCHAIN_API_KEY`). Show `expected_amount_out` and slippage bps from the quote. Re-fetch quote before the user copies the address; quotes expire.
- **Hook:** on submit, emit `{ inboundTxid, sourceChain, destination, expectedAmountOut }` to Panel 2. This is the only fork modification beyond config and styling.
- Size cap: 0.05 BTC-equivalent per swap until Solana pool depth improves. Config value, not hardcoded.
- Send UX: v1 is deposit-address + memo + QR (works from any wallet). v2 adds wallet-connect via XChainJS clients (BTC: Xverse/Unisat; XRP: Xaman). Do not block v1 on v2.

### Panel 2 — hop (mostly existing code)
- On receiving the hook payload: poll `/thorchain/tx/status/{inboundTxid}` (Liquify gateway) every 15s, max 90 min. States: `observed → swapping → outbound_signed → done`. Show each.
- On `done`: detect SOL landing in the connected wallet (balance delta ≥ expected − tolerance). Auto-advance into the existing SOL→USDC same-chain swap, then the 1% skim, then Warp. Reuse `HoldingsPanel` / `TokenPicker`; do not build new pickers.
- Optional "land as XNT" toggle: after Warp, run one X1-side swap USDC.x→XNT. Only if an X1 DEX route exists; otherwise hide the toggle.
- If the user closes the tab mid-poll, the hop resumes on return: persist `{inboundTxid, stage}` in `window.storage` keyed by txid. No server state.

### Follow-on (week 3+) — One-sign flow
Goal: user signs once in-app, sends BTC from anywhere, walks away; the Solana leg executes itself when SOL lands.
- **Mechanism:** durable-nonce pre-signed Solana tx = `[advance_nonce, forward_to_x1]`, signed at minute zero, broadcast by a keyless watcher (Vercel cron / browser / FRANKY box — retries until nonce advances) when THORChain outbound confirms.
- **On-chain program** (Anchor), single instruction `forward_to_x1(x1_dest: [u8;32], slippage_bps)`: read SOL balance at execution, keep ~0.01 SOL reserve; compute `min_out` from a Pyth SOL/USD feed account × slippage; CPI one deep direct SOL/USDC pool (Orca whirlpool or Raydium — fixed accounts, not Jupiter); skim 1% to fee wallet on-chain; CPI Warp with runtime USDC amount + X1 destination. All accounts static.
- **Dependency:** Warp must be CPI-callable with a runtime amount. Get the IDL from Jack. If not, the program swaps and holds USDC and the Warp step falls back to a second user signature.
- **UX:** first visit = two signs (create nonce account + forward tx); repeat visits = one. Cancel button advances the nonce.
- Fixed priority fee + generous compute budget baked into the pre-signed tx.
- 🔴 Pro lane; external audit before mainnet. Do not fold into Phase 3.

### Follow-on (week 4) — Jito bundle + backrun rebate
Goal: submit the forward tx privately so it cannot be sandwiched, and capture the backrun arb for the user instead of a random searcher.
- **Submission:** the watcher sends `[forward_to_x1 tx, backrun tx]` as a single Jito bundle with a tip, via a Jito block-engine endpoint — never to the public mempool. Bundles are atomic: both land or neither. Keep a plain-RPC fallback if Jito is down (floor still protects).
- **Backrun tx:** signed by a protocol-controlled arb keypair (holds only working capital + tips, never user funds). Trades the same SOL/USDC pool back toward market after the user's swap. Profit is computed on-chain in the program (`rebate` instruction) and split **90% to the user's USDC before the Warp CPI, 10% to the fee wallet**. If the backrun would be unprofitable after tip, skip it — bundle carries the forward tx alone.
- **Floor stays:** Pyth `min_out` on the user's swap remains as the fallback defense; the bundle makes it belt-and-suspenders.
- **Infra note:** this is the one piece that needs a hot key. Keep the arb keypair's balance capped and rotate it; treat it as the "no infra on me" exception with a bounded blast radius.
- Report the rebate in the UI as a line item ("MEV rebate: +$X") so "user assumes the risk" reads as "user gets the rebate."
- 🔴 Pro lane; audit alongside the program.

### Decision — price risk
User assumes price risk from send to settlement (standard for every cross-chain rail). UI shows "estimated" amounts and the floor; terms carry one line. Floors (THORChain `limit`, program `min_out`) are set wide — they are execution protection against flash crashes and MEV, not price promises.


- THORChain affiliate bps (protocol-side, paid in USDC to our THORName).
- Our 1% pre-bridge skim on the Solana leg (existing).
- Warp's flat $1. Display all three to the user before they send.

### Acceptance
- Live BTC → X1 test at 0.001 BTC completes end-to-end on mainnet with all three fees visible and correct.
- Same for one of DOGE/LTC/XRP.
- Halted-chain state renders correctly (simulate by mocking `halted: true`).
- Closed-tab resume works.

---

## Workstream B — Any-swap / any-bridge

### Outcome
Teleporter becomes a general LI.FI front end: any token, any chain LI.FI supports, to any other, with X1 as one destination among many. Every route monetized.

### Scope
- Remove the "destination must be X1" constraint in the route builder. `fromChain` and `toChain` both come from LI.FI `/v1/chains`; tokens from `/v1/tokens`. Dynamic lists already exist — extend them.
- Bridges: allow all from `/v1/tools`. Expose an "advanced" toggle to pin a bridge (`allowBridges`). Default is LI.FI's router.
- Fee: LI.FI integrator `fee` param for non-X1 routes (start 0.3%). Keep the pre-bridge skim **only** for X1-destined routes where Warp's hardcoded $1 forces it. `computeFee(route)` from Workstream 0 decides which applies. Never both.
- Chain types: EVM, Solana, Bitcoin (BTC via LI.FI is PSBT — never modify it), Tron (existing deserialize→re-anchor→sign path), Move. Bitcoin as *destination* is allowed; test one BTC-out route.
- Route display: show `tool`, estimated time, gas, fee breakdown, and `toAmountMin`. Slippage default 0.5%, user-adjustable.
- Status: use LI.FI `/v1/status` polling for cross-chain; same closed-tab resume pattern as Workstream A.

### Not in scope
- PulseChain (no LI.FI support) — keep the Compactor handoff as-is.
- THORChain routes via LI.FI's `thorswap` key — Workstream A owns THORChain.
- Anything that requires a server process.

### Acceptance
- Ten mainnet routes across at least four chain types complete at small size with the fee enforced serverlessly. Include: EVM→EVM bridge, EVM→Solana, Solana→EVM, BTC→EVM, Tron→EVM, EVM→BTC.
- No route shows a double fee. No route requests an unlimited approval.
- X1-destined routes behave identically to today.

---

## Order of work
1. Workstream 0 (gate) — merge with tests.
2. Workstream A Panel 2 hook + polling (small, reuses existing code).
3. Workstream A Panel 1 fork mount + config.
4. Workstream A mainnet test → soft launch behind a feature flag.
5. Workstream B route builder + fee unification.
6. Workstream B ten-route test → launch.

## Open items Franky must supply
- THORName registration + preferred payout asset.
- THORChain aggregator API key.
- Whether Warp supports SOL directly (skips the Jupiter step) and which mints beyond USDC it carries.
- Whether an X1-side USDC.x→XNT route exists for the toggle.
