# golden/wanchain-leg — the Wanchain-family fixtures (VERIFIED 2026-09-05)

**LABEL — one REAL ok quote; six REAL failed-route bodies (all captured live,
read-only, no funds, no broadcast).**

These are REAL responses from the Wanchain family's only public quote+build
HTTP API — **XFlows v3** (`POST https://xflows.wanchain.org/api/v3/quote`,
keyless — OpenAPI at https://xflows-open-api.wanscan.org/openapi.json),
captured live on **2026-09-05**. Full evidence chain:
`VERIFICATION-2026-09-05.json` (this directory) — the WanBridge REST API
(bridge-api.wanchain.org) tokenPairs capture, the XFlows
supported/chains+tokens+pairs captures, every probe request + response, and
the Rango /basic/meta re-verification.

| fixture | request (as captured) | result | meaning |
|---|---|---|---|
| `quote-avax-usdt-bnb-10usdt.real.json` | AVAX USDT(0x9702…) → BNB USDT(0x55d3…), 10 USDT, workMode-1 | **OK** | The one route class XFlows ACTUALLY quotes today: EVM↔EVM (direct WanBridge). Reproduces the docs' own example verbatim. |
| `quote-ada-sol-100ada.failed.json` | Cardano native ADA (2147485463, 0x0) → Solana native SOL (501, 0x0), 100 ADA | FAIL | "From Chain not supported / Unsupported chain #1" — **no ADA → SOL route** (addresses were valid-format: CIP-19 mainnet vector). |
| `quote-ada-wan-100ada.failed.json` | Cardano native ADA → Wanchain L1 (888), 100 ADA | FAIL | Same error — **no ADA → WAN route via the API** either (the docs' portal manual ADA flow is NOT behind this API). |
| `quote-btc-sol-001btc.failed.json` | Bitcoin native BTC (2147483648, 0x0) → SOL native, 0.01 BTC | FAIL | Same error — no BTC → SOL route. |
| `quote-trx-sol-1000trx.failed.json` | TRON native TRX (195, 0x0) → SOL native, 1000 TRX | FAIL | Same error — no TRX → SOL route. |
| `quote-eth-usdc-sol-100usdc.failed.json` | Ethereum USDC → SOL native (CONTROL), 100 USDC | FAIL | "no token pair for SOL cross ETH -> SOL" — **SOL has NO quotable pairs via this API at all** (not even from EVM USDC). |
| `quote-ada-sol-100ada.invalid-addr.failed.json` | Cardano ADA → SOL with a fabricated (invalid) Cardano address | FAIL | "Invalid fromAddress" — proves address validation happens BEFORE routing (the 103-char CIP-19 vector passes; this one doesn't). |

## What this means (the honest verdict)

**Wanchain does NOT currently expose any public HTTP API that quotes
ADA/SUI/Polkadot (or any non-EVM source) → SOL.** The docs' supported-chains
matrix (Cardano/Sui/Polkadot/Solana/Tron/UTXOs under "WanBridge") describes
the portal product (bridge.wanchain.org — storeman bridge-node group,
17-of-25 sMPC), whose pair registry + fees are ON-CHAIN iWan JSON-RPC calls —
not a documented public REST quote API — and whose live operational status for
those chains could not be verified without a portal/on-chain session.

The engine's Wanchain leg (`wanchainQuoteLeg`) is therefore built against the
XFlows v3 API with a **fail-closed coverage gate**: its config registry marks
exactly which source chains are `apiQuotable` (today: the EVM class only), and
the leg refuses to build a request for anything else. The fixtures above pin
the parser against both the OK shape and the real failed-route bodies.

## Re-capturing (when you want fresh evidence)

```bash
# OK route (EVM):
curl -s -X POST https://xflows.wanchain.org/api/v3/quote -H 'Content-Type: application/json' \
  -d '{"fromChainId":43114,"toChainId":56,"fromTokenAddress":"0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7","toTokenAddress":"0x55d398326f99059ff775485246999027b3197955","fromAddress":"0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200","toAddress":"0x2fb4D46372Ea1748ec3c29Bd2C7B536019DF5200","fromAmount":"10"}'

# Unsupported route (ADA → SOL) — expect the real failure body:
curl -s -X POST https://xflows.wanchain.org/api/v3/quote -H 'Content-Type: application/json' \
  -d '{"fromChainId":2147485463,"toChainId":501,"fromTokenAddress":"0x0000000000000000000000000000000000000000","toTokenAddress":"0x0000000000000000000000000000000000000000","fromAddress":"addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x","toAddress":"G8XKKQv6kESVby9b1qvGWHpyexKfbWzFvVQtEz6WyiS2","fromAmount":"100"}'
```

**Re-verify before ANY future claim that 'Wanchain covers chain X':** run the
probe for that exact route and keep the body. The XFlows supported/chains
registry lists Cardano/Sui/BTC/SOL/TRON today while the quote router refuses
every one of them — registry rows are NOT routes.
