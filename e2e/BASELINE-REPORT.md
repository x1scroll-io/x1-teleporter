# Browser-verification harness — BASELINE REPORT (Tool 2)

The lean Playwright harness that drives the CURRENT forward leg (ETH → X1)
of the STABLE v2 build UP TO THE SIGNATURE and asserts the UI flow, quote,
fees, To-address, buttons, and advancement to the sign step. This is the
BASELINE the routing-engine migration will later be verified against: when
the engine replaces the forward leg, this spec must pass UNCHANGED.

## Files

| File | Purpose |
|---|---|
| `e2e/forward-leg.spec.js` | The 3-test Playwright spec (the harness). |
| `e2e/helpers/fakeEthereum.js` | addInitScript payload: the fake EIP-6963 EVM wallet. CANNOT sign — `eth_sendTransaction` records the exact payload the app asked to sign, then hangs ("ready to sign") or declines (4001). There is no code path that returns a tx hash. |
| `e2e/fixtures/tools-chain-1.json` | Real LI.Fi `/v1/tools` response for chain 1 (captured 2026-09-02) — replays for the approval-validation fetch. |
| `e2e/playwright.config.js` | Test config (workers 1, deterministic viewport, baseURL from `E2E_BASE_URL`). |
| `e2e/run-harness.mjs` | Runner: `npm run build` → `vite preview` on 4173 → spec → teardown. |
| `e2e/screenshots/local/*.png` | State screenshots from the LOCAL baseline run (disarmed build). |
| `e2e/screenshots/deployed/*.png` | State screenshots from the DEPLOYED git-v2 alias run (armed build). |

The spec shares the frozen quote fixture + the golden step-1 fixture with the
oracle (Tool 1): the wallet-signature payload is asserted byte-for-byte
against `test/fixtures/golden/forward-leg/step1-approval.json`, and the fee
line amounts are asserted against the reference strings in
`forward-leg-summary.json` (computed by the real fee code).

## How to run

```bash
# Local baseline (builds + previews the disarmed local bundle):
node e2e/run-harness.mjs

# Deployed one-off check (the ONLY browser check against a deployed URL —
# the stable git-v2 alias, always the latest v2 merge; NO new deploy):
E2E_BASE_URL=https://x1teleporter-git-v2-x1scroll-ios-projects.vercel.app \
  npx playwright test --config e2e/playwright.config.js
```

## What is ASSERTED vs MOCKED (documented)

ASSERTED (real UI + real app logic):
- The connect modal → connected body → bridge form journey, with the fake
  EVM wallet session (`0x4634e8e0…e5f6`) and the Solana mock session.
- The console build banner reads the REAL compiled `WARP_LIVE_SEND` flag
  (#45): **"live sends ON"** on the deployed v2 alias (armed),
  **"live sends OFF"** on the local build (disarmed by the allowlist pin).
- The quote box for the fixture input (25.65 USDC ETH→X1): "You send
  25.65 USDC on Ethereum"; fee line **Teleporter fee (1%) $0.26**; fee line
  **Warp bridge fee $1.00**; "You receive ≈ 24.30 USDC.x on X1"; the step
  chips (LiFi · Solana / Warp Bridge · X1).
- The To-address destination line (dest-address-forward) displays the
  connected Solana session (X1 recipient, bridge-to-self): full address in
  the title attribute, truncated in the row.
- Buttons present/enabled and the flow ADVANCES: clicking "Bridge — Step 1
  of 2" runs the REAL stage-1 logic (chain check → allowance read → exact
  approval build → simulation gate) up to the wallet signature.
- THE SIGNATURE BOUNDARY: the fake wallet records exactly ONE
  `eth_sendTransaction` request whose payload is byte-for-byte the golden
  step-1 approval (exact amount, LiFi Diamond spender, USDC target, never
  MaxUint256). Nothing is ever signed or broadcast.
- Declining the signature (4001) surfaces the honest
  "Transaction rejected by wallet" error and returns to the quoted state.

MOCKED (deterministic, no money, no live third parties):
- EVM wallet: fake EIP-1193 provider injected pre-load (EIP-6963 announce).
  eth_call/eth_estimateGas answer deterministically; eth_sendTransaction
  records + hangs/declines — it CANNOT sign or broadcast.
- Solana wallet: the app's own dev-mock fallback (Starport row →
  createMockProvider — no signing surface; stage 2 is unreachable anyway
  because the harness stops at the stage-1 signature).
- Network: `/api/lifi/quote` and `/api/lifi/tools` are intercepted and
  fulfilled with the frozen fixtures (no live LI.Fi calls).
- NOT mocked: everything else the UI does (real fetches to public RPCs for
  the balance lines are read-only and fail soft).

## Baseline result — PASS (2026-09-02)

Local build (`npm run build`, disarmed): **3/3 passed**
Deployed git-v2 alias (stable URL, armed): **3/3 passed**

```
Running 3 tests using 1 worker
  ✓ baseline: banner reads the real WARP_LIVE_SEND flag + forward quote renders
    correct fees, To-address, buttons
  ✓ baseline: forward flow advances to the sign step and STOPS at the wallet
    signature (nothing signed, nothing sent)
  ✓ baseline: declining the signature surfaces the honest rejection and sends nothing
  3 passed
```

The deployed alias banner asserted **"live sends ON"** + `WARP_LIVE_SEND=true`
— the #45 build-banner fix verified against the real armed build.

## Screenshots (each state)

| State | Local | Deployed |
|---|---|---|
| Connected wallets + form (idle) | `screenshots/local/1-connected-form.png` | `screenshots/deployed/1-connected-form.png` |
| Quote box — fee lines + To-address + buttons | `screenshots/local/2-quote-fees-dest.png` | `screenshots/deployed/2-quote-fees-dest.png` |
| Sign-ready (wallet prompt open — approval payload captured, nothing sent) | `screenshots/local/3-sign-ready.png` | `screenshots/deployed/3-sign-ready.png` |
| Signature declined (honest rejection, nothing sent) | `screenshots/local/4-sign-declined.png` | `screenshots/deployed/4-sign-declined.png` |

## Engine Phase-1 gate

The routing engine is correct iff, against a build whose forward leg is the
engine: (a) `test/golden.test.js` passes UNCHANGED (byte-identical tx
construction), and (b) this spec passes UNCHANGED (identical browser
behaviour through the sign boundary). Do not weaken either to accommodate
the engine.
