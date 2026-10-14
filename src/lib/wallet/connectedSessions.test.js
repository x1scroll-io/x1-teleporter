/**
 * connectedSessions.test.js — the React-free registry must keep ONE session
 * per family, independent and collision-free (multi-wallet routes need an EVM
 * wallet AND a Solana wallet connected at once).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearAllConnectedSessions,
  clearConnectedSession,
  getConnectedSession,
  getConnectedSessions,
  setConnectedSession,
} from "./connectedSessions.js";

test("publishing one family's session never clobbers another's", () => {
  clearAllConnectedSessions();
  try {
    const evm = { status: "connected", address: "0xEVM", provider: { id: "evm" } };
    const sol = { status: "connected", address: "SOL", provider: { id: "sol" } };
    const btc = { status: "connected", address: "BTC", provider: { id: "btc" } };
    setConnectedSession("evm", evm);
    setConnectedSession("solana", sol);
    setConnectedSession("bitcoin", btc);

    assert.equal(getConnectedSession("evm"), evm, "evm session intact");
    assert.equal(getConnectedSession("solana"), sol, "solana session intact");
    assert.equal(getConnectedSession("bitcoin"), btc, "bitcoin session intact");
    assert.equal(getConnectedSessions().size, 3);
  } finally {
    clearAllConnectedSessions();
  }
});

test("clearing one family leaves the others connected", () => {
  clearAllConnectedSessions();
  try {
    const evm = { status: "connected", address: "0xEVM" };
    const sol = { status: "connected", address: "SOL" };
    setConnectedSession("evm", evm);
    setConnectedSession("solana", sol);

    clearConnectedSession("evm");
    assert.equal(getConnectedSession("evm"), null, "evm cleared");
    assert.equal(getConnectedSession("solana"), sol, "solana untouched by the evm disconnect");
  } finally {
    clearAllConnectedSessions();
  }
});

test("publishing a null/falsy session clears that family (no stale signer)", () => {
  clearAllConnectedSessions();
  try {
    setConnectedSession("solana", { status: "connected" });
    setConnectedSession("solana", null);
    assert.equal(getConnectedSession("solana"), null);
    assert.equal(getConnectedSession("evm"), null, "an unknown family never has a session");
  } finally {
    clearAllConnectedSessions();
  }
});
