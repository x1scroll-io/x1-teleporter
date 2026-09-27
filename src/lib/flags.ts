/**
 * Feature flags for the Teleporter v2 UI.
 *
 * Read from Vite env vars (import.meta.env). Vite only exposes vars prefixed
 * with VITE_ to the client by default, so vite.config.js sets
 * `envPrefix: ["VITE_", "NEXT_PUBLIC_"]` to also expose the NEXT_PUBLIC_ names
 * that were already configured in Vercel for the old Next.js layout. We read
 * the NEXT_PUBLIC_ name first, fall back to the VITE_ name, and default to
 * false when neither is set.
 *
 * The import.meta.env access is guarded (same pattern as Teleporter.jsx) so
 * this module also loads outside Vite, e.g. under `node --test`.
 */

type Env = Record<string, string | undefined>;

function readEnv(): Env {
  // Vite replaces ONLY literal `import.meta.env` expressions at build time.
  // A dynamic `meta.env` access compiles to native `import.meta.env`, which is
  // undefined in the browser — flags would silently resolve false in every
  // deployed bundle (this is exactly why env injection never reached the
  // gate). Read the replaceable form directly. Under node --test (no Vite
  // transform), `import.meta.env` is undefined and `?? {}` keeps every flag
  // at its safety default.
  return import.meta.env ?? {};
}

/**
 * Resolve the flags from a raw env object. Exported for testing — the
 * singleton booleans below are resolved once at module load.
 */
export function resolveFlags(env: Env): {
  THORCHAIN: boolean;
  ANYSWAP: boolean;
  REVERSE_ENABLED: boolean;
  LEGACY_UI: boolean;
  WARP_LIVE_SEND: boolean;
  MEV_CAPTURE_ENABLED: boolean;
  CONSOLE_UI: boolean;
} {
  const on = (names: string[]): boolean => {
    for (const name of names) {
      const raw = env[name];
      if (raw !== undefined && raw !== "") {
        return raw.toLowerCase() === "true" || raw === "1";
      }
    }
    return false;
  };

  // onByDefault — the KILL-SWITCH read for flags whose shipped default is ON.
  // First present name wins (same precedence rule as `on`); a present value
  // of "false"/"0" turns the flag OFF, anything else (incl. "true"/"1") turns
  // it ON, and an UNSET env resolves to the default (true). Used by
  // REVERSE_ENABLED: the X1 → EVM off-ramp ships enabled, but an operator can
  // set VITE_FLAG_REVERSE_ENABLED=false to disable it without a code change.
  const onByDefault = (names: string[]): boolean => {
    for (const name of names) {
      const raw = env[name];
      if (raw !== undefined && raw !== "") {
        return raw.toLowerCase() !== "false" && raw !== "0";
      }
    }
    return true;
  };

  return {
    THORCHAIN: on(["NEXT_PUBLIC_FLAG_THORCHAIN", "VITE_FLAG_THORCHAIN"]),
    ANYSWAP: on(["NEXT_PUBLIC_FLAG_ANYSWAP", "VITE_FLAG_ANYSWAP"]),
    REVERSE_ENABLED: onByDefault(["NEXT_PUBLIC_FLAG_REVERSE_ENABLED", "VITE_FLAG_REVERSE_ENABLED"]),
    WARP_LIVE_SEND: on(["NEXT_PUBLIC_FLAG_WARP_LIVE_SEND", "VITE_WARP_LIVE_SEND"]),
    MEV_CAPTURE_ENABLED: on(["NEXT_PUBLIC_FLAG_MEV_CAPTURE_ENABLED", "VITE_MEV_CAPTURE_ENABLED"]),
    LEGACY_UI: on(["NEXT_PUBLIC_FLAG_LEGACY_UI", "VITE_FLAG_LEGACY_UI"]),
    CONSOLE_UI: on(["NEXT_PUBLIC_FLAG_CONSOLE_UI", "VITE_FLAG_CONSOLE_UI"]),
  };
}

