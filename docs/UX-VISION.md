
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
