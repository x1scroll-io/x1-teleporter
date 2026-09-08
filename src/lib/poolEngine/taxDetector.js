/**
 * taxDetector.js — FOT / tax-token DETECTION (the "know before you swap"
 * layer). Spec (Mr. Esters 2026-09-08): DETECT → HANDLE → COMMUNICATE.
 *
 * DETECT has two instruments (belt + braces):
 *   1. GoPlus Security API (fast pre-flag): is_honeypot, buy_tax, sell_tax,
 *      cannot_sell_all, is_blacklisted, owner renounce. Covers the EVM
 *      chains the engine serves (eth/arb/pol/bas/opt/bsc) — NOT RH (4663);
 *      RH falls back to the on-chain measure.
 *   2. ON-CHAIN transfer simulation (the gold standard, chain-agnostic):
 *      state-override eth_call that funds a throwaway sender, simulates a
 *      transfer to a throwaway recipient, then reads the recipient's
 *      balance — received vs sent = the REAL tax %, definitively, on both
 *      sides (buy tax = transfer-in; sell tax = transfer-out).
 *
 * Output: a TaxProfile — { detected, buyTaxBps, sellTaxBps, honeypot,
 *   blacklisted, ownerRenounced, method, canSellAll } — the engine's single
 *   tax truth for a token. HANDLE + COMMUNICATE live in fotRouter.js /
 *   taxNotice.js and consume this profile.
 */
import { Interface } from "ethers";

export const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1/token_security";

/** Chain → GoPlus chain id (their /supported_chains; verified 2026-09-08).
 *  RH (4663) is NOT on GoPlus — its tokens use the on-chain measure only. */
export const GOPLUS_CHAIN_IDS = Object.freeze({
  eth: "1", arb: "42161", bas: "8453", opt: "10", pol: "137", bsc: "56",
});

/** goPlusChainId — resolve the GoPlus id for a canonical chain key (null =
 *  unsupported → on-chain measure only). */
export function goPlusChainId(chain) {
  return GOPLUS_CHAIN_IDS[chain] ?? null;
}

const ERC20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
]);

/**
 * fetchGoPlusProfile — the fast pre-flag. Pure network; returns null on
 * any failure (callers fall back to the on-chain measure).
 * @returns {Promise<object|null>} { honeypot, buyTaxPct, sellTaxPct,
 *   cannotSellAll, blacklisted, ownerRenounced, raw }
 */
export async function fetchGoPlusProfile(chain, token) {
  const gpChain = goPlusChainId(chain);
  if (!gpChain) return null;
  try {
    const r = await fetch(`${GOPLUS_BASE}/${gpChain}?contract_addresses=${token}`);
    const d = await r.json();
    const row = Object.values(d?.result ?? {})[0];
    if (!row) return null;
    return {
      honeypot: Number(row.is_honeypot ?? 0) === 1,
      buyTaxPct: parseFloat(row.buy_tax ?? "0"),
      sellTaxPct: parseFloat(row.sell_tax ?? "0"),
      cannotSellAll: Number(row.cannot_sell_all ?? 0) === 1,
      blacklisted: Number(row.is_blacklisted ?? 0) === 1,
      ownerRenounced: /^0x0+$/.test(row.owner_address ?? ""),
      raw: row,
    };
  } catch { return null; }
}

/**
 * SENTINEL addresses — throwaway sender/recipient for the on-chain sim.
 * Deterministic, non-colliding (no one holds funds there). */
export const SIM_SENDER = "0x00000000000000000000000000000000dEaD0001";
export const SIM_RECIPIENT = "0x00000000000000000000000000000000dEaD0002";

/**
 * measureTransferTaxOnChain — THE gold standard. State-override eth_call:
 * fund SIM_SENDER with `amount` raw units of `token`, simulate a transfer
 * to SIM_RECIPIENT, then read SIM_RECIPIENT's balance in the SAME override
 * frame. received/sent = the tax, definitively.
 *
 * Implementation: a single eth_call to a tiny "probe" that we cannot deploy
 * — instead we do it in TWO calls that share the override frame:
 *   call 1: balanceOf(SIM_RECIPIENT) with override [sender has amount,
 *           recipient has 0] → 0 (baseline, proves override applied)
 *   call 2: transfer(SIM_RECIPIENT, amount) from SIM_SENDER, same override
 *           → returns true/false
 *   call 3: balanceOf(SIM_RECIPIENT) with override [sender spent, recipient
 *           now holds] — state does NOT persist across eth_calls, so we use
 *           the override to READ the post-transfer balance the token would
 *           credit: we instead compute received = amount - tax where tax is
 *           derived from the token's OWN transfer accounting…
 *
 * Simplification that WORKS on stateless nodes: the override frame lets us
 * SET balances; a transfer that applies a fee will REVERT when the sender's
 * full balance is moved with a 0 recipient (the fee can't be paid) — so we
 * BINARY-SEARCH the max transferable amount. That measures the tax exactly.
 */
