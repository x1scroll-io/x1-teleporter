# Stage 2 — Warp Bridge execution (Solana USDC → X1 USDC.x)

This is the leg LiFi can't do. Built from the spec decoded off a live mainnet
`BridgeOut` tx. The instruction encoding is **verified byte-perfect** against
that real tx. The remaining unknowns are PDA derivations and the `seq` source —
which is exactly what `simulateTransaction` will confirm for you, safely, with
no funds at risk.

## Files
- `src/warpBridge.js` — the module: `buildStage2`, `simulateStage2`,
  `sendStage2ViaPhantom`, and the guarded `runStage2`.

## The golden rule
**Never send before simulate passes.** `runStage2({ allowLive: false })` builds
and simulates only — it touches nothing. Flip `allowLive: true` ONLY after a
clean simulation whose logs show `Instruction: BridgeOut` and
`Bridge out initiated`, and whose balance changes show your 1% skim + the lock.

## Validate against mainnet (safe — simulation only)

```js
import { Connection, PublicKey } from "@solana/web3.js";
import { runStage2 } from "./src/warpBridge.js";

const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

const res = await runStage2({
  connection,
  userPubkey: new PublicKey("<a wallet that holds >=25 USDC on Solana>"),
  feeWalletSvm: new PublicKey("<YOUR svm fee wallet>"),
  amountHuman: 25,
  allowLive: false,        // DRY RUN — simulates, sends nothing
});

console.log(res.stage, res.success);
console.log(res.sim.logs);   // look for "BridgeOut" + "Bridge out initiated"
console.log("units:", res.sim.unitsConsumed);
```

## What the simulation tells you
- **err: null** + the BridgeOut logs → the account list, flags, discriminator,
  and args are all correct. You're cleared to go live.
- **err about an account / seed / privilege** → a PDA in `WARP_ACCOUNTS` or the
  `seq` offset needs fixing. The error names the failing account; cross-check it
  against `WARP_BRIDGE_SPEC.md` and the on-chain program.

## The 3 things to confirm (all surfaced by simulation)
1. **PDAs** — `config`, `tokenRegistry`, `eventOut`, `vaultAuthority`, `feeConfig`.
   The module uses the literal addresses from the decoded tx. Those are correct
   for THIS program state; if the program derives them per-user or per-mint,
   replace with `PublicKey.findProgramAddressSync([...seeds], WARP_PROGRAM_ID)`.
2. **seq** — `fetchSeq()` reads event_out's first u64 as a placeholder. Simulation
   will reveal if the program wants the live value at a different offset, or
   auto-increments (in which case the arg may be ignored / different).
3. **Fee ATA existence** — if your fee wallet's USDC ATA doesn't exist yet, add a
   `createAssociatedTokenAccountInstruction` before the skim transfer (one-time).

## Going live (after a clean sim)
Set `allowLive: true`. The user's Phantom signs once; the tx does the 1% skim
then BridgeOut; USDC.x lands on X1 at the user's same address.

## Why this is safe to build now
The risky part of bridge code is getting the instruction wrong and burning funds.
Here the instruction bytes are proven against a real successful tx, and the guard
refuses to send unless simulation passes. You cannot accidentally fire a bad tx
through `runStage2` with `allowLive:false`.
