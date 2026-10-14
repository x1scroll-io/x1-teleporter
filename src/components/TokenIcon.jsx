/**
 * TokenIcon.jsx — the shared token-icon renderer (logo → badge fallback).
 *
 * One tiny component so the token PICKER (TokenSelect) and the wallet balance
 * rows (BalancesLine) draw a token the same way: prefer the real brand logo
 * (tokenLogo), fall back to the deterministic colour badge (tokenIcon) when no
 * logo is registered OR the remote image fails to load (dead link, CDN
 * hotlink-block, CORS). A token therefore ALWAYS renders an icon — never a
 * blank gap.
 *
 * The fallback is applied via the <img> onError handler: on the first error we
 * swap `src` to the badge data-URI (guarded by a data-flag so a broken badge
 * can't loop). No network at render time unless a logo URL is registered; the
 * badge itself is a pure inline SVG data-URI (zero external calls).
 *
 * DI-clean: `icon`/`logo` resolvers default to the pure tokenOptions helpers
 * and can be injected for tests (pass functions) so no test depends on a real
 * remote image.
 */
import { tokenIcon, tokenLogo } from "../lib/tokenOptions.js";

/**
 * @param {{symbol: string, size?: number, testid?: string, className?: string,
 *          style?: object, title?: string,
 *          icon?: (s: string) => string, logo?: (s: string) => (string|null)}} props
 */
export default function TokenIcon({
  symbol,
  size = 18,
  testid,
  className,
  style,
  title,
  icon = tokenIcon,
  logo = tokenLogo,
}) {
  const fallback = icon(symbol);
  const src = logo(symbol) || fallback;
  return (
    <img
      className={className}
      data-testid={testid}
      data-fallback={fallback}
      src={src}
      alt={symbol ? `${symbol} icon` : ""}
      title={title}
      width={size}
      height={size}
      style={{ flex: "0 0 auto", borderRadius: "50%", ...style }}
      onError={(e) => {
        const el = e.currentTarget;
        if (el.dataset.failed) return; // never loop on a broken badge
        el.dataset.failed = "1";
        el.src = el.dataset.fallback;
      }}
    />
  );
}
