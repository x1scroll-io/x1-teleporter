/**
 * changenow/index.test.js — the ChangeNOW (instant-swap) rail client.
 *
 * Proves the long-tail rail's CONTRACTS without a live upstream (every network
 * call is driven through an injected fetchImpl):
 *   - the source identity pins BOTH the ticker and the network (fromCurrency +
 *     fromNetwork) — the network is never omitted (a same-name ticker on
 *     another chain is a different asset);
 *   - the quote is FAIL-CLOSED: a real positive toAmount is required (the
 *     rate), the provider minimum is honored, and any error/empty response
 *     yields a not-ok result — never a fabricated number;
 *   - the create (deposit-address step) requires a payout address and returns
 *     the payin address, failing closed otherwise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHANGENOW_API_BASE,
  changeNowSourceFor,
  buildChangeNowQuoteQuery,
  parseChangeNowEstimate,
  parseChangeNowMinAmount,
  quoteChangeNow,
  canServeChangeNowRoute,
  buildChangeNowCreateBody,
  createChangeNowExchange,
} from "./index.js";

/** A fake fetch that answers the quote / min-amount / create routes. */
function fakeFetch({ estimate, minAmount, estimateStatus = 200, minStatus = 200, create } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const route = String(url).replace(`${CHANGENOW_API_BASE}/`, "").split("?")[0];
    if (route === "create") {
      const body = create ?? {};
      return { ok: (create?.__status ?? 200) < 400, status: create?.__status ?? 200, json: async () => body };
    }
    if (route === "minAmount") {
      return { ok: minStatus < 400, status: minStatus, json: async () => minAmount ?? {} };
    }
    // quote
    return { ok: estimateStatus < 400, status: estimateStatus, json: async () => estimate ?? {} };
  };
  fn.calls = calls;
  return fn;
}

// ── source identity ─────────────────────────────────────────────────────────

test("changenow: the source identity pins the ticker AND the network (fromCurrency + fromNetwork)", () => {
  for (const [chain, want] of Object.entries({
    xmr: { fromCurrency: "xmr", fromNetwork: "xmr", asset: "XMR" },
    ada: { fromCurrency: "ada", fromNetwork: "ada", asset: "ADA" },
    atom: { fromCurrency: "atom", fromNetwork: "atom", asset: "ATOM" },
    near: { fromCurrency: "near", fromNetwork: "near", asset: "NEAR" },
    zec: { fromCurrency: "zec", fromNetwork: "zec", asset: "ZEC" },
    dash: { fromCurrency: "dash", fromNetwork: "dash", asset: "DASH" },
    bch: { fromCurrency: "bch", fromNetwork: "bch", asset: "BCH" },
    // Second wave (2026-09-27) — verified live: native network == ticker.
    algo: { fromCurrency: "algo", fromNetwork: "algo", asset: "ALGO" },
    xtz: { fromCurrency: "xtz", fromNetwork: "xtz", asset: "XTZ" },
    fil: { fromCurrency: "fil", fromNetwork: "fil", asset: "FIL" },
    hbar: { fromCurrency: "hbar", fromNetwork: "hbar", asset: "HBAR" },
    vet: { fromCurrency: "vet", fromNetwork: "vet", asset: "VET" },
    theta: { fromCurrency: "theta", fromNetwork: "theta", asset: "THETA" },
    osmo: { fromCurrency: "osmo", fromNetwork: "osmo", asset: "OSMO" },
  })) {
    const src = changeNowSourceFor(chain);
    assert.ok(src, `${chain} has a ChangeNOW source identity`);
    assert.equal(src.fromCurrency, want.fromCurrency);
    assert.equal(src.fromNetwork, want.fromNetwork, `${chain}: fromNetwork is pinned`);
    assert.equal(src.asset, want.asset);
    assert.ok(Number.isInteger(src.decimals) && src.decimals > 0, `${chain} decimals present`);
  }
  // Non-long-tail chains have NO ChangeNOW source identity here.
  for (const c of ["eth", "btc", "sui", "x1", "polkadot"]) {
    assert.equal(changeNowSourceFor(c), null, `${c} is not a ChangeNOW long-tail source`);
  }
});

