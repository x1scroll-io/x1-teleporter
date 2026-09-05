# Robinhood Chain — research + integration scaffold (2026-09-05)

Autonomous overnight research session (Mr. Esters asleep). **NO live funds —
quotes/reads only.** Everything below is verified against primary sources
with the fetch date; nothing is guessed.

## 1. What Robinhood Chain is (verified)

- **Live on mainnet** (LiFi `/v1/chains` lists it `mainnet: true`; live RPC
  responds; the chain hosts memecoins AND tokenized equities — SPY, NVDA,
  SpaceX — via Robinhood's on-chain asset registry).
- **Tech: Arbitrum Orbit** — officially "Arbitrum Dedicated Blockchains".
  Robinhood's docs: *"Robinhood Chain is built on Arbitrum Dedicated
  Blockchains, a modular Layer-2 framework"* (docs.robinhood.com/chain).
  chainid.network confirms the L2 parent: `eip155-1` (Ethereum) with the
  Arbitrum portal bridge. FCFS sequencing, no priority-fee bumping; ERC-4337
  first-class.
- **Native gas: ETH** (18 decimals). Permissionless + EVM-compatible.

## 2. Chain coordinates (verified 2026-09-05)

| Field | Value | Source |
|---|---|---|
| Chain ID | **4663** (hex `0x1237`) | chainid.network + live `eth_chainId` on two RPCs |
| Official RPC | `https://rpc.mainnet.chain.robinhood.com` | LiFi metamask block + chainid.network; live |
| Public RPCs | `https://robinhood-rpc.publicnode.com`, `https://rpc.arrowrpc.com`, `https://rpc.ordofi.network` | chainid.network |
| Explorer | `https://robinhoodchain.blockscout.com` (Blockscout), `https://robinscan.io`, `https://hoodscan.co` | chainid.network |
| Docs | `https://docs.robinhood.com/chain` | — |
| LiFi chain key | **`out`** | li.quest `/v1/chains` |
| LiFi diamond | `0xB477751B76CF82d00a686A1232f5fCD772414Af3` | li.quest `/v1/chains` (the quote `approvalAddress`) |

## 3. Stablecoins — THE key finding: no Circle USDC

**There is no native/canonical USDC on Robinhood Chain** (as of 2026-09-05):

- Robinhood's own docs, Token Contracts page
  (`docs.robinhood.com/chain/contracts`), list exactly **two** canonical
  non-stock tokens: **WETH** `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` and
  **USDG** `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 decimals).
- LiFi's chain-4663 token list (297 tokens) contains **no plain USDC, no
  USDT, no DAI**. The only USDC-named token is `syrupUSDC`
  (`0xC6a4854eeB493224d5f9485E12Dd3A81f22EEE14`) — a **Maple Syrup yield
  wrapper, NOT canonical** — deliberately excluded from the scaffold.

**The chain's canonical stablecoin is Paxos USDG** (Global Dollar, 6
decimals, `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`). Robinhood is a
Paxos USDG distribution partner, so USDG-first is consistent with the
issuer set.

**Scaffold consequence:** `TOKENS.rh = { USDG }` only. No USDC entry was
invented. The X1 hop still lands **Solana USDC** (LiFi/Relay converts
USDG→USDC inside the route), so the Warp leg and X1 USDC.x minting are
unchanged.

## 4. LI.Fi support — VERDICT: SUPPORTED (with evidence)

- Chain **4663 is a live LiFi chain** (`/v1/chains`, key `out`, mainnet).
- Bridges available on 4663 (li.quest `/v1/tools?chains=4663`): Across V4,
  Symbiosis, Glacis, **Relay**, LI.FI Intents, **Paxos Labs Transit**, Smart
  Deposits, Layerswap. DEXes: OpenOcean, KyberSwap, etc.
- **Simulated (read-only) quotes — both directions work via Relay:**
  - Forward: **USDG (4663) → USDC (Solana)** — $100 in → ~99.641 USDC out;
    LiFi fixed fee 0.25% ($0.2498); execution ≈ 1 min.
  - Reverse: **USDC (Solana) → USDG (4663)** — $100 in → ~99.505 USDG out.
  - Both accept `fromChain=4663` AND `fromChain=out`.
  - Evidence fixtures: `test/fixtures/golden/robinhood-leg/` (SIMULATED
    label, no live tx, no funds).
- **Rail verdict:** the existing **LiFi/Warp rail serves Robinhood Chain**
  for the X1 hop (`buildLifiQuoteParams` is chain-generic over
  `CHAINS[from].lifiKey` + `TOKENS[from][token]`). No new rail needed, no
  rail-gap doc required. Relay handles the USDG→USDC conversion so the
  Solana landing token is unchanged.

## 5. X1 / Warp relevance

None direct — Robinhood Chain is an **EVM source/destination** for the
forward (and reverse) leg. X1 is only reachable via the Solana Warp bridge,
which is untouched: the LiFi leg lands Solana USDC exactly as it does for
Ethereum/Arbitrum/Base today.

## 6. Token resolver relevance (sibling task)

RH Chain USDC is a **non-event for the resolver**: there is no canonical
Circle USDC contract on Robinhood Chain to map. If the resolver grows a
USDG map later, the canonical contract is
`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (6 dec) — same address LiFi
lists. The resolver must NOT map `syrupUSDC` as USDC.

## 7. What was scaffolded (branch feat/robinhood-chain → PR into v2)

1. `src/lib/teleportConstants.js` — `CHAINS.rh` (lifiKey `out`, chainId
   4663, walletType `evm`, green `#00C805`, glyph `R`), `TOKENS.rh = { USDG }`
   (canonical address + 6 dec), `EVM_CHAINS` appends `rh` → console pickers
   (`SOURCE_CHAINS`, `tokensOn`) surface it automatically.
2. `src/Teleporter.jsx` — v1 safety-net mirror kept in sync (same CHAINS.rh +
   TOKENS.rh entries; v1's ChainSelect enumerates CHAINS dynamically).
3. `src/lib/prices.js` — `COINGECKO_IDS.USDG = "global-dollar"` (CG id
   verified live at $1.00) so the balance line shows USDG in USD.
4. `test/fixtures/golden/robinhood-leg/` — SIMULATED quote evidence (README +
   2 li.quest captures + re-run commands), additive-only, frozen files
   untouched.
5. `src/lib/teleportConstants.test.js` — 6 tests: chain entry validity,
   the no-fake-USDC honesty test, rail routing, quote-builder params,
   fixture structure. Registered in package.json test list.
6. `src/lib/prices.test.js` — updated mocks/assertions for the new
   COINGECKO_IDS key (additive; no frozen file touched).

## 8. Ready for live test (Mr. Esters)

- Console forward journey: source **Robinhood Chain → USDG → X1 (USDC.x)** —
  verify the quote renders (Relay route), then a small ($25–50) live bridge.
- Console reverse: **X1 (USDC.x) → Robinhood Chain → USDG**.
- Wallet network switch to 4663 (`0x1237`): Rabby/MetaMask need the network
  added; the app's `wallet_switchEthereumChain` returns 4902 → user adds it
  manually (same UX as every other EVM chain today — no in-app add flow).
- Confirm Relay's USDG route stays live (it is the only forward carrier
  found; Across/Paxos Transit exist on-chain but LiFi picked Relay).
