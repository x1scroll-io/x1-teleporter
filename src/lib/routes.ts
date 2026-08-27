/**
 * Teleporter route brain — the single source of truth for route typing.
 *
 * Step 1.2: REVERSE_ENABLED gates every X1-source route here, so NO
 * X1 → Solana (x1_reverse) or X1 → onward (x1_onward) route can be
 * constructed while the reverse off-ramp is disabled. The reverse self-relay
 * was removed from the user-facing path (dead at step one: fee ATA missing on
 * X1; a partial fix would let burns go out with no working completion behind
 * them). When REVERSE_ENABLED is false, X1-source pairs fall through to
 * "direct" — a route type that can never execute from X1 (X1 has no LiFi key,
 * so the quote builder returns null), and the picker additionally blocks X1
 * from being selected as a source chain.
 */
import { REVERSE_ENABLED } from "./flags.ts";

export type RouteType = "direct" | "x1" | "x1_reverse" | "x1_onward" | "sol_x1";

/**
 * Determine the route type for a (from, to) chain pair.
 *
 * `reverseEnabled` defaults to the REVERSE_ENABLED flag (resolved once at
 * module load); it is a parameter only so tests can exercise both states.
 */
export function determineRoute(from: string, to: string, reverseEnabled: boolean = REVERSE_ENABLED): RouteType {
  if (to === "x1") return from === "sol" ? "sol_x1" : "x1";
  if (from === "x1") {
    // X1 → Solana is a single Warp burn/release. X1 → any other chain is a
    // TWO-leg route: Warp burn (X1→Sol) then LiFi (Sol→destination). Both
    // depend on the reverse completion path, so both are gated by the flag.
    if (!reverseEnabled) return "direct";
    return to === "sol" ? "x1_reverse" : "x1_onward";
  }
  return "direct";
}
