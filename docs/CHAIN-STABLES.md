# CHAIN-STABLES.md — dominant gas + stablecoin map per chain

**Status:** live-verified 2026-09-08 (DefiLlama stablecoins API + per-chain
RPC/metadata probes + the tokenResolver's on-chain-verified entries).
This is the routing answer to "what gas do we send and what stable does each
chain actually deep-liquidity in". Do NOT blanket-assume USDC/ETH.

---

## STANDARD CHAINS (gas = native, stable = deep standard)

| Chain | Gas | Dominant stable | 2nd | Stable supply (live) | DEX routing note |
|---|---|---|---|---|---|
| Ethereum | ETH | **USDC** (AMM standard) | USDT | USDT $73.4B / USDC $47.1B | USDT has more *supply*; Uniswap v3 USDC pairs are the deep AMM standard. Both fine. |
| Arbitrum | ETH | **USDC** | USDT | USDC $2.23B / USDT $0.84B | Native USDC `0xaf88d065...` (6 dec). Fee-100 USDC:USDT verified. |
| Optimism | ETH | **USDT** (hairline) | USDC | USDT $238M / USDC $194M | Near-tie. Repo verified USDC:USDT fee-500. Either works. |
| Base | ETH | **USDC** | USDe | USDC $4.2B | Native USDC `0x833589fC...` (6 dec). Massively dominant. |
| Polygon | POL | **USDC** | USDT | USDC $1.8B / USDT $777M | Both native USDC `0x3c499c...` and USDC.e `0x2791Bca1...` live. Fee-500 verified. |
| BNB Chain | BNB | **USDT** | USYC/USDC | **USDT $9.18B** / USDC $1.58B | ⚠️ USDT is the king (5.8:1). Binance-Peg both, 18 dec. BSC has NO native Circle USDC. |
| Solana | SOL | **USDC** | USDT | USDC $7.3B / USDT $2.77B | USDC `EPjFWdd5...` (6 dec, spl). |
| Tron | TRX | **USDT** | USDD | **USDT $92.3B** | THE USDT chain (99.97%). USDC is negligible ($28M). TRC-20 USDT `TR7NHqje...` (6 dec). |

## WEDGE / SPECIAL CHAINS (the ones that differ — get these RIGHT)

| Chain | Gas | Stable | Evidence (verified) |
|---|---|---|---|
| **Robinhood Chain** (4663) | ETH | **USDG** (Paxos Global Dollar) | ✅ USDG $677M circulating. **NO Circle USDC exists on-chain** — LiFi token list (297) has no USDC/USDT/DAI; only `syrupUSDC` (Maple yield wrapper — excluded). USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dec). WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`. Arbirum-Orbit L2, chainId 4663, LiFi key `out`. |
| **Sui** | SUI | **USDC** (native Move coin) | ✅ USDC $280M dominant (vs USDSUI $74M, FDUSD $44M). Circle's native deployment. ⚠️ exact `0x…::usdc::USDC` type string still to be re-verified on next live touch (public Sui RPC/GraphQL unreachable from this box 2026-09-08 — do not hardcode until confirmed). |
| **X1** | XNT | **USDC.x** | ✅ Resolver-verified on-chain: USDC.x = Token-2022 `B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq` (6 dec, rails warp/xdex). wXNT = `So1111111…` (wraps XNT; xdex pool `CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR`). ⚠️ Warp bridge currently PAUSED — X1 needs its native rail (Warp/xdex), not LiFi. |
| **Hyperliquid** | HYPE | **USDC** (bridged) | ⚠️ **CORRECTION vs the 2026-09-08 brief assumption**: DefiLlama shows USDC **$6.95B** dominant; USDH only $8M. HL's own spotMeta registry (authoritative): USDC evm contract `0x6b9e773128f453f5c2c60935ee2de2cbc5390a24`, USDH `0x111111a1a0667d36bd57c0a9f569b98057111111`, HYPE = native L1 gas (no evm contract). USDH is HL's *native* stable but is NOT the deep one yet. |

---

## THE ROUTING RULES

1. **USDC-default holds for:** ETH, ARB, OPT, BASE, POL, SOL, SUI, HL, X1 (USDC.x).
2. **USDT is MANDATORY for:** BSC (dominant, 5.8:1) and Tron (99.97%).
3. **USDG is MANDATORY for Robinhood** — no USDC exists; the X1 hop converts USDG→USDC inside the route (LiFi/Relay), Warp leg unchanged.
4. **Hyperliquid routes USDC** (perp-collateral standard), NOT USDH.
5. **X1 routes via native rails** (Warp/xdex) — XNT gas, USDC.x stable; LiFi does not serve it.
6. **Native gas tokens are the DEX quote base on every chain** (memes pair against WETH/WBNB/etc. first) — for the ape/capture legs, route native → meme on the deepest venue.

## Verified-address cheat sheet (from the repo tokenResolver + this session)

- BSC USDT `0x55d398326f99059fF775485246999027B3197955` (18 dec) · BSC USDC `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` (18 dec, Binance-Peg)
- OPT USDC `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` · OPT USDT `0x94b008aA00579c1307B0EF2c499aD98a8ce58e58` (both 6 dec)
- ARB native USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` · ARB USDT `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9`
- BASE USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 dec)
- POL native USDC `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` · POL USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- ETH USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- Tron USDT `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` (6 dec, TRC-20)
- RH USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dec) · RH WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- HL USDC `0x6b9e773128f453f5c2c60935ee2de2cbc5390a24` · HL USDH `0x111111a1a0667d36bd57c0a9f569b98057111111`
- X1 USDC.x `B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq` (6 dec Token-2022)
