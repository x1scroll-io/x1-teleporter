// api/earnings.js — your collected integrator fees across all chains/tokens.
import { lifiGet, cors, INTEGRATOR } from "./_lifi.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const { status, data } = await lifiGet(`/integrators/${encodeURIComponent(INTEGRATOR)}`);
    res.status(status).json(data);
  } catch (err) {
    res.status(502).json({ error: "earnings_failed", message: String(err.message || err) });
  }
}
