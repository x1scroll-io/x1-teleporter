/**
 * JourneyReadout — the TELEPORT CONSOLE journey readout.
 *
 * A lightweight, self-contained itinerary panel that renders next to (or below,
 * responsive) the swap card. It shows the EXACT travel path the engine builds
 * for the current selection: source coordinates → each hop (bridge vs swap
 * drawn distinctly) → destination coordinates, with the fees/skim pinned to
 * the leg that charges them and any leg the hard liquidity gate blocks flagged
 * BLOCKED with its reason.
 *
 * DATA SOURCE: the pure model in src/lib/journeyReadout.js (buildJourney) —
 * which itself reuses the engine's route/leg contract (routePlanner leg ids)
 * and the form's own quote.feeLines + checkRouteLiquidity verdict. This
 * component adds NO route logic — it only draws the model, so it live-rebuilds
 * on every selection change (a React re-render).
 *
 * AESTHETIC: a sci-fi teleport console — monospace, dark bezel, cyan rim, a
 * "coordinates" stamp per station. No heavy deps, inline styles only (matches
 * the rest of the v2 card, which ships no stylesheet).
 */

import { useMemo } from "react";
import { buildJourney } from "../lib/journeyReadout.js";

/** Hop-kind → accent colour (bridge cyan / swap amber / release green). */
const KIND_COLOR = {
  bridge: "#3fd3e8",
  swap: "#e8b04a",
  release: "#5fd38a",
};

