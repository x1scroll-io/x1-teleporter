# Teleporter v2 — Two-Week Runbook

Copy-paste prompts for FRANKY (dispatching Claude Code on the server). One prompt per step. Each step says which model lane to use, what you do by hand, and what "done" looks like before you send the next prompt.

Model lanes: 🟢 Flash (default) · 🔴 Pro (money-touching code only — switch the env var for that session, switch back after).

Ground rules for every prompt — paste this block at the top of the very first session, and again any time a session starts fresh:
CONTEXT: You are working on the x1teleporter repo (Vite app on Vercel; api/lifi/ are Vercel serverless functions). Read docs/BRIEF.md and docs/WALLET-REGISTRY.md before doing anything. Work ONLY on the v2 branch in the v2 worktree. Never touch main. Never run a deploy to production. Every change goes in a PR into v2 with a clear title and a description of what you tested. If a task is unclear, stop and ask; do not guess on anything touching fees, approvals, or signing. Do not mark a task done unless the tests you wrote pass. Report back with: PR link, what changed, what you tested, what you could NOT test.

-----

## Phase 0 — Sandbox (Day 1)

Goal: the agent physically cannot break the live site.

### Step 0.1 — You, by hand (30 min)

- GitHub → repo → Settings → Branches: protect main. Require PRs, no direct pushes, require the CI check (created in 0.4) to pass.
- Vercel → project → Settings → Git: confirm Production Branch = main.
- Vercel → Domains: add next.x1teleporter.com and point it at the v2 branch preview.
- Vercel → Deployment Protection: turn on for Preview.
- Vercel → Environment Variables: create THORCHAIN_API_KEY (placeholder for now), VITE_FLAG_THORCHAIN=false, VITE_FLAG_ANYSWAP=false — Preview scope only. Do not add them to Production.
- Copy teleporter-thorchain-anyswap-brief.md → docs/BRIEF.md and teleporter-wallet-registry.md → docs/WALLET-REGISTRY.md in the repo (on v2, once it exists — the agent creates the branch in 0.2; you can push the docs right after).

### Step 0.2 — Create the branch and worktree 🟢
Create a branch called v2 from the current main. Set up a git worktree for it at ../x1-teleporter-v2 and do all future work there. Push the branch so Vercel starts building previews. Confirm the worktree path and branch name back to me. Do not change any files yet.

Done when: Vercel shows a preview deployment for v2 and next.x1teleporter.com loads the current site unchanged.

### Step 0.3 — Tool-call sanity check 🟢
Small test task to confirm your tooling works end to end: on v2, add a file scripts/hello-check.ts that prints the current git branch name, run it with tsx, then delete it. Tell me exactly which tools you used (file create, bash, file delete) and paste the command output. Do not open a PR for this.

Done when: it reports clean tool use with real output. If anything is flaky here, fix that before continuing — this is the DeepSeek-via-Claude-Code compatibility check.

### Step 0.4 — Feature flags + CI 🟢
On v2, open a PR that does three things and nothing else:
1. Add a lib/flags.ts that exports THORCHAIN and ANYSWAP booleans read from import.meta.env.VITE_FLAG_THORCHAIN and import.meta.env.VITE_FLAG_ANYSWAP, defaulting to false when unset.
2. Add a GitHub Actions workflow .github/workflows/ci.yml that runs on every PR: install, typecheck, lint, test, build. Add one extra check: fail the build if the directory api/lifi/ does not exist (this guards against the api-lifi naming regression).
3. Add a placeholder test so the test step has something to run.
Do not change any existing behavior. Report the PR link.

Done when: CI is green on the PR and you've merged it into v2. Then go back to GitHub branch protection on main and require this CI check.

-----

## Phase 1 — Audit gate (Days 2–4)

Goal: close the security findings before adding surface area. All 🔴 Pro.

### Step 1.1 — Approvals 🔴
Read docs/BRIEF.md Workstream 0 item 1. Find every place we request an ERC-20 approval for a LI.FI route. Replace unlimited (MaxUint256) approvals with exact-amount approvals to the approvalAddress LI.FI returns. Before signing, validate that address against the spender list from LI.FI's /v1/tools response for that chain; if it is not present, abort the transaction and show an error. Write unit tests covering: exact amount used, unknown spender rejected, known spender accepted. Open a PR. In the description, list every file you changed and every code path that still requests an approval.

