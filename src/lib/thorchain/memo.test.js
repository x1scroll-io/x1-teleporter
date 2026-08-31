/**
 * memo.test.js — THORChain deposit-memo construction (Step 3.2).
 *
 * Proves the EXACT THORChain memo format (verified against THORNode
 * `x/thorchain/memo/memo_swap.go` `SwapMemo.String()` and swap.thorchain's
 * `src/lib/memo-helpers.ts`):
 *   `=:SOL.SOL:<destAddress>[/<refundAddress>][:<limit>][:<affiliate>:<bps>]`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDepositMemo,
  parseDepositMemo,
  THORCHAIN_SOURCE_ASSETS,
  THORCHAIN_DESTINATION_ASSET,
  SWAP_OPCODE,
  isUsableMemoAddress,
} from "./memo.js";

const SOL_DEST = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const BTC_REFUND = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";

test("THORChain source assets are exactly the four allowed sources", () => {
  assert.deepEqual(THORCHAIN_SOURCE_ASSETS, {
    BTC: "BTC.BTC",
    DOGE: "DOGE.DOGE",
    LTC: "LTC.LTC",
    XRP: "XRP.XRP",
  });
});

test("buildDepositMemo: minimal memo is the exact 3-part THORChain swap form", () => {
  const memo = buildDepositMemo({ sourceChain: "BTC", destAddress: SOL_DEST });
  assert.equal(memo, `=:SOL.SOL:${SOL_DEST}`);
  const parts = memo.split(":");
  assert.equal(parts.length, 3, "no limit + no affiliate → 3 parts (THORNode `last = 3`)");
  assert.equal(parts[0], SWAP_OPCODE, "swap opcode is `=` (short form of SWAP:)");
  assert.equal(parts[1], THORCHAIN_DESTINATION_ASSET, "destination pinned to SOL.SOL");
  assert.equal(parts[2], SOL_DEST);
});

test("buildDepositMemo: refund address is appended to the destination with a '/' (THORNode destString)", () => {
  const memo = buildDepositMemo({ sourceChain: "BTC", destAddress: SOL_DEST, refundAddress: BTC_REFUND });
  assert.equal(memo, `=:SOL.SOL:${SOL_DEST}/${BTC_REFUND}`);
  const parsed = parseDepositMemo(memo);
  assert.equal(parsed.destination, SOL_DEST);
  assert.equal(parsed.refundAddress, BTC_REFUND);
});

test("buildDepositMemo: works for all four source chains (the memo format is chain-agnostic)", () => {
  for (const [chain] of Object.entries(THORCHAIN_SOURCE_ASSETS)) {
    const memo = buildDepositMemo({ sourceChain: chain, destAddress: SOL_DEST, refundAddress: "RefundAddr1" });
    assert.equal(memo, `=:SOL.SOL:${SOL_DEST}/RefundAddr1`, chain);
    assert.equal(parseDepositMemo(memo).refundAddress, "RefundAddr1", chain);
  }
});

test("buildDepositMemo: optional limit appends the 4th part (THORNode `last = 4`)", () => {
  const memo = buildDepositMemo({ sourceChain: "BTC", destAddress: SOL_DEST, refundAddress: BTC_REFUND, limit: 5000000 });
  assert.equal(memo, `=:SOL.SOL:${SOL_DEST}/${BTC_REFUND}:5000000`);
  assert.equal(parseDepositMemo(memo).limit, "5000000");
  // A zero/empty limit must NOT append a part — THORNode keeps 3 parts.
  assert.equal(
    buildDepositMemo({ sourceChain: "BTC", destAddress: SOL_DEST, limit: 0 }),
    `=:SOL.SOL:${SOL_DEST}`,
  );
});

test("buildDepositMemo: affiliate + bps append the 6-part form (THORNode `last = 6`)", () => {
  const memo = buildDepositMemo({
    sourceChain: "DOGE",
    destAddress: SOL_DEST,
    affiliate: "teleporter",
    affiliateBps: 100,
  });
  assert.equal(memo, `=:SOL.SOL:${SOL_DEST}:teleporter:100`);
  const parsed = parseDepositMemo(memo);
  assert.equal(parsed.affiliate, "teleporter");
  assert.equal(parsed.affiliateBps, "100");
});

test("buildDepositMemo: affiliate requires bps and vice versa (fail closed)", () => {
  assert.throws(
    () => buildDepositMemo({ sourceChain: "BTC", destAddress: SOL_DEST, affiliate: "teleporter" }),
    /together/,
  );
  assert.throws(
    () => buildDepositMemo({ sourceChain: "BTC", destAddress: SOL_DEST, affiliateBps: 100 }),
    /together/,
  );
});

test("buildDepositMemo: unknown source chain is rejected", () => {
  assert.throws(
    () => buildDepositMemo({ sourceChain: "ETH", destAddress: SOL_DEST }),
    /unknown sourceChain "ETH"/,
  );
});

test("buildDepositMemo: missing/unusable destination is rejected", () => {
  assert.throws(() => buildDepositMemo({ sourceChain: "BTC", destAddress: "" }), /destAddress is required/);
  assert.throws(() => buildDepositMemo({ sourceChain: "BTC", destAddress: "has space" }), /destAddress is required/);
  assert.throws(() => buildDepositMemo({ sourceChain: "BTC", destAddress: "has:colon" }), /destAddress is required/);
});

test("buildDepositMemo: a refund address that would corrupt the memo is rejected", () => {
  assert.throws(
    () => buildDepositMemo({ sourceChain: "BTC", destAddress: SOL_DEST, refundAddress: "a/b" }),
    /refundAddress is unusable/,
  );
  assert.throws(
    () => buildDepositMemo({ sourceChain: "BTC", destAddress: SOL_DEST, refundAddress: "a:b" }),
    /refundAddress is unusable/,
  );
});

test("buildDepositMemo: empty-string refundAddress is treated as absent (THORNode refunds to sender)", () => {
  const memo = buildDepositMemo({ sourceChain: "BTC", destAddress: SOL_DEST, refundAddress: "  " });
  assert.equal(memo, `=:SOL.SOL:${SOL_DEST}`);
  assert.equal(parseDepositMemo(memo).refundAddress, null);
});

test("parseDepositMemo round-trips the exact scheme", () => {
  const memo = buildDepositMemo({
    sourceChain: "XRP",
    destAddress: SOL_DEST,
    refundAddress: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    limit: 12345678,
    affiliate: "teleporter",
    affiliateBps: 100,
  });
  assert.equal(memo, `=:SOL.SOL:${SOL_DEST}/rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh:12345678:teleporter:100`);
  const parsed = parseDepositMemo(memo);
  assert.deepEqual(parsed, {
    opcode: "=",
    asset: "SOL.SOL",
    destination: SOL_DEST,
    refundAddress: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
    limit: "12345678",
    affiliate: "teleporter",
    affiliateBps: "100",
  });
});

test("isUsableMemoAddress: sane address-segment guard", () => {
  assert.equal(isUsableMemoAddress(SOL_DEST), true);
  assert.equal(isUsableMemoAddress(""), false);
  assert.equal(isUsableMemoAddress("   "), false);
  assert.equal(isUsableMemoAddress("a b"), false);
  assert.equal(isUsableMemoAddress("a:b"), false);
  assert.equal(isUsableMemoAddress("a/b"), false);
  assert.equal(isUsableMemoAddress(null), false);
  assert.equal(isUsableMemoAddress(123), false);
});
