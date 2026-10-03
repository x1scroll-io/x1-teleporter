/**
 * payoutConfig.test.js — the MEV PAYOUT CONFIG tests (the treasury map +
 * sweep config of the deposit-only payout layer).
 *
 * Spec coverage:
 *   • the DEFAULT payout groups (the public deposit-only treasury map —
 *     evm address serves ETH/Base/BNB/Arb/Opt/Pol/RH; the SVM address
 *     serves sol+x1) + the derived chain→treasury map,
 *   • address format validation (fail-closed — a wrong destination is a
 *     lost deposit): EVM 0x+40hex, SVM base58 32 bytes,
 *   • resolvePayoutConfig: defaults + overrides + every malformed-input
 *     rejection (frequency / basket / chain-family / address),
 *   • the env load pattern (readPayoutEnv → resolvePayoutConfig),
 *   • BASKET_TARGETS sanity vs the repo tokenResolver ground truth (every
 *     mapped canonical symbol resolves on its chain; the basket member
 *     list sanity — the conceptual SOL/wBTC/wETH/USDC basket).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MEV_PAYOUT_GROUPS_DEFAULT,
  MEV_PAYOUT_DEPOSIT_ONLY_NOTE,
  MEV_SWEEP_FREQUENCIES,
  MEV_SWEEP_FREQUENCY_DEFAULT,
  MEV_SWEEP_BASKET,
  BASKET_TARGETS,
  resolvePayoutConfig,
  readPayoutEnv,
  DEFAULT_MEV_PAYOUT_CONFIG,
  treasuryForChain,
  payoutGroupForChain,
  configuredChains,
  isValidEvmAddress,
  isValidSvmAddress,
  isValidNearAccountId,
  isValidTonAddress,
  base58Decode,
} from "./payoutConfig.js";
import { resolve, CHAIN_META } from "../tokenResolver.js";

const EVM_TREASURY = "0xd907e2d4770D3222382eE619980075ac1e59a369";
const SVM_TREASURY = "H3JfpvBRxAQ9ejrkyeKtCEy3WSRKbwcCxxxFBcohKSuY";
const NEAR_TREASURY = "mev-treasury.near";
const TON_TREASURY = "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt";

test("payout config: the DEFAULT groups are the public deposit-only treasury map (Mr. Esters' addresses)", () => {
  const cfg = DEFAULT_MEV_PAYOUT_CONFIG;
  assert.equal(cfg.kind, "mev-payout-config");
  assert.equal(cfg.version, 1);
  assert.equal(cfg.depositOnly, true, "deposit-only boundary is structural");
  assert.match(cfg.note, /DEPOSIT-ONLY/);
  // evm group — one address serves ETH/Base/BNB/Arb/Opt/Pol/RH
  assert.equal(cfg.groups.evm.address, EVM_TREASURY);
  assert.deepEqual([...cfg.groups.evm.chains], ["eth", "bas", "bsc", "arb", "opt", "pol", "rbn"]);
  assert.equal(cfg.groups.evm.family, "evm");
  // solana_x1 group — Solana + X1 share the SVM address space
  assert.equal(cfg.groups.solana_x1.address, SVM_TREASURY);
  assert.deepEqual([...cfg.groups.solana_x1.chains], ["sol", "x1"]);
  assert.equal(cfg.groups.solana_x1.family, "svm");
});

test("payout config: NEAR + TON groups exist but DEFAULT to NO destination (env-supplied, fail-closed)", () => {
  const cfg = DEFAULT_MEV_PAYOUT_CONFIG;
  // the group definitions declare the intended family + chains,
  assert.equal(MEV_PAYOUT_GROUPS_DEFAULT.near.family, "near");
  assert.deepEqual([...MEV_PAYOUT_GROUPS_DEFAULT.near.chains], ["near"]);
  assert.equal(MEV_PAYOUT_GROUPS_DEFAULT.near.address, null, "no NEAR address is committed/guessed");
  assert.equal(MEV_PAYOUT_GROUPS_DEFAULT.ton.family, "ton");
  assert.deepEqual([...MEV_PAYOUT_GROUPS_DEFAULT.ton.chains], ["ton"]);
  assert.equal(MEV_PAYOUT_GROUPS_DEFAULT.ton.address, null, "no TON address is committed/guessed");
  // but the RESOLVED config serves nothing for them while unset
  assert.equal(cfg.groups.near.address, null);
  assert.deepEqual([...cfg.groups.near.chains], [], "an unset group serves no chain");
  assert.equal(cfg.groups.ton.address, null);
  assert.deepEqual([...cfg.groups.ton.chains], []);
  // fail-closed: no destination ⇒ treasuryForChain null ⇒ the ledger refuses a real capture there
  assert.equal(treasuryForChain(cfg, "near"), null);
  assert.equal(treasuryForChain(cfg, "ton"), null);
  assert.equal(payoutGroupForChain(cfg, "near"), null);
  assert.equal(payoutGroupForChain(cfg, "ton"), null);
  // the default configured chain set is UNCHANGED (near/ton add nothing while unset)
  assert.deepEqual(configuredChains(cfg), ["eth", "bas", "bsc", "arb", "opt", "pol", "rbn", "sol", "x1"]);
});

test("payout config: NEAR + TON env addresses flow through readPayoutEnv → resolvePayoutConfig", () => {
  const o = readPayoutEnv({ VITE_MEV_PAYOUT_NEAR: NEAR_TREASURY, NEXT_PUBLIC_MEV_PAYOUT_TON: TON_TREASURY });
  const cfg = resolvePayoutConfig(o);
  assert.equal(treasuryForChain(cfg, "near"), NEAR_TREASURY);
  assert.equal(treasuryForChain(cfg, "ton"), TON_TREASURY);
  assert.equal(payoutGroupForChain(cfg, "near"), "near");
  assert.equal(payoutGroupForChain(cfg, "ton"), "ton");
  assert.deepEqual([...cfg.groups.near.chains], ["near"], "the group serves its chain once an address is set");
  assert.equal(cfg.groups.near.family, "near");
  assert.ok(configuredChains(cfg).includes("near"));
  assert.ok(configuredChains(cfg).includes("ton"));
  // an unset override leaves the default (unset) standing — never guesses
  assert.equal(treasuryForChain(resolvePayoutConfig(readPayoutEnv({ VITE_MEV_PAYOUT_NEAR: "" })), "near"), null);
});

test("payout config: NEAR + TON address format validators (accept/reject) + fail-closed resolver", () => {
  // NEAR account id — named + 64-hex implicit accepted; malformed rejected
  assert.equal(isValidNearAccountId(NEAR_TREASURY), true);
  assert.equal(isValidNearAccountId("usdt.tether-token.near"), true);
  assert.equal(isValidNearAccountId("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2"), true, "64-hex implicit account id");
  assert.equal(isValidNearAccountId("UPPERCASE.near"), false, "uppercase rejected");
  assert.equal(isValidNearAccountId("a"), false, "too short");
  assert.equal(isValidNearAccountId("x".repeat(65)), false, "too long (named)");
  assert.equal(isValidNearAccountId("bad..dots.near"), false, "consecutive dots");
  assert.equal(isValidNearAccountId("has space.near"), false);
  assert.equal(isValidNearAccountId(""), false);
  assert.equal(isValidNearAccountId(null), false);
  // TON friendly address — EQ…/UQ… base64url 48 chars accepted; else rejected
  assert.equal(isValidTonAddress(TON_TREASURY), true);
  assert.equal(isValidTonAddress("UQ" + "A".repeat(46)), true);
  assert.equal(isValidTonAddress("EQ" + "A".repeat(45)), false, "too short");
  assert.equal(isValidTonAddress("EQ" + "A".repeat(47)), false, "too long");
  assert.equal(isValidTonAddress("AA" + "A".repeat(46)), false, "wrong tag");
  assert.equal(isValidTonAddress("EQ" + "!".repeat(46)), false, "non-base64url char");
  assert.equal(isValidTonAddress("0:" + "ab".repeat(32)), false, "raw form not accepted");
  assert.equal(isValidTonAddress(""), false);
  // the resolver fails closed on a malformed near/ton override
  assert.throws(() => resolvePayoutConfig({ groups: { near: { address: "Bad Address" } } }), /not a valid NEAR address/);
  assert.throws(() => resolvePayoutConfig({ groups: { ton: { address: "not-a-ton-addr" } } }), /not a valid TON address/);
});

test("payout config: NEAR + TON basket targets are EMPTY (drop-as-is until a canonical member resolves)", () => {
  assert.deepEqual(Object.keys(BASKET_TARGETS.near), []);
  assert.deepEqual(Object.keys(BASKET_TARGETS.ton), []);
});

test("payout config: the derived chain→treasury map covers every capture chain + RH", () => {
  const cfg = DEFAULT_MEV_PAYOUT_CONFIG;
  assert.equal(treasuryForChain(cfg, "eth"), EVM_TREASURY);
  assert.equal(treasuryForChain(cfg, "bas"), EVM_TREASURY);
  assert.equal(treasuryForChain(cfg, "bsc"), EVM_TREASURY);
  assert.equal(treasuryForChain(cfg, "arb"), EVM_TREASURY);
  assert.equal(treasuryForChain(cfg, "opt"), EVM_TREASURY);
  assert.equal(treasuryForChain(cfg, "pol"), EVM_TREASURY);
  assert.equal(treasuryForChain(cfg, "rbn"), EVM_TREASURY, "Robinhood Chain is served by the EVM address");
  assert.equal(treasuryForChain(cfg, "sol"), SVM_TREASURY);
  assert.equal(treasuryForChain(cfg, "x1"), SVM_TREASURY, "X1 is served by the SVM address");
  // every CAPTURE_SCAN_CHAINS chain (routePlanner) has a treasury
  for (const chain of ["eth", "arb", "bas", "opt", "pol", "bsc", "sol"]) {
    assert.ok(treasuryForChain(cfg, chain), `${chain} has a treasury`);
  }
  // unconfigured chains → null (a capture there cannot drop — fail closed downstream)
  assert.equal(treasuryForChain(cfg, "avax"), null);
  assert.equal(treasuryForChain(cfg, "btc"), null);
  assert.equal(treasuryForChain(cfg, null), null);
  // group lookups
  assert.equal(payoutGroupForChain(cfg, "sol"), "solana_x1");
  assert.equal(payoutGroupForChain(cfg, "eth"), "evm");
  assert.equal(payoutGroupForChain(cfg, "avax"), null);
  assert.deepEqual(configuredChains(cfg), ["eth", "bas", "bsc", "arb", "opt", "pol", "rbn", "sol", "x1"]);
});

test("payout config: sweep config defaults — daily cadence + the SOL/wBTC/wETH/USDC basket", () => {
  const cfg = DEFAULT_MEV_PAYOUT_CONFIG;
  assert.equal(MEV_SWEEP_FREQUENCY_DEFAULT, "daily");
  assert.deepEqual(MEV_SWEEP_FREQUENCIES, ["daily", "weekly"]);
  assert.equal(cfg.sweep.frequency, "daily");
  assert.deepEqual([...MEV_SWEEP_BASKET], ["SOL", "wBTC", "wETH", "USDC"], "Mr. Esters' basket names, in order");
  assert.deepEqual([...cfg.sweep.basket], ["SOL", "wBTC", "wETH", "USDC"]);
  assert.match(cfg.sweep.basketNote, /CANONICAL/);
  assert.equal(MEV_PAYOUT_DEPOSIT_ONLY_NOTE.length > 0, true);
});

test("payout config: address format validation is fail-closed (EVM 0x+40hex, SVM base58 32 bytes)", () => {
  assert.equal(isValidEvmAddress(EVM_TREASURY), true);
  assert.equal(isValidEvmAddress("0xd907e2d4770D3222382eE619980075ac1e59a36"), false, "short hex");
  assert.equal(isValidEvmAddress("d907e2d4770D3222382eE619980075ac1e59a369"), false, "missing 0x");
  assert.equal(isValidEvmAddress("0xzzz7e2d4770D3222382eE619980075ac1e59a369"), false, "non-hex");
  assert.equal(isValidEvmAddress(""), false);
  assert.equal(isValidEvmAddress(null), false);
  assert.equal(isValidSvmAddress(SVM_TREASURY), true, "the committed SVM address decodes to 32 bytes");
  assert.equal(base58Decode(SVM_TREASURY).length, 32);
  assert.equal(isValidSvmAddress("H3JfpvBRxAQ9ejrkyeKtCEy3WSRKbwcC"), false, "short base58");
  assert.equal(isValidSvmAddress("0OIl"), false, "invalid base58 chars (0/O/I/l)");
  assert.equal(isValidSvmAddress(""), false);
  // resolvePayoutConfig throws on malformed overrides
  assert.throws(() => resolvePayoutConfig({ groups: { evm: { address: "0x123" } } }), /not a valid EVM address/);
  assert.throws(() => resolvePayoutConfig({ groups: { solana_x1: { address: "not-an-address" } } }), /not a valid SVM address/);
  assert.throws(() => resolvePayoutConfig({ groups: { bogus: { address: "0x123" } } }), /unknown payout group/);
});

test("payout config: resolvePayoutConfig rejects every malformed sweep override", () => {
  assert.throws(() => resolvePayoutConfig({ sweepFrequency: "monthly" }), /daily \| weekly/);
  assert.throws(() => resolvePayoutConfig({ sweepBasket: ["SOL", "DOGE"] }), /unknown basket member "DOGE"/);
  assert.throws(() => resolvePayoutConfig({ sweepBasket: ["SOL", "SOL"] }), /duplicate basket member/);
  // a chain can only be served by its own family's group (the family check
  // makes cross-family claims structurally impossible)
  assert.throws(() => resolvePayoutConfig({ groups: { evm: { chains: ["sol"] } } }), /not evm/);
  assert.throws(() => resolvePayoutConfig({ groups: { solana_x1: { chains: ["eth"] } } }), /not svm/);
  // an explicit chains override REPLACES the group's served chains (the
  // add-a-chain path — e.g. extending the EVM group to avax without a code change)
  const extended = resolvePayoutConfig({ groups: { evm: { chains: ["avax"] } } });
  assert.equal(extended.groups.evm.chains.length, 1);
  assert.equal(treasuryForChain(extended, "avax"), EVM_TREASURY, "avax is now served by the EVM treasury");
  assert.equal(treasuryForChain(extended, "eth"), null, "the replaced list no longer covers eth (override choice)");
});

test("payout config: env overrides flow through readPayoutEnv → resolvePayoutConfig (the load pattern)", () => {
  // empty env → no overrides → defaults
  assert.deepEqual(readPayoutEnv({}), {});
  assert.deepEqual(readPayoutEnv({ VITE_MEV_PAYOUT_EVM: "", MEV_SWEEP_FREQUENCY: "" }), {});
  // env names resolve (VITE_ first, NEXT_PUBLIC_ fallback — the flags.ts pattern)
  const SVM_OVERRIDE = "GjiCBHTxYMF7v1HSr6fEgSZanRJUoQ8QQon6trqU5eZT"; // a valid SVM address (the .sandbox x1 test-fleet address)
  const o = readPayoutEnv({
    VITE_MEV_PAYOUT_EVM: "0x1111111111111111111111111111111111111111",
    NEXT_PUBLIC_MEV_PAYOUT_SOLANA_X1: SVM_OVERRIDE,
    MEV_SWEEP_FREQUENCY: "weekly",
    MEV_SWEEP_BASKET: "USDC,SOL",
  });
  const cfg = resolvePayoutConfig(o);
  assert.equal(cfg.groups.evm.address, "0x1111111111111111111111111111111111111111");
  assert.equal(cfg.groups.solana_x1.address, SVM_OVERRIDE);
  assert.equal(cfg.sweep.frequency, "weekly");
  assert.deepEqual([...cfg.sweep.basket], ["USDC", "SOL"], "basket override keeps its order");
  // overridden groups keep their DEFAULT chains (the map stays complete)
  assert.deepEqual([...cfg.groups.evm.chains], ["eth", "bas", "bsc", "arb", "opt", "pol", "rbn"]);
  assert.equal(treasuryForChain(cfg, "sol"), SVM_OVERRIDE);
  assert.equal(treasuryForChain(cfg, "x1"), SVM_OVERRIDE);
});

test("payout config: BASKET_TARGETS sanity — every mapped canonical symbol resolves on its chain (tokenResolver ground truth)", () => {
  const resolverChains = Object.keys(CHAIN_META);
  for (const chain of resolverChains) {
    const table = BASKET_TARGETS[chain];
    if (!table) continue;
    for (const [member, canonical] of Object.entries(table)) {
      assert.ok(MEV_SWEEP_BASKET.includes(member), `${chain}: ${member} is a basket member`);
      const r = resolve(canonical, chain);
      assert.ok(r, `${chain}: canonical "${canonical}" for basket member ${member} RESOLVES via tokenResolver`);
      assert.equal(r.symbol, canonical, `${chain}: resolve returned the exact canonical row`);
    }
  }
  // every configured chain has a BASKET_TARGETS row (the planner can always
  // answer what the basket is there)
  for (const chain of Object.keys(DEFAULT_MEV_PAYOUT_CONFIG.payouts)) {
    assert.ok(BASKET_TARGETS[chain], `${chain} has a basket-targets row`);
  }
  // representability truth: sol/x1 full basket; EVM partial; rbn empty today
  assert.deepEqual(Object.keys(BASKET_TARGETS.sol).sort(), ["SOL", "USDC", "wBTC", "wETH"]);
  assert.deepEqual(Object.keys(BASKET_TARGETS.x1).sort(), ["SOL", "USDC", "wBTC", "wETH"]);
  assert.deepEqual(Object.keys(BASKET_TARGETS.eth).sort(), ["USDC", "wETH"]);
  assert.deepEqual(Object.keys(BASKET_TARGETS.rbn), [], "Robinhood Chain: no canonical basket member resolves today (canonical stable = Paxos USDG)");
});

test("payout config: the config is frozen (nobody mutates the treasury map at runtime)", () => {
  assert.ok(Object.isFrozen(DEFAULT_MEV_PAYOUT_CONFIG));
  assert.ok(Object.isFrozen(DEFAULT_MEV_PAYOUT_CONFIG.payouts));
  assert.ok(Object.isFrozen(DEFAULT_MEV_PAYOUT_CONFIG.groups.evm));
  assert.throws(() => {
    DEFAULT_MEV_PAYOUT_CONFIG.payouts.eth = "0xdead";
  }, TypeError);
  assert.ok(Object.isFrozen(MEV_PAYOUT_GROUPS_DEFAULT.evm.chains));
});
