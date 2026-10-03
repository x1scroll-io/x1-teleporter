/**
 * qr.js — QR rendering for the THORChain deposit-address stage (Step 3.2).
 *
 * The deposit row shows the THORChain vault address as a QR code so the user
 * can scan it from a mobile wallet. Rendered client-side as an inline SVG
 * (no external image service — the brief's "no infra on us" rule).
 *
 * Implementation: the `qrcode` package (already in the dependency tree via
 * WalletConnect's modal UI; pinned as a direct dependency so we never rely on
 * a transitive). `renderQrSvg` returns an SVG STRING; the component mounts it
 * with dangerouslySetInnerHTML. The text is encoded into QR modules — it is
 * never interpolated into the SVG markup, so there is no injection surface.
 *
 * PURE + DI: `qrImpl` is injectable (tests stub it; the component wires the
 * real renderer). Runnable under `node --test`.
 */

import QRCode from "qrcode";

/**
 * Render `text` as an SVG QR code string.
 *
 * @param {string} text the value to encode (the deposit address)
 * @param {object} [opts]
 * @param {Function} [opts.qrImpl] qrcode-compatible `toString(text, opts)`
 *   — DI seam for tests
 * @param {number} [opts.width] output width in px (default 168)
 * @param {number} [opts.margin] quiet-zone modules (default 1)
 * @param {string} [opts.dark] dark module color (default #e8edf6)
 * @param {string} [opts.light] light module color (default #0a1019)
 * @returns {Promise<string>} the SVG markup
 * @throws on empty text or renderer failure
 */
export async function renderQrSvg(text, opts = {}) {
  const value = String(text ?? "");
  if (value.trim().length === 0) {
    throw new Error("renderQrSvg: text is required");
  }
  const qrImpl = opts.qrImpl ?? QRCode;
  const svg = await qrImpl.toString(value, {
    type: "svg",
    width: opts.width ?? 168,
    margin: opts.margin ?? 1,
    errorCorrectionLevel: "M",
    color: {
      dark: opts.dark ?? "#e8edf6",
      light: opts.light ?? "#0a1019",
    },
  });
  return String(svg);
}
