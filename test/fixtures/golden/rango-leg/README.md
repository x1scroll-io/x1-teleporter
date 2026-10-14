# golden/rango-leg — the Phase-5 Rango fixtures (REAL quote responses)

**LABEL — quote-level REAL, swap-execution PENDING LIVE ANCHOR.**

These four response bodies are REAL Rango API responses, captured live on
**2026-09-05** (read-only quote calls — no funds, no broadcast) against
`https://public-api.rango.exchange/basic/quote` with Rango's DOCUMENTED
public test key (docs.rango.exchange/api-integration/api-key-and-rate-limits:
`c6381a79-2817-4602-83bf-6a641a409e32` — test key, public-api host only,
fixed low rate limit, never production).

| fixture | request (as captured) | result | swapper |
|---|---|---|---|
| `quote-sui-sol-100sui.real.json` | `from=SUI.SUI&to=SOLANA.SOL&amount=100000000000` (100 SUI, 9 dec) `&slippage=1` | OK | NearIntent |
| `quote-xrpl-sol-100xrp.real.json` | `from=XRPL.XRP&to=SOLANA.SOL&amount=100000000` (100 XRP, 6 dec) `&slippage=1` | OK | NearIntent |
| `quote-tron-usdt-sol-100usdt.real.json` | `from=TRON--TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` (TRON USDT) `&to=SOLANA.SOL&amount=100000000` `&slippage=1` | OK | NearIntent |
| `quote-btc-sol-1btc.real.json` | `from=BTC.BTC&to=SOLANA.SOL&amount=100000000` (1 BTC, 8 dec) `&slippage=1` | OK | Flashnet |

Why these four: SUI + XRP are the Rango-native sources the scaffold plans
(THORChain can't serve SUI; XRP is served by BOTH rails — Rango is the
fallback). TRON USDT is the address-form asset string (`CHAIN--address`).
BTC is the THORChain-halt fallback case — Rango serving a native THORChain
source. All four prove the SOLANA.SOL destination answers OK.

## What is REAL vs PENDING here

- **REAL (this dir):** the quote-level responses above — market data,
  captured read-only, safe to freeze. The canonical parse
  (`parseRangoQuoteResponse` in src/lib/rango/quote.js) must handle them;
  the golden test (test/goldenRango.test.js) pins that.
- **PENDING (deliberately NOT captured):** the swap-execution anchor. A real
  Rango create-transaction (`GET /basic/swap`) needs a real source wallet +
  real funds to be meaningful — that is **Mr. Esters' live test**, fired
  when he's up. The engine's `rango-execute` leg is a GUARDED STUB whose
  submit() throws `RangoLiveTestGateError` ("ready for live test — not
  wired for autonomous broadcast"). The request SHAPE it pins is built from
  the documented API (docs.rango.exchange …/create-transaction-swap), not
  from a live capture — replace with the real capture on the first operator
  swap, exactly like the THORChain lane's synthetic-to-live note.

## Re-capturing (when you want fresh quotes)

```bash
curl -s "https://public-api.rango.exchange/basic/quote?from=SUI.SUI&to=SOLANA.SOL&amount=100000000000&slippage=1&apiKey=c6381a79-2817-4602-83bf-6a641a409e32"
```

The `apiKey` is the PUBLIC TEST key from Rango's docs — do NOT put a real
key in fixtures or code. Request a private key on Rango's Discord for
production (server env only: `RANGO_API_KEY`).
