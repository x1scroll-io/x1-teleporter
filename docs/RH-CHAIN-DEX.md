# RH-CHAIN-DEX.md — Robinhood Chain DEX + token mechanics research

**Status:** on-chain verified 2026-09-08 (read-only probes on rpc.mainnet.chain.robinhood.com).
Live-test wallet: 0x562d9b7093e624a83a2fdE35ee71a658208F09F9 (0.0028 WETH + 0.00038 ETH held).

## 1. THE DEX LAYER — one Uni-v3 FORK factory

- **Factory:** `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` (owner `0x05C420bC4823e039AA4dA645eDde743486dAAA25`)
- **Confirmed standard Uniswap-v3 clone:** `feeAmountTickSpacing(3000)=60` (canonical value)
- **ALL the deep "uniswap"-labeled RH pools live on this fork** (HOOD/WETH, CASHCAT/WETH, USDG/ETH, TSLA/USDG…)
- Pools are **per-pair contracts** (NOT v4 singletons) with standard v3 interface (fee/token0/token1/liquidity/slot0 all readable)
- **Canonical Uniswap contracts do NOT serve it:** canonical factory `0x1F98431c...` has no pools; canonical Quoter `0x61fFE014...` and SwapRouter `0xE592427A...` revert on fork pools (they point at the canonical factory)
- ⚠️ **The fork's own Quoter + SwapRouter addresses are UNKNOWN yet** — external explorers (blockscout, suiscan) are unreachable from this box. Found via: owner-deployment probing / pool swap-caller log scanning (HOOD pool: 0 swaps in ~5000 blocks — too idle to reveal the router).
- **Other RH DEXes (gecko slugs):** pons-v2-dex, pons-dot-family, bankr-robinhood, uniswap-v3-robinhood, uniswap-v4-robinhood, uniswap-pools-trade. Dexscreener also shows: ramses, giga, up, sushiswap, 0swap, alandale.

## 2. THE TOKEN UNIVERSE — equities trade like memes

Deep "uniswap"(fork) pools found:
| Token | Address | Deep pair | Liq | Note |
|---|---|---|---|---|
| **HOOD** | `0x274C8C4665c0343730C78B184e560F902A8Bf200` | HOOD/WETH fee-3000 | **$66.4M** | chain's flagship; standard ERC-20 (transfer sim clean); pool holds 500K HOOD |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | USDG/ETH | $8.5M | Paxos stable; also USDG/WETH $531K |
| CASHCAT | `0x020bfC650A365f8BB26819deAAbF3E21291018b4` | CASHCAT/WETH | $4.6M | meme; standard ERC-20; pool holds 16M |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | TSLA/USDG | $1.25M | **OFFICIAL RH tokenized equity — PROXY** |
| COIN | `0x6330D8C317...` | COIN/WETH | $540K | equity |
| CATE | `0xeEC74A9b96d720898316A23F12138307274C20f8` | CATE/WETH | $449K | 0 vol24 — dead LP |
| HOOD (2nd) | `0xDAA8f3f54c66E9BE2c44C1B6b566cBD07229CED3` | vs native ETH | $12M | **different HOOD? native-ETH quote** |

⚠️ Duplicate/wildcat tokens confirmed (two "CATE", two "HOOD" bases). Verify mint identity before touching.

## 3. THE HOOKS (Mr. Esters was right — THIS is the MEV edge)

- **Equity tokens = EIP-1967 proxies** with an implementation contract. TSLA proxy delegates to impl `0xe10b6f6b275de231345c20d14ab812db62151b00` (568-byte proxy, `5c60da1b` implementation() getter).
- **TSLA impl has `paused()` + `hasRole` (AccessControl)** — role-gated + pausable. Standard `transfer`/`transferFrom` selectors NOT present in impl bytecode → **transfers are compliance-gated, not plain ERC-20**.
- Implication: **equity-token swaps in AMMs can revert or behave non-standard** depending on role/pause state → sandwhich/back-run surface + liquidation-style MEV when gates toggle.
- Meme tokens (HOOD, CASHCAT, CATE2) are standard ERC-20 (transfer sims clean) — but several have **fee-on-transfer potential** (custom bytecode ~9.6-10.3KB, not OpenZeppelin-standard); needs balance-delta testing with real holdings to confirm.

## 4. FUNKY LP observations

- HOOD pool: **0 swap events in ~5000 blocks** despite $66M "liquidity" → much of it is **idle/one-sided** (dexscreener liq ≠ real depth).
- TSLA pool holder balance = 0 → the $1.25M TSLA/USDG pair may be **illiquid/misleading**.
- CATE $449K pair: **0 buys, 1 sell in 24h** → dead.
- Real volume concentrates on **pons/bankr** DEXes (PONS $8.4M liq/$27M vol, MEME $2.8M/$25M vol per gecko) — those are the ACTIVE markets, uniswap-fork is the deep-but-idle one.

## 5. NEXT STEPS (research to close)

1. **Find the fork's Quoter + SwapRouter** (needed to execute ape legs). Candidates: probe owner `0x05C420bC...` deployments via RH RPC `eth_getCode` sweep of likely addresses; or find a recent swap tx on an ACTIVE fork pool (USDG/ETH $8.5M may trade more than HOOD).
2. **Map pons-v2-dex + bankr** routers (the active-volume DEXes).
3. **Balance-delta tax test** on meme tokens with real holdings (small buy → sell, compare).
4. **Equity-token gate mechanics:** read TSLA impl's role structure + paused state; map which roles can transfer.
5. Identify the **arb surface**: equity/stable pairs (TSLA/USDG, COIN/SPY) vs WETH pairs — cross-venue spreads between fork pools + pons + bankr on the SAME token.

## PROFILE (Mr. Esters, 2026-09-08 — the authoritative framing)
- **RH Chain = Arbitrum-Orbit L2** (settles to Ethereum). Standard EVM rollup — ethers/viem, standard EVM tooling. Chain ID 4663. L2 confirmations fast.
- **Gas = ETH.** Bridge: SOL → native ETH via LiFi (chain 4663 supported). 
- **Stable = USDG (Paxos). NO Circle USDC exists. Never route USDC on RH.**
- **Dominant DEX = Uniswap (~85% volume) + Pons ($90M/day, 6 venues).**
- **Pool versions: v2 / v3 (fee tiers) / v4 all present — route across ALL versions.**

## ADDRESS VERIFICATION (2026-09-08, clean probe)
- The CANONICAL Uniswap v3 addresses (factory 0x1F98431c…, quoter 0x61fFE014…, router 0xE592427A…) DO have code on RH — but all three are **identical 4220B stubs** (impossible for real distinct contracts). They are NOT the live deployment.
- The REAL pools report factory **0x1f7d7550B1b028f7571E69A784071F0205FD2EfA** (49KB real code; pools = 44KB standard v3 code with fee/token0/slot0 readable — genuinely standard v3 pools, just RH's own factory).
- Conclusion: RH's Uniswap = standard v3-fork deployment at NON-canonical factory. Engine needs RH's factory (0x1f7d7550…) + its router (proprietary 0xB19e4456… custom entrypoint) OR aggregator execution (paraswap/kyber solve it). Pool mechanics are standard EVM — only addresses differ.
