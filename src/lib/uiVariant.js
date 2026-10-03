/**
 * uiVariant.js — the root UI mount decision (Teleport Console vs classic).
 *
 * The Teleport Console is the v2 card's new visual front door (the hardware
 * console swap surface — src/components/TeleportConsole.jsx). The CLASSIC
 * card (BridgeCard → TeleportTab → TeleportForm) stays byte-behavior-identical
 * and remains the default on every non-preview host, because the frozen
 * browser harnesses (e2e/forward-leg.spec.js, reverse-leg.spec.js,
 * thorchain-leg.spec.js) measure the classic flow and must keep passing
 * UNCHANGED against local default builds.
 *
 * So the console mounts, with NO env var needed, on the x1scroll Vercel
 * preview hosts — the branch-preview deployments (this PR's live preview)
 * and the stable git-v2 alias (x1teleporter-git-v2-…). This mirrors the
 * vite.config.js philosophy of keying build behavior off the PROVEN
 * deployment fact (there: VERCEL_GIT_COMMIT_REF; here: the preview
 * hostname — the runtime deployment fact). Promotion of the console to
 * other hosts (the production domain, or a permanent default) is a
 * DELIBERATE future act: either flip the CONSOLE_UI env flag in the Vercel
 * project or extend the hostname rule — never an implicit side effect.
 *
 * Decision table (pure — unit-tested in uiVariant.test.js):
 *   LEGACY_UI=true                    → "legacy"   (v1 Teleporter card)
 *   CONSOLE_UI=true                   → "console"
 *   CONSOLE_UI=false                  → "classic"  (v2 classic card)
 *   CONSOLE_UI unset + preview host   → "console"
 *   CONSOLE_UI unset + any other host → "classic"
 */

/**
 * The x1scroll Vercel preview hostname shape. Vercel preview deployments of
 * the x1-teleporter project are named x1teleporter-git-<branch>-x1scroll-ios-
 * projects.vercel.app — this covers branch previews (any branch slug) AND
 * the stable git-v2 alias (the branch slug "v2"). Production aliases
 * (x1teleporter.vercel.app / the custom domain) do NOT match → classic.
 */
export const X1SCROLL_PREVIEW_HOST_RE =
  /^x1teleporter-git-[a-z0-9-]+-x1scroll-ios-projects\.vercel\.app$/;

/** Is this hostname an x1scroll Vercel preview/alias deployment? */
export function isX1ScrollPreviewHost(hostname = "") {
  return X1SCROLL_PREVIEW_HOST_RE.test(String(hostname).toLowerCase());
}

/**
 * Resolve the UI variant to mount. Pure — main.jsx calls this with the
 * runtime facts (flags + location.hostname); tests call it directly.
 *
 * @param {{LEGACY_UI?: boolean, CONSOLE_UI?: boolean, hostname?: string}}
 * @returns {"legacy" | "console" | "classic"}
 */
export function resolveUiVariant({ LEGACY_UI = false, CONSOLE_UI, hostname = "" } = {}) {
  if (LEGACY_UI) return "legacy";
  if (CONSOLE_UI !== undefined) {
    return CONSOLE_UI ? "console" : "classic";
  }
  return isX1ScrollPreviewHost(hostname) ? "console" : "classic";
}