test("changenow: the SECOND-WAVE long-tail coins pin their native network and DOT has no identity (2026-09-27)", () => {
  // Each second-wave coin is single-network with network == ticker; the query
  // pins BOTH so a same-ticker wrapped variant (e.g. fil on bsc) can never
  // cross. DOT is not a ChangeNOW source here at all (fail-closed null).
  for (const c of ["algo", "xtz", "fil", "hbar", "vet", "theta", "osmo"]) {
    const src = changeNowSourceFor(c);
    assert.ok(src, `${c} has a ChangeNOW source identity`);
    assert.equal(src.fromCurrency, c);
    assert.equal(src.fromNetwork, c, `${c}: fromNetwork pinned (native network == ticker)`);
    const built = buildChangeNowQuoteQuery({ fromChain: c, toCurrency: "usdc", toNetwork: "sol", amount: 2 });
    assert.ok(built, `${c}: quote query builds`);
    assert.equal(built.qs.get("fromCurrency"), c);
    assert.equal(built.qs.get("fromNetwork"), c, `${c}: fromNetwork always sent`);
    assert.equal(built.qs.get("toCurrency"), "usdc");
    assert.equal(built.qs.get("toNetwork"), "sol");
    assert.equal(built.qs.get("fromAmount"), "2");
  }
  assert.equal(changeNowSourceFor("polkadot"), null, "polkadot is NOT a ChangeNOW source");
  assert.equal(buildChangeNowQuoteQuery({ fromChain: "polkadot", toCurrency: "usdc", amount: 1 }), null);
  assert.equal(
    buildChangeNowCreateBody({ fromChain: "polkadot", toCurrency: "usdc", amount: 1, address: "a" }),
    null,
    "DOT: create body is null (fail-closed)",
  );
});

test("changenow: the quote query sends fromCurrency + fromNetwork + toCurrency + fromAmount (and toNetwork when given)", () => {
  const built = buildChangeNowQuoteQuery({ fromChain: "xmr", toCurrency: "usdc", toNetwork: "sol", amount: 0.5 });
  assert.ok(built, "built for a long-tail source");
  assert.equal(built.qs.get("fromCurrency"), "xmr");
  assert.equal(built.qs.get("fromNetwork"), "xmr");
  assert.equal(built.qs.get("toCurrency"), "usdc");
  assert.equal(built.qs.get("toNetwork"), "sol");
  assert.equal(built.qs.get("fromAmount"), "0.5");
  assert.equal(built.qs.get("flow"), "standard");
  // Fail-closed inputs: unknown source / missing dest / bad amount → null.
  assert.equal(buildChangeNowQuoteQuery({ fromChain: "eth", toCurrency: "usdc", amount: 1 }), null);
  assert.equal(buildChangeNowQuoteQuery({ fromChain: "xmr", toCurrency: "", amount: 1 }), null);
  assert.equal(buildChangeNowQuoteQuery({ fromChain: "xmr", toCurrency: "usdc", amount: 0 }), null);
  assert.equal(buildChangeNowQuoteQuery({ fromChain: "xmr", toCurrency: "usdc", amount: -1 }), null);
});

// ── estimate parsing (fail-closed) ──────────────────────────────────────────

test("changenow: parseChangeNowEstimate requires a real positive toAmount and honors minAmount", () => {
  assert.equal(parseChangeNowEstimate(null), null);
  assert.equal(parseChangeNowEstimate({}), null);
  assert.equal(parseChangeNowEstimate({ toAmount: 0 }), null, "zero rate is not a quote");
  assert.equal(parseChangeNowEstimate({ toAmount: -3 }), null, "negative rate is not a quote");
  assert.equal(parseChangeNowEstimate({ toAmount: "n/a" }), null, "non-numeric rate is not a quote");
  const q = parseChangeNowEstimate({ toAmount: 42.5, minAmount: 0.1, rateId: "r1" }, { amount: 1 });
  assert.ok(q);
  assert.equal(q.toAmount, 42.5);
  assert.equal(q.minAmount, 0.1);
  assert.equal(q.rateId, "r1");
  // Below the provider minimum → refused (fail-closed).
  assert.equal(parseChangeNowEstimate({ toAmount: 42.5, minAmount: 0.1 }, { amount: 0.05 }), null);
  // parseChangeNowMinAmount accepts both the object and bare-number shapes.
  assert.equal(parseChangeNowMinAmount({ minAmount: 0.25 }), 0.25);
  assert.equal(parseChangeNowMinAmount(0.25), 0.25);
  assert.equal(parseChangeNowMinAmount({}), null);
  assert.equal(parseChangeNowMinAmount({ minAmount: 0 }), null);
});

// ── live quote (injected fetch) ─────────────────────────────────────────────

test("changenow: quoteChangeNow returns a real rate + minimum on success", async () => {
  const fetchImpl = fakeFetch({ estimate: { toAmount: 61.2, rateId: "abc" }, minAmount: { minAmount: 0.2 } });
  const r = await quoteChangeNow({ fromChain: "xmr", toCurrency: "usdc", toNetwork: "sol", amount: 1, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.quote.toAmount, 61.2);
  assert.equal(r.quote.minAmount, 0.2, "the live provider minimum is carried through");
  assert.equal(r.source.fromNetwork, "xmr");
  // It hit BOTH endpoints (estimate + min-amount) with the pinned network.
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls.every((c) => c.url.includes("fromNetwork=xmr")));
});

