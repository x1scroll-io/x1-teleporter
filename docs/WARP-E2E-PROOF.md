# Warp route — end-to-end proof (2026-09-13)

**Route:** Solana USDC → X1 USDC.x (the leg LiFi cannot do). Test funds only.

## Preconditions established
- Program `6JbPTuxVuoTgyQeXFb9MH8C8nUY8NBbLP1Lu4B13JfMD` verified deployed on Solana AND X1.
- `evt_out(seq)` PDA derivation matched a real on-chain account; X1 `evt_in(seq)` exists for the
  historical ground-truth seq.
- Blocker found and fixed first: the user's X1 account held **0 XNT**, so it could not pay rent for the
  recipient's USDC.x ATA → simulation failed `AccountNotFound` at stage `x1_ata_simulation`.
  Funded 0.02 XNT to the X1 account (tx `mRMZDZeRUURge3ccRDmCeyncSbvzFv4Nth8g7tNDTfvQgaVeeiidHnv8SijRMkCE5ULVDWkE3eppM5ZNw4hV9hM`).

## Simulation gate (allowLive:false) — PASSED
```
STAGE   : simulated_ok
SUCCESS : true
sim.err : null
units   : 30736
logs    : Program 6JbPTux… invoke [1] / Program log: Instruction: BridgeOut
```
This is the acceptance criterion the module's own README defines for going live, and it validates the
`seq` source, the PDA derivations, the account list, the discriminator and the args — closing the last
residual unknown from `STAGE2_README.md`.

## Live execution — SUCCESS
```
SIGNATURE : 3rzhrmpXkSFzDd3PmyMTU4AUwmFfhBpBinEq6xzWG95JndoH3trs21cVDAdwB9ekaoVQsv6kdnefmHtw3bT2cow5
slot      : 446841671 · meta.err: null · fee 5000
Warp program invoked: true
logs      : "Instruction: BridgeOut" / "Bridge out initiated"
SOL       : 0.405071864 -> 0.403878144
```
## Verification (both chains, independent reads)
- **Solana:** hub USDC ATA `4R7WRzPtdw…` = **10.466863 USDC** (35.466863 − 25.0 exactly).
- **X1:** Token-2022 USDC.x mint `B69chRzq…` = **23.875** received at the same address.
- Fee wallet accumulated the flat fee + skim.

## Verdict
**The Warp route completes end-to-end on mainnet with test funds, verified on both chains.**
Residual: the console-UI variant of this route still requires a wallet-extension connection; the
engine-level route is proven here. See the worklog for that boundary.

## Reverse leg (X1 -> Solana) — reclaimed 2026-09-14
Sim gate: `simulated_ok` (Instruction: BridgeOut + Token-2022 TransferChecked skim + Burn).
Live: X1 burn tx `4ixSaFvb6AWvMVWHVHGREdM4fNaTtS1X…` (02:35, ok).
- X1 USDC.x: 23.875 -> 0
- Solana USDC: 10.466863 -> 33.341863 (+22.875 = 23.875 - 1.0 flat fee)
- X1 XNT: 0.01592592 -> 0.01229728 (burn fee)

ROUND-TRIP COST MEASURED: 25 USDC in -> 22.875 back = **2.125 USDC total** (1.0 flat each way +
0.125 skim). One-way ~4.3% at 25 USDC; see fee model before pricing small tickets.
