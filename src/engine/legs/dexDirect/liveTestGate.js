/**
 * liveTestGate.js — the DEX-DIRECT live-test boundary (shared by every
 * dexDirect execute leg).
 *
 * 🔴 LIVE-FUNDS BOUNDARY — READ FIRST:
 *   Every dexDirect execute leg is a GUARDED STUB. Its submit() THROWS
 *   DexDirectLiveTestGateError: the swap-execution anchor is "READY FOR
 *   LIVE ANCHOR" — it requires a REAL broadcast by Mr. Esters (a live swap
 *   needs live funds + a real source wallet; the autonomous agent NEVER
 *   fires it). Nothing in the dexDirect family ever signs, broadcasts, or
 *   moves funds. The honest error is the product — the same discipline as
 *   the Rango execute stub (rangoExecuteLeg.js).
 *
 * The quote legs (read-only: quoter eth_call / on-chain pool-state reads /
 * RPC simulation) are REAL; the execute half stays gated until Mr. Esters
 * fires the first live swap per DEX.
 */
export class DexDirectLiveTestGateError extends Error {
  constructor(message) {
    super(message);
    this.name = "DexDirectLiveTestGateError";
  }
}

/** The canonical message every dexDirect guarded submit carries. */
export const DEX_DIRECT_LIVE_TEST_GATE_MESSAGE =
  "dex-direct-execute: not wired for autonomous broadcast — the swap-execution anchor is " +
  "READY FOR LIVE ANCHOR and Mr. Esters fires live swaps (a real swap needs live funds and " +
  "a real source wallet). Nothing here signs or broadcasts.";
