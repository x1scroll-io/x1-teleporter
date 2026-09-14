# Teleporter V2 — Engine Interface (published contract)

**Status:** published 2026-09-13 · **Source of truth:** this file + the code it cites
**Purpose:** let an external consumer (the Starport wallet) integrate against a **contract**, not a build artifact.

---

## 1. Scope

The engine answers *"move value from (chain A, token X) to (chain B, token Y)"* and returns an ordered
list of **legs**. It does not hold keys and does not sign. Two consumers exist: the console (same repo)
and, prospectively, the wallet.

## 2. The route request

```
quote({ fromChain, fromToken, toChain, toToken, amount, senderContext }) -> RouteResult
```

`senderContext` carries the sender address per chain family (EVM address, SVM address, and the source
address for UTXO/XRP-style chains). It is required only for legs that need it; a quote that can be
computed without a sender MUST NOT require one.

### RouteResult

```
{
  ok: true,
  routeKind: "same-chain" | "cross-chain" | "x1-class" | "unsupported",
  legs: Leg[],
  quotedOut:  string,   // expected output, base units
  minReceived: string,  // ACCEPTED MINIMUM (never the optimistic number)
  fees: { items: FeeItem[], totalUsd: string|null },
  etaSeconds: number|null,
  reason?: string       // REQUIRED when routeKind === "unsupported"
}
```

`Leg`:

```
{
  index: number,
  chain: string,            // chain key, e.g. "base", "solana", "x1"
  family: "evm" | "svm" | "utxo" | "xrpl" | "cardano" | "sui" | "tron",
  provider: string,         // "lifi" | "thorchain" | "rango" | "wanchain" | "warp" | "pool"
  kind: "approval" | "swap" | "bridge" | "ata-create" | "warp-lock" | "warp-complete",
  expectedOut: string,
  minReceived: string,
  executableByWallet: boolean,   // false => this leg requires a handoff
  handoffUrl?: string,           // present iff executableByWallet === false
  status: "planned" | "built" | "simulated" | "signed" | "submitted" | "confirmed" | "failed"
}
```

## 3. Unsupported routes — explicit, always

A route that cannot be planned MUST return `routeKind: "unsupported"` **with a `reason`** string.
Never an empty legs array, never a silently-reduced route, never an optimistic fallback.

> **Implemented 2026-09-14 (was a gap):** `planOrExplain(opts)` is the reason-bearing entry.
> It never returns `null`; an unplannable request yields
> `{ routeKind: "unsupported", route: null, reason, direction, via }` where `reason` names the
> specific defect (e.g. `unsupported route: no planner for direction="dex" — expected one of
> forward | reverse | thorchain | rango | wanchain | swap`).
>
> `plan()` is **unchanged** and still returns `null` for those lanes, so existing `if (!route)`
> callers keep working — the fix is additive, not a behaviour break. `classifyRoute(route)` maps a
> planned route to `"same-chain" | "cross-chain" | "x1-class"`.
> Tests: `test/routeUnsupported.test.js` (6/6) + `test/engine.test.js` (45/45, no regression).
>
> Consumers should prefer `planOrExplain` for anything user-facing: an empty result must never be
> shown in place of a reason.

## 4. Leg lifecycle — the engine's real contract

The engine implements **five** phases, in this order (`src/engine/`, asserted by `test/engine.test.js`):

```
build → simulate → requestSignature → submit → confirm
```

- **A failed or skipped simulation MUST NEVER reach the wallet or the network.**
- Undefined phases are skipped; a throwing `simulate` **propagates** (it is not swallowed).
- Leg artifacts are **byte-identical to golden fixtures** (canonical JSON + sha256), covering the
  serialized transaction bytes as well as the account construction.

**Signing boundary — non-negotiable:** `SignerResolver` resolves a signer **by chain family**
(EVM → the proven EVM provider resolution; SVM → the proven Solana adapter resolution). The signer runs
**in the consumer**. The engine hands a leg to the signer; it never holds a key and never delegates a
signature to a server. This is what makes in-wallet execution possible.

## 5. Fees

- Fee policy is enforced **server-side** in the quote proxy (`api/lifi/_lifi`): `INTEGRATOR` is
  **hardcoded** (`x1-teleporter-labs`) and the integrator fee is forced onto every non-X1-class quote —
  it cannot be stripped or tampered with from the browser.
- FEE-MODEL v2: 0.5% (`INTEGRATOR_FEE = "0.005"`), charged **once per journey**.
- x1-class routes (journeys touching the Warp bridge) **omit** the aggregator fee param entirely —
  absent means absent, never `fee=0`; the on-chain Warp skim is the fee for that class.
- Consumers MUST present the fee breakdown itemised and identify the integrator fee explicitly.
  **Never** assume `feeCosts[0]`.

## 6. Embeddability (what the wallet requires)

An extension cannot depend on a hosted service for signing, and cannot execute serverless proxies.
Therefore:

| Requirement | State today |
|---|---|
| Engine code importable as a module (no DOM, no bundler assumptions) | **Partially** — `src/engine/*` is plain ESM; browser-safe (uses `Uint8Array`, not `Node Buffer`, in PDA derivation) |
| No server-only imports in engine paths | Must be verified per module (the `api/*` handlers are server-only and must stay out) |
| Deterministic artifacts (golden sha256) | **Yes** — proven by test suite |
| Fee/integrator identity available without a server | **No** — enforced in the proxy today; an embedded engine must carry the same policy in-process |
| Signing performed by the consumer | **Yes** — `SignerResolver` design |

**Recommended integration shape:** vendor `src/engine/**` + the chain-family leg builders into the wallet
as a pinned first-party module, with the fee policy carried in-process and byte-identity fixtures run in
the wallet's CI. The wallet keeps the aggregator path for lanes the engine does not yet plan.

## 7. Proven / unproven (evidence layers)

**Proven:** LegContract phase ordering and simulation gating; SignerResolver family mapping; planner leg
sequence for the forward route; byte identity vs golden fixtures. *(unit/module layer)*

**Not proven:** a route requested and **completed** through the console UI in a browser (the Teleport
form is gated behind wallet-connect), and the Warp `seq` source offset (see `docs/WARP-VERIFICATION.md`).
*(browser/acceptance layer — open)*
