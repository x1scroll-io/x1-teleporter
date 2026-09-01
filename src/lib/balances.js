/**
 * balances.js — per-chain token balance readers for the v2 bridge form's
 * balance line ("bridge should have values of what is in the users wallets").
 *
 * Three sides, all fail-soft (a dead RPC / disconnected wallet → null → the
 * UI shows "—" for that side; the bridge form is NEVER blocked or thrown):
 *
 *   EVM    — eth_call balanceOf(token, wallet) on the connected EIP-1193
 *            provider. Decimals come from TOKENS (USDC 6, USDT 6, DAI 18 —
 *            BSC's USDC/USDT are 18 — handled correctly per chain).
 *   Solana — getTokenAccountsByOwner for the USDC + WSOL mints (both live
 *            there; the Warp leg locks whichever the burn released).
 *   X1     — getTokenAccountsByOwner for the USDC.x + wSOL.X mints (Token-2022,
 *            same RPC shape as Solana — SVM-compatible).
 *
 * Every reader takes its transport as a parameter (provider / connection) so
 * tests inject fakes — no network, no DOM. The component (BalancesLine.jsx)
 * wires the real provider/connections.
 */

import { TOKENS } from "./teleportConstants.js";

/** balanceOf(address) selector — the only EVM read the balance line needs. */
const BALANCE_OF_SIG = "0x70a08231";

/**
 * Read a wallet's balance of an ERC-20 token via eth_call.
 *
 * @param {{provider: ?object, wallet: ?string, token: ?{address: string,
 *          decimals: number}}} args
 *   provider = the resolved EIP-1193 provider ({ request }), wallet = the
 *   connected EVM address, token = TOKENS[chain][symbol] (address + decimals).
 * @returns {Promise<?number>} human units (raw base units / 10^decimals), or
 *   null when the wallet/provider/token is missing or the RPC read fails —
 *   fail-soft, never throws.
 */
export async function fetchEvmTokenBalance({ provider, wallet, token }) {
  if (!provider?.request || !wallet || !token?.address) return null;
  try {
    const data = BALANCE_OF_SIG + wallet.slice(2).toLowerCase().padStart(64, "0");
    const hex = await provider.request({
      method: "eth_call",
      params: [{ to: token.address, data }, "latest"],
    });
    if (hex == null) return null;
    const raw = BigInt(hex || "0x0");
    const decimals = token.decimals ?? 6;
    return Number(raw) / 10 ** decimals;
  } catch {
    return null; // RPC error / revert — fail-soft
  }
}

/**
 * Read a wallet's balances of several SPL/Token-2022 mints on an SVM chain
 * (Solana or X1) via getTokenAccountsByOwner. Sums across every token account
 * for a mint (a wallet can hold the same mint in multiple ATAs).
 *
 * @param {{connection: ?object, wallet: ?string, mints: Array<{symbol: string,
 *          mint: string, decimals: number}>}} args
 *   connection = an object exposing getTokenAccountsByOwner (real web3.js
 *   Connection, or a fake in tests). mints = [{ symbol, mint, decimals }].
 * @returns {Promise<?Object<string, number>>} { symbol: humanUnits } for each
 *   mint, or null when the connection/wallet is missing or ANY RPC read fails
 *   — fail-soft, never throws.
 */
export async function fetchSvmTokenBalances({ connection, wallet, mints }) {
  if (!connection?.getTokenAccountsByOwner || !wallet || !mints?.length) return null;
  const out = {};
  try {
    for (const m of mints) {
      const { value } = await connection.getTokenAccountsByOwner(wallet, { mint: m.mint });
      let total = 0n;
      for (const acc of value || []) {
        const amt = acc?.account?.data?.parsed?.info?.tokenAmount?.amount;
        if (amt != null) total += BigInt(amt);
      }
      const decimals = m.decimals ?? 6;
      out[m.symbol] = Number(total) / 10 ** decimals;
    }
    return out;
  } catch {
    return null; // RPC failure — fail-soft
  }
}

/** The Solana-side mints the balance line shows (USDC + WSOL, per TOKENS). */
export const SOLANA_MINTS = [
  { symbol: "USDC", mint: TOKENS.sol.USDC.address, decimals: TOKENS.sol.USDC.decimals },
  { symbol: "WSOL", mint: TOKENS.sol.WSOL.address, decimals: TOKENS.sol.WSOL.decimals },
];

/** The X1-side mints the balance line shows (USDC.x + wSOL.X, per TOKENS). */
export const X1_MINTS = [
  { symbol: "USDC.x", mint: TOKENS.x1["USDC.x"].address, decimals: TOKENS.x1["USDC.x"].decimals },
  { symbol: "wSOL.X", mint: TOKENS.x1["wSOL.X"].address, decimals: TOKENS.x1["wSOL.X"].decimals },
];

/** Format a human-unit balance compactly: trim trailing zeros, cap decimals. */
export function formatBalance(n) {
  if (n == null) return null;
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  // 27.5900000 → "27.59"; 0.3000000 → "0.3"; 5 → "5"
  return parseFloat(num.toFixed(6)).toString();
}
