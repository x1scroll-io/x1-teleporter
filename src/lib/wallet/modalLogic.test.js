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
  normalizeBitcoinDiscovered,
  normalizeLitecoinDiscovered,
  normalizeDogecoinDiscovered,
  normalizeXrpDiscovered,
  normalizeTronDiscovered,
} from "./modalLogic.js";
import {
  BITCOIN_WALLETS,
  BITCOIN_WALLET_IDS as IDS,
  DEPOSIT_ADDRESS_ID,
} from "./bitcoinRegistry.js";
import {
  LITECOIN_WALLETS,
  LITECOIN_WALLET_IDS as LTC_IDS,
} from "./litecoinRegistry.js";
import {
  DOGECOIN_WALLETS,
  DOGECOIN_WALLET_IDS as DOGE_IDS,
} from "./dogecoinRegistry.js";
import {
  XRP_WALLETS,
  XRP_WALLET_IDS as XRP_IDS,
} from "./xrpRegistry.js";
import {
  TRON_WALLETS,
  TRON_WALLET_IDS as TRON_IDS,
} from "./tronRegistry.js";

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

/* ————————————— Bitcoin family (Step 2.3, canonical table) ————————————— */

/**
 * The order buildFamilyWalletRows MUST produce for bitcoin:
 * pinned (Starport) → reference (Xverse) → software alphabetical →
 * hardware alphabetical (Ledger, Trezor) → deposit-address last.
 * Derived from the same grouping rules, so it pins the modal layout
 * without duplicating the implementation.
 */
function expectedBitcoinOrder() {
  const byId = new Map(BITCOIN_WALLETS.map((e) => [e.id, e]));
  const byName = (a, b) => byId.get(a).name.localeCompare(byId.get(b).name);
  const pinned = BITCOIN_WALLETS.filter((e) => e.pinned).map((e) => e.id);
  const reference = BITCOIN_WALLETS.filter((e) => e.reference).map((e) => e.id);
  const software = BITCOIN_WALLETS.filter(
    (e) => !e.pinned && !e.reference && !e.hardware && !e.depositAddress,
  )
    .map((e) => e.id)
    .sort(byName);
  const hardware = BITCOIN_WALLETS.filter((e) => e.hardware)
    .map((e) => e.id)
    .sort(byName);
  const deposit = BITCOIN_WALLETS.filter((e) => e.depositAddress).map((e) => e.id);
  return [...pinned, ...reference, ...software, ...hardware, ...deposit];
}

test("bitcoin: the full registry table renders — deposit-address row ALWAYS last, never removed", () => {
  // Zero wallets installed: every row still renders (modal layout rule:
  // never hidden), and the deposit-address row is the final row.
  const rows = buildFamilyWalletRows({ family: "bitcoin", discovered: [] });

  assert.equal(rows[0].id, STARPORT_ID, "Starport pinned first");
  assert.equal(rows[1].id, IDS.XVERSE, "Xverse (reference wallet) second");
  assert.equal(rows[rows.length - 1].id, DEPOSIT_ADDRESS_ID, "deposit-address row is last");
  assert.equal(rows[rows.length - 1].depositAddress, true);
  assert.equal(rows[rows.length - 1].installed, false);

  // Every canonical entry appears exactly once, in the fixed modal order —
  // nothing hidden, nothing reordered by install state.
  assert.deepEqual(rows.map((r) => r.id), expectedBitcoinOrder());
});

test("bitcoin: hardware (Ledger, Trezor) sorts after software, before deposit-address", () => {
  const rows = buildFamilyWalletRows({ family: "bitcoin", discovered: [] });
  const ids = rows.map((r) => r.id);
  const softwareSet = new Set(
    rows.filter((r) => !r.pinned && !r.reference && !r.hardware && !r.depositAddress).map((r) => r.id),
  );
  const hardwareIds = [IDS.LEDGER, IDS.TREZOR];

  const softwareIdx = ids.map((id, i) => (softwareSet.has(id) ? i : -1)).filter((i) => i >= 0);
  const hardwareIdx = ids.map((id, i) => (hardwareIds.includes(id) ? i : -1)).filter((i) => i >= 0);
  const deposit = ids.indexOf(DEPOSIT_ADDRESS_ID);

  assert.ok(Math.max(...softwareIdx) < Math.min(...hardwareIdx), "all hardware after all software");
  assert.ok(Math.max(...hardwareIdx) < deposit, "hardware before deposit-address");
  assert.ok(rows[hardwareIdx[0]].hardware && rows[hardwareIdx[1]].hardware);
});

