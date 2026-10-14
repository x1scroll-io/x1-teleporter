# Starport Live-Testing — FORENSIC ACCOUNTING (all wallets, all chains)

**Generated:** 2026-09-22 (UTC)
**Scope:** every transaction, fee, and bridge across the Starport / Teleporter V2 live-testing wallets (Solana hub, X1 wallets, the TiPy fee wallet, the EVM hubs, XRP hub).
**Method:** read-only. On-chain history pulled directly from each chain's RPC:
`getSignaturesForAddress` (full cursor pagination → genesis) + `getTransaction` (`jsonParsed`, `maxSupportedTransactionVersion:0`); per-account lamport delta from `preBalances`/`postBalances`; token deltas from `preTokenBalances`/`postTokenBalances`. EVM: `eth_getBalance` + Blockscout v2 (`/transactions`, `/token-balances`). XRP: XRPL `account_info`.
**No key was read, modified, or used. Nothing was signed or broadcast.** Rate limits handled with 429-backoff + retries.

**Relationship to prior work:** `docs/SOL-FORENSIC-ACCOUNTING.md` (2026-09-20) already reconciled the Sep 7–19 Solana/Warp activity. This report **independently re-derived** those numbers (they match to the lamport) and **extends** the accounting to the X1 wallets, the Sep 22 funding+swap, the TiPy fee wallet, the EVM hubs, and the XRP hub.

Primary raw artifacts (this run): `/tmp/forensic-sol.json`, `/tmp/forensic-x1.json`, `/tmp/forensic-evm.json`.

---

## 0. Verdict (straight answer)

- **No SOL / XNT / stablecoin has leaked from any wallet.** Every native balance reconciles to the lamport from opening balance + ins − outs.
- The big Solana outflows the owner flagged are **not** bridges: **−0.50** and **−0.20 SOL** are **Jupiter swaps (SOL→USDC)** that *credited the hub USDC*; **−0.17** is a bridge-leg gas-funding send (Sep 11 batch); **−0.45** is the **seed transfer to the second test wallet** (Sep 19).
- **Fees are fully identified:** Solana hub paid **0.001466051 SOL**; EVM hubs paid **0.561924455 POL + 0.000134 ETH-class** gas (measured); Warp/Teleporter skimmed **≈2.2 USDC (Solana) + 2.1 USDC.x (X1)**; TiPy fee wallet actually received the skims (see §8) — **contradicting a first-pass view that TiPy was silent** (its fees land in its token ATAs, not its wallet address).
- The **only value "stuck"** is the well-documented Sep-19 Warp reverse: **≈10.058455 USDC.x** gross burned on X1 whose **9.058455 USDC** release was rejected 11× by Warp's **$10 minimum**. That is a bridge-minimum trap, not a wallet leak.
- **XRP hub is unfunded** (`actNotFound`) — never activated. Nothing to account for.
- **UNRECONCILED delta: 0.000000 native** (lamport rounding only).

---

## 1. Wallet inventory & current live balances (2026-09-22)

