/**
 * journeyReadout.dom.test.jsx — the JOURNEY READOUT panel at the DOM level.
 *
 * Proves the sci-fi itinerary renders from the real model:
 *   - a built route renders the correct hop SEQUENCE (the engine leg ids +
 *     tools, in engine order) with the coordinate stations;
 *   - a leg the liquidity gate blocks renders the BLOCKED badge + the gate's
 *     reason;
 *   - the readout live-rebuilds when the selection changes;
 *   - the panel is wired into the swap card (TeleportForm renders it).
 *
 * HARNESS NOTE: ./thorchain/jsdomSetup.js MUST stay the FIRST import (DOM
 * globals before react/react-dom evaluate — see that file).
 */
import { dom } from "./thorchain/jsdomSetup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import JourneyReadout from "../components/JourneyReadout.jsx";
import TeleportForm from "../components/TeleportForm.jsx";
import { checkRouteLiquidity } from "./liquidityGate.js";

const FEE_LINES = [
  { id: "warp-skim", label: "Teleporter fee (0.5%, max $250)", amountUsd: 0.5 },
  { id: "warp-flat", label: "Warp bridge fee ($1 flat)", amountUsd: 1 },
];
const QUOTE = { feeLines: FEE_LINES };

function render(el) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(el));
  return {
    container,
    rerender(next) { act(() => root.render(next)); },
    unmount() { act(() => root.unmount()); container.remove(); },
  };
}

const hopLegs = (container) =>
  [...container.querySelectorAll('[data-testid="journey-hop"]')].map((h) => h.getAttribute("data-hop-leg"));
const hopTools = (container) =>
  [...container.querySelectorAll('[data-testid="journey-hop"]')].map((h) => h.getAttribute("data-hop-tool"));

test("a built forward route renders the correct hop sequence + coordinate stations", () => {
  const r = render(
    <JourneyReadout direction="forward" from="eth" token="USDC" destToken="USDC.x" amount="100" quote={QUOTE} />,
  );
  try {
    assert.ok(r.container.querySelector('[data-testid="journey-readout"]'), "the readout panel renders");
    assert.deepEqual(hopLegs(r.container), ["lifi-evm-bridge", "warp-lock"], "the engine's travel legs, in order");
    assert.deepEqual(hopTools(r.container), ["LiFi", "Warp Bridge"]);
    const src = r.container.querySelector('[data-testid="journey-coords-source"]');
    const dst = r.container.querySelector('[data-testid="journey-coords-dest"]');
    assert.ok(src.textContent.includes("Ethereum") && src.textContent.includes("USDC"), `source coords, got: ${src.textContent}`);
    assert.ok(dst.textContent.includes("X1") && dst.textContent.includes("USDC.X"), `dest coords, got: ${dst.textContent}`);
    // The Warp hop pins the 0.5% skim + Warp fee.
    const fees = [...r.container.querySelectorAll('[data-testid="journey-fee"]')].map((f) => f.getAttribute("data-fee-id"));
    assert.ok(fees.includes("warp-skim") && fees.includes("warp-flat"), `fee badges on the leg, got: ${fees}`);
    assert.equal(r.container.querySelector('[data-testid="journey-status"]').textContent, "ROUTE LOCKED");
  } finally {
    r.unmount();
  }
});

test("a blocked leg renders BLOCKED with the gate's reason", () => {
  const liquidity = checkRouteLiquidity({ from: "sonic", to: "x1", srcToken: "USDT", dstToken: "USDC.x" });
  const r = render(
    <JourneyReadout direction="forward" from="sonic" token="USDT" destToken="USDC.x" amount="100" quote={QUOTE} liquidity={liquidity} />,
  );
  try {
    const blocked = r.container.querySelector('[data-testid="journey-hop-blocked"]');
    assert.ok(blocked, "the blocked hop carries the BLOCKED badge");
    assert.equal(blocked.closest('[data-testid="journey-hop"]').getAttribute("data-hop-leg"), "lifi-evm-bridge");
    const reason = r.container.querySelector('[data-testid="journey-hop-blocked-reason"]');
    assert.ok(reason && /insufficient liquidity/i.test(reason.textContent), `gate reason, got: ${reason?.textContent}`);
    assert.equal(r.container.querySelector('[data-testid="journey-status"]').textContent, "LEG BLOCKED");
    assert.equal(r.container.querySelector('[data-testid="journey-coords-source"]').getAttribute("data-blocked"), "true");
  } finally {
    r.unmount();
  }
});

test("live update: changing the token rebuilds the itinerary (bridge → swap)", () => {
  const r = render(
    <JourneyReadout direction="forward" from="eth" token="USDC" destToken="USDC.x" amount="100" quote={QUOTE} />,
  );
  try {
    assert.equal(r.container.querySelector('[data-testid="journey-hop"]').getAttribute("data-hop-kind"), "bridge");
    r.rerender(
      <JourneyReadout direction="forward" from="eth" token="DAI" destToken="USDC.x" amount="100" quote={QUOTE} />,
    );
    assert.equal(r.container.querySelector('[data-testid="journey-hop"]').getAttribute("data-hop-kind"), "swap", "rebuilt as a swap hop");
    assert.ok(r.container.querySelector('[data-testid="journey-hop"]').textContent.includes("DAI"));
  } finally {
    r.unmount();
  }
});

test("reverse route renders burn → release → LiFi with X1 source coordinates", () => {
  const r = render(
    <JourneyReadout direction="reverse" to="eth" token="USDC" reverseToken="USDC.x" amount="100" quote={QUOTE} />,
  );
  try {
    assert.deepEqual(hopLegs(r.container), ["x1-reverse-burn", "warp-release-wait", "lifi-solana-out"]);
    assert.ok(r.container.querySelector('[data-testid="journey-coords-source"]').textContent.includes("X1"));
    assert.ok(r.container.querySelector('[data-testid="journey-coords-dest"]').textContent.includes("Ethereum"));
  } finally {
    r.unmount();
  }
});

test("the swap card (TeleportForm) mounts the journey readout beside the form", () => {
  const noop = { priceFetcher: async () => null, evmBalanceFetcher: async () => null, solBalanceFetcher: async () => null, x1BalanceFetcher: async () => null };
  const r = render(
    <TeleportForm
      evmSession={{ status: "connected", address: "0x4634e8e0b1c2d3f4a5b6c7d8e9f0a1b2c3d4e5f6" }}
      solSession={{ status: "connected", address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" }}
      balancesDeps={noop}
    />,
  );
  try {
    assert.ok(r.container.querySelector('[data-testid="teleport-form"]'), "the swap card renders");
    const readout = r.container.querySelector('[data-testid="journey-readout"]');
    assert.ok(readout, "the journey readout renders inside the swap card");
    assert.deepEqual(hopLegs(readout), ["lifi-evm-bridge", "warp-lock"], "forward itinerary by default");
  } finally {
    r.unmount();
  }
});
