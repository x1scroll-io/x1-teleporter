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
 *   Solana — getParsedTokenAccountsByOwner for the USDC + WSOL mints (both
 *            live there; the Warp leg locks whichever the burn released).
 *   X1     — getParsedTokenAccountsByOwner for the USDC.x + wSOL.X mints
 *            (Token-2022, same RPC shape as Solana — SVM-compatible).
 *
 * Every reader takes its transport as a parameter (provider / connection) so
 * tests inject fakes — no network, no DOM. The component (BalancesLine.jsx)
 * wires the real provider/connections.
 */

import { TOKENS } from "./teleportConstants.js";
import { PublicKey } from "@solana/web3.js";

/** balanceOf(address) selector — the only EVM read the balance line needs. */
const BALANCE_OF_SIG = "0x70a08231";

/**
 * Normalize a wallet/mint value to a PublicKey. Real web3.js Connections
 * require PublicKey INSTANCES for getParsedTokenAccountsByOwner (the raw
 * method calls `.toBase58()` on both args — a plain string throws
 * `ownerAddress.toBase58 is not a function` before any RPC round-trip,
 * which is exactly how the live Balances line showed `Solana: —` / `X1: —`
 * even with a healthy network). Accepts either form; fakes in tests accept
 * the resulting PublicKey fine (String(pk) === the base58 address).
 */
function toPublicKey(v) {
  if (v instanceof PublicKey) return v;
  return new PublicKey(v);
}

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
 * (Solana or X1) via getParsedTokenAccountsByOwner. Sums across every token
 * account for a mint (a wallet can hold the same mint in multiple ATAs).
 *
 * WHY getParsedTokenAccountsByOwner (NOT getTokenAccountsByOwner): the
 * un-parsed variant hardcodes `encoding: "base64"` server-side — the
 * response's `data` is a base64 blob with NO `.parsed` member, so reading
 * `data.parsed.info.tokenAmount.amount` would silently sum zero. The parsed
 * variant requests `jsonParsed` and returns exactly the shape this reader
 * consumes (same SVM RPC shape on X1 for the Token-2022 mints).
 *
 * @param {{connection: ?object, wallet: ?string|PublicKey, mints: Array<{symbol: string,
 *          mint: string, decimals: number}>}} args
 *   connection = an object exposing getParsedTokenAccountsByOwner (real
 *   web3.js Connection, or a fake in tests). mints = [{ symbol, mint,
 *   decimals }].
 * @returns {Promise<?Object<string, number>>} { symbol: humanUnits } for each
 *   mint, or null when the connection/wallet is missing or ANY RPC read fails
 *   — fail-soft, never throws.
 */
export async function fetchSvmTokenBalances({ connection, wallet, mints }) {
  if (!connection?.getParsedTokenAccountsByOwner || !wallet || !mints?.length) return null;
  const out = {};
  try {
    const owner = toPublicKey(wallet);
    for (const m of mints) {
      const { value } = await connection.getParsedTokenAccountsByOwner(owner, { mint: toPublicKey(m.mint) });
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