test("bitcoin: software rows (✅ and ⚠️) are alphabetical; ⚠️ rows carry status + install links", () => {
  const rows = buildFamilyWalletRows({ family: "bitcoin", discovered: [] });
  const software = rows.filter((r) => !r.pinned && !r.reference && !r.hardware && !r.depositAddress);
  assert.deepEqual(
    software.map((r) => r.name),
    [...software.map((r) => r.name)].sort((a, b) => a.localeCompare(b)),
    "software sorted alphabetically",
  );

  const verifyRows = software.filter((r) => r.status === "verify");
  assert.ok(verifyRows.length >= 6, "all ⚠️ registry rows present (Magic Eden, Coinbase, Enkrypt, Keplr, Leap, Trust, OP_NET)");
  for (const row of verifyRows) {
    assert.ok(
      typeof row.installUrl === "string" && row.installUrl.startsWith("https://"),
      `${row.id} keeps its install link (never hidden)`,
    );
  }
});

test("bitcoin: installed wallets are highlighted in place (fixed order, not detected-first)", () => {
  const rows = buildFamilyWalletRows({
    family: "bitcoin",
    discovered: normalizeBitcoinDiscovered([
      { key: IDS.PHANTOM, name: "Phantom", source: "global" },
      { key: IDS.XVERSE, name: "Xverse", source: "standard" },
    ]),
  });

  assert.deepEqual(
    rows.map((r) => r.id),
    expectedBitcoinOrder(),
    "fixed order unchanged by install state",
  );
  assert.equal(rows.find((r) => r.id === IDS.XVERSE).installed, true);
  assert.equal(rows.find((r) => r.id === IDS.PHANTOM).installed, true);
  assert.equal(rows.find((r) => r.id === IDS.UNISAT).installed, false);
});

test("bitcoin: normalizeBitcoinDiscovered maps discovery entries to {key, name}", () => {
  const normalized = normalizeBitcoinDiscovered([
    { key: IDS.XVERSE, name: "Xverse", source: "standard" },
    { key: "standard:Future", name: "Future", source: "standard" },
  ]);
  assert.deepEqual(normalized.map((n) => n.key), [IDS.XVERSE, "standard:Future"]);
  assert.equal(normalized[0].name, "Xverse");
  assert.deepEqual(normalizeBitcoinDiscovered(undefined), []);
});

test("bitcoin: a discovered Starport announcement flips the pinned row to installed", () => {
  const rows = buildFamilyWalletRows({ family: "bitcoin", discovered: [{ key: "Starport" }] });
  assert.equal(rows[0].id, STARPORT_ID);
  assert.equal(rows[0].installed, true, "Starport highlighted when it announces Bitcoin");
});

/* ————————————— Step 2.4 families: LTC / DOGE / XRP / Tron ————————————— */

/**
 * Expected modal order for a canonical-table family, including the Step
 * 2.4 groups: pinned → reference → software-alpha → hardware →
 * walletConnect → unmaintained → deposit. Mirrors buildFamilyWalletRows.
 */
function expectedCanonicalOrder(wallets) {
  const byId = new Map(wallets.map((e) => [e.id, e]));
  const byName = (a, b) => byId.get(a).name.localeCompare(byId.get(b).name);
  const pinned = wallets.filter((e) => e.pinned).map((e) => e.id);
  const reference = wallets.filter((e) => e.reference).map((e) => e.id);
  const software = wallets
    .filter((e) => !e.pinned && !e.reference && !e.hardware && e.walletConnect !== true && e.unmaintained !== true && !e.depositAddress)
    .map((e) => e.id)
    .sort(byName);
  const hardware = wallets.filter((e) => e.hardware).map((e) => e.id).sort(byName);
  const walletConnect = wallets.filter((e) => e.walletConnect === true).map((e) => e.id).sort(byName);
  const unmaintained = wallets.filter((e) => e.unmaintained === true).map((e) => e.id).sort(byName);
  const deposit = wallets.filter((e) => e.depositAddress).map((e) => e.id);
  return [...pinned, ...reference, ...software, ...hardware, ...walletConnect, ...unmaintained, ...deposit];
}

function assertFamilyOrder(family, wallets) {
  const rows = buildFamilyWalletRows({ family, discovered: [] });
  assert.deepEqual(
    rows.map((r) => r.id),
    expectedCanonicalOrder(wallets),
    `${family} renders the full canonical table in fixed modal order`,
  );
  assert.equal(rows[0].id, STARPORT_ID, `${family}: Starport pinned first`);
  assert.equal(rows[rows.length - 1].depositAddress, true, `${family}: deposit-address row is ALWAYS last`);
  return rows;
}

