# DEX-LIVE-ANCHOR-GUIDE — signable swaps, signed in YOUR wallet

> The dexDirect family (Uniswap v3 / PancakeSwap v3 / Raydium CPMM+CLMM /
> Orca Whirlpool) is now **SIGNABLE but can never self-broadcast**. The
> legs build the real, correctly-encoded transactions with the official
> SDKs; YOU sign them in your wallet (Rabby for EVM, Backpack for Solana);
> the wallet's own connection broadcasts on YOUR confirm. This guide is
> the exact click/sign sequence for the live-anchor session.

## 🔴 The boundary (non-negotiable, structural)

- `leg.phases.submit()` on every dexDirect leg throws
  `DexDirectLiveTestGateError` — *"the agent CANNOT broadcast — sign in
  your wallet"*. There is no broadcast path in the legs: no
  `sendRawTransaction`, no `eth_sendTransaction`, no
  `signAndSendTransaction`, no agent-side `Connection` for sending — the
  no-broadcast static scan is part of the test suite.
- The ONLY handoff layer is `src/lib/dexAnchor/dexAnchorRunner.js`
  (`runDexAnchor`): it resolves your connected wallet through the engine's
  SignerResolver and walks the sign list. EVM sends go through the
  EIP-1193 provider (Rabby pops) — sim-gated by the repo's standard
  `guardedSendEvmTx` (a reverting tx is NEVER sent). Solana sends go
  through `adapter.signAndSendTransaction` ONLY (Backpack pops) — there is
  deliberately no `signTransaction` + app-side raw-send fallback.
- Agent builds → you approve → the wallet broadcasts. Always.

## The flow (every leg)

```
connect wallet → leg.phases.build(ctx) → quote-pinned artifact
→ plan (read-only checks: allowance eth_call / ATA getAccountInfo)
→ [approval or ATA-setup tx first, when needed] → swap tx
→ each tx: WALLET POPUP → review → confirm → wallet broadcasts → hash/sig
```

The per-leg planners return the task-shaped plan:

- EVM (Uniswap/PancakeSwap): `planEvmDexExecute` →
  `{ needsApproval, approvalTx?, swapTx }`
- SVM (Raydium/Orca): `planRaydiumExecute` / `planOrcaExecute` →
  `{ needsSetup, setupTx?, swapTx }`

## 1. Uniswap v3 — EVM (Ethereum/Arbitrum/Optimism/Polygon) — Rabby

**SDK/encoding:** viem (the official EVM SDK) encodes
`SwapRouter.exactInputSingle` against the canonical v3 periphery ABI;
byte-pinned to the frozen dex-direct calldata by a drift canary.
**Router:** `0xE592427A0AEce92De3Edee1F18E0157C05861564`
**Approval flow:** DIRECT approve (the skill's LEGACY DIRECT-APPROVE
pattern — endorsed for this direct-periphery path): the one approval tx =
`USDC.approve(SwapRouter, EXACT amount)`. Never Permit2/Universal Router
here (documented in `uniswapSwapLeg.js`).

**Click/sign sequence (Rabby):**
1. Connect Rabby to the app (Ethereum Mainnet for the eth leg; the runner
   calls `wallet_switchEthereumChain` if your wallet is on another net —
   approve the switch popup).