/**
 * resolveConsoleUi — tri-state CONSOLE_UI read for the mount decision.
 *
 * The Teleport Console is the v2 card's new visual front door, but the
 * CLASSIC card stays the default on non-preview hosts (localhost builds, the
 * production domain) so the frozen browser harnesses (forward/reverse/
 * thorchain-leg.spec.js) keep measuring the classic flow unchanged. The
 * console mounts on the x1scroll Vercel preview hosts (branch previews + the
 * stable git-v2 alias) with NO env var needed — see src/lib/uiVariant.js.
 *
 * Returns:
 *   true      — env forces the console ON (VITE_FLAG_CONSOLE_UI=true),
 *   false     — env forces the console OFF (classic card),
 *   undefined — env unset → the hostname rule decides (uiVariant).
 */
export function resolveConsoleUi(env: Env): boolean | undefined {
  for (const name of ["NEXT_PUBLIC_FLAG_CONSOLE_UI", "VITE_FLAG_CONSOLE_UI"]) {
    const raw = env[name];
    if (raw !== undefined && raw !== "") {
      return raw.toLowerCase() === "true" || raw === "1";
    }
  }
  return undefined;
}

/**
 * resolveDiscovery — tri-state WARP_DISCOVERY read (dynamic xStock discovery +
 * lane health from the live Warp config). Explicit env WINS when set:
 *   VITE_FLAG_WARP_DISCOVERY / NEXT_PUBLIC_FLAG_WARP_DISCOVERY / WARP_DISCOVERY
 *   = "true"/"1" → ON, anything else → OFF.
 * When the env is UNSET it DEFAULTS to whether a real Vite env is present:
 *   * a Vite build/dev (import.meta.env defined) → ON — the live bridge offers
 *     newly-added rails automatically;
 *   * `node --test` (no Vite transform, import.meta.env undefined) → OFF — the
 *     UI/dropdown tests stay deterministic (no mount-time network fetch).
 * Tests force either state via the `registryFetcher` prop.
 */
export function resolveDiscovery(env: Env, viteEnvPresent = false): boolean {
  for (const name of ["NEXT_PUBLIC_FLAG_WARP_DISCOVERY", "VITE_FLAG_WARP_DISCOVERY", "WARP_DISCOVERY"]) {
    const raw = env[name];
    if (raw !== undefined && raw !== "") return raw.toLowerCase() === "true" || raw === "1";
  }
  return viteEnvPresent === true;
}

const flags = resolveFlags(readEnv());

/**
 * WARP_DISCOVERY — when ON, the form reads the live Warp config once on mount
 * and merges discovered rails into the offerable set, gating everything on the
 * config's paused/halted state (fail-closed: unknown rails are never guessed,
 * paused lanes are never offered). Default: ON in a real Vite build, OFF under
 * `node --test` — see resolveDiscovery.
 */
export const WARP_DISCOVERY: boolean = resolveDiscovery(readEnv(), import.meta.env != null);

/**
 * Whether the Teleport Console (the v2 hardware-console front door) is
 * force-enabled. Default: false — see resolveConsoleUi: when the env is
 * UNSET the mount decision falls to the hostname rule in uiVariant.js (the
 * x1scroll Vercel preview hosts mount the console; everything else keeps
 * the classic card).
 */
export const CONSOLE_UI: boolean = flags.CONSOLE_UI;

/** Whether the THORCHAIN route is enabled in the UI. Default: false. */
export const THORCHAIN: boolean = flags.THORCHAIN;

/** Whether the ANYSWAP route is enabled in the UI. Default: false. */
export const ANYSWAP: boolean = flags.ANYSWAP;

