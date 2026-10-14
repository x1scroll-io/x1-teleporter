/**
 * uiVariant.test.js — the root UI mount decision (console vs classic vs
 * legacy). Pure decision table:
 *   LEGACY_UI=true → legacy (v1 card), always.
 *   CONSOLE_UI env set → its value decides (console / classic).
 *   CONSOLE_UI unset → console on the x1scroll Vercel preview hosts
 *     (branch previews + the stable git-v2 alias), classic everywhere else
 *     (localhost, the production domain) — so the frozen browser harnesses
 *     keep measuring the classic flow on local default builds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveUiVariant,
  isX1ScrollPreviewHost,
  X1SCROLL_PREVIEW_HOST_RE,
} from "./uiVariant.js";

// ── Hostname matcher ────────────────────────────────────────────────────────

test("preview host regex: branch previews + the git-v2 alias match", () => {
  assert.equal(isX1ScrollPreviewHost("x1teleporter-git-v2-x1scroll-ios-projects.vercel.app"), true);
  assert.equal(isX1ScrollPreviewHost("x1teleporter-git-feat-teleport-console-x1scroll-ios-projects.vercel.app"), true);
  assert.equal(isX1ScrollPreviewHost("x1teleporter-git-fix-arm-2-x1scroll-ios-projects.vercel.app"), true);
});

test("preview host regex: localhost, production and foreign hosts do NOT match", () => {
  assert.equal(isX1ScrollPreviewHost("127.0.0.1"), false);
  assert.equal(isX1ScrollPreviewHost("localhost"), false);
  assert.equal(isX1ScrollPreviewHost("localhost:4173"), false);
  assert.equal(isX1ScrollPreviewHost("x1teleporter.vercel.app"), false);
  assert.equal(isX1ScrollPreviewHost("x1teleporter.com"), false);
  assert.equal(isX1ScrollPreviewHost("other-git-v2-x1scroll-ios-projects.vercel.app"), false);
  assert.equal(isX1ScrollPreviewHost("x1teleporter-git-v2-evil-org.vercel.app"), false);
  assert.equal(isX1ScrollPreviewHost(""), false);
});

// ── Decision table ──────────────────────────────────────────────────────────

test("LEGACY_UI wins over everything → legacy (v1 Teleporter card)", () => {
  assert.equal(resolveUiVariant({ LEGACY_UI: true, CONSOLE_UI: true }), "legacy");
  assert.equal(resolveUiVariant({ LEGACY_UI: true, CONSOLE_UI: false }), "legacy");
  assert.equal(
    resolveUiVariant({ LEGACY_UI: true, hostname: "x1teleporter-git-v2-x1scroll-ios-projects.vercel.app" }),
    "legacy",
  );
  assert.equal(resolveUiVariant({ LEGACY_UI: true }), "legacy");
});

test("CONSOLE_UI=true forces the console on any host", () => {
  assert.equal(resolveUiVariant({ CONSOLE_UI: true }), "console");
  assert.equal(resolveUiVariant({ CONSOLE_UI: true, hostname: "localhost" }), "console");
  assert.equal(resolveUiVariant({ CONSOLE_UI: true, hostname: "x1teleporter.com" }), "console");
});

test("CONSOLE_UI=false forces the classic card even on a preview host", () => {
  assert.equal(resolveUiVariant({ CONSOLE_UI: false }), "classic");
  assert.equal(
    resolveUiVariant({ CONSOLE_UI: false, hostname: "x1teleporter-git-v2-x1scroll-ios-projects.vercel.app" }),
    "classic",
  );
});

test("env unset + x1scroll preview host → console (the branch previews + git-v2 alias)", () => {
  assert.equal(resolveUiVariant({ hostname: "x1teleporter-git-v2-x1scroll-ios-projects.vercel.app" }), "console");
  assert.equal(
    resolveUiVariant({ hostname: "x1teleporter-git-feat-teleport-console-x1scroll-ios-projects.vercel.app" }),
    "console",
  );
  // Missing hostname/flag behaves like unset + non-preview → classic.
  assert.equal(resolveUiVariant({}), "classic");
});

test("env unset + any other host → classic (frozen harnesses keep measuring the classic flow)", () => {
  assert.equal(resolveUiVariant({ hostname: "127.0.0.1" }), "classic");
  assert.equal(resolveUiVariant({ hostname: "localhost" }), "classic");
  assert.equal(resolveUiVariant({ hostname: "x1teleporter.vercel.app" }), "classic");
  assert.equal(resolveUiVariant({ hostname: "x1teleporter.com" }), "classic");
});
