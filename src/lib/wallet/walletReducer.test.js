/**
 * Isolation tests for the WalletContext state layer (Step 2.1).
 *
 * Runs under node:test against the PURE state module (walletReducer.js) — no
 * DOM, no React. These are the guarantees the runbook demands:
 *   (a) connecting evm never touches solana state,
 *   (b) disconnecting one family leaves the others connected,
 *   (c) every family starts disconnected,
 *   (d) connecting the same family twice is idempotent,
 *   (e) an error in one family never affects the others.
 *
 * The React-level equivalents (hook + context wiring) live in
 * WalletContext.test.jsx.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInitialState,
  initialFamilyState,
  walletReducer,
  canConnect,
  CONNECTED,
  CONNECTING,
  DISCONNECTED,
  ERROR,
} from "./walletReducer.js";
import { WALLET_FAMILIES } from "./families.js";

const EVM_ADDR = "mock:evm:0x1234567890abcdef1234567890abcdef12345678";

/** Drive one family through CONNECT_START + CONNECT_SUCCESS. */
function connectFamily(state, family, address = `mock:${family}:addr`) {
  let next = walletReducer(state, { type: "CONNECT_START", family });
  next = walletReducer(next, {
    type: "CONNECT_SUCCESS",
    family,
    address,
    provider: { id: `mock:${family}` },
  });
  return next;
}

test("(c) every family starts disconnected", () => {
  const state = createInitialState();
  assert.deepEqual(
    Object.keys(state).sort(),
    [...WALLET_FAMILIES].sort(),
    "state has exactly the seven registered families",
  );
  for (const family of WALLET_FAMILIES) {
    assert.deepEqual(state[family], { status: DISCONNECTED }, `${family} starts disconnected`);
    assert.equal(state[family].address, undefined);
    assert.equal(state[family].provider, undefined);
    assert.equal(state[family].error, undefined);
  }
});

test("(a) connecting evm never touches solana or any other family", () => {
  const state = connectFamily(createInitialState(), "evm", EVM_ADDR);
  assert.equal(state.evm.status, CONNECTED);
  assert.equal(state.evm.address, EVM_ADDR);
  assert.equal(state.evm.provider.id, "mock:evm");
  for (const family of WALLET_FAMILIES) {
    if (family === "evm") continue;
    assert.deepEqual(state[family], { status: DISCONNECTED }, `${family} must stay untouched`);
  }
});

test("(b) disconnecting one family leaves the others connected", () => {
  let state = createInitialState();
  state = connectFamily(state, "evm", EVM_ADDR);
  state = connectFamily(state, "solana");
  state = walletReducer(state, { type: "DISCONNECT", family: "evm" });

  assert.deepEqual(state.evm, { status: DISCONNECTED }, "evm fully reset");
  assert.equal(state.solana.status, CONNECTED, "solana still connected");
  assert.equal(state.solana.address, "mock:solana:addr", "solana session intact");
  assert.equal(state.solana.provider.id, "mock:solana");
});

test("(d) connecting the same family twice is idempotent", () => {
  let state = createInitialState();
  state = connectFamily(state, "evm", EVM_ADDR);
  const before = state;

  // A second CONNECT_START on a connected family is a reducer no-op (same ref).
  const afterStart = walletReducer(state, { type: "CONNECT_START", family: "evm" });
  assert.equal(afterStart, before);
  assert.equal(state.evm.status, CONNECTED);
  assert.equal(state.evm.address, EVM_ADDR);

  // And the action-level guard refuses it outright.
  assert.equal(canConnect(state, "evm"), false);
});

test("(d2) canConnect: refuses while connecting, allows retry after error", () => {
  let state = createInitialState();
  assert.equal(canConnect(state, "evm"), true, "disconnected → connectable");

  state = walletReducer(state, { type: "CONNECT_START", family: "evm" });
  assert.equal(state.evm.status, CONNECTING);
  assert.equal(canConnect(state, "evm"), false, "connecting → refused");

  state = walletReducer(state, { type: "CONNECT_ERROR", family: "evm", error: "boom" });
  assert.equal(state.evm.status, ERROR);
  assert.equal(canConnect(state, "evm"), true, "error → retry allowed");
});

test("(e) an error in one family never affects the others", () => {
  let state = createInitialState();
  state = connectFamily(state, "solana");
  state = walletReducer(state, { type: "CONNECT_ERROR", family: "evm", error: "user rejected" });

  assert.equal(state.evm.status, ERROR);
  assert.equal(state.evm.error, "user rejected");
  assert.equal(state.evm.address, undefined, "failed session carries no address");
  assert.equal(state.evm.provider, undefined, "failed session carries no provider");

  assert.equal(state.solana.status, CONNECTED, "solana unaffected by evm error");
  assert.equal(state.solana.address, "mock:solana:addr");
  for (const family of ["bitcoin", "litecoin", "dogecoin", "xrp", "tron"]) {
    assert.deepEqual(state[family], { status: DISCONNECTED }, `${family} still pristine`);
  }
});

test("DISCONNECT fully resets a session (address/provider/error cleared)", () => {
  let state = createInitialState();
  state = walletReducer(state, { type: "CONNECT_START", family: "tron" });
  state = walletReducer(state, { type: "CONNECT_ERROR", family: "tron", error: "nope" });
  state = walletReducer(state, { type: "DISCONNECT", family: "tron" });
  assert.deepEqual(state.tron, initialFamilyState());
});

test("unknown families are ignored defensively", () => {
  const state = createInitialState();
  assert.equal(walletReducer(state, { type: "CONNECT_START", family: "monero" }), state);
  assert.equal(walletReducer(state, { type: "CONNECT_SUCCESS", family: "monero", address: "x" }), state);
  assert.equal(walletReducer(state, { type: "CONNECT_ERROR", family: "monero", error: "x" }), state);
  assert.equal(walletReducer(state, { type: "DISCONNECT", family: "monero" }), state);
  assert.equal(canConnect(state, "monero"), false);
});

test("CONNECT_SUCCESS carries the optional balance (Bitcoin payment-address balance, Step 2.3)", () => {
  let state = createInitialState();
  state = walletReducer(state, { type: "CONNECT_START", family: "bitcoin" });
  state = walletReducer(state, {
    type: "CONNECT_SUCCESS",
    family: "bitcoin",
    address: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
    provider: {},
    balance: 400_000,
  });
  assert.equal(state.bitcoin.status, CONNECTED);
  assert.equal(state.bitcoin.balance, 400_000);

  // Families without a balance keep their shape-stable sessions (no
  // balance key introduced).
  state = walletReducer(state, { type: "CONNECT_START", family: "evm" });
  state = walletReducer(state, {
    type: "CONNECT_SUCCESS",
    family: "evm",
    address: "0xabc",
    provider: {},
  });
  assert.equal(state.evm.balance, undefined);
  assert.deepEqual(Object.keys(state.evm), ["status", "address", "provider", "error"]);

  // DISCONNECT clears the balance with the session.
  state = walletReducer(state, { type: "DISCONNECT", family: "bitcoin" });
  assert.deepEqual(state.bitcoin, initialFamilyState());
});