/**
 * Whether the X1 → EVM reverse (off-ramp) route is enabled in the UI.
 *
 * DEFAULT: TRUE (kill-switch model). The off-ramp is COMPLETE and
 * fail-closed end to end — the X1 Warp burn (fee-wallet ATA bundled, 0.5%
 * skim once), the submitter release-wait (permanent-fail vs pending
 * distinguished), and the LiFi Solana→EVM onward leg that only fires after
 * the Solana release lands. The destination-minimum preflight REFUSES before
 * burning so a doomed reverse never strands funds.
 *
 * HISTORY (why this used to default false): at the Step 1.2 cutover the
 * reverse self-relay was removed and the route was genuinely DEAD at step one
 * (fee ATA missing on X1) — a partial fix would have let burns go out with no
 * working completion behind them, so the route builder rejected every
 * X1-source route. That completion path now exists (routing-engine Phase 2:
 * x1-burn → release-wait → lifi-solana-out, proven by the golden reverse
 * oracle), so the gate is un-gated. The flag survives as a KILL SWITCH: set
 * NEXT_PUBLIC_FLAG_REVERSE_ENABLED=false (or VITE_FLAG_REVERSE_ENABLED=false)
 * to disable every X1-source route without a code change.
 *
 * While this flag is false, `determineRoute` returns "direct" for every
 * X1-source pair, so no x1_reverse / x1_onward route can be constructed by
 * the UI (fail-closed).
 */
export const REVERSE_ENABLED: boolean = flags.REVERSE_ENABLED;

/**
 * WARP_LIVE_SEND — env-driven gate for REAL Warp bridge sends (forward + reverse).
 * Default: false — real broadcasts stay OPERATOR-ARMED even though the reverse
 * completion path is now complete (see REVERSE_ENABLED).
 * Set VITE_WARP_LIVE_SEND=true in Vercel Preview only when the live hop is ready.
 */
export const WARP_LIVE_SEND: boolean = flags.WARP_LIVE_SEND;

/**
 * MEV_CAPTURE_ENABLED — env-driven gate for the MEV/price-gap CAPTURE
 * ENGINE (the same-chain cross-DEX price-gap detector — src/lib/mev/).
 * DEFAULT: false, always, everywhere except a branch whose build pins it
 * true (vite.config.js MEV_ARMED_BRANCHES — mirrors WARP_LIVE_SEND).
 *
 * WHAT THE GATE MEANS (read src/lib/mev/captureGate.js): while false the
 * detector RUNS (read-only quote observation + gap math) and the engine
 * reports "capture opportunity: X bps (gated OFF)" — nothing is ever
 * executable. When true (v2 builds only, via the vite define) the capture
 * ROUTE CONSTRUCTOR may compose the two existing DEX swap legs, but it
 * still only produces artifacts for Mr. Esters' wallet to sign — the
 * composed legs are the repo's existing dexDirect/aggregator swap legs
 * whose submit() throws (DexDirectLiveTestGateError): no autonomous
 * broadcast exists at any flag value. The live arm is Mr. Esters' alone.
 */
export const MEV_CAPTURE_ENABLED: boolean = flags.MEV_CAPTURE_ENABLED;
// NOTE: the value above is resolved from the env at module load. Under the
// test runner the env is unset → false (safety default). A real Vite build
// pins import.meta.env.VITE_MEV_CAPTURE_ENABLED to "true" (vite.config.js)
// unless an explicit env override disarms it — so the gate arms by default
// in production and can be killed instantly without a code change.

/**
 * Whether the app mounts the legacy v1 Teleporter card instead of the v2
 * BridgeCard. Default: false (the v2 card is the default mount).
 *
 * PREVIEW SAFETY NET ONLY: flip to true if the v2 card breaks on the
 * preview — the old proven card returns with a rebuild and no code change.
 * Teleporter.jsx is NOT deleted; it stays as the flag-restorable fallback
 * until the v2 cutover. This flag does NOT change what production serves
 * (production stays on v1 Teleporter until the cutover regardless).
 */
export const LEGACY_UI: boolean = flags.LEGACY_UI;

/**
 * Choose which root card main.jsx mounts. Pure — exported for tests.
 *
 * @param flags resolved flags (LEGACY_UI)
 * @returns "legacy" when the legacy-UI flag is on, otherwise "v2" (default)
 */
export function selectRootCard(flags: { LEGACY_UI?: boolean }): "v2" | "legacy" {
  return flags.LEGACY_UI === true ? "legacy" : "v2";
}