test("changenow: quoteChangeNow FAILS CLOSED on upstream error / unusable body / sub-minimum", async () => {
  const err = await quoteChangeNow({ fromChain: "xmr", toCurrency: "usdc", amount: 1, fetchImpl: fakeFetch({ estimateStatus: 502, estimate: { error: "boom" } }) });
  assert.equal(err.ok, false);
  assert.equal(err.reason, "boom");

  const empty = await quoteChangeNow({ fromChain: "xmr", toCurrency: "usdc", amount: 1, fetchImpl: fakeFetch({ estimate: {} }) });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "unusable_quote");

  const below = await quoteChangeNow({ fromChain: "xmr", toCurrency: "usdc", amount: 0.01, fetchImpl: fakeFetch({ estimate: { toAmount: 5 }, minAmount: { minAmount: 0.5 } }) });
  assert.equal(below.ok, false);
  assert.equal(below.reason, "below_minimum");
  assert.equal(below.minAmount, 0.5);

  const unsupported = await quoteChangeNow({ fromChain: "eth", toCurrency: "usdc", amount: 1, fetchImpl: fakeFetch({}) });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.reason, "unsupported_source");
});

test("changenow: a missing min-amount endpoint still yields a real rate (min stays null, never invented)", async () => {
  const r = await quoteChangeNow({ fromChain: "ada", toCurrency: "usdc", amount: 10, fetchImpl: fakeFetch({ estimate: { toAmount: 8.7 }, minStatus: 502, minAmount: { error: "nope" } }) });
  assert.equal(r.ok, true, "the rate is real — the quote is usable");
  assert.equal(r.quote.toAmount, 8.7);
  assert.equal(r.quote.minAmount, null, "no minimum was answered → null, never fabricated");
  assert.equal(await canServeChangeNowRoute({ fromChain: "ada", toCurrency: "usdc", amount: 10, fetchImpl: fakeFetch({ estimate: { toAmount: 8.7 } }) }), true);
  assert.equal(await canServeChangeNowRoute({ fromChain: "ada", toCurrency: "usdc", amount: 10, fetchImpl: fakeFetch({ estimateStatus: 500 }) }), false);
});

// ── create (deposit-address step) ───────────────────────────────────────────

test("changenow: the create body pins the network(s) and requires a payout address", () => {
  const body = buildChangeNowCreateBody({ fromChain: "xmr", toCurrency: "usdc", toNetwork: "sol", amount: 1.5, address: "So1anaAddr", refundAddress: "xmrRefund" });
  assert.ok(body);
  assert.equal(body.fromCurrency, "xmr");
  assert.equal(body.fromNetwork, "xmr", "fromNetwork always sent");
  assert.equal(body.toCurrency, "usdc");
  assert.equal(body.toNetwork, "sol");
  assert.equal(body.fromAmount, 1.5);
  assert.equal(body.address, "So1anaAddr");
  assert.equal(body.refundAddress, "xmrRefund");
  assert.equal(body.flow, "standard");
  assert.equal(body.type, "direct");
  // Fail-closed: no address / no dest / bad amount / unknown source → null.
  assert.equal(buildChangeNowCreateBody({ fromChain: "xmr", toCurrency: "usdc", amount: 1 }), null, "no payout address");
  assert.equal(buildChangeNowCreateBody({ fromChain: "xmr", toCurrency: "", amount: 1, address: "a" }), null);
  assert.equal(buildChangeNowCreateBody({ fromChain: "xmr", toCurrency: "usdc", amount: 0, address: "a" }), null);
  assert.equal(buildChangeNowCreateBody({ fromChain: "eth", toCurrency: "usdc", amount: 1, address: "a" }), null);
});

test("changenow: createChangeNowExchange returns the payin address, failing closed otherwise", async () => {
  const ok = await createChangeNowExchange(
    { fromChain: "xmr", toCurrency: "usdc", toNetwork: "sol", amount: 1, address: "So1anaAddr" },
    { fetchImpl: fakeFetch({ create: { payinAddress: "4AdDress", payinExtraId: null, id: "ex1" } }) },
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.exchange.payinAddress, "4AdDress");
  assert.equal(ok.request.fromNetwork, "xmr");

  const noPayin = await createChangeNowExchange(
    { fromChain: "xmr", toCurrency: "usdc", amount: 1, address: "So1anaAddr" },
    { fetchImpl: fakeFetch({ create: { id: "ex1" } }) },
  );
  assert.equal(noPayin.ok, false);
  assert.equal(noPayin.reason, "no_payin_address");

  const badReq = await createChangeNowExchange({ fromChain: "xmr", toCurrency: "usdc", amount: 1 }, { fetchImpl: fakeFetch({}) });
  assert.equal(badReq.ok, false);
  assert.equal(badReq.reason, "missing_params");

  const upstreamErr = await createChangeNowExchange(
    { fromChain: "xmr", toCurrency: "usdc", amount: 1, address: "a" },
    { fetchImpl: fakeFetch({ create: { __status: 502, error: "boom" } }) },
  );
  assert.equal(upstreamErr.ok, false);
  assert.equal(upstreamErr.reason, "boom");
});