2. Run the anchor (console → dex anchor → uniswap, 10 USDC → USDT).
   Status: *"allowance short — approval tx first"* (or *"allowance
   sufficient — swap only"*).
3. **If approval:** Rabby pops "Sign transaction" — a contract
   interaction with the **USDC** token contract:
   - Verify: to = USDC (`0xA0b8…`), method = approve, spender =
     `0xE592427A…` (the SwapRouter), amount = your exact swap amount
     (never infinite).
   - Click **Sign/Confirm**. Rabby broadcasts; the runner waits for the
     receipt.
4. **Swap:** Rabby pops again — contract interaction with the
   **SwapRouter**:
   - Verify: to = `0xE592427A…`, method = exactInputSingle, USDC→USDT,
     min-out = quote minus slippage (positive), deadline fresh (≈now+30m).
   - Click **Sign/Confirm**. Rabby broadcasts. The hash is the anchor
     receipt. Done.

## 2. PancakeSwap v3 — BNB Chain — Rabby

**SDK/encoding:** same viem encoding against PancakeSwap's own v3
SwapRouter (its deployment files pin it; live-verified quoter).
**Router:** `0x1b81D678ffb9C0263b24A97847620C99d213eB14`
**Approval flow:** DIRECT approve to the PCS router (fixture-pinned
direct-v3 path — documented in `pancakeswapSwapLeg.js`).
**Chain:** BNB Smart Chain (chainId 56).

**Click/sign sequence (Rabby):**
1. Connect Rabby, ensure **BNB Smart Chain** (approve the switch popup if
   prompted).
2. Run the anchor (pancakeswap, 10 USDC → USDT on bsc).
3. **If approval:** Rabby pops — approve on the **USDC (BSC)** token
   (`0x8AC76a51…`) with spender = `0x1b81D678…` and the exact amount.
   Confirm.
4. **Swap:** Rabby pops — exactInputSingle on the PCS SwapRouter,
   USDC→USDT, positive min-out, fresh deadline. Confirm. Done.

## 3. Raydium — Solana (CPMM or CLMM) — Backpack

**SDK:** the swap instruction is built by the OFFICIAL
`@raydium-io/raydium-sdk-v2` — `makeSwapCpmmBaseInInstruction` (CPMM) /
`ClmmInstrument.swapV2Instruction` (CLMM) — byte-identical to the frozen
dex-direct layouts (live read-only sims during capture) via fail-closed
drift canaries.
**Approval flow:** none — Solana tokens move via your associated token
accounts (ATAs). The plan checks both ATAs (read-only getAccountInfo) and
builds an **ATA-create setup tx** when either is missing (official
@solana/spl-token `createAssociatedTokenAccountInstruction`).
**Swap tx:** compute-budget (setComputeUnitLimit 200k, + optional priority
fee) + the SDK swap ix, serialized with a fresh blockhash for Backpack.

**Click/sign sequence (Backpack):**
1. Connect Backpack to the app (Solana mainnet).
2. Run the anchor (raydium, e.g. 0.1 SOL → USDC; dex cpmm or clmm).
   Status: *"ATA(s) missing — setup tx first"* or *"token accounts
   present — swap only"*.
3. **If setup:** Backpack pops "Approve transaction" — a
   **createAssociatedTokenAccount** (program `ATokenGPvbd…`). Verify the
   mint + owner are yours. **Approve/Sign.** Backpack broadcasts.
4. **Swap:** Backpack pops again — the swap (program
   `CPMMoo8L3F4…` or `CAMMCzo5YL…`), the pool, your input ATA debit and
   output ATA credit, min-out pinned. **Approve/Sign.** Backpack
   broadcasts. The signature is the anchor receipt. Done.

## 4. Orca Whirlpool — Solana — Backpack

**SDK:** the swap_v2 instruction is built by the OFFICIAL
`@orca-so/whirlpools-sdk` `WhirlpoolIx.swapV2Ix` (anchor-built against the
SDK's bundled Whirlpool IDL) — byte-identical to the frozen layout that
was verified against a REAL live mainnet swap tx (`44VxpkKE…` on the
SOL/USDC whirlpool, err ok).
**Approval flow:** none — ATA setup only when missing (same shape as
Raydium).

**Click/sign sequence (Backpack):**
1. Connect Backpack (Solana mainnet).
2. Run the anchor (orca, e.g. 0.1 SOL → USDC).
3. **If setup:** Backpack pops — createAssociatedTokenAccount
   (SOL or USDC ATA). Verify + **Approve/Sign**.
4. **Swap:** Backpack pops — swap_v2 on the Whirlpool program
   (`whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`), pool
   `Czfq3xZZ…` for SOL/USDC, your ATAs, min-out pinned. **Approve/Sign.**
   Done.

## Live-anchor checklist (before the first real swap per DEX)

- [ ] Wallet connected and on the right network/chain (the runner
      auto-switches EVM chains — approve the popup).
- [ ] The pair's pool state snapshot is FRESH (vault balances/tick arrays
      move — refresh before any live use; the leg's decode functions read
      the live accounts).
- [ ] A live quote landed (min-out positive) — the wire validator refuses
      a pre-quote tx; a live anchor never signs a zero-min-out swap.
- [ ] Amounts are what you intend (the wallet popup shows the exact
      contract interaction — read it before signing).
- [ ] You understand the boundary: the agent built the tx; the wallet
      broadcast is YOUR action.

## Where the pieces live

| Piece | File |
|---|---|
| No-broadcast gate (submit tripwire) | `src/engine/legs/dexDirect/liveTestGate.js` |
| EVM signable plans (allowance/approval/swap, viem) | `src/engine/legs/dexDirect/evmSignable.js` |
| Official-SDK Solana ix builders + canaries | `src/engine/legs/dexDirect/solanaSdk.js` |
| Solana signable plans (ATA setup + swap, compute budget) | `src/engine/legs/dexDirect/solanaSignable.js` |
| Per-leg planner exports | the four `*SwapLeg.js` modules |
| Wallet handoff (the ONLY send surface) | `src/lib/dexAnchor/dexAnchorRunner.js` |
| No-broadcast + parity + flow tests | `test/engineDexExecute.test.js` |
| Frozen quote artifacts (unchanged) | `test/fixtures/golden/dex-direct-leg/` |
