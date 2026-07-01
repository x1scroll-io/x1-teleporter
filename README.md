# X1 Teleporter

Any-chain → any-chain stablecoin aggregator with an X1 on-ramp. Built on LI.FI.

This repo is **Vercel-ready**: a Vite/React front-end plus serverless API
functions that proxy LI.FI and enforce the integrator fee. One `git push` and
Vercel deploys it.

---

## Deploy in 5 steps

### 1. Push to GitHub
```bash
git init
git add .
git commit -m "X1 Teleporter — initial"
git branch -M main
git remote add origin https://github.com/<you>/x1teleporter.git
git push -u origin main
```

### 2. Import to Vercel
- vercel.com → Add New → Project → import the repo.
- Vercel auto-detects Vite. Framework: **Vite**. Build: `npm run build`.
  Output: `dist`. (Already set in `vercel.json`.)
- Deploy. You get a `*.vercel.app` URL — the app is live in **demo mode**.

### 3. Set environment variables (Vercel → Settings → Environment Variables)
```
INTEGRATOR=x1-teleporter-labs
INTEGRATOR_FEE=0.01
LIFI_API_KEY=<from portal.li.fi — optional but raises rate limits>
FEE_WALLET_EVM=<your EVM fee wallet>
FEE_WALLET_SVM=<your Solana/X1 fee wallet>
```
Redeploy after adding them.

### 4. Go live (turn off demo mode)
In `src/Teleporter.jsx`, set:
```js
const DEMO_MODE = false;
```
Commit + push. Vercel auto-redeploys. Quotes now hit real LI.FI through your
serverless proxy, with your 1% fee forced on every route.

### 5. Point the domain
- Vercel → Project → Settings → Domains → add `x1teleporter.com`.
- In GoDaddy: turn OFF the Website Builder placeholder (it's hijacking the
  domain), then either set the A record Vercel shows (`76.76.21.21`) or switch
  nameservers to Vercel's. Nameserver switch avoids GoDaddy's flaky DNS panel.

---

## Checking earnings / withdrawing

```
GET /api/earnings              # your collected fees, per chain/token
GET /api/withdraw/137          # build withdraw tx for Polygon (chainId 137)
```
The server returns the withdrawal transaction; you SIGN it with your fee wallet
(EVM chains → FEE_WALLET_EVM, Solana/X1 → FEE_WALLET_SVM). The server never
holds keys or signs.

---

## What's live vs. gated

**Live at launch:**
- Any-chain → any-chain stablecoin routing (ETH, BSC, Arbitrum, Base, Optimism,
  Polygon, Avalanche, Sonic, Solana)
- X1 on-ramp / off-ramp via LI.FI + Warp Bridge
- 1% integrator fee on every EVM-leg route (in AND out of X1)
- Wallet connect, real tx execution, live status, history, recovery, settings

**Gated (flip flags when ready):**
- `ENABLE_TRON` (in Teleporter.jsx) — Tron support. LI.FI routes it; needs a
  TronLink connector + TVM sign path added. Roadmap: +1 week post-launch.
- Transak fiat on-ramp — separate Transak account + keys. Roadmap: +2 weeks
  after Tron.

**Still gated on the Warp capture test:**
- The pure Solana↔X1 hop execution and its 1% mint-skim. Keep that route in
  demo until the $1 capture test confirms the real Warp program ID,
  discriminator, and account layout (see warp-bridge-verification-checklist.md).

---

## Local dev
```bash
npm install
npm run dev        # http://localhost:5173 — runs in demo mode, no backend needed
```
The serverless `/api/*` functions run on Vercel (or `vercel dev` locally if you
install the Vercel CLI). For pure UI work, DEMO_MODE keeps everything clickable.