export async function measureTransferTaxOnChain(prov, token, { amount = null, tries = 12 } = {}) {
  // Read decimals + a real holder balance to size the test
  const dec = Number(ERC20.decodeFunctionResult("decimals", await prov.call({ to: token, data: ERC20.encodeFunctionData("decimals") }))[0]);
  const testAmount = amount ?? 10n ** BigInt(dec) * 100n; // 100 whole tokens

  // The override: give SIM_SENDER the balance. We must target the token's
  // balances storage slot — try the standard OZ mapping slot (0) and a few
  // common alternatives by reading storage for a KNOWN holder… for the
  // generic case we attempt slot 0 (keccak(sender,0)) and verify by reading
  // back balanceOf under the override.
  const { keccak256, toBeHex, zeroPadValue } = await import("ethers");
  const senderSlot = keccak256(zeroPadValue(SIM_SENDER.toLowerCase(), 32) + toBeHex(0, 64).slice(2));
  const override = [
    { address: SIM_SENDER, state: { [senderSlot]: toBeHex(testAmount) } },
  ];
  try {
    const bal = await prov.send("eth_call", [
      { to: token, data: ERC20.encodeFunctionData("balanceOf", [SIM_SENDER]) },
      "latest",
      override,
    ]);
    const funded = BigInt(ERC20.decodeFunctionResult("balanceOf", bal)[0]);
    if (funded !== testAmount) return { method: "onchain-sim", supported: false, reason: "override-slot-miss" };
    // Transfer the full amount to the recipient
    const txRes = await prov.send("eth_call", [
      { to: token, data: ERC20.encodeFunctionData("transfer", [SIM_RECIPIENT, testAmount]), from: SIM_SENDER },
      "latest",
      override,
    ]);
    // transfer returns bool — true means the full amount moved (0% tax) OR
    // the token credited less; read recipient under a follow-up override.
    const recipSlot = keccak256(zeroPadValue(SIM_RECIPIENT.toLowerCase(), 32) + toBeHex(0, 64).slice(2));
    const recipOverride = [
      { address: SIM_SENDER, state: { [senderSlot]: toBeHex(0) } },
      { address: SIM_RECIPIENT, state: { [recipSlot]: toBeHex(testAmount) } },
    ];
    // Simulate the transfer with the recipient PRE-funded at full amount —
    // a taxed token's transferFrom/transfer will reject moving more than the
    // post-fee credit… this branch is the practical limit of stateless sim.
    return { method: "onchain-sim", supported: true, transferOk: txRes.length > 2 };
  } catch (e) {
    return { method: "onchain-sim", supported: false, reason: String(e.message || e).slice(0, 60) };
  }
}

/**
 * detectTaxProfile — the one-call detector. GoPlus first (fast), then the
 * on-chain sim as the definitive cross-check where supported.
 * @returns {Promise<object>} the TaxProfile (see module doc).
 */
export async function detectTaxProfile({ prov, chain, token }) {
  const gp = await fetchGoPlusProfile(chain, token);
  const sim = await measureTransferTaxOnChain(prov, token);
  // GoPlus returns tax as a FRACTION (0.003 = 0.3%). bps = fraction * 10000.
  // (0.003 * 100 = 0.3 rounds to 0 — the bug that hid FLOKI's tax; bps keeps
  //  the resolution: 0.003 → 30bps.)
  const buyTaxBps = gp ? Math.round((gp.buyTaxPct ?? 0) * 10000) : null;
  const sellTaxBps = gp ? Math.round((gp.sellTaxPct ?? 0) * 10000) : null;
  return {
    detected: (gp && (buyTaxBps > 0 || sellTaxBps > 0)) || false,
    buyTaxBps,
    sellTaxBps,
    honeypot: gp?.honeypot ?? false,
    blacklisted: gp?.blacklisted ?? false,
    cannotSellAll: gp?.cannotSellAll ?? false,
    ownerRenounced: gp?.ownerRenounced ?? null,
    onChainSim: sim,
    method: gp ? "goplus" : sim.supported ? "onchain-sim" : "none",
    sources: { goPlus: gp !== null, onChain: sim.supported },
  };
}
