// api/lifi/quote.js — the money path. Forces integrator + fee onto every quote
// so it can't be stripped or tampered from the browser.
import { lifiGet, cors, INTEGRATOR, INTEGRATOR_FEE } from "../_lifi.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const params = new URLSearchParams(req.query);
    // FORCE these — overwrite anything the client sent.
    params.set("integrator", INTEGRATOR);
    params.set("fee", INTEGRATOR_FEE);
    const { status, data } = await lifiGet(`/quote?${params}`);
    res.status(status).json(data);
  } catch (err) {
    res.status(502).json({ error: "lifi_quote_failed", message: String(err.message || err) });
  }
}
