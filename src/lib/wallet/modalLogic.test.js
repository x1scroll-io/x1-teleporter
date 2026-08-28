/**
 * Connect-modal data-logic tests (Step 2.2) — the binding modal rules from
 * docs/WALLET-REGISTRY.md, proven at the pure-data level:
 *   1. Fixed order (families + wallets).
 *   2. Starport pinned first in EVERY family, regardless of install state.
 *   3. Installed highlighted.
 *   4. Not-installed still shown, with an install link.
 *   5. Never hide a wallet — every registry entry always present.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { WALLET_FAMILIES } from "./families.js";
import {
  WALLET_REGISTRY,
  STARPORT_ID,
  buildFamilyRows,
  buildFamilyWalletRows,
  normalizeEvmDiscovered,
  normalizeSolanaDiscovered,
} from "./modalLogic.js";

/** Every family in the registry must have entries — the modal has no empty families. */
test("registry covers every family with the pinned Starport row + a reference wallet", () => {
  for (const family of WALLET_FAMILIES) {
    const entries = WALLET_REGISTRY[family];
    assert.ok(Array.isArray(entries) && entries.length > 0, `${family} has registry entries`);
    assert.equal(entries[0].id, STARPORT_ID, `${family} pins Starport first`);
    assert.equal(entries[0].pinned, true, `${family} Starport row is pinned`);
    assert.ok(
      entries.some((e) => e.reference === true),
      `${family} has a reference wallet (docs/WALLET-REGISTRY.md modal layout)`,
    );
  }
});

test("Starport is pinned first in every family regardless of install state", () => {
  for (const family of WALLET_FAMILIES) {
    // Case A: nothing installed.
    const emptyRows = buildFamilyWalletRows({ family, discovered: [] });
    assert.equal(emptyRows[0].id, STARPORT_ID, `${family}: Starport first when nothing installed`);
    assert.equal(emptyRows[0].pinned, true);

    // Case B: a non-Starport wallet is installed — Starport STILL first.
    const key = WALLET_REGISTRY[family].find((e) => e.id !== STARPORT_ID)?.id ?? "SomeWallet";
    const rows = buildFamilyWalletRows({ family, discovered: [{ key }] });
    assert.equal(rows[0].id, STARPORT_ID, `${family}: Starport first when others installed`);
    assert.equal(rows[0].pinned, true, `${family}: Starport stays pinned`);
  }
});

test("fixed order: Starport → reference wallet → alphabetical rest, installed highlighted in place", () => {
  // Installed: Rabby + MetaMask. The list does NOT reorder by install
  // state (docs/WALLET-REGISTRY.md: fixed-order list, not detected-first
  // sorting) — installed wallets are highlighted where they sit.
  const discovered = [{ key: "io.rabby" }, { key: "io.metamask" }];
  const rows = buildFamilyWalletRows({ family: "evm", discovered });
  const ids = rows.map((r) => r.id);

  assert.deepEqual(ids, [
    STARPORT_ID, "io.metamask", "com.coinbase.wallet", "app.phantom", "io.rabby",
  ]);
  assert.equal(rows[0].pinned, true, "Starport pinned first");
  assert.equal(rows[1].reference, true, "reference wallet second");

  const installedRows = rows.filter((r) => r.installed);
  assert.deepEqual(installedRows.map((r) => r.id), ["io.metamask", "io.rabby"], "installed highlighted in place");
  assert.ok(installedRows.every((r) => r.discovered !== null), "installed rows carry their discovered match");

  // The "rest" is alphabetical (Coinbase Wallet, Phantom, Rabby).
  const rest = rows.slice(2);
  assert.deepEqual(
    rest.map((r) => r.name),
    [...rest.map((r) => r.name)].sort((a, b) => a.localeCompare(b)),
    "rest sorted alphabetically by name",
  );
});

test("not-installed wallets are never hidden and carry an install link", () => {
  const rows = buildFamilyWalletRows({ family: "evm", discovered: [] });
  const notInstalled = rows.filter((r) => !r.installed);
  // Every registry entry present exactly once — nothing hidden.
  assert.deepEqual(
    rows.map((r) => r.id),
    WALLET_REGISTRY.evm.map((e) => e.id),
  );
  // Non-Starport not-installed rows all have install links.
  for (const row of notInstalled) {
    if (row.id === STARPORT_ID) continue; // Starport has no public install link yet
    assert.ok(typeof row.installUrl === "string" && row.installUrl.startsWith("https://"), `${row.id} has an install link`);
  }
});

