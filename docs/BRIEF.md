# Teleporter v2 — Phase 2 Design Direction (BRIEF)

> Created at Step 2.1 (WalletContext) because this file did not exist in the
> worktree. This is the design-direction contract for ALL Phase 2 UI work. It
> supersedes runbook UI language where the two conflict. Consolidated from the
> product orders; extend this file as the design evolves — do not bury design
> decisions in PR descriptions.

## One card, tabs, sequential states

- The entire bridge experience is **ONE card**. No separate pages, no
  floating modals for the main flow.
- The card is **tabbed**. Phase 2 tabs: **Connect** and **Bridge**. (History
  can be added later as another tab inside the same card.)
- Each tab holds a **sequential state machine** — one step at a time, in
  order, inside the card. Never parallel panels, never side-by-side steps.
- The Connect tab (Step 2.2+) hosts the wallet connect flow: pick a family →
  pick a wallet → connecting → connected / error. That whole flow lives
  INSIDE the card's Connect tab as sequential states.

## State foundation

- `src/lib/wallet/` (Step 2.1) is the wallet state layer: one independent
  session per chain family (evm, solana, bitcoin, litecoin, dogecoin, xrp,
  tron), mock providers, isolation-tested. Step 2.2 builds the Connect tab UI
  on top of `useWallet(family)` — it must NOT duplicate wallet state.

## Rules

1. One card. Tabs inside it. Sequential states inside each tab.
2. No UI work happens outside the card for the bridge flow.
3. Wallet state lives in WalletContext only — components read via
   `useWallet(family)` / `useWalletContext()`.
4. If this file and the runbook conflict, THIS file wins.
