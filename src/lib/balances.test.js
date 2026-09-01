/**
 * balances.test.js — per-chain balance readers: EVM eth_call balanceOf,
 * Solana USDC+WSOL via getParsedTokenAccountsByOwner, X1 USDC.x+wSOL.X (same
 * SVM shape). All DI-able (fake provider / fake connection), all fail-soft.
 *
 * The SVM reader calls the PARSED variant (jsonParsed encoding) with
 * PublicKey instances — real web3.js Connections require both (the raw
 * getTokenAccountsByOwner hardcodes base64, whose response has no `.parsed`
 * member, and calls `.toBase58()` on its args, so string addresses throw
 * before any RPC round-trip — the live `Solana: —` / `X1: —` root cause,
 * fix/proxy-solana-x1-rpc). The fakes below mirror that contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchEvmTokenBalance,
  fetchSvmTokenBalances,
  SOLANA_MINTS,
  X1_MINTS,
  formatBalance,
} from "./balances.js";

const EVM_ADDR = "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6";

/** Valid base58 wallet fixtures — real Connections require
 *  PublicKey-parseable addresses (the reader normalizes strings → PublicKey
 *  before calling, so these must be real base58). */
const SVM_WALLET = "So11111111111111111111111111111111111111112";
const X1_WALLET = "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq";

/** Fake EIP-1193 provider — records eth_call requests, returns canned hex. */
function makeEvmProvider({ hex = "0x0", fail = false } = {}) {
  const calls = [];
  return {
    calls,
    request: async ({ method, params }) => {
      calls.push({ method, params });
      if (method === "eth_call") {
        if (fail) throw new Error("execution reverted");
        return hex;
      }
      return "0x";
    },
  };
}

/** Fake SVM connection — records getParsedTokenAccountsByOwner, returns
 *  canned parsed token accounts (the jsonParsed RPC shape — the variant the
 *  reader actually calls; getTokenAccountsByOwner hardcodes base64 and has
 *  no `.parsed` to read). */
function makeSvmConnection({ accountsByMint = {}, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    getParsedTokenAccountsByOwner: async (wallet, { mint }) => {
      calls.push({ wallet: String(wallet), mint: String(mint) });
      if (fail) throw new Error("RPC unavailable");
      return { value: accountsByMint[String(mint)] || [] };
    },
  };
}

/** One parsed token account for a mint: { amount } in base units. */
function tokenAccount(baseAmount) {
  return {
    account: {
      data: {
        parsed: {
          info: { tokenAmount: { amount: String(baseAmount) } },
        },
      },
    },
  };
}

// ── EVM: eth_call balanceOf with per-token decimals ────────────────────────

test("EVM: USDC (6 decimals) balance reads via eth_call with the right calldata", async () => {
  // 27_590_000 base units = 27.59 USDC (6 dec)
  const provider = makeEvmProvider({ hex: "0x" + (27_590_000n).toString(16) });
  const bal = await fetchEvmTokenBalance({
    provider,
    wallet: EVM_ADDR,
    token: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  });
  assert.equal(bal, 27.59);
  const call = provider.calls.find((c) => c.method === "eth_call");
  assert.ok(call, "eth_call fired");
  // balanceOf(address): 0x70a08231 + 32-byte left-padded wallet
  assert.equal(
    call.params[0].to,
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "reads the USDC contract",
  );
  assert.equal(
    call.params[0].data,
    "0x70a08231" + "000000000000000000000000" + EVM_ADDR.slice(2).toLowerCase(),
    "balanceOf calldata with the padded wallet",
  );
});

test("EVM: USDT (6 decimals) and DAI (18 decimals) are converted with their own decimals", async () => {
  // USDT: 12_345_678 base → 12.345678 USDT
  const usdt = await fetchEvmTokenBalance({
    provider: makeEvmProvider({ hex: "0x" + (12_345_678n).toString(16) }),
    wallet: EVM_ADDR,
    token: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  });
  assert.equal(usdt, 12.345678);

  // DAI: 27_590_000_000_000_000_000 base (18 dec) → 27.59 DAI
  const dai = await fetchEvmTokenBalance({
    provider: makeEvmProvider({ hex: "0x" + (27_590_000_000_000_000_000n).toString(16) }),
    wallet: EVM_ADDR,
    token: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  });
  assert.equal(dai, 27.59);
});

test("EVM: fail-soft — missing provider/wallet/token → null, RPC error → null, never throws", async () => {
  const token = { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 };
  assert.equal(await fetchEvmTokenBalance({ provider: null, wallet: EVM_ADDR, token }), null);
  assert.equal(await fetchEvmTokenBalance({ provider: makeEvmProvider(), wallet: null, token }), null);
  assert.equal(await fetchEvmTokenBalance({ provider: makeEvmProvider(), wallet: EVM_ADDR, token: null }), null);
  const failing = await fetchEvmTokenBalance({
    provider: makeEvmProvider({ fail: true }),
    wallet: EVM_ADDR,
    token,
  });
  assert.equal(failing, null, "reverting eth_call → null, no throw");
});