const S = {
  panel: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    background: "#080d15",
    border: "1px solid #163a52",
    borderRadius: 12,
    padding: "12px 13px",
    color: "#9fb3c8",
    fontSize: 12,
    lineHeight: 1.5,
    boxSizing: "border-box",
    minWidth: 0,
  },
  head: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 4 },
  title: { color: "#3fd3e8", fontSize: 11, fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase" },
  status: { fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: "#5fd38a", whiteSpace: "nowrap" },
  statusIdle: { color: "#7d8aa0" },
  statusBlocked: { color: "#f2b8b5" },
  sub: { color: "#5a6b80", fontSize: 10, letterSpacing: ".06em", marginBottom: 10 },
  station: {
    display: "flex", alignItems: "baseline", gap: 8, padding: "6px 8px",
    background: "#0b1622", border: "1px solid #16324a", borderRadius: 7, margin: "2px 0",
  },
  coord: { color: "#3fd3e8", fontSize: 10, letterSpacing: ".08em", whiteSpace: "nowrap" },
  stationName: { color: "#e8ecf3", fontWeight: 600 },
  stationToken: { color: "#9fb3c8" },
  stationBlocked: { borderColor: "rgba(232,65,66,.5)", background: "rgba(232,65,66,.06)" },
  hop: {
    display: "flex", flexDirection: "column", gap: 3, padding: "8px 9px",
    borderLeft: "2px solid #1c2a3f", margin: "0 0 0 6px",
  },
  hopBlocked: { borderLeftColor: "#e84142" },
  hopTop: { display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" },
  arrow: { color: "#4a5f75" },
  via: { fontWeight: 700, letterSpacing: ".02em" },
  chip: {
    fontSize: 10, padding: "1px 6px", borderRadius: 999,
    border: "1px solid #28303f", color: "#9aa6bb", whiteSpace: "nowrap",
  },
  feeRow: { display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 },
  fee: { fontSize: 10, color: "#7d8aa0", border: "1px dashed #2e4a6b", borderRadius: 5, padding: "0 6px" },
  note: { color: "#5a6b80", fontSize: 10.5 },
  blocked: { color: "#f2b8b5", fontSize: 11, fontWeight: 600 },
  empty: { color: "#5a6b80", fontSize: 11, marginTop: 6 },
};

function Station({ station, testid, label }) {
  if (!station) return null;
  return (
    <div
      data-testid={testid}
      data-chain={station.chain}
      data-token={station.token || ""}
      data-blocked={station.blocked ? "true" : "false"}
      style={station.blocked ? { ...S.station, ...S.stationBlocked } : S.station}
    >
      <span style={S.coord}>{label} {station.coord}</span>
      <span style={S.stationName}>{station.name}</span>
      {station.token && <span style={S.stationToken}>· {station.token}</span>}
      {station.blocked && <span style={S.blocked}>⛔ BLOCKED</span>}
    </div>
  );
}

function Hop({ hop }) {
  const color = KIND_COLOR[hop.kind] || "#9aa6bb";
  return (
    <div
      data-testid="journey-hop"
      data-hop-seq={hop.seq}
      data-hop-kind={hop.kind}
      data-hop-leg={hop.legId}
      data-hop-tool={hop.tool}
      data-blocked={hop.blocked ? "true" : "false"}
      style={hop.blocked ? { ...S.hop, ...S.hopBlocked } : S.hop}
    >
      <div style={S.hopTop}>
        <span style={S.stationName}>{hop.from.name}</span>
        <span style={S.stationToken}>· {hop.from.token}</span>
        <span style={S.arrow}>→</span>
        <span style={{ ...S.via, color }}>{hop.action}</span>
        <span style={S.chip}>{hop.tool}</span>
        <span style={S.arrow}>→</span>
        <span style={S.stationName}>{hop.to.name}</span>
        <span style={S.stationToken}>· {hop.to.token}</span>
        {hop.blocked && <span data-testid="journey-hop-blocked" style={S.blocked}>⛔ BLOCKED</span>}
      </div>
      {hop.blocked && hop.blockedReason && (
        <div data-testid="journey-hop-blocked-reason" style={S.blocked}>{hop.blockedReason}</div>
      )}
      {hop.fees && hop.fees.length > 0 && (
        <div style={S.feeRow}>
          {hop.fees.map((f) => (
            <span key={f.id} data-testid="journey-fee" data-fee-id={f.id} style={S.fee}>
              {f.label}{Number.isFinite(f.amountUsd) ? ` $${f.amountUsd.toFixed(2)}` : ""}
            </span>
          ))}
        </div>
      )}
      {hop.note && <div style={S.note}>{hop.note}</div>}
    </div>
  );
}

/**
 * @param {{direction?:string, from?:string, to?:string, token?:string,
 *          reverseToken?:string, destToken?:string, amount?:string|number,
 *          quote?:object, liquidity?:object, style?:object}} props
 */
export default function JourneyReadout({
  direction = "forward",
  from,
  to,
  token,
  reverseToken = "USDC.x",
  destToken = "USDC.x",
  amount = null,
  quote = null,
  liquidity = null,
  style,
} = {}) {
  const journey = useMemo(
    () => buildJourney({ direction, from, to, token, reverseToken, destToken, amount, quote, liquidity }),
    [direction, from, to, token, reverseToken, destToken, amount, quote, liquidity],
  );

  const hasAmount = journey.amount !== null && journey.amount > 0;
  const status = journey.blocked ? "LEG BLOCKED" : hasAmount ? "ROUTE LOCKED" : "STANDING BY";
  const statusStyle = journey.blocked ? { ...S.status, ...S.statusBlocked } : hasAmount ? S.status : { ...S.status, ...S.statusIdle };

  return (
    <section data-testid="journey-readout" data-direction={journey.direction} style={{ ...S.panel, ...(style || {}) }}>
      <div style={S.head}>
        <span style={S.title}>Journey Readout</span>
        <span data-testid="journey-status" style={statusStyle}>{status}</span>
      </div>
      <div style={S.sub}>
        TELEPORT ITINERARY · {journey.source.name} → {journey.dest.name}
        {hasAmount ? ` · ${journey.amount} ${journey.source.token}` : ""}
      </div>

      <Station station={journey.source} testid="journey-coords-source" label="FROM" />

      {journey.hops.map((hop) => (
        <Hop key={hop.seq} hop={hop} />
      ))}

      <Station station={journey.dest} testid="journey-coords-dest" label="TO  " />

      {!hasAmount && (
        <div data-testid="journey-empty" style={S.empty}>
          Set an amount to arm the route — the path below is what the engine will build.
        </div>
      )}
    </section>
  );
}
