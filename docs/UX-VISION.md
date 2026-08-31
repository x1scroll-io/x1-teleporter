# UX Vision — Route-first, Wallet-on-Demand (Teleporter v2)

*Status: VISION — captured 2026-08-31 for a future session. NOT yet built.
The current UI is functional (testable for the hop) but exposes implementation
plumbing. This document is the frictionless redesign target.*

## The problem with the current flow

The app makes the user think about plumbing. "Connect EVM. Now also connect
Solana because the hop lands there first." A user moving USDC from Ethereum to
X1 shouldn't have to know — or care — that Solana is a waypoint. The
implementation leaks into the UX.

## The principle

**Route-first, wallet-on-demand.** Ask for a wallet only at the moment you need
it, and only the one you need. Not "connect everything up front."

## The flow

1. **User describes the trip first** — From Ethereum, To X1, USDC, amount. No
   wallet connection yet. They're just saying where they want to go.
2. **They hit Get Quote.** Now the app knows exactly which wallets the route
   needs, and asks for only those, in order:
   - "Connect the wallet holding your USDC on Ethereum" → the source wallet.
   - The destination / Solana-waypoint wallet is requested ONLY if the route
     actually needs the user to hold it — framed as "where it lands," not
     "connect a second wallet because reasons."
3. **Each connect request is contextual — it says why.** "Connect a Solana
   wallet — your USDC lands here before the final hop to X1." The user
   understands because they were told at the moment it mattered, not as
   upfront homework.

## Wallet discovery — show their wallets, not a taxonomy

The wallet registry already solves detection. The user shouldn't pick "EVM
family" then pick a wallet; they should just see their wallets:

- When the route needs an EVM wallet, show Rabby / MetaMask / Phantom-EVM as
  ready-to-tap, dimmed-others below.
- When it needs a Tron wallet, TronLink surfaces.
- **The family is inferred from the route, not chosen by the user.** They
  picked "From Ethereum" — the app knows that's EVM, so it asks for an EVM
  wallet without ever making the user think the word "EVM".

## Honest scoping

This is a **UX redesign, not a bug fix** — the difference between "the plumbing
works" and "it feels like magic." Both are worth building, but they're
different phases:

- **Now (functional, testable):** the current flow supports the hop — prove
  the money moves correctly (1% + $1 lands right) against this UI first.
- **Next (frictionless):** redesign the connect flow AFTER the mechanics are
  proven. Rebuilding the connect flow before the hop risks building it around
  behavior the hop reveals is wrong.

**Sequencing decision (Mr. Esters, 2026-08-31):** test the hop against the
functional UI first. Dispatch the route-first/wallet-on-demand redesign as its
own piece, in a fresh session, once the underlying mechanics are proven.

---

## REVISION 2 — one unified form, no rail tabs (Mr. Esters, 2026-08-31)

The tab structure (Teleport / THORChain / Buy) exposes the plumbing as the
user's navigation. The user shouldn't pick "THORChain" — they don't know or
care that DOGE routes through THORChain. They pick DOGE as the From chain and
the app figures out the rail.

**Three moves:**

1. **Kill the rail tabs. One form.** From-chain and To-chain are just chain
   pickers; the rail (LI.FI vs THORChain vs Warp) is chosen by the app based
   on the chains picked — invisible. Dogecoin → X1 silently routes through
   THORChain; Ethereum → X1 is LI.FI; the user never sees those words. The
   THORChain tab dies entirely (it was never a user-facing destination).
   **Buy stays as a tab** — it's a genuinely different action (fiat on-ramp).

2. **From/To are chains; Token From / Token To are tokens** — four pickers in
   a clean grid.

3. **Token pickers: stables → gas token → search.** Ordering matches
   frequency of use: stablecoins first (what most people bridge), then the
   chain's gas token, then a search box that matches on name OR pasted address
   and populates live. Lead with the 80% case, search for the 20%. This is
   how the best swap UIs do it.

**Why this is the edge:** it hides the machinery that competitors (e.g.
FortiBlox) expose. The front-end wins by making cross-chain routing feel like
a single swap — the user never has to understand the rails beneath.

**Sequencing (unchanged):** the quick unblock (inline connect button — PR #25)
comes first so the hop can be tested; this redesign is the follow-on piece in
a fresh session after the mechanics are proven.

## Related
- docs/WALLET-REGISTRY.md — the detection keys + modal rules the wallet
  discovery builds on (Starport pinned, installed highlighted, never hidden).
- docs/BRIEF.md — design direction (one card, tabs, glass, honest fees).
