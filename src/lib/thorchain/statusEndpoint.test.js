/**
 * statusEndpoint.test.js — THORChain tx-status response parsing (Step 3.1).
 *
 * The wire shape is verified against the documented THORNode contract with
 * DEFENSIVE parsing: every known response variant (top-level `status` string,
 * stage-object flags, the `stages` map, and the newer `observed_tx` key) must
 * map onto the canonical stage vocabulary observed → swapping →
 * outbound_signed → done. The default host is the LIVE Liquify gateway
 * (gateway.liquify.com/chain/thorchain_api — probed 2026-09-02); the older
 * hosts (liquify.thorchain.org / thornode.thorchain.info / *.ninerealms.com)
 * are retired or DNS-dead.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTxStatusResponse,
  normaliseStage,
  statusUrl,
  THORCHAIN_STAGES,
  THORCHAIN_STATUS_BASE_URL,
} from "./statusEndpoint.js";

test("canonical stage vocabulary is observed → swapping → outbound_signed → done", () => {
  assert.deepEqual([...THORCHAIN_STAGES], ["observed", "swapping", "outbound_signed", "done"]);
});

test("statusUrl builds the brief's endpoint shape: {base}/thorchain/tx/status/{txid}", () => {
  assert.equal(
    statusUrl("https://gateway.liquify.com/chain/thorchain_api", "abc123"),
    "https://gateway.liquify.com/chain/thorchain_api/thorchain/tx/status/abc123",
  );
  assert.equal(
    statusUrl("https://gateway.liquify.com/chain/thorchain_api/", "abc123"),
    "https://gateway.liquify.com/chain/thorchain_api/thorchain/tx/status/abc123",
    "trailing slash trimmed",
  );
  assert.equal(
    statusUrl(undefined, "abc 123"),
    `${THORCHAIN_STATUS_BASE_URL}/thorchain/tx/status/abc%20123`,
    "txid is URL-encoded",
  );
});

test("default status base is the LIVE Liquify gateway (retired hosts gone from src)", () => {
  assert.equal(
    THORCHAIN_STATUS_BASE_URL,
    "https://gateway.liquify.com/chain/thorchain_api",
  );
  assert.ok(!THORCHAIN_STATUS_BASE_URL.includes("liquify.thorchain.org"), "DNS-dead host retired");
  assert.ok(!THORCHAIN_STATUS_BASE_URL.includes("ninerealms.com"), "ninerealms mirrors retired");
  assert.equal(
    statusUrl(undefined, "abc123"),
    "https://gateway.liquify.com/chain/thorchain_api/thorchain/tx/status/abc123",
    "default resolves to the live-gateway status URL",
  );
});

test("normaliseStage maps raw stage strings onto the canonical vocabulary", () => {
  assert.equal(normaliseStage("observed"), "observed");
  assert.equal(normaliseStage("swapping"), "swapping");
  assert.equal(normaliseStage("outbound_signed"), "outbound_signed");
  assert.equal(normaliseStage("done"), "done");
  // The inbound_confirmed intermediate maps to observed (swap not started yet).
  assert.equal(normaliseStage("inbound_confirmed"), "observed");
  assert.equal(normaliseStage("inbound_observed"), "observed");
  assert.equal(normaliseStage("DONE"), "done", "case-insensitive");
  assert.equal(normaliseStage("garbage"), null);
  assert.equal(normaliseStage(undefined), null);
});

test("parses the top-level status-string variant (newer THORNode)", () => {
  const r = parseTxStatusResponse({ status: "swapping", tx_id: "abc" });
  assert.equal(r.ok, true);
  assert.equal(r.stage, "swapping");
  assert.equal(r.halted, false);
});

test("parses the stage-object variant — highest finalised stage wins", () => {
  const r = parseTxStatusResponse({
    observed: { success: true, finalised: true },
    swapping: { success: false, finalised: false },
    outbound_signed: { success: false, finalised: false },
    done: { success: false, finalised: false },
  });
  assert.equal(r.ok, true);
  assert.equal(r.stage, "observed");

  const r2 = parseTxStatusResponse({
    observed: { success: true, finalised: true },
    swapping: { success: true, finalised: true },
    outbound_signed: { finalised: false },
    done: { finalised: false },
  });
  assert.equal(r2.stage, "swapping");

  const r3 = parseTxStatusResponse({
    observed: { finalised: true },
    swapping: { finalised: true },
    outbound_signed: { finalised: true },
    done: { finalised: false },
  });
  assert.equal(r3.stage, "outbound_signed");

  const r4 = parseTxStatusResponse({
    observed: { finalised: true },
    swapping: { finalised: true },
    outbound_signed: { finalised: true },
    done: { success: true, finalised: true },
  });
  assert.equal(r4.stage, "done");
});

test("accepts the newer observed_tx stage key and maps it to observed", () => {
  const r = parseTxStatusResponse({
    observed_tx: { finalised: true },
    swapping: { finalised: false },
  });
  assert.equal(r.ok, true);
  assert.equal(r.stage, "observed");
});

test("parses the stages-map variant (per-stage finalised flags)", () => {
  const r = parseTxStatusResponse({
    stages: {
      inbound_observed: { start_time: "2026-08-28T00:00:00Z", finalised: true },
      swapping: { finalised: true },
      outbound_signed: { finalised: true },
      outbound_done: { finalised: false },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.stage, "outbound_signed");
});

test("observed-but-unfinalised responses default to the observed stage", () => {
  const r = parseTxStatusResponse({ observed: {}, tx_id: "abc", chain: "BTC" });
  assert.equal(r.ok, true);
  assert.equal(r.stage, "observed");
});

test("surfaces the halted/paused flag without losing the stage", () => {
  const r = parseTxStatusResponse({ status: "observed", halted: true });
  assert.equal(r.ok, true);
  assert.equal(r.stage, "observed");
  assert.equal(r.halted, true);

  const r2 = parseTxStatusResponse({ status: "swapping", paused: true });
  assert.equal(r2.halted, true);
});

test("not-found: HTTP 404 and body-level not-found errors both report not-found", () => {
  const http = parseTxStatusResponse({}, { status: 404 });
  assert.equal(http.ok, false);
  assert.equal(http.reason, "not-found");

  const body = parseTxStatusResponse({ error: "tx hash abc not found" });
  assert.equal(body.ok, false);
  assert.equal(body.reason, "not-found");
});

test("generic error bodies report error (poller keeps polling within max)", () => {
  const r = parseTxStatusResponse({ error: "internal server error" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "error");
  assert.equal(r.message, "internal server error");
});

test("malformed bodies (null / arrays / non-objects) report malformed", () => {
  for (const bad of [null, undefined, [], "hello", 42]) {
    const r = parseTxStatusResponse(bad);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "malformed");
  }
});
