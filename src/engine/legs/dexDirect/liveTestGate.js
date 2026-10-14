/**
 * liveTestGate.js — the DEX-DIRECT live-anchor boundary (shared by every
 * dexDirect execute leg).
 *
 * 🔴 FUNDS RULE — READ FIRST:
 *   The dexDirect execute path PRODUCES signable transactions for Mr.
 *   Esters' wallet — it NEVER broadcasts. Each leg now builds the real
 *   correctly-encoded swap (official-SDK construction; approval + swap txs
 *   for EVM — Rabby; ATA-setup + swap txs for Solana — Backpack) and the
 *   anchor harness (src/lib/dexAnchor/dexAnchorRunner.js) hands it to the
 *   wallet adapter for HIM to approve in the wallet UI. The broadcast, if
 *   any, is performed by THE WALLET as the consequence of his confirm —
 *   never by an agent code path.
 *
 *   submit() is the tripwire that makes the boundary structural: the leg
 *   contract's broadcast phase exists (runLeg drives build → … → submit),
 *   and on the dexDirect family it ALWAYS throws
 *   DexDirectLiveTestGateError — "the agent CANNOT broadcast — sign in
 *   your wallet." Nothing in the dexDirect family signs, broadcasts, or
 *   moves funds on its own. The honest error is the product — the same
 *   discipline as the Rango execute stub (rangoExecuteLeg.js).
 *
 * The quote legs (read-only: quoter eth_call / on-chain pool-state reads /
 * RPC simulation) are REAL; the swap-execution anchor stays gated until
 * Mr. Esters fires the first live swap per DEX — but the gate is now
 * "signable, never self-broadcast", not "throw-only stub".
 */
export class DexDirectLiveTestGateError extends Error {
  constructor(message) {
    super(message);
    this.name = "DexDirectLiveTestGateError";
  }
}

/** The canonical message every dexDirect guarded submit carries. */
export const DEX_DIRECT_LIVE_TEST_GATE_MESSAGE =
  "dex-direct-execute: the agent CANNOT broadcast — sign in your wallet. " +
  "This leg builds the signable swap (approval + swap txs for Rabby; " +
  "ATA-setup + swap txs for Backpack) and the anchor harness hands it to " +
  "the wallet adapter — Mr. Esters approves in the wallet UI and THE " +
  "WALLET broadcasts. READY FOR LIVE ANCHOR: no dexDirect leg ever " +
  "submits on its own.";
