/**
 * buildBanner — pure builder for the [Teleporter] BUILD console banner.
 *
 * WHY THIS EXISTS: the banner used to hardcode "live sends OFF", which lied
 * about armed builds (the v2 branch compiles WARP_LIVE_SEND:true via the
 * vite.config.js allowlist pin). The console is the first place an operator
 * checks that a deployed bundle is armed, so the banner must read the REAL
 * compiled flag, not a static string.
 *
 * HOW THE BUILD-TIME FOLD WORKS: vite.config.js `define`s the env access
 * `import.meta.env.VITE_WARP_LIVE_SEND` to "true"/"false" at build time
 * (allowlist-pinned by branch: v2 → "true", everything else → "false").
 * The phrase ternary reads that define-replaced literal INLINE (no function
 * call between the condition and the branches), so esbuild folds it to a
 * single string during minification. The deployed bundle therefore contains
 * EXACTLY ONE phrase: "live sends ON" (armed) or "live sends OFF" (disarmed)
 * — grep the bundle to verify a deployment at a glance.
 *
 * Under node --test (no Vite transform) import.meta.env is undefined and the
 * optional chain resolves to undefined → false, so the banner builder stays
 * unit-testable without touching a chain.
 */

/**
 * Map the armed state to the banner phrase. Pure — unit-tested.
 * Full literal phrases on purpose: the bundle must contain the exact
 * "live sends ON" / "live sends OFF" strings so a build grep proves the
 * deployed bundle's armed state at a glance.
 */
export function liveSendPhrase(armed) {
  return armed ? "live sends ON" : "live sends OFF";
}

/**
 * Resolve the armed state from the build-pinned env. Reads the SAME var
 * flags.ts resolves (NEXT_PUBLIC_FLAG_WARP_LIVE_SEND then VITE_WARP_LIVE_SEND
 * → vite.config.js pins VITE_WARP_LIVE_SEND via `define`). Under node --test
 * (no Vite transform) import.meta.env is undefined → safely false.
 *
 * NOTE: this stays a separate pure helper so the mapping is unit-testable;
 * buildBanner below keeps the foldable INLINE form (per the header comment).
 */
export function resolveLiveSendArmed() {
  return import.meta.env?.VITE_WARP_LIVE_SEND === "true";
}

/**
 * Build the full banner text (without the %c style prefix — main.jsx adds it).
 *
 * The phrase is computed INLINE from the build-pinned env var (see header)
 * so esbuild folds it at build time: exactly one phrase ships per bundle,
 * proven by grep. The flag dumps (WARP_LIVE_SEND= / THORCHAIN=) come from
 * the flags.ts singletons — the same values the deployed bundle compiled.
 *
 * @param {object} args
 * @param {string|undefined} args.buildTime  __BUILD_TIME__ marker ("dev" fallback)
 * @param {boolean} args.WARP_LIVE_SEND      real compiled live-send gate (flags.ts)
 * @param {boolean} args.THORCHAIN           real compiled THORCHAIN route flag
 * @returns {string} banner text
 */
export function buildBanner({ buildTime, WARP_LIVE_SEND, THORCHAIN }) {
  const when = buildTime ?? "dev";
  const liveSend = liveSendPhrase(
    import.meta.env?.VITE_WARP_LIVE_SEND === "true"
  );
  return (
    "[Teleporter] BUILD " +
    when +
    " (v2 card mounted — preview; " +
    liveSend +
    " | WARP_LIVE_SEND=" +
    WARP_LIVE_SEND +
    " THORCHAIN=" +
    THORCHAIN +
    ")"
  );
}
