#!/usr/bin/env node
// simulate.js — SAFE dry-run of the X1 Teleporter stage-2 Warp bridge.
//
// This SIMULATES the Solana→X1 BridgeOut (with your 1% skim to TiPy).
// It SENDS NOTHING. No funds move. It just asks Solana "would this work?"
// and prints the answer in plain English.
//
// ── HOW TO RUN ──
//   This file lives at the PROJECT ROOT (next to package.json). warpBridge.js
//   is in src/. From the project root:
//   1. npm install            (gets @solana/web3.js + @solana/spl-token)
//   2. node simulate.js <A_SOLANA_ADDRESS_HOLDING_25+_USDC>
//
//   Example:
//   node simulate.js wJs2CD1pDFQCSDi4vd6bFuuZSM1YAdoE3HwHdTex8MV
//
// You can pass ANY address that holds >=25 USDC on Solana — it's only a
// simulation, so it doesn't need to be yours and nothing is signed or sent.

import { Connection, PublicKey } from "@solana/web3.js";
import { buildStage2, simulateStage2, fromBaseUnits } from "./src/warpBridge.js";

const FEE_WALLET_SVM = "TiPy76viRMRTcKsZMfNp9enh2cCfaUXg3LPdjtpmBDu"; // your tip wallet
const SOLANA_RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const AMOUNT = 25; // test amount in USDC

const line = "─".repeat(60);

async function main() {
  const userAddr = process.argv[2];
  if (!userAddr) {
    console.log("\n❌ Usage: node simulate.js <SOLANA_ADDRESS_HOLDING_25+_USDC>\n");
    console.log("   (any address with >=25 USDC works — nothing is sent)\n");
    process.exit(1);
  }

  console.log("\n" + line);
  console.log("  X1 TELEPORTER — Stage 2 Warp Bridge SIMULATION (dry run)");
  console.log(line);
  console.log(`  RPC:         ${SOLANA_RPC}`);
  console.log(`  Test wallet: ${userAddr}`);
  console.log(`  Amount:      ${AMOUNT} USDC`);
  console.log(`  Fee wallet:  ${FEE_WALLET_SVM} (TiPy)`);
  console.log(line + "\n");

  let userPubkey;
  try {
    userPubkey = new PublicKey(userAddr);
  } catch {
    console.log("❌ That's not a valid Solana address. Check it and retry.\n");
    process.exit(1);
  }

  const connection = new Connection(SOLANA_RPC, "confirmed");

  console.log("→ Building the transaction (skim 1% + BridgeOut)...");
  let built;
  try {
    built = await buildStage2({
      connection,
      userPubkey,
      feeWalletSvm: new PublicKey(FEE_WALLET_SVM),
      amountHuman: AMOUNT,
    });
    console.log(`  ✓ built. Skim = ${fromBaseUnits(built.skimBase)} USDC → TiPy`);
    console.log(`          Bridge = ${fromBaseUnits(built.bridgeBase)} USDC → Warp`);
    console.log(`          Seq used = ${built.seq}`);
  } catch (e) {
    console.log("\n❌ BUILD FAILED:", e.message);
    console.log("   (usually the amount/min guard or a bad address)\n");
    process.exit(1);
  }

  console.log("\n→ Simulating against mainnet (NOTHING is sent)...");
  let sim;
  try {
    sim = await simulateStage2(connection, built.transaction);
  } catch (e) {
    console.log("\n❌ SIMULATION CALL FAILED:", e.message);
    console.log("   (RPC issue? Try a different SOLANA_RPC env var.)\n");
    process.exit(1);
  }

  console.log("\n" + line);
  if (sim.ok) {
    console.log("  ✅ SIMULATION PASSED");
    console.log(line);
    console.log(`  Compute units: ${sim.unitsConsumed}`);
    console.log("\n  Program logs:");
    (sim.logs || []).forEach((l) => console.log("    " + l));
    const hasBridgeOut = (sim.logs || []).some((l) => /BridgeOut|Bridge out initiated/i.test(l));
    console.log("\n" + line);
    if (hasBridgeOut) {
      console.log("  🚀 CLEARED FOR LAUNCH.");
      console.log("     The logs show BridgeOut executing. Accounts, discriminator,");
      console.log("     seq, and the skim all check out against live mainnet.");
      console.log("\n     NEXT: in Teleporter.jsx flip  WARP_LIVE = true");
      console.log("           then (after one more confirm)  WARP_LIVE_SEND = true");
    } else {
      console.log("  ⚠️  Simulation passed but I didn't see the BridgeOut log line.");
      console.log("     Eyeball the logs above — confirm it actually hit the Warp");
      console.log("     program before flipping the live flags.");
    }
    console.log(line + "\n");
  } else {
    console.log("  ❌ SIMULATION FAILED — do NOT go live yet");
    console.log(line);
    console.log("  Error:", JSON.stringify(sim.err));
    console.log("\n  Program logs (the error reason is usually here):");
    (sim.logs || []).forEach((l) => console.log("    " + l));
    console.log("\n" + line);
    console.log("  WHAT THIS MEANS:");
    console.log("  The instruction bytes are verified correct, so a failure here is");
    console.log("  almost always one of:");
    console.log("    • a PDA in WARP_ACCOUNTS (config/tokenRegistry/eventOut/");
    console.log("      vaultAuthority/feeConfig) needs the real derived address");
    console.log("    • the `seq` offset in fetchSeq() is wrong");
    console.log("    • the test wallet doesn't actually hold 25+ USDC / no USDC ATA");
    console.log("  The log lines above name the failing account — send them to");
    console.log("  Claude and the fix is usually one line.");
    console.log(line + "\n");
  }
}

main().catch((e) => {
  console.error("\n❌ Unexpected error:", e);
  process.exit(1);
});