Done when: PR merged into v2, tests green, and you've read the diff yourself.

### Step 1.2 — Self-relay path 🔴
Read docs/BRIEF.md Workstream 0 item 2. The X1 to Solana self-relay path has four known bugs and does not work. Investigate it, list the four bugs you find with file and line, and tell me whether you recommend fixing or removing the path for now. Do not change code yet. Stop and wait for my decision.

Then, after you decide:
[Fix it / Remove it]. If removing, make sure no picker or route builder can still offer it. If fixing, add a test per bug. Open a PR.

### Step 1.3 — Simulation, CORS, fee unification 🔴
Read docs/BRIEF.md Workstream 0 items 3, 4, 5. Open three separate PRs:
A) Simulation: any failed simulation must block the send and surface the reason to the user. Add a test.
B) CORS: restrict api/lifi/ to the production and preview origins only. Add a test that a foreign origin is rejected.
C) Fees: consolidate all fee logic into one function computeFee(route) in lib/fees.ts. It must handle: same-chain (0.5%), X1 hop (1% pre-bridge skim), Escape Hatch (5%), and two future cases with clear TODO branches: thorchain-leg and non-x1-bridge. Remove the dead fee ladder. Add tests for every case and a test that proves no route is charged twice.
Report all three PR links.

Done when: all three merged; you deploy v2 preview and do one small real X1 hop from next.x1teleporter.com to confirm the fee still lands correctly.

### Step 1.4 — You, by hand

- Do the test hop above with real money (small).
- Request the THORChain API key in the integrate-thorchain Discord channel. Register a THORName. Put the key in the Preview env var.
- Confirm with Jack/X1 Labs: does Warp carry SOL directly, and which mints beyond USDC? Is there an X1-side USDC.x→XNT route?

-----

## Phase 2 — Wallet layer (Days 5–7)

Goal: every wallet in the registry connects, nothing collides. 🟢 Flash, except signing paths.

### Step 2.1 — Shared wallet context 🟢
Read docs/BRIEF.md "Cross-cutting — Wallet layer" and docs/WALLET-REGISTRY.md. Build a single WalletContext that holds one independent session per chain family: evm, solana, bitcoin, litecoin, dogecoin, xrp, tron. Connecting or disconnecting one family must never affect another. Expose hooks useWallet(family). Do not wire any real wallets yet; use a mock provider per family and write tests proving isolation. Open a PR.

### Step 2.2 — EVM + Solana discovery 🟢
Implement EVM discovery using EIP-6963 only (wagmi). Implement Solana discovery using Wallet Standard via @solana/wallet-adapter-react with autoDetect. Build the connect modal per docs/WALLET-REGISTRY.md "Connect modal layout": fixed order, Starport pinned first, installed wallets highlighted, not-installed shown with install links, never hidden. There must be no code that reads window.ethereum or window.solana directly — add a lint rule or grep test that fails if either appears. Open a PR.

### Step 2.3 — Bitcoin via LaserEyes 🟢 (signing: 🔴)
Implement Bitcoin wallet support using @omnisat/lasereyes with one explicit provider per wallet in the Bitcoin table of docs/WALLET-REGISTRY.md. Always request the payment (bc1q) address, never the ordinals address. Implement the window.unisat impersonation rule from the registry. Include the deposit-address fallback row. Open a PR for discovery and balance reading only — do NOT implement PSBT signing in this PR.

Then, switch to 🔴:
Add PSBT signing for the Bitcoin providers, following LI.FI's Bitcoin docs: never modify the PSBT LI.FI returns. Add a test that asserts the PSBT passed to the wallet is byte-identical to the one received. Open a PR.