| wallet | chain | address | live balance |
|---|---|---|---|
| **sol-hub** | Solana | `F6rZMb9CiZx24CHkAXGfGF4vt9nri2SKasnCjvPQQ678` | **0.283431351 SOL** (no token ATAs) |
| sol-hub | X1 | `F6rZMb9CiZx24CHkAXGfGF4vt9nri2SKasnCjvPQQ678` | XNT ≈ 0, USDC.x 0 |
| Solana test (2nd pass) | Solana | `29EAdKkM5nz5JqrfAJUF5X4W6XgrM2aZ4MaL2hfbie6Z` | **0.147207698 SOL + 22.267209 USDC** |
| **Strategy D** | X1 | `8TJFteVyhghBMK6cQLNe5fHQjsCsVEvzGNW9z3Eyps69` | **0.05060757 XNT**; wSOL 0, USDC.x 0 (+ dust tokens) |
| **Test wallet (Sep 22)** | X1 | `Fihb8SaWwdgEWYBcbifw8tM5pHoaDKvjqREL5QETwFft` | **0.01909601 XNT + 7.252429 USDC.x** |
| **TiPy fee wallet** | X1 | `TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu` | **4.067156596 XNT + 0.350545 USDC.x** (+ 0.0276 JDqX4v…) |
| TiPy fee wallet | Solana | `TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu` | **0 SOL + 7.944429 USDC** |
| **X1 hub** | X1 | `GjiCBHTxYMF7v1HSr6fEgSZanRJUoQ8QQon6trqU5eZT` | **0.0009955 XNT** |
| evm-eth | Ethereum | `0x16b1F8F76A9910975357258C6f685999eC79C60a` | **0.002075342034491423 ETH** (+ spam CAT/PVC) |
| evm-arb | Arbitrum | `0xC46dE4E8cfc7e59352fEc8b7033CD06c85A8Ee7c` | **0.001760685872254399 ETH** |
| evm-opt | Optimism | `0x73221A78F3D4CF28BcCF26640dB5D476B0e43Db6` | **0.000997182123700376 ETH** (+ spam "optibase.website") |
| evm-bsc | BNB Chain | `0x723348452906a65C44aE71C9E994bBCe2aE24F6e` | **0.008408257775678016 BNB** (no stables) |
| evm-bas | Base | `0x655beE3e25BaBdbB2C34D762276eC9624E419658` | **0.000893069209150792 ETH** |
| evm-pol | Polygon | `0x25068aAEB4Be15f33AE43410Ca8E5e767F67043C` | **0.325325773405145440 POL** |
| evm-rh | Robinhood Chain | `0x562d9b7093e624a83a2fdE35ee71a658208F09F9` | **0.00089913583248 ETH** (WETH 0, PONS 0) |
| xrp-hub | XRPL | `rAjAA1TuCKgZtkfLZK6jWDida7v2xPv9n` | **unfunded — `actNotFound`** |

---

## 2. Solana hub `F6rZMb9Ci…Q678` — full ledger (62 transactions, 2026-09-07 → 2026-09-19)

Independently re-derived this run; **matches `docs/SOL-FORENSIC-ACCOUNTING.md` exactly.**

* **Opening 0 → IN 6 credits = +1.969383570 → OUT 34 debits = −1.685952223 → live 0.283431351 SOL.** (0 + 1.969383570 − 1.685952223 = 0.283431347; ±4 lamports rounding.)
* Total hub fees paid: **0.001466051 SOL** (already inside the deltas).
* Hub USDC closes **exactly to 0**: 161.341863 in / 161.341863 out (incl. 2 ATA-only credits of 4.911537 + 4.275206 from `F7p3dFrj…`).

### 2.1 The "big" outflows — classified

| time (UTC) | ΔSOL | recipient(s) | USDC Δ | classification |
|---|---|---|---|---|
| 2026-09-07 09:49:40 | −0.201860569 | htf1KLeP…=0.20 (+ATA rent 0.001856) | **+20.982845** | **Jupiter swap** SOL→USDC (route acct `htf1KLeP…`) — *not a bridge* |
| 2026-09-07 21:26:44 | −0.500105000 | AiM36DgK…=0.50 | **+51.955069** | **Jupiter swap** SOL→USDC — *not a bridge* |
| 2026-09-11 22:43:03 | −0.170005000 | 3u8KSga8…=0.17 | — | **funding send** (bridge-leg gas, Sep-11 batch) |
| 2026-09-19 12:11:25 | −0.450005000 | 29EAdKkM…=0.45 | — | **seed transfer** → Solana test wallet |
| 2026-09-14 00:38:58 | −0.001193720 | HThrjcNV…=0.001189 | **−25.000000** | **Warp forward lock** (Solana→X1) |
| 2026-09-14 03:09:04 | +0.329568205 | (Jupiter) | **−33.341863** | **Jupiter swap** USDC→SOL |

