/**
 * tonSignable.js — the SIGNED-IN-YOUR-WALLET execute surface for the TON
 * dexDirect leg (STON.fi).
 *
 * 🔴 FUNDS RULE — nothing in this module broadcasts. It turns the leg's
 * build artifact (the STON.fi SenderArguments `{ to, value, body }`) into
 * exactly the shape TON Connect signs:
 *
 *   TON Connect —
 *     `tonConnectUI.sendTransaction({ validUntil, messages })`
 *     where each message is `{ address, amount, payload }` (address = the
 *     destination friendly address; amount = nanoTON as a string; payload =
 *     the swap body BOC, base64). THE WALLET signs and submits; the agent
 *     never calls sendTransaction itself.
 *
 * The split mirrors solanaSignable.js:
 *   senderArgumentsToMessage — PURE: `{ to, value, body }` (a @ton/ton
 *     SenderArguments) → a TON Connect message `{ address, amount, payload }`.
 *   planTonExecute — assembles `{ validUntil, messages }` for
 *     tonConnectUI.sendTransaction (NO send).
 *
 * There is NO sendTransaction / broadcast anywhere here. The anchor harness
 * hands the returned request to the TON Connect UI; Mr. Esters approves in
 * his TON wallet; the WALLET's own bridge broadcasts.
 */

/** Convert a @ton/core Cell body to a base64 BOC (TON Connect payload form). */
export function bodyToBase64(body) {
  if (body == null) return null;
  if (typeof body === "string") return body; // already a BOC string
  if (typeof body.toBoc === "function") return body.toBoc().toString("base64");
  throw new Error("tonSignable.bodyToBase64: body must be a Cell (toBoc) or a BOC string");
}

/** Friendly-address string from an Address | string. */
function addressToString(to) {
  if (to == null) return null;
  if (typeof to === "string") return to;
  if (typeof to.toString === "function") return to.toString();
  return String(to);
}

/**
 * Convert ONE @ton/ton SenderArguments `{ to, value, body }` into a TON
 * Connect message `{ address, amount, payload }`. PURE.
 * @param {{to: any, value: bigint, body: any}} args
 * @returns {{address: string, amount: string, payload: string|null}}
 */
export function senderArgumentsToMessage(args) {
  if (!args || args.to == null) throw new Error("tonSignable.senderArgumentsToMessage: { to, value, body } are required");
  return {
    address: addressToString(args.to),
    amount: BigInt(args.value ?? 0).toString(),
    payload: bodyToBase64(args.body),
  };
}

/**
 * Convert a list of SenderArguments into TON Connect messages. PURE.
 * @param {Array<{to, value, body}>} senderArgsList
 * @returns {Array} messages
 */
export function buildTonSwapMessages(senderArgsList) {
  return (Array.isArray(senderArgsList) ? senderArgsList : []).map((a) => senderArgumentsToMessage(a));
}

/**
 * The TON per-leg execute PLAN: turn the built artifact into the wallet-ready
 * sign request. Read-only; NO broadcast.
 *
 * @param {object} args
 * @param {object} args.artifact the tonSwapLeg build artifact
 *   (`{ messages, quote, … }`)
 * @param {number} [args.validUntil] unix seconds the request is valid until
 *   (default: now + 60s)
 * @returns {{chain: string, validUntil: number, messages: Array,
 *   quote: object, boundary: string}}
 */
export function planTonExecute({ artifact, validUntil = null } = {}) {
  if (!artifact || !Array.isArray(artifact.messages)) {
    throw new Error("planTonExecute: artifact.messages is required");
  }
  const vu = validUntil ?? Math.floor(Date.now() / 1000) + 60;
  return {
    chain: "ton",
    router: artifact.router ?? null,
    validUntil: vu,
    messages: artifact.messages,
    quote: artifact.quote ?? null,
    boundary:
      "sign-in-wallet: TON Connect signs + submits (tonConnectUI.sendTransaction({ validUntil, messages })). " +
      "The agent never broadcasts — sign in your wallet; the wallet's own bridge sends on Mr. Esters' confirm.",
  };
}