### Step 2.4 — LTC, DOGE, XRP, Tron 🟢
Implement the remaining families from docs/WALLET-REGISTRY.md: Litecoin and Dogecoin (Ctrl via window.xfi, plus deposit-address default), XRP (Xaman via xumm SDK as primary, deposit-address default, Crossmark and GemWallet shown with an "unmaintained" badge and ranked last), Tron (explicit adapters from @tronweb3/tronwallet-adapters, never bare window.tronWeb). Every ⚠️ row in the registry: leave a clearly marked TODO with what needs verifying rather than guessing the API. Open a PR.

### Step 2.5 — You, by hand: the collision test

In a real Chrome profile with MetaMask, Rabby, Phantom, Solflare, Xverse, Unisat, TronLink, and GemWallet installed, open next.x1teleporter.com. Work through the acceptance list in the brief. Screenshot every family's modal. Send failures back as:
Wallet layer bug report from real Chrome: [paste what you saw]. Fix and open a PR. Do not touch unrelated code.

-----

## Phase 3 — THORChain lane (Days 8–11)

Goal: native BTC/DOGE/LTC/XRP → X1, behind the THORCHAIN flag.

### Step 3.1 — Panel 2 first (hop + polling) 🟢
Read docs/BRIEF.md Workstream A, Panel 2. Build the hop side first since it reuses existing code: a component that accepts {inboundTxid, sourceChain, destination, expectedAmountOut}, polls the THORChain tx status endpoint every 15s (max 90 min), shows the stages observed → swapping → outbound_signed → done, then on done detects SOL landing in the connected Solana wallet and auto-advances into the existing SOL→USDC swap, 1% skim, and Warp step. Persist {inboundTxid, stage} in window.storage so a closed tab resumes. Everything renders only when flags.THORCHAIN is true. Mock the THORChain endpoint in tests. Open a PR.

### Step 3.2 — Fork and mount Panel 1 🟢
Read docs/BRIEF.md Workstream A, Panel 1. Fork github.com/thorchain/swap.thorchain into our org and add it as a package under packages/thorchain-panel. Mount it as a component (not iframe) inside a new two-panel field on a /thor route, gated by flags.THORCHAIN. Configure: sources limited to BTC.BTC, DOGE.DOGE, LTC.LTC, XRP.XRP; destination pinned to SOL.SOL; destination address prefilled from the Solana session in WalletContext and not editable; if no Solana wallet is connected, block with "connect a Solana wallet first". Fetch inbound_addresses on mount and every 60s and grey out halted chains. Add the submit hook that emits {inboundTxid, sourceChain, destination, expectedAmountOut} to Panel 2. Keep upstream changes minimal and list every file you modified in the fork. Open a PR.

### Step 3.3 — Fees + quote + caps 🔴
Wire the THORChain quote through the free aggregator API using THORCHAIN_API_KEY. Set affiliate to our THORName and affiliate_bps from config (start 100). Add the thorchain-leg case to computeFee so the user sees three fees before sending: THORChain affiliate, our 1% skim on the Solana leg, Warp's $1. Add a per-swap size cap from config (default 0.05 BTC equivalent). Re-fetch the quote immediately before the deposit address is shown. Tests for fee display and cap enforcement. Open a PR.

### Step 3.4 — You, by hand: mainnet test

Flip VITE_FLAG_THORCHAIN=true in Preview only. On next.x1teleporter.com, do 0.001 BTC → X1 and one of DOGE/LTC/XRP → X1. Close the tab mid-poll and reopen. Confirm all three fees. Then message Jack with the preview link.

-----

## Phase 4 — Any-swap start (Days 12–13)

Two weeks is enough to start Workstream B, not finish it. Get the route builder open and the fee model right; the ten-route acceptance runs into week three.

### Step 4.1 — Open the route builder 🟢
Read docs/BRIEF.md Workstream B. Behind flags.ANYSWAP, remove the "destination must be X1" constraint. fromChain and toChain both come from LI.FI /v1/chains, tokens from /v1/tokens, bridges from /v1/tools, with an advanced toggle for allowBridges. X1-destined routes must behave exactly as before — add a test that snapshots today's X1 route output and asserts it is unchanged. Open a PR.

### Step 4.2 — Non-X1 fee path 🔴
Add the non-x1-bridge case to computeFee: use LI.FI's integrator fee param (0.3%) for non-X1 routes; keep the pre-bridge skim only for X1-destined routes. Prove with tests that no route ever gets both. Open a PR.