test("EVM: null hex response → null (fail-soft)", async () => {
  const provider = { request: async () => null };
  const bal = await fetchEvmTokenBalance({
    provider,
    wallet: EVM_ADDR,
    token: { address: "0xabc", decimals: 6 },
  });
  assert.equal(bal, null);
});

// ── Solana: USDC + WSOL via getParsedTokenAccountsByOwner ──────────────────

test("Solana: USDC + WSOL balances, decimals per mint (6 and 9)", async () => {
  const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const wsolMint = "So11111111111111111111111111111111111111112";
  const conn = makeSvmConnection({
    accountsByMint: {
      [usdcMint]: [tokenAccount(5_200_000)], // 5.2 USDC
      [wsolMint]: [tokenAccount(300_000_000)], // 0.3 WSOL (9 dec)
    },
  });
  const bals = await fetchSvmTokenBalances({ connection: conn, wallet: SVM_WALLET, mints: SOLANA_MINTS });
  assert.deepEqual(bals, { USDC: 5.2, WSOL: 0.3 });
  // the connection was asked for the right mints (as base58 strings)
  assert.deepEqual(
    conn.calls.map((c) => c.mint),
    [usdcMint, wsolMint],
  );
});

test("Solana: multiple token accounts for one mint are summed", async () => {
  const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const wsolMint = "So11111111111111111111111111111111111111112";
  const conn = makeSvmConnection({
    accountsByMint: {
      [usdcMint]: [tokenAccount(2_000_000), tokenAccount(3_200_000)], // 2 + 3.2
      [wsolMint]: [],
    },
  });
  const bals = await fetchSvmTokenBalances({ connection: conn, wallet: SVM_WALLET, mints: SOLANA_MINTS });
  assert.equal(bals.USDC, 5.2, "sums across every ATA for the mint");
  assert.equal(bals.WSOL, 0, "no account → 0, not null");
});

test("Solana: fail-soft — connection throws → null, missing connection/wallet → null", async () => {
  const failing = await fetchSvmTokenBalances({
    connection: makeSvmConnection({ fail: true }),
    wallet: SVM_WALLET,
    mints: SOLANA_MINTS,
  });
  assert.equal(failing, null, "RPC failure → null, no throw");
  assert.equal(await fetchSvmTokenBalances({ connection: null, wallet: SVM_WALLET, mints: SOLANA_MINTS }), null);
  assert.equal(await fetchSvmTokenBalances({ connection: makeSvmConnection(), wallet: null, mints: SOLANA_MINTS }), null);
  assert.equal(await fetchSvmTokenBalances({ connection: makeSvmConnection(), wallet: SVM_WALLET, mints: [] }), null);
});

// ── X1: USDC.x + wSOL.X (Token-2022, same SVM RPC shape) ───────────────────

test("X1: USDC.x + wSOL.X balances via the same getParsedTokenAccountsByOwner pattern", async () => {
  const usdcxMint = "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq";
  const wsolxMint = "JDqX4vau2P5zJmLpuNitvR6vMURr9kYjex6oZQXz3Ja8";
  const conn = makeSvmConnection({
    accountsByMint: {
      [usdcxMint]: [tokenAccount(27_590_000)], // 27.59 USDC.x
      [wsolxMint]: [tokenAccount(300_000_000)], // 0.3 wSOL.X (9 dec)
    },
  });
  const bals = await fetchSvmTokenBalances({ connection: conn, wallet: X1_WALLET, mints: X1_MINTS });
  assert.deepEqual(bals, { "USDC.x": 27.59, "wSOL.X": 0.3 });
  assert.deepEqual(
    conn.calls.map((c) => c.mint),
    [usdcxMint, wsolxMint],
    "reads the X1 Token-2022 mints from TOKENS.x1",
  );
});

test("X1: fail-soft — X1 RPC down → null, never blocks", async () => {
  const bals = await fetchSvmTokenBalances({
    connection: makeSvmConnection({ fail: true }),
    wallet: X1_WALLET,
    mints: X1_MINTS,
  });
  assert.equal(bals, null);
});

test("SOLANA_MINTS / X1_MINTS mirror TOKENS (address + decimals per mint)", () => {
  assert.equal(SOLANA_MINTS[0].symbol, "USDC");
  assert.equal(SOLANA_MINTS[0].decimals, 6);
  assert.equal(SOLANA_MINTS[1].symbol, "WSOL");
  assert.equal(SOLANA_MINTS[1].decimals, 9);
  assert.equal(X1_MINTS[0].symbol, "USDC.x");
  assert.equal(X1_MINTS[0].decimals, 6);
  assert.equal(X1_MINTS[1].symbol, "wSOL.X");
  assert.equal(X1_MINTS[1].decimals, 9);
});

// ── formatBalance — compact human display ──────────────────────────────────

test("formatBalance trims trailing zeros and caps runaway precision", () => {
  assert.equal(formatBalance(27.59), "27.59");
  assert.equal(formatBalance(27.590000001), "27.59");
  assert.equal(formatBalance(0.3), "0.3");
  assert.equal(formatBalance(5), "5");
  assert.equal(formatBalance(0), "0");
  assert.equal(formatBalance(null), null);
  assert.equal(formatBalance(undefined), null);
});
