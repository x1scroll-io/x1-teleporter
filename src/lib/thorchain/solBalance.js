/**
 * solBalance.js — native SOL balance reader for the THORChain hop's landing
 * detection (Step 3.1). The THORChain outbound delivers SOL.SOL to the
 * connected Solana wallet; the landing watcher polls this reader and looks
 * for a balance delta ≥ expectedAmountOut − tolerance.
 *
 * The reader is created once (per wallet address) and reused — the
 * @solana/web3.js Connection is lazily created on first use and shared.
 * `connection` may be injected (the app's existing Connection); otherwise a
 * PROXIED Connection is built (fix/proxy-solana-x1-rpc): the HTTP transport
 * POSTs to the app's own /api/rpc/solana serverless function instead of the
 * raw RPC, so the read works even when the browser's network blocks the
 * Solana RPC directly (the live `Solana: —` / blocked stage-2 symptom).
 *
 * PURE OF WINDOW: no injected globals, no DOM — runs under node --test with
 * a mocked Connection.
 */

const DEFAULT_SOLANA_RPC =
  (typeof import.meta !== "undefined" &&
    import.meta.env &&
    import.meta.env.VITE_SOLANA_RPC) ||
  "https://berty-633y20-fast-mainnet.helius-rpc.com";

/**
 * Create a native SOL balance reader.
 *
 * @param {object} [deps]
 * @param {string} [deps.rpcUrl] Solana RPC URL (default: VITE_SOLANA_RPC or the
 *   standard fallback ladder)
 * @param {object} [deps.connection] an existing @solana/web3.js Connection
 *   (when provided, rpcUrl is ignored)
 * @param {object} [deps.web3] injected @solana/web3.js module (test seam;
 *   default: dynamic import)
 * @returns {(address:string) => Promise<number>} native SOL balance in SOL
 */
export function createSolBalanceReader({ rpcUrl, connection, web3 } = {}) {
  let connPromise = null;
  const getConnection = () => {
    if (connection) return Promise.resolve(connection);
    if (!connPromise) {
      connPromise = import("../proxiedConnection.js").then(({ createProxiedConnection }) =>
        createProxiedConnection(rpcUrl ?? DEFAULT_SOLANA_RPC, "/api/rpc/solana", {
          web3: web3 ?? undefined,
        }),
      );
    }
    return connPromise;
  };

  return async function readSolBalance(address) {
    const conn = await getConnection();
    const lamports = await conn.getBalance(address);
    return lamports / 1e9;
  };
}
