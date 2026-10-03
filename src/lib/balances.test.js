/**
 * balances.test.js — per-chain balance readers: EVM eth_call balanceOf,
 * Solana USDC+WSOL and X1 USDC.x+wSOL.X via the LIVE site's exact pattern:
 * raw JSON-RPC getTokenAccountsByOwner (encoding: "jsonParsed") over plain
 * fetch with a multi-RPC fallback ladder. All DI-able (fake provider / fake
 * fetch), all fail-soft.
 *
 * Pinned behaviors (fix/balances-match-fork):
 *   (1) a 403/429 on the first RPC falls to the second (walk in ladder order)
 *   (2) a jsonrpc error on a rung → next rung
 *   (3) every rung failed → null (UI "—", never a false 0.00)
 *   (4) multiple token accounts for one mint are summed (uiAmount)
 *   (5) the live-site ladder URLs are used verbatim (fetch calls asserted)
 *   (6) X1 reads use X1_RPC (single-rung ladder — the app's own infra)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchEvmTokenBalance,
  fetchSvmTokenBalances,
  fetchSvmMintBalance,
  SOLANA_MINTS,
  X1_MINTS,
  SOLANA_RPC_LADDER,
  X1_RPC_LADDER,
  formatBalance,
} from "./balances.js";
import { SOLANA_RPC, X1_RPC } from "./teleportConstants.js";

const EVM_ADDR = "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6";

/** Plain base58 wallet fixtures — the raw JSON-RPC read accepts strings
 *  directly (no web3.js PublicKey instances, no arg validation). */
const SOL_WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const X1_WALLET = "FngrVsErrrbodyFngrVsErrrbodyFngrVsErrrbody9cXz7";

/** The Solana USDC + WSOL mints (mirror TOKENS.sol). */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

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

/**
 * Fake fetch — a queue of canned responses, one per call index (walking the
 * ladder in order). `throwOn` indexes simulate network failures. Records
 * every call ({ url, opts }) for assertions.
 */
function makeFetch({ responses = [], throwOn = [] } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    const i = calls.length;
    calls.push({ url, opts });
    if (throwOn.includes(i)) throw new Error("network down");
    const r = responses[Math.min(i, responses.length - 1)] ?? { ok: true };
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.body ?? { result: { value: [] } },
    };
  };
  fn.calls = calls;
  return fn;
}

/** A canned HTTP response with a parsed JSON body (the reader calls .json()). */
function jsonResponse(body, { ok = true } = {}) {
  return { ok, body };
}

/** One parsed token account for a mint: { uiAmount } in HUMAN units — the
 *  field the live site sums (jsonParsed encoding). */
