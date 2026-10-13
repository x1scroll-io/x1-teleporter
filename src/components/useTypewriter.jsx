/**
 * useTypewriter.jsx — the teleport-console TYPEWRITER primitives behind the
 * JOURNEY READOUT's "console printing the route" feel.
 *
 * WHAT IT IS: a tiny, dependency-free character-by-character reveal. You hand
 * it a string; it hands back the part revealed SO FAR (`text`) and whether it
 * has finished (`done`). The `Typed` component layers the sci-fi console
 * dressing on top: a blinking print-head cursor while the line is being
 * written, nothing once it lands.
 *
 * ANIMATION GATING (matches the card's existing `useTicker` contract): the
 * reveal is driven by requestAnimationFrame, and it is DISABLED — the full
 * string returned on the very first render — when:
 *   - the user prefers reduced motion (`prefers-reduced-motion: reduce`), or
 *   - there is no requestAnimationFrame (SSR / the jsdom unit environment).
 * Both cases are deliberate: reduced-motion is an a11y requirement, and "no
 * rAF" keeps the node:test suite deterministic (the DOM tests assert the full
 * itinerary is painted immediately). A test that wants the animation installs
 * a controllable rAF of its own.
 *
 * PURE display helper: no DOM writes, no fetch, no keys. Re-runs from the top
 * whenever the text OR the `restartKey` changes — the readout passes a
 * selection signature as `restartKey`, so changing chain/token/amount fires a
 * fresh "teleport lock-in" print even if the visible text happens to be equal.
 */

import { useEffect, useState } from "react";

/** Milliseconds per revealed character. Fast enough to feel snappy, slow
 *  enough to read as "typing". */
export const TYPE_SPEED_MS = 12;

/** Blinking print-head keyframes. Injected once by the readout via a <style>
 *  tag (the v2 card ships no stylesheet, so the keyframes ride inline). */
export const CURSOR_CSS =
  "@keyframes jrCursorBlink{0%,45%{opacity:1}50%,100%{opacity:0}}";

/** The print-head block: a solid cyan cell that blinks while typing. It has
 *  NO text content (so it never perturbs `textContent` assertions). */
const CURSOR_STYLE = {
  display: "inline-block",
  width: "0.55em",
  height: "1em",
  marginLeft: 1,
  background: "#3fd3e8",
  verticalAlign: "text-bottom",
  animation: "jrCursorBlink .9s steps(1,end) infinite",
};

/** True when the environment asks for reduced motion. Safe everywhere (no
 *  window / no matchMedia ⇒ false). */
export function prefersReducedMotion() {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/**
 * Reveal `text` one character at a time.
 *
 * @param {string} text             the full string to reveal
 * @param {number} [speedMs]        ms per character (default TYPE_SPEED_MS)
 * @param {object} [opts]
 * @param {number} [opts.startDelayMs]  hold before the first character
 * @param {boolean} [opts.enabled]      master switch (false ⇒ instant)
 * @param {string|number} [opts.restartKey]  change ⇒ restart from the top
 * @returns {{text:string, done:boolean}}
 */
export function useTypewriter(
  text,
  speedMs = TYPE_SPEED_MS,
  { startDelayMs = 0, enabled = true, restartKey = null } = {},
) {
  const full = text == null ? "" : String(text);
  const animate =
    enabled && !prefersReducedMotion() && typeof requestAnimationFrame !== "undefined";
  const speed = speedMs > 0 ? speedMs : TYPE_SPEED_MS;
  const [count, setCount] = useState(() => (animate ? 0 : full.length));

  useEffect(() => {
    if (!animate) {
      setCount(full.length);
      return undefined;
    }
    setCount(0);
    let raf = 0;
    let start = null;
    let cancelled = false;
    const step = (now) => {
      if (cancelled) return;
      if (start === null) start = now;
      const elapsed = now - start - startDelayMs;
      const n = elapsed <= 0 ? 0 : Math.floor(elapsed / speed);
      if (n >= full.length) {
        setCount(full.length);
        return;
      }
      setCount(n);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
    // restartKey deliberately in deps: an equal text on a new route re-types.
  }, [full, speed, startDelayMs, animate, restartKey]);

  const clamped = count < 0 ? 0 : count > full.length ? full.length : count;
  return { text: full.slice(0, clamped), done: clamped >= full.length };
}

/**
 * A single typed line/segment: reveals `text`, then carries a blinking
 * print-head cursor while it is still being written. Style is passed straight
 * through so the readout keeps its own per-segment colours.
 */
export function Typed({
  text,
  speedMs = TYPE_SPEED_MS,
  startDelayMs = 0,
  enabled = true,
  restartKey = null,
  cursor = true,
  style,
  className,
  "data-testid": testid,
  ...rest
}) {
  const { text: shown, done } = useTypewriter(text, speedMs, {
    startDelayMs,
    enabled,
    restartKey,
  });
  // One cursor at the "print head": only the segment actively being written
  // (has content, not yet finished) shows it — segments still waiting (0
  // chars) or already landed stay bare, so the block tracks the write position.
  const showCursor = cursor && !done && shown.length > 0;
  return (
    <span
      className={className}
      style={style}
      data-testid={testid}
      data-typing={done ? undefined : "true"}
      {...rest}
    >
      {shown}
      {showCursor && <span aria-hidden="true" data-testid="typewriter-cursor" style={CURSOR_STYLE} />}
    </span>
  );
}
