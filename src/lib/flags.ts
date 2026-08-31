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
  const meta = import.meta as unknown as { env?: Env };
  return meta.env ?? {};
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

  return {
    THORCHAIN: on(["NEXT_PUBLIC_FLAG_THORCHAIN", "VITE_FLAG_THORCHAIN"]),
    ANYSWAP: on(["NEXT_PUBLIC_FLAG_ANYSWAP", "VITE_FLAG_ANYSWAP"]),
    REVERSE_ENABLED: on(["NEXT_PUBLIC_FLAG_REVERSE_ENABLED", "VITE_FLAG_REVERSE_ENABLED"]),
    WARP_LIVE_SEND: on(["NEXT_PUBLIC_FLAG_WARP_LIVE_SEND", "VITE_WARP_LIVE_SEND"]),
    LEGACY_UI: on(["NEXT_PUBLIC_FLAG_LEGACY_UI", "VITE_FLAG_LEGACY_UI"]),
  };
}

const flags = resolveFlags(readEnv());

/** Whether the THORCHAIN route is enabled in the UI. Default: false. */
export const THORCHAIN: boolean = flags.THORCHAIN;

/** Whether the ANYSWAP route is enabled in the UI. Default: false. */
export const ANYSWAP: boolean = flags.ANYSWAP;

/**
 * Whether the X1 → Solana reverse (off-ramp) route is enabled in the UI.
 * Default: false.
 *
 * Step 1.2: the reverse self-relay was REMOVED from the user-facing path —
 * the route was dead at step one (fee ATA missing on X1) and a partial fix
 * would let burns go out with no working completion behind them. While this
 * flag is false, the route builder rejects every X1-source route, so no
 * X1 → Solana (x1_reverse) or X1 → onward (x1_onward) route can be
 * constructed by the UI. Do NOT flip this on without a verified, working
 * completion path for X1 burns.
 */
export const REVERSE_ENABLED: boolean = flags.REVERSE_ENABLED;

/**
 * WARP_LIVE_SEND — env-driven gate for REAL Warp bridge sends (forward + reverse).
 * MUST NEVER be true without a working completion path (step 1.2). Default: false.
 * Set VITE_WARP_LIVE_SEND=true in Vercel Preview only when the live hop is ready.
 */
export const WARP_LIVE_SEND: boolean = flags.WARP_LIVE_SEND;

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
