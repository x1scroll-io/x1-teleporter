/**
 * TokenSelect.jsx — the shared token dropdown used by the Teleport Console and
 * the classic bridge form.
 *
 * Renders a native <select> (so keyboard/a11y behaviour and the existing
 * `.value` / `.options` semantics are unchanged) whose every <option> caption
 * carries the token SYMBOL, its live $ VALUE and the user's token AMOUNT —
 * plus the selected token's ICON rendered alongside the control (a native
 * <option> cannot host an <img>; the icon therefore rides the visible control
 * for the chosen token, and every option carries the symbol/$/amount text).
 *
 * The four fields come from tokenOptions.js (buildTokenOptions) so the
 * "icon + symbol + $ value + amount, never blank, never a fabricated price"
 * contract is proven by unit tests without a DOM.
 */

import { buildTokenOptions } from "../lib/tokenOptions.js";

/**
 * @param {{testid: string, value: string, onChange: Function, symbols: string[],
 *          prices?: object, balances?: object, disabled?: boolean,
 *          ariaLabel?: string, className?: string, style?: object,
 *          iconStyle?: object}} props
 */
export default function TokenSelect({
  testid,
  value,
  onChange,
  symbols,
  prices = {},
  balances = {},
  disabled = false,
  ariaLabel,
  className,
  style,
  iconStyle,
}) {
  const options = buildTokenOptions({ symbols, prices, balances });
  const selected = options.find((o) => o.symbol === value) ?? options[0] ?? null;

  return (
    <span
      className="token-select"
      data-testid={`${testid}-wrap`}
      style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", minWidth: 0 }}
    >
      <img
        className="token-select-icon"
        data-testid={`${testid}-icon`}
        src={selected?.icon}
        alt={selected ? `${selected.symbol} icon` : ""}
        width={18}
        height={18}
        style={{ flex: "0 0 auto", borderRadius: "50%", ...iconStyle }}
      />
      <select
        data-testid={testid}
        value={value}
        onChange={onChange}
        disabled={disabled}
        className={className}
        aria-label={ariaLabel}
        style={{ width: "auto", flex: 1, minWidth: 0, ...style }}
      >
        {options.map((o) => (
          <option
            key={o.symbol}
            value={o.symbol}
            data-usd={o.usdText}
            data-amount={o.amountText}
          >
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}