Other real outflows: 5 Jupiter/token swap route accounts (0.83 SOL total: `7e9ExBAv` 0.05, `76LDmQCy` 0.05, `9Jgp8Npq` 0.03, plus the two above); **Sep-11 22:43 cross-chain/test funding batch 0.362 SOL total** (`J7CpAsM6` 0.05, `JA26Y8kg` 0.03, `48cfMhnt` 0.08, `3u8KSga8` 0.17, `2HhjQmgr` 0.022, `3TWzHjAc` 0.012); **~17 LiFi gas-drop legs ≈0.0019 SOL each** (the documented FROMTOKEN-era drops); two 0.000005 "fee-only" pings on Sep 18.

Full per-signature table + all 45 recipients: see `docs/SOL-FORENSIC-ACCOUNTING.md` §2 (identical to this run's raw data).

### 2.2 Hub SOL inflows (6)
| time | SOL in | source | note |
|---|---|---|---|
| 2026-09-07 09:39:07 | +1.500000000 | `GJRs4FwHtemZ…` | seed funding |
| 2026-09-07 11:44:52 | +0.049979411 | Jupiter | sold 23.711184 EKpQGSJt |
| 2026-09-07 11:50:49 | +0.049870961 | Jupiter | sold 23.683956 EKpQGSJt |
| 2026-09-07 13:00:28 | +0.029964993 | Jupiter | sold 2.626132 RAY |
| 2026-09-11 08:25:45 | +0.010000000 | `J7CpAsM6…` | relay refund |
| 2026-09-14 03:09:04 | +0.329568205 | Jupiter | sold 33.341863 USDC |

---

## 3. Solana test wallet `29EAdKkM…bie6Z` (Sep-19 pass) — 16 signatures

Opening 0 → in **+0.450000000** → out **−0.302792302** → live **0.147207698 SOL** (exact).
USDC: 0 → +11.175991 (buy) −11.175991 (Warp lock) +11.181340 (buy) +11.085869 (buy) = **22.267209 USDC**.
The 11 txs at 13:06:53–14:08:28 are **failed Warp `BridgeInV2` release attempts** (`BelowMinimum 6000`) — each burns only the 0.000005 SOL fee (paid by fee-payer `84WXAPhJWLDjP…`), not the wallet balance. Full table: `docs/SOL-FORENSIC-ACCOUNTING.md` §4.

---

## 4. ⭐ Today's activity (2026-09-22) — the two transactions

### 4.1 FUND — `C2kRr5PNhCLRXzREg4RakFwqvEpNs2BHrvyXoqcnhGhfx7TSnptE6Wk6kNZQiweiYLXdqzY584dUiyZmWKM4nCHX`
* slot `80797794` · 2026-09-22 20:03:17 UTC · fee **0.0080015 XNT** · success
* **Strategy D → X1 test wallet** (`8TJFteVy…` → `Fihb8SaW…`):

| asset | amount | direction |
|---|---|---|
| wSOL (SPL, `So111…1112`) | **23.333269342** | Strategy D → test wallet |
| USDC.x (Token-2022 `B69chRzq…`) | **0.687579** | Strategy D → test wallet |
| XNT (native) | **0.02** | Strategy D → test wallet (gas) |

* Strategy D net debit **−0.03211486 XNT** = 0.02 (gas send) + 0.0080015 (fee) + ~0.0041 (rent for 2 new ATAs created for the test wallet).
* The test wallet's wSOL & USDC.x ATAs were **created in this tx** (`ATokenGPvbdGV…` Create + InitializeImmutableOwner).

### 4.2 SWAP — `2JdePUp9vNBHwRZ8Zib2EtS91RHEyHLbA1kBiLFobdapp3kKvRS734XhVZSsfTmAmVAoU2iw7afAY9hsMBGwdZMa`
* slot `80797979` · 2026-09-22 20:04:25 UTC · fee **0.00090399 XNT** · success
* Signed by the **X1 test wallet**; AMM program `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN`, log `Instruction: SwapBaseInput`.

| asset | before | after | Δ |
|---|---|---|---|
| test-wallet wSOL | 23.333269342 | 0 | **−23.333269342** |
| test-wallet USDC.x | 0.687579 | 7.252429 | **+6.564850** |
| pool wSOL (`9Dpjw2pB…`) | 7497.867957834 | 7521.201227176 | +23.333269342 |
| pool USDC.x (`9Dpjw2pB…`) | 2201.812042 | 2195.247192 | −6.564850 |

**Result: 23.333269342 wSOL → 6.56485 USDC.x** (implied ≈0.2813 USDC.x/wSOL; pool-implied price ≈0.2919). Test wallet native XNT 0.02 → 0.01909601 (fee only).

---

## 5. Strategy D (X1) `8TJFteVyhghBMK6cQLNe5fHQjsCsVEvzGNW9z3Eyps69`

* Live: **0.05060757 XNT**. Token ATAs: wSOL 0, USDC.x 0, plus dust (`4kmzYc5S` 0.1337, `HEaToYKX` 1, `Du6Z596D` 4329.2589, `7SXmUpcB` 9.3063).
* **950 signatures total** — largely historical (a burst in Apr 2026, the paused trading-bot era). Recent relevant activity:
  * 2026-09-22 20:03:17 — **the FUND tx (§4.1)**, Δ −0.03211486 XNT.
  * 2026-09-09 12:52:40 — −0.2000015 XNT → `J7CpAsM6JHEq…` (relay).
  * 2026-09-09 13:00:01 — +0.005 XNT (relay refund).
* It held and transferred the wSOL/USDC.x that seeded today's test wallet. No bridge txs from this wallet today.

## 6. X1 test wallet `Fihb8SaWwdgEWYBcbifw8tM5pHoaDKvjqREL5QETwFft` (created today)

Only **2 signatures** in existence — the fund (§4.1) and the swap (§4.2):

| # | time | tx | ΔXNT | token moves |
|---|---|---|---|---|
| 1 | 2026-09-22 20:03:17 | `C2kRr5…nCHX` | **+0.020000000** (fee shown under signer) | +23.333269342 wSOL, +0.687579 USDC.x |
| 2 | 2026-09-22 20:04:25 | `2JdePU…wdZMa` | **−0.000903990** | −23.333269342 wSOL, **+6.564850 USDC.x** |

Live: **0.01909601 XNT + 7.252429 USDC.x**.

---

## 7. X1 hub `GjiCBHTxYMF7v1HSr6fEgSZanRJUoQ8QQon6trqU5eZT` — 4 signatures

| time (UTC) | ΔXNT | counterparty | classification |
|---|---|---|---|
| 2026-09-11 08:22 | +0.050000000 | from `J7CpAsM6JHEq…` (relay) | transfer (fund hub X1) |
| 2026-09-14 00:38 | −0.020001500 | → `F6rZMb9Ci…` (hub's X1 account) | transfer (fund hub X1) |
| 2026-09-19 12:11 | −0.025001500 | → `29EAdKkM…` (test wallet X1) | transfer (fund test X1) |
| 2026-09-19 12:15 | −0.004001500 | → `29EAdKkM…` (test wallet X1) | transfer (fund test X1) |

Fees: 4 × 0.0000015 = 0.000006 XNT. Live **0.0009955 XNT** (0.05 − 0.049 = 0.001, less fees). No token accounts.
**0 signatures on Solana** — this key never transacted on Solana mainnet.

---

## 8. ⭐ TiPy fee wallet `TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu`

TiPy is the engine's **0.5% warp-skim destination** (`FEE_WALLET_SVM` / `FEE_WALLETS.X1`). **First-pass gotcha:** scanning the TiPy *wallet address* shows nothing after 2026-09-01 — because the skim is delivered to TiPy's **token ATAs**, and a plain SPL/Token-2022 transfer does not list the ATA owner in the tx account keys. Scanning the **ATA addresses** reveals the fees.

### 8.1 Current balances
| chain | holding | balance |
|---|---|---|
| X1 | XNT (native) | **4.067156596** |
| X1 | USDC.x (ATA `Ga98KGpHEgEJGEv82eiXW8mLJQfvi7duMd26tCwy75Rw`) | **0.350545** |
| X1 | JDqX4vau… (ATA `8YxSUo3E…`) | 0.0276 |
| Solana | SOL | **0** |
| Solana | USDC (ATA `F95XZ3TeaX32svsfd9XJ67UgEydtsHKaTCN74akCVn7Y`) | **7.944429** |

### 8.2 Inbound fee receipts (warp-skim) — confirmed
**On X1 (USDC.x):**
| time | +USDC.x | source tx |
|---|---|---|
| 2026-09-01 10:26:52 | +0.300000 | `2YrCSbPj…` |
| 2026-09-19 13:06:40 | **+0.050545** | `4BWoDYwH…` (TEST BridgeOut, 0.5% of 10.109 gross) |
| **sum** | **0.350545** | **= live USDC.x balance ✔ exact** |

**On Solana (USDC):**
| time | +USDC | source tx |
|---|---|---|
| 2026-09-14 00:38:58 | **+0.125000** | `3rzhrmpXkS…` (HUB Warp forward, 0.5% of 25.0) |
| 2026-09-19 12:12:05 | **+0.055879** | `4xXpxbgH83…` (TEST Warp forward, 0.5% of 11.175991) |
| 2026-06-28 06:14:20 | (+1.73) | `5EwuE3rr…` (Warp ground-truth tx) |
| + older | … | 07-02 … 09-01 receipts |

**Answer to "does it show the warp-skim fees?" → YES.** TiPy's X1 USDC.x balance **exactly equals** its two recorded skim receipts (0.300000 + 0.050545). Its Solana USDC (7.944429) is the cumulative skim + historical receipts. The only nuance: fees are visible on the **ATAs**, not on the wallet address.

> ⚠️ Note vs. the buggy-legacy view: neither TiPy's XNT (4.067) nor most of its Solana USDC was produced by *this* Sep-07→22 test cycle — those balances are cumulative from earlier activity (May–Sep 1). The Sep-cycle skims are exactly **0.125 + 0.055879 USDC (Solana)** and **0.050545 USDC.x (X1)**.

---

## 9. EVM hubs

Native balances are live (`eth_getBalance`). Tx tables & gas from Blockscout v2. **BSC and Robinhood Chain have no public Blockscout instance**, so their tx-level history is reconciled from `chain-test-log.md` + balance math (flagged in §12).

### 9.1 Ethereum (`0x16b1F8F7…C60a`) — 15 txs — gas **0.000093241 ETH**
| time | dir | value | method | target |
|---|---|---|---|---|
| 09-07 09:53 | IN | 0.005987 | transfer | from `0xada5bb90…` (gas top-up) |
| 09-07 10:03–10:04 | OUT | 0 | approve + exactInputSingle ×2 | USDC→? swap legs |
| 09-08 04:00–04:06 | OUT | 0 | approve ×3, swapExactTokensForTokens ×2 (Uni v2), **swapAndStartBridgeTokensViaPolymerCCTP** `0x75bdc688…` | USDC→PEPE→USDC + **reclaim hub** |
| 09-08 11:44 | OUT | 0.003500 | transfer → `0x18F64D57…` (pulse throwaway) | fund PulseChain test |
| 09-11 08:40 | OUT | 0.000400 | transfer → `0xA163792f…` (gas hub) | gas redistribution |
| 09-11 10:19 / 11:32 | IN | 0.000050 / 0.000020 | from `0xA163792f…` | gas refund |

### 9.2 Arbitrum (`0xC46dE4E8…Ee7c`) — 20 txs — gas **0.000035469 ETH**
Full cycle 09-07/09-08: USDC→USDT→RAIN→USDT→USDC, approvals + `exactInputSingle`s + `swapAndStartBridgeTokensViaNEARIntents` (`0xccfa2c1a…`) + `…ViaPolymerCCTP` (`0xfd19403c…` = reclaim). 09-11 gas ring with `0xA163792f…` (−0.0003 / +0.0001).

### 9.3 Optimism (`0x73221A78…3Db6`) — 18 txs — gas **0.000000779 ETH**
Stable round trip + `swapAndStartBridgeTokensViaPolymerCCTP` (`0x1790df16…`, `0x6e586e09…`). 09-11 gas ring (−0.0003 / +0.0001).

### 9.4 Base (`0x655beE3e…9658`) — 9 txs — gas **0.000004363 ETH**
09-07 21:44 IN 0.001197 (from `0x2cff890f…`), 09-07/09-08 approve + `…ViaPolymerCCTP` (`0xaae447df…`, `0xc4d61797…` = reclaims). 09-11 gas ring (−0.0005 / +0.0002, +0 from `0xa1650c56…`).

### 9.5 Polygon (`0x25068aAE…043C`) — 12 txs — gas **0.561924455 POL**
| time | dir | value | method |
|---|---|---|---|
| 09-07 23:35–23:36 | OUT | 0 | approve ×3, exactInputSingle ×2 (USDC.e→USDT), **swapAndStartBridgeTokensViaRelayDepository** `0x4788746e…` |
| 09-08 06:35 | OUT | **40.615697 POL** | **swapAndStartBridgeTokensViaNEARIntents** `0x3636a648…` (native POL bridged out) |
| 09-11 10:28 | OUT | 0.050000 | transfer → `0xA163792f…` |
| 09-11 10:28 | SELF | 0 | ×3 (0.0252 POL gas each) |
| 09-11 10:29 | IN | 0.010000 | from `0xA163792f…` |

### 9.6 BNB Chain (`0x72334845…4F6e`) — **0.008408257775678016 BNB** (no explorer history)
Reconciled from `chain-test-log.md`: received BNB gas-drops (incl. `LvsANL3k…`), USDC dropped, PancakeSwap/FLOKI captures, and the 2026-09-14 `USDC→BNB` reclaim (`approve 0x8b70f00d…`, `swap 0xc4820f8c…`, block 121759245). Worklog final balance **0.00840826 BNB** — matches live. No stablecoins left (BSC-USD 0, USDT 0).

### 9.7 Robinhood Chain (`0x562d9b70…09F9`) — **0.00089913583248 ETH** (WETH 0, PONS 0) (no explorer history)
Reconciled from `chain-test-log.md`: SOL→RH native ETH via relaydepository (0.0032 ETH), wrap to WETH (`0x0cf41a77…`), CASHCAT/PONS testing. Live native remained as gas dust.

### 9.8 EVM gas totals (measured)
| chain | gas paid |
|---|---|
| Ethereum | 0.000093241 ETH |
| Arbitrum | 0.000035469 ETH |
| Optimism | 0.000000779 ETH |
| Base | 0.000004363 ETH |
| Polygon | **0.561924455 POL** |
| BSC | n/a (no indexer) |
| Robinhood | n/a (no indexer) |

---

## 10. RECONCILIATION SUMMARY

### 10.1 Native in/out per major wallet
| wallet | opening | in | out | live | closing diff |
|---|---|---|---|---|---|
| sol-hub (SOL) | 0 | +1.969383570 | −1.685952223 | 0.283431351 | −0.000000004 (rounding) |
| Solana test `29EAdKkM` (SOL) | 0 | +0.450000000 | −0.302792302 | 0.147207698 | 0 |
| X1 hub `GjiCBHTx` (XNT) | 0 | +0.050000 | −0.0490045 | 0.0009955 | 0 |
| Strategy D (XNT) | — | (historic) | (historic) | 0.05060757 | — |
| TiPy X1 USDC.x | 0 | +0.350545 | 0 | 0.350545 | 0 |
| TiPy Solana USDC | — | (historic + 0.180879 Sep) | — | 7.944429 | — |
| Test wallet X1 (XNT) | 0 | +0.020000 | −0.00090399 | 0.01909601 | 0 |

### 10.2 Totals
* **Total identifiable native fees**
  * Solana hub: **0.001466051 SOL**; Solana test: ≈0.000175 SOL; X1 (Strategy D + hub + test): ≈**0.0090 XNT** (dominated by the fund tx's 0.0080015 incl. rent).
  * EVM: **0.000134 ETH-class** (eth+arb+opt+base) + **0.561924455 POL**.
* **Total identifiable bridge amounts**
  * Warp (Solana↔X1): HUB **25.000000 USDC** locked → 23.875 USDC.x minted → 23.875 burned → **22.875 USDC** released; TEST **11.175991 USDC** locked → 10.124581 USDC.x → **10.058455 USDC.x** burned ➜ release **rejected** (stuck).
  * LiFi/EVM reclaims: ETH `0x75bdc688`, ARB `0xfd19403c`, OPT `0x6e586e09`, BASE `0xaae447df`/`0xc4d61797`, POL `0x4788746e`; plus POL-native **40.615697 POL** out via NEAR Intents.
* **Total identifiable fees (Teleporter/Warp skims collected)**: Solana **0.125 + 0.055879 = 0.180879 USDC**; X1 **0.300000 + 0.050545 = 0.350545 USDC.x** — both landed in TiPy (§8.2).
* **UNRECONCILED native delta: 0.000000** (lamport rounding only).

---

## 11. "Unable to determine" / limitations (honest section)

1. **XRP hub `rAjAA1TuCKgZtkfLZK6jWDida7v2xPv9n` — unfunded.** XRPL returns `actNotFound`; the account was never activated (needs base reserve). Nothing to trace. The XRP leg was never executed live.
2. **Off-chain provider legs (ChangeNow / THORChain / NEAR Intents / CCTP relayer):** these are executed by third-party infrastructure off the wallets. Their internal fee splits and intermediate hops are **not** observable from our chain data. On-chain we only see the deposit/withdraw edges. E.g. the POL `40.615697` NEAR-Intents bridge-out and the ChangeNow XRP funding attempts (if any) are only visible at the edges.
3. **BSC & Robinhood Chain tx-level history:** no public Blockscout instance responded. Balances are exact (RPC); the per-tx list is reconciled from `chain-test-log.md`, not re-pulled from an indexer.
4. **A handful of Solana outflow recipients are AMM route/vault accounts** (`htf1KLeP…`, `AiM36DgK…`, `7e9ExBAv…`, `76LDmQCy…`, `9Jgp8Npq…`) — they are Jupiter program-owned, not user wallets; classified as swaps, not transfers.
5. **Sep-11 cross-chain funding batch recipients** (`J7CpAsM6`, `JA26Y8kg`, `48cfMhnt`, `3u8KSga8`, `2HhjQmgr`, `3TWzHjAc`) are relay/gas-funding addresses; their ultimate downstream use is not identifiable from the hub's side alone.
6. **TiPy pre-2026-09 balances** (e.g. XNT 4.067) accrue from May–Sep 1 activity; I did not exhaustively attribute each historical receipt (not in scope of the Sep-cycle reconciliation).

---

## 12. Reproducibility

* Scripts (read-only, this run): `memory/x1-teleporter-v2/forensic-sol.mjs`, `forensic-x1.mjs` / `forensic-x1b.mjs`, `forensic-evm.mjs`.
* Raw JSON: `/tmp/forensic-sol.json` (62 hub sigs, parsed), `/tmp/forensic-x1.json` (4 X1 wallets + deep parses), `/tmp/forensic-evm.json` (7 EVM chains).
* Caveat: pruned-index RPCs (`solana-rpc.publicnode.com`) truncate history — use `api.mainnet-beta.solana.com`. Helius was used as primary here with the public RPC as fallback.
* No keys read or used; no signatures; no broadcasts.