function tokenAccount(uiAmount) {
  return {
    account: {
      data: {
        parsed: {
          info: { tokenAmount: { uiAmount } },
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

// ── Solana: USDC + WSOL via the raw JSON-RPC ladder (the live site's pattern)

test("Solana: USDC + WSOL balances read through the fallback ladder", async () => {
  const ladder = ["https://rpc-a.example", "https://rpc-b.example"];
  const fetchFn = makeFetch({
    responses: [
      jsonResponse({ result: { value: [tokenAccount(5.2)] } }), // USDC
      jsonResponse({ result: { value: [tokenAccount(0.3)] } }), // WSOL
    ],
  });
  const bals = await fetchSvmTokenBalances({ rpcs: ladder, wallet: SOL_WALLET, mints: SOLANA_MINTS, fetchFn });
  assert.deepEqual(bals, { USDC: 5.2, WSOL: 0.3 });
  // the POST is the raw JSON-RPC getTokenAccountsByOwner with jsonParsed —
  // plain base58 strings, NO PublicKey instances (web3.js Connection methods
  // would throw `toBase58 is not a function` on raw strings — the live bug)
  const call = fetchFn.calls[0];
  assert.equal(call.url, "https://rpc-a.example");
  assert.equal(call.opts.method, "POST");
  assert.equal(call.opts.headers["Content-Type"], "application/json");
  const body = JSON.parse(call.opts.body);
  assert.equal(body.method, "getTokenAccountsByOwner");
  assert.deepEqual(body.params, [SOL_WALLET, { mint: USDC_MINT }, { encoding: "jsonParsed" }]);
});

test("(1) Solana: first RPC 403 → falls to the second rung; walks in ladder order", async () => {
  const ladder = ["https://rpc-a.example", "https://rpc-b.example", "https://rpc-c.example"];
  const fetchFn = makeFetch({
    responses: [
      { ok: false, status: 403 },                            // USDC rung 1: rate-limited
      jsonResponse({ result: { value: [tokenAccount(5.2)] } }), // USDC rung 2: answers
      { ok: false, status: 429 },                            // WSOL rung 1: rate-limited
      jsonResponse({ result: { value: [tokenAccount(0.3)] } }), // WSOL rung 2: answers
    ],
  });
  const bals = await fetchSvmTokenBalances({ rpcs: ladder, wallet: SOL_WALLET, mints: SOLANA_MINTS, fetchFn });
  assert.deepEqual(bals, { USDC: 5.2, WSOL: 0.3 });
  assert.deepEqual(
    fetchFn.calls.map((c) => c.url),
    ["https://rpc-a.example", "https://rpc-b.example", "https://rpc-a.example", "https://rpc-b.example"],
    "a 403/429 on one endpoint never kills the balance — the ladder walks on",
  );
});

test("Solana: network throw on a rung → next rung", async () => {
  const fetchFn = makeFetch({
    throwOn: [0],
    responses: [null, jsonResponse({ result: { value: [tokenAccount(5.2)] } })],
  });
  const bals = await fetchSvmTokenBalances({
    rpcs: ["https://rpc-a.example", "https://rpc-b.example"],
    wallet: SOL_WALLET,
    mints: [SOLANA_MINTS[0]],
    fetchFn,
  });
  assert.deepEqual(bals, { USDC: 5.2 });
  assert.deepEqual(fetchFn.calls.map((c) => c.url), ["https://rpc-a.example", "https://rpc-b.example"]);
});

test("(2) Solana: jsonrpc error on a rung → next rung, not a false zero", async () => {
  const fetchFn = makeFetch({
    responses: [
      jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } }),
      jsonResponse({ result: { value: [tokenAccount(27.59)] } }),
    ],
  });
  const bals = await fetchSvmTokenBalances({
    rpcs: ["https://rpc-a.example", "https://rpc-b.example"],
    wallet: SOL_WALLET,
    mints: [SOLANA_MINTS[0]],
    fetchFn,
  });
  assert.deepEqual(bals, { USDC: 27.59 });
  assert.equal(fetchFn.calls.length, 2, "both rungs tried");
});

test("(4) Solana: multiple token accounts for one mint are summed (uiAmount)", async () => {
  const fetchFn = makeFetch({
    responses: [
      jsonResponse({ result: { value: [tokenAccount(2.0), tokenAccount(3.2)] } }), // USDC: 2 + 3.2
      jsonResponse({ result: { value: [] } }), // WSOL: no accounts
    ],
  });
  const bals = await fetchSvmTokenBalances({
    rpcs: ["https://rpc-a.example"],
    wallet: SOL_WALLET,
    mints: SOLANA_MINTS,
    fetchFn,
  });
  assert.equal(bals.USDC, 5.2, "sums across every ATA for the mint");
  assert.equal(bals.WSOL, 0, "RPC answered with no accounts → 0, not null");
});

test("(3) Solana: every rung failed → null (UI shows —, never a false 0.00)", async () => {
  const fetchFn = makeFetch({
    responses: [
      { ok: false, status: 403 },
      { ok: false, status: 429 },
      { ok: false, status: 500 },
    ],
  });
  const bals = await fetchSvmTokenBalances({
    rpcs: ["https://rpc-a.example", "https://rpc-b.example", "https://rpc-c.example"],
    wallet: SOL_WALLET,
    mints: SOLANA_MINTS,
    fetchFn,
  });
  assert.equal(bals, null, "ALL rungs failed for every mint → null, no throw");
});

test("fetchSvmMintBalance: all rungs fail → null; RPC answers empty → 0 (honest zero)", async () => {
  const nullBal = await fetchSvmMintBalance({
    rpcs: ["https://rpc-a.example", "https://rpc-b.example"],
    wallet: SOL_WALLET,
    mint: USDC_MINT,
    fetchFn: makeFetch({ responses: [{ ok: false, status: 403 }, { ok: false, status: 429 }] }),
  });
  assert.equal(nullBal, null, "ALL failed → null (unknown), never 0.00");
  const zeroBal = await fetchSvmMintBalance({
    rpcs: ["https://rpc-a.example"],
    wallet: SOL_WALLET,
    mint: USDC_MINT,
    fetchFn: makeFetch({ responses: [jsonResponse({ result: { value: [] } })] }),
  });
  assert.equal(zeroBal, 0, "RPC answered with no accounts → 0 (honest empty)");
  assert.equal(
    await fetchSvmMintBalance({ rpcs: [], wallet: SOL_WALLET, mint: USDC_MINT }),
    null,
    "empty ladder → null",
  );
});

test("(5) SOLANA_RPC_LADDER is the live site's 5 rungs verbatim (order + URLs)", () => {
  assert.deepEqual(SOLANA_RPC_LADDER, [
    SOLANA_RPC, // env-overridable first rung (default = the Helius Secure URL)
    "https://berty-633y20-fast-mainnet.helius-rpc.com",
    "https://solana-rpc.publicnode.com",
    "https://rpc.ankr.com/solana",
    "https://solana.drpc.org",
  ]);
});

test("Solana: reads walk the exported ladder verbatim — fetch called with the live URLs", async () => {
  const fetchFn = makeFetch({
    responses: [jsonResponse({ result: { value: [tokenAccount(5.2)] } })],
  });
  await fetchSvmTokenBalances({ rpcs: SOLANA_RPC_LADDER, wallet: SOL_WALLET, mints: [SOLANA_MINTS[0]], fetchFn });
  assert.deepEqual(
    fetchFn.calls.map((c) => c.url),
    [SOLANA_RPC],
    "first rung = SOLANA_RPC; the walk stops at the first answering rung",
  );
});

// ── X1: USDC.x + wSOL.X (Token-2022, same ladder read against X1_RPC) ──────

test("(6) X1: reads use X1_RPC — the single-rung ladder (the app's own infra)", async () => {
  assert.deepEqual(X1_RPC_LADDER, [X1_RPC], "X1 documents one mainnet public RPC");
  const fetchFn = makeFetch({
    responses: [
      jsonResponse({ result: { value: [tokenAccount(27.59)] } }), // USDC.x
      jsonResponse({ result: { value: [tokenAccount(0.3)] } }), // wSOL.X
    ],
  });
  const bals = await fetchSvmTokenBalances({ rpcs: X1_RPC_LADDER, wallet: X1_WALLET, mints: X1_MINTS, fetchFn });
  assert.deepEqual(bals, { "USDC.x": 27.59, "wSOL.X": 0.3 });
  assert.deepEqual(fetchFn.calls.map((c) => c.url), [X1_RPC, X1_RPC], "both X1 mint reads hit X1_RPC");
  const body = JSON.parse(fetchFn.calls[0].opts.body);
  assert.equal(body.params[1].mint, X1_MINTS[0].mint, "reads the USDC.x Token-2022 mint from TOKENS.x1");
});

test("X1: fail-soft — X1 RPC down → null, never blocks", async () => {
  const bals = await fetchSvmTokenBalances({
    rpcs: X1_RPC_LADDER,
    wallet: X1_WALLET,
    mints: X1_MINTS,
    fetchFn: makeFetch({ responses: [{ ok: false, status: 403 }] }),
  });
  assert.equal(bals, null);
});

test("SVM: fail-soft — missing rpcs/wallet/mints → null; one dead mint → null for that mint only", async () => {
  assert.equal(await fetchSvmTokenBalances({ rpcs: null, wallet: SOL_WALLET, mints: SOLANA_MINTS }), null);
  assert.equal(await fetchSvmTokenBalances({ rpcs: SOLANA_RPC_LADDER, wallet: null, mints: SOLANA_MINTS }), null);
  assert.equal(await fetchSvmTokenBalances({ rpcs: SOLANA_RPC_LADDER, wallet: SOL_WALLET, mints: [] }), null);
  // USDC's whole ladder fails → USDC: null; WSOL answers → map with a null member
  const fetchFn = makeFetch({
    responses: [
      { ok: false, status: 403 },
      { ok: false, status: 429 },
      jsonResponse({ result: { value: [tokenAccount(0.3)] } }),
    ],
  });
  const bals = await fetchSvmTokenBalances({
    rpcs: ["https://rpc-a.example", "https://rpc-b.example"],
    wallet: SOL_WALLET,
    mints: SOLANA_MINTS,
    fetchFn,
  });
  assert.deepEqual(bals, { USDC: null, WSOL: 0.3 }, "per-mint null — never a false 0.00 for the dead mint");
});

test("SOLANA_MINTS / X1_MINTS mirror TOKENS (address + decimals per mint)", () => {
  assert.equal(SOLANA_MINTS[0].symbol, "USDC");
  assert.equal(SOLANA_MINTS[0].mint, USDC_MINT);
  assert.equal(SOLANA_MINTS[0].decimals, 6);
  assert.equal(SOLANA_MINTS[1].symbol, "WSOL");
  assert.equal(SOLANA_MINTS[1].mint, WSOL_MINT);
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
