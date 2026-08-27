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
export function resolveFlags(env: Env): { THORCHAIN: boolean; ANYSWAP: boolean } {
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
  };
}

const flags = resolveFlags(readEnv());

/** Whether the THORCHAIN route is enabled in the UI. Default: false. */
export const THORCHAIN: boolean = flags.THORCHAIN;

/** Whether the ANYSWAP route is enabled in the UI. Default: false. */
export const ANYSWAP: boolean = flags.ANYSWAP;
