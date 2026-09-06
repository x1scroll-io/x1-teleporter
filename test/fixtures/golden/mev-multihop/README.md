# MEV multi-hop simulation fixtures — REAL per-leg quote captures (2026-09-06)

🔴 READ-ONLY captures for the MULTI-HOP route-choice capture SIMULATION. NO
funds, NO broadcast, NO signing — quoter eth_calls (EVM), on-chain pool-state
reads + pure quote math (Solana / X1), keyless aggregator quotes (Jupiter /
LiFi). The capture EXECUTION path is dead-gated (MEV_CAPTURE_ENABLED=false
default).

- `inputs/route-*.json` — per-route REAL quote evidence (every leg's venue
  options at the leg's routed size) + the analysis computed over it
  (REAL-labeled; quote-level only).
- `capture-log.json` — every real quote of the run (flat).
- Docs: docs/MEV-MULTIHOP-SIMULATION-2026-09-06.md +
  docs/mev-multihop-simulation-2026-09-06.json.

Refresh before any live use — quotes are market data and move.
