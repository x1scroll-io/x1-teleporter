# robinhood-leg — SIMULATED LiFi quote evidence (Robinhood Chain → X1 hop)

**HONESTY LABEL — SIMULATED, READ-ONLY EVIDENCE. NO LIVE TRANSACTION EVER
HAPPENED. NO FUNDS MOVED.**

Captured 2026-09-05 (autonomous research session, Mr. Esters asleep) via
read-only `GET https://li.quest/v1/quote` calls — LiFi quotes are reads; they
quote a route and never move funds. These files exist so the Robinhood Chain
integration's rail support is backed by **real API evidence**, not
assumption. Nothing here is a frozen golden reference and nothing here was
produced by a live send.

## What the quotes prove

Robinhood Chain (chainId **4663**, LiFi key **`out`**) is a live LiFi
source/destination chain, and the **LiFi/Warp rail already serves it** for
the X1 hop's exact leg shape (EVM stable → Solana USDC → Warp → X1 USDC.x):

| File | Route | Tool | Result |
|---|---|---|---|
| `quote-usdg-4663-to-sol-usdc-100.json` | USDG (RH Chain 4663) → USDC (Solana) — the forward on-ramp leg 1 | Relay (relaydepository) | $100 USDG in → ~99.641 USDC out (est. `toAmount` 99641002 @ 6 dec); LiFi fixed fee 0.25% ($0.2498) in `feeCosts`; `approvalAddress` = LiFi diamond 0xB477…4Af3 on 4663 |
| `quote-sol-usdc-to-usdg-4663-100.json` | USDC (Solana) → USDG (RH Chain 4663) — the reverse off-ramp leg | Relay (relaydepository) | $100 USDC in → ~99.505 USDG out (est. `toAmount` 99504985 @ 6 dec); executionDuration ≈ 1 min; gasCosts on Solana (SOL) |

Both used the repo's fixture wallet addresses (fake, never funded) as
`fromAddress`/`toAddress` — the builder's no-placeholders rule is about real
execution, and these are read-only quotes.

## Why USDG and not USDC?

**There is no Circle USDC on Robinhood Chain** (as of 2026-09-05). Robinhood
Chain's canonical stablecoin is **Paxos USDG** — `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`
(6 decimals) — listed on Robinhood's own docs (Token Contracts page:
`https://docs.robinhood.com/chain/contracts`) and in LiFi's chain-4663 token
list. LiFi's list (297 tokens) contains no plain USDC/USDT/DAI; `syrupUSDC`
(0xC6a4…) is a Maple Syrup yield wrapper, not canonical, and is deliberately
excluded from `TOKENS.rh`. Relay converts USDG → Solana USDC inside the
route, so the X1 hop's landing token (Solana USDC) is unchanged.

## Re-running the evidence

```
curl -s "https://li.quest/v1/quote?fromChain=out&toChain=SOL&fromToken=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168&toToken=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&fromAmount=100000000&fromAddress=0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6&toAddress=wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV&slippage=0.005&order=CHEAPEST&allowSwitchChain=false"
```

(`fromChain=out` and `fromChain=4663` both work — verified 2026-09-05.)

## Ready for live test (Mr. Esters)

- [ ] Live quote in the console: source Robinhood Chain → USDG → X1 (USDC.x).
- [ ] Live quote reverse: X1 (USDC.x) → Robinhood Chain → USDG.
- [ ] Wallet network switch to Robinhood Chain (chainId 4663 / 0x1237,
      RPC `https://rpc.mainnet.chain.robinhood.com`) — Rabby/MetaMask will
      need the network added (wallet_switchEthereumChain returns 4902 → app
      tells the user to add it; no in-app add flow exists for any chain yet).
- [ ] Confirm Relay's USDG route is still live + the fee lines render sanely
      (LiFi fixed fee 0.25% shows as third-party fee; the x1-class route has
      NO integrator fee — stage-2 skim only, per fee policy).
- [ ] First REAL journey should be small ($25–50) per the repo's go-live habit.