test("litecoin: full canonical table — Ctrl reference second, deposit last, ⚠️ rows in the alpha group", () => {
  const rows = assertFamilyOrder("litecoin", LITECOIN_WALLETS);
  assert.equal(rows[1].id, LTC_IDS.CTRL, "Ctrl (ex-XDEFI) is the reference wallet");
  assert.equal(rows[1].reference, true);

  const software = rows.filter((r) => !r.pinned && !r.reference && !r.hardware && !r.depositAddress);
  assert.deepEqual(
    software.map((r) => r.name),
    [...software.map((r) => r.name)].sort((a, b) => a.localeCompare(b)),
  );
  const verifyRows = software.filter((r) => r.status === "verify");
  assert.deepEqual(verifyRows.map((r) => r.id).sort(), [LTC_IDS.ENKRYPT, LTC_IDS.OKX, LTC_IDS.TRUST].sort());
  for (const row of verifyRows) {
    assert.ok(typeof row.todo === "string" && row.todo.length > 0, `${row.id} carries a verification TODO`);
  }
  // Litescribe: status ok per the canonical table, but connect-gated
  // (API + memo unverified) — the row still carries its connectTodo.
  const litescribe = rows.find((r) => r.id === LTC_IDS.LITESCRIBE);
  assert.equal(litescribe.status, "ok");
  assert.ok(litescribe.connectTodo, "Litescribe connect is TODO-gated (memo/API unverified)");
  // Memo rule metadata flows through to the rows.
  assert.equal(rows.find((r) => r.id === LTC_IDS.CTRL).memoSupport, "op_return");
  assert.equal(litescribe.memoSupport, "verify");
  assert.equal(rows.find((r) => r.id === LTC_IDS.DEPOSIT_ADDRESS).memoSupport, "op_return");
});

test("dogecoin: full canonical table — Ctrl reference second, deposit last, MyDoge ⚠️ in the alpha group", () => {
  const rows = assertFamilyOrder("dogecoin", DOGECOIN_WALLETS);
  assert.equal(rows[1].id, DOGE_IDS.CTRL, "Ctrl (ex-XDEFI) is the reference wallet");
  assert.equal(rows[1].reference, true);

  const software = rows.filter((r) => !r.pinned && !r.reference && !r.hardware && !r.depositAddress);
  assert.deepEqual(
    software.map((r) => r.name),
    [...software.map((r) => r.name)].sort((a, b) => a.localeCompare(b)),
  );
  const verifyRows = software.filter((r) => r.status === "verify");
  assert.deepEqual(
    verifyRows.map((r) => r.id).sort(),
    [DOGE_IDS.BITGET, DOGE_IDS.DOGELABS, DOGE_IDS.ENKRYPT, DOGE_IDS.MYDOGE, DOGE_IDS.OKX, DOGE_IDS.TRUST].sort(),
  );
  assert.ok(
    rows.find((r) => r.id === DOGE_IDS.MYDOGE).memoSupport === "verify",
    "MyDoge memo is ⚠️ (balance-only + deposit-address until verified)",
  );
  assert.equal(rows.find((r) => r.id === DOGE_IDS.CTRL).memoSupport, "op_return");
});

test("xrp: Xaman reference second; Crossmark/GemWallet badged unmaintained ranked after hardware, before deposit", () => {
  const rows = assertFamilyOrder("xrp", XRP_WALLETS);
  assert.equal(rows[1].id, XRP_IDS.XAMAN, "Xaman (ex-XUMM) is the reference wallet (registry PRIMARY)");
  assert.equal(rows[1].reference, true);

  const ids = rows.map((r) => r.id);
  const hardwareIdx = [XRP_IDS.LEDGER, XRP_IDS.TREZOR].map((id) => ids.indexOf(id));
  const unmaintainedIdx = [XRP_IDS.CROSSMARK, XRP_IDS.GEMWALLET].map((id) => ids.indexOf(id));
  const depositIdx = ids.indexOf(XRP_IDS.DEPOSIT_ADDRESS);
  assert.ok(
    Math.max(...hardwareIdx) < Math.min(...unmaintainedIdx),
    "❌ rows rank AFTER hardware",
  );
  assert.ok(
    Math.max(...unmaintainedIdx) < depositIdx,
    "❌ rows rank BEFORE the deposit-address row (which is final)",
  );
  for (const id of [XRP_IDS.CROSSMARK, XRP_IDS.GEMWALLET]) {
    const row = rows.find((r) => r.id === id);
    assert.equal(row.unmaintained, true, `${id} flagged unmaintained`);
    assert.equal(row.status, "unmaintained");
  }
  // Tangem: deposit-only info row in the software group, never connectable.
  const tangem = rows.find((r) => r.id === XRP_IDS.TANGEM);
  assert.equal(tangem.depositOnly, true);
  assert.equal(tangem.installed, false);
  assert.ok(
    ids.indexOf(XRP_IDS.TANGEM) < Math.min(...hardwareIdx),
    "Tangem sits in the software group (alphabetical), before hardware",
  );
  // Xaman memoSupport: the XRPL Memos field.
  assert.equal(rows.find((r) => r.id === XRP_IDS.XAMAN).memoSupport, "memos");
  assert.equal(rows.find((r) => r.id === XRP_IDS.DEPOSIT_ADDRESS).memoSupport, "memos");
});

