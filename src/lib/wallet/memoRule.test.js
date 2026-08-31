/**
 * Memo-rule tests (Step 2.4) — the THORChain-lane memo constraint as pure
 * logic (docs/WALLET-REGISTRY.md Litecoin/Dogecoin/XRP sections): a wallet
 * that cannot attach the THORChain memo (OP_RETURN for LTC/DOGE, XRPL
 * Memos for XRP) shows its balance and hands sends off to the
 * deposit-address row. Fail-closed: missing memoSupport → "none".
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMO_RULE_FAMILIES,
  canSendInApp,
  depositMemoNote,
  depositRowSubtitle,
  isMemoRuleFamily,
  memoCapability,
  memoHandoffNote,
} from "./memoRule.js";

test("the memo rule governs exactly litecoin, dogecoin and xrp", () => {
  assert.deepEqual(MEMO_RULE_FAMILIES, ["litecoin", "dogecoin", "xrp"]);
  assert.equal(isMemoRuleFamily("litecoin"), true);
  assert.equal(isMemoRuleFamily("dogecoin"), true);
  assert.equal(isMemoRuleFamily("xrp"), true);
  assert.equal(isMemoRuleFamily("bitcoin"), false);
  assert.equal(isMemoRuleFamily("tron"), false);
  assert.equal(isMemoRuleFamily("evm"), false);
});

test("memoCapability defaults to 'none' — fail closed, never assume memo support", () => {
  assert.equal(memoCapability({ memoSupport: "op_return" }), "op_return");
  assert.equal(memoCapability({ memoSupport: "memos" }), "memos");
  assert.equal(memoCapability({ memoSupport: "verify" }), "verify");
  assert.equal(memoCapability({}), "none");
  assert.equal(memoCapability(null), "none");
});

test("canSendInApp: only documented memo paths ('op_return', 'memos')", () => {
  assert.equal(canSendInApp({ memoSupport: "op_return" }), true, "Ctrl on LTC/DOGE");
  assert.equal(canSendInApp({ memoSupport: "memos" }), true, "Xaman + the XRP deposit row");
  assert.equal(canSendInApp({ memoSupport: "verify" }), false, "⚠️ rows cannot send in-app yet");
  assert.equal(canSendInApp({ memoSupport: "none" }), false);
  assert.equal(canSendInApp({}), false);
});

test("hand-off notes: verify vs none, per chain (OP_RETURN vs XRPL Memos)", () => {
  assert.equal(
    memoHandoffNote("litecoin", { memoSupport: "verify" }),
    "⚠️ OP_RETURN memo unverified — balance shown; sends hand off to the deposit-address row.",
  );
  assert.equal(
    memoHandoffNote("dogecoin", { memoSupport: "none" }),
    "No OP_RETURN memo support — balance only; use the deposit-address row to send.",
  );
  assert.equal(
    memoHandoffNote("xrp", { memoSupport: "verify" }),
    "⚠️ XRPL Memos support unverified — balance shown; sends hand off to the deposit-address row.",
  );
  assert.equal(
    memoHandoffNote("xrp", { memoSupport: "none" }),
    "No XRPL Memos support — balance only; use the deposit-address row to send.",
  );
});

test("no note for wallets that can send in-app, deposit rows, or non-memo families", () => {
  assert.equal(memoHandoffNote("litecoin", { memoSupport: "op_return" }), null);
  assert.equal(memoHandoffNote("xrp", { memoSupport: "memos" }), null);
  assert.equal(memoHandoffNote("xrp", { memoSupport: "verify", depositAddress: true }), null, "the deposit row is the hand-off target itself");
  assert.equal(memoHandoffNote("tron", { memoSupport: "verify" }), null, "Tron has no memo rule");
  assert.equal(memoHandoffNote("bitcoin", { memoSupport: "verify" }), null, "Bitcoin's memo handling is the Step 2.3 deposit row");
});

test("deposit row subtitle is family-aware (the Sparrow/Electrum line is BTC-only)", () => {
  assert.equal(depositRowSubtitle("litecoin"), "Send from any Litecoin wallet — no extension needed");
  assert.equal(depositRowSubtitle("dogecoin"), "Send from any Dogecoin wallet — no extension needed");
  assert.equal(depositRowSubtitle("xrp"), "Send from any XRP wallet or exchange — no extension needed");
  assert.match(depositRowSubtitle("bitcoin"), /Sparrow, Electrum/);
});

test("deposit memo TODO documents the per-chain memo transport rule", () => {
  assert.match(depositMemoNote("litecoin"), /OP_RETURN/);
  assert.match(depositMemoNote("dogecoin"), /OP_RETURN/);
  assert.match(depositMemoNote("xrp"), /XRPL Memos field, NOT a destination tag/);
  assert.match(depositMemoNote("bitcoin"), /Step 3.3/);
  assert.doesNotMatch(depositMemoNote("xrp"), /destination tag.*destination tag/);
});