-----

## Day 14 — Cutover

1. You: review that every merged PR into v2 is one you actually read.
1. Prompt 🟢:
Open a PR from v2 into main. In the description, list every flag and confirm all default to false. Do not merge it.

1. You: merge it. Watch x1teleporter.com — it should be identical to before.
1. You: flip VITE_FLAG_THORCHAIN=true in Production. Announce to Jack. Leave ANYSWAP off until the ten-route test passes in week three.
1. If anything looks wrong: flag off → Vercel Instant Rollback → git revert, in that order.

-----

## Week 3 — One-sign flow (after cutover, THORCHAIN live)

### Step W3.1 — Warp IDL check 🟢
Read docs/BRIEF.md "Follow-on — One-sign flow". Using the Warp IDL I've placed in docs/warp-idl.json, determine whether Warp's deposit instruction can be called via CPI with the USDC amount supplied at runtime by the calling program. Write a one-page findings note in docs/warp-cpi.md: instruction name, accounts required, signer requirements, and a yes/no on CPI-with-runtime-amount. Do not write program code yet.

Done when: the note says yes. If no, stop and we redesign the fallback before spending on the program.

### Step W3.2 — Anchor program 🔴
Build the Anchor program in programs/teleporter-forward per docs/BRIEF.md: single instruction forward_to_x1(x1_dest, slippage_bps). Read SOL balance at execution, keep a 0.01 SOL reserve, compute min_out from the Pyth SOL/USD feed account × slippage, CPI one direct SOL/USDC pool (use the Orca whirlpool for SOL/USDC; fixed accounts), skim 1% to the fee wallet, CPI Warp with the runtime USDC amount and x1_dest. Write tests on a local validator with mocked Pyth and pool accounts covering: normal path, floor trips, reserve respected, fee correct. Open a PR. Do not deploy to mainnet.

### Step W3.3 — Durable nonce client + watcher 🟢
Client side: on "Start", create the user's nonce account if missing (first-visit only), build [advance_nonce, forward_to_x1] with a fixed priority fee and a generous compute budget, get it signed, store the serialized signed tx in window.storage keyed by the THORChain inbound txid, then show the deposit address. Add a Cancel button that advances the nonce. Watcher: a Vercel cron (api/cron/forward.ts) that reads pending entries, polls THORChain status, and broadcasts the stored tx when the outbound confirms; retries until the nonce advances; on floor failure, marks the entry "needs re-sign" and stops retrying. Tests for each state. Open a PR.

### Step W3.4 — You, by hand

Deploy the program to devnet, run the full flow with test BTC → devnet, then get the audit quote. Do not deploy to mainnet before the audit.

-----

## Week 4 — Jito bundle + rebate (after the program is audited)

### Step W4.1 — Bundle submission 🟢
Read docs/BRIEF.md "Follow-on — Jito bundle + backrun rebate". Change the watcher to submit the forward tx as a Jito bundle with a tip via a block-engine endpoint, with plain-RPC fallback if Jito is unavailable. Tip amount from config. Tests for bundle path and fallback path. Open a PR.

### Step W4.2 — Backrun + rebate 🔴
Add a rebate instruction to the program and a backrun tx builder in the watcher: after the user's swap, trade the same pool back toward market from the arb keypair, compute profit on-chain, credit 90% to the user's USDC before the Warp CPI and 10% to the fee wallet. Skip the backrun when unprofitable after tip. The arb keypair is loaded from an env var, its balance is capped by config, and it must never hold user funds — add a test that the program rejects any path where user USDC moves to the arb key. Show "MEV rebate: +$X" in the UI. Open a PR.

### Step W4.3 — You, by hand

Fund the arb keypair with capped working capital, run ten bundled swaps on mainnet at small size, confirm rebates land, then announce the rebate line to Jack.

-----

## If a step goes sideways

Paste this:
Stop. Do not make further changes. Summarize exactly what you changed since the last merged PR, which tests pass and which fail, and what you are unsure about. Then wait.

Then decide whether to fix forward or git checkout the worktree back to the last merged commit on v2.
