# MEV-capture simulation fixtures — REAL quote captures (2026-09-06)

🔴 READ-ONLY captures for the MEV/price-gap capture SIMULATION. NO funds,
NO broadcast, NO signing — quoter eth_calls (EVM), on-chain pool-state reads
+ pure quote math (Solana), keyless aggregator quotes (Jupiter/LiFi). The
capture EXECUTION path is dead-gated (MEV_CAPTURE_ENABLED=false default).

- `inputs/round-*-evidence.json` — per-round quote evidence + the detection
  computed over it (REAL-labeled; quote-level only).
- `capture-log.json` — every real quote of the run (flat).
- Docs: docs/MEV-SIMULATION-2026-09-06.md + docs/mev-simulation-2026-09-06.json.

Refresh before any live use — quotes are market data and move.