test("Phantom is multi-chain: separate entries in EVM, Solana and Bitcoin (separate sessions)", () => {
  const evm = buildFamilyWalletRows({ family: "evm", discovered: [{ key: "app.phantom" }] });
  const solana = buildFamilyWalletRows({ family: "solana", discovered: [{ key: "Phantom" }] });
  const bitcoin = buildFamilyWalletRows({ family: "bitcoin", discovered: [{ key: "Phantom" }] });

  // One Phantom entry per family, never merged across families.
  assert.equal(evm.filter((r) => r.name === "Phantom").length, 1);
  assert.equal(solana.filter((r) => r.name === "Phantom").length, 1);
  assert.equal(bitcoin.filter((r) => r.name === "Phantom").length, 1);

  // Each appearance is independently installed per family.
  assert.equal(evm.find((r) => r.name === "Phantom").installed, true);
  assert.equal(solana.find((r) => r.name === "Phantom").installed, true);
  assert.equal(bitcoin.find((r) => r.name === "Phantom").installed, true);

  // And an EVM-announced Phantom does NOT mark the Solana/BTC entries installed.
  const evmOnly = buildFamilyWalletRows({ family: "solana", discovered: [{ key: "app.phantom" }] });
  assert.equal(evmOnly.find((r) => r.name === "Phantom").installed, false);
});

test("a discovered Starport wallet flips the pinned row to installed (still first)", () => {
  const rows = buildFamilyWalletRows({ family: "evm", discovered: [{ key: "Starport" }] });
  assert.equal(rows[0].id, STARPORT_ID);
  assert.equal(rows[0].pinned, true);
  assert.equal(rows[0].installed, true, "Starport highlighted when discovered");
});

test("Solana matching uses adapter names; EVM uses rdns", () => {
  const solanaRows = buildFamilyWalletRows({
    family: "solana",
    discovered: normalizeSolanaDiscovered([{ name: "Phantom", icon: "data:image/svg+xml;base64,AA==" }]),
  });
  assert.equal(solanaRows.find((r) => r.id === "Phantom").installed, true);

  const evmRows = buildFamilyWalletRows({
    family: "evm",
    discovered: normalizeEvmDiscovered([
      { uuid: "u1", name: "MetaMask", icon: "data:image/svg+xml;base64,AA==", rdns: "io.metamask", provider: {} },
    ]),
  });
  assert.equal(evmRows.find((r) => r.id === "io.metamask").installed, true);
});

test("families render in fixed WALLET_FAMILIES order with labels", () => {
  const rows = buildFamilyRows();
  assert.deepEqual(rows.map((r) => r.family), WALLET_FAMILIES);
  assert.ok(rows.every((r) => typeof r.label === "string" && r.label.length > 0));
});

test("unknown family degrades to an empty row list (never throws)", () => {
  assert.deepEqual(buildFamilyWalletRows({ family: "monero", discovered: [] }), []);
});

test("announced providers outside the registry still get their own entry (never hidden)", () => {
  const rows = buildFamilyWalletRows({
    family: "evm",
    discovered: [{ key: "com.xyz.wallet", name: "XYZ Wallet" }, { key: "io.metamask" }],
  });
  const ids = rows.map((r) => r.id);
  // Fixed list first (starport, reference, alphabetical rest), then the
  // unregistered announced provider appended, installed.
  assert.deepEqual(ids, [
    STARPORT_ID, "io.metamask", "com.coinbase.wallet", "app.phantom", "io.rabby", "com.xyz.wallet",
  ]);
  const extra = rows.find((r) => r.id === "com.xyz.wallet");
  assert.equal(extra.installed, true);
  assert.equal(extra.name, "XYZ Wallet");
  assert.equal(extra.pinned, false);
});

test("wagmi's generic injected fallback connector is not a wallet entry", () => {
  const normalized = normalizeEvmDiscovered([
    { uuid: "u1", name: "MetaMask", rdns: "io.metamask", provider: {} },
    { uuid: "u2", name: "Injected", rdns: "injected", provider: {} },
  ]);
  assert.deepEqual(
    normalized.map((n) => n.key),
    ["io.metamask"],
    "the injected fallback is filtered out, announced providers kept",
  );
});