test("tron: TronLink reference second; WalletConnect sorts after hardware; NO deposit row", () => {
  const rows = buildFamilyWalletRows({ family: "tron", discovered: [] });
  assert.deepEqual(
    rows.map((r) => r.id),
    expectedCanonicalOrder(TRON_WALLETS),
    "Tron renders the full canonical table in fixed modal order",
  );
  assert.equal(rows[0].id, STARPORT_ID, "Starport pinned first");
  assert.equal(rows[1].id, TRON_IDS.TRONLINK, "TronLink is the reference wallet");
  assert.equal(rows[1].reference, true);

  const ids = rows.map((r) => r.id);
  const ledgerIdx = ids.indexOf(TRON_IDS.LEDGER);
  const wcIdx = ids.indexOf(TRON_IDS.WALLETCONNECT);
  assert.ok(ledgerIdx < wcIdx, "WalletConnect (mobile) sorts after hardware");
  assert.equal(rows.find((r) => r.id === TRON_IDS.WALLETCONNECT).walletConnect, true);
  assert.ok(
    !rows.some((r) => r.depositAddress),
    "Tron has NO deposit-address row (the registry's deposit row is BTC/LTC/DOGE/XRP only)",
  );

  const verifyRows = rows.filter((r) => r.status === "verify");
  assert.deepEqual(verifyRows.map((r) => r.id).sort(), [TRON_IDS.BINANCE, TRON_IDS.TRUST].sort());
  for (const row of verifyRows) {
    assert.ok(row.todo.includes("WalletConnect"), `${row.id} TODO names the WalletConnect path`);
  }
  // Adapter rows carry their adapterName for the discovery match.
  assert.equal(rows.find((r) => r.id === TRON_IDS.TRONLINK).adapterName, "TronLink");
  assert.equal(rows.find((r) => r.id === TRON_IDS.BITGET).adapterName, "Bitget Wallet");
});

test("Step 2.4 normalizers map discovery entries to {key, name}", () => {
  const cases = [
    [normalizeLitecoinDiscovered, [{ key: LTC_IDS.CTRL, name: "Ctrl (ex-XDEFI)" }]],
    [normalizeDogecoinDiscovered, [{ key: DOGE_IDS.CTRL, name: "Ctrl (ex-XDEFI)" }]],
    [normalizeXrpDiscovered, [{ key: XRP_IDS.CROSSMARK, name: "Crossmark" }]],
    [normalizeTronDiscovered, [{ key: TRON_IDS.TRONLINK, name: "TronLink" }]],
  ];
  for (const [normalize, input] of cases) {
    const out = normalize(input);
    assert.equal(out.length, 1);
    assert.equal(out[0].key, input[0].key);
    assert.equal(out[0].name, input[0].name);
    assert.deepEqual(normalize(undefined), []);
  }
});

test("Step 2.4 installed highlighting works in place (fixed order, not detected-first)", () => {
  // LTC: Ctrl installed → highlighted where it sits (reference slot).
  const ltc = buildFamilyWalletRows({
    family: "litecoin",
    discovered: normalizeLitecoinDiscovered([{ key: LTC_IDS.CTRL, name: "Ctrl (ex-XDEFI)" }]),
  });
  assert.deepEqual(ltc.map((r) => r.id), expectedCanonicalOrder(LITECOIN_WALLETS));
  assert.equal(ltc.find((r) => r.id === LTC_IDS.CTRL).installed, true);
  assert.equal(ltc.find((r) => r.id === LTC_IDS.LITESCRIBE).installed, false);

  // Tron: TronLink installed via an adapter discovery entry.
  const tron = buildFamilyWalletRows({
    family: "tron",
    discovered: normalizeTronDiscovered([{ key: TRON_IDS.TRONLINK, name: "TronLink" }]),
  });
  assert.equal(tron.find((r) => r.id === TRON_IDS.TRONLINK).installed, true);
  assert.equal(tron.find((r) => r.id === TRON_IDS.OKX).installed, false);
});
