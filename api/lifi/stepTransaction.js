// api/lifi/stepTransaction.js — materializes the executable transaction for a
// LiFi step (needed for Solana routes where /quote may return a step without
// transactionRequest populated). POST the full step object; get it back with
// transactionRequest filled in.
import { LIFI, lifiHeaders, cors } from "../_lifi.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    const r = await fetch(`${LIFI}/advanced/stepTransaction`, {
      method: "POST",
      headers: { ...lifiHeaders(), "Content-Type": "application/json" },
      body,
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: "lifi_step_failed", message: String(err.message || err) });
  }
}
