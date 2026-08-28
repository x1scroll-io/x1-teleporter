// api/lifi/status.js — track an in-flight bridge.
import { lifiGet } from "../_lifi.js";
import { cors } from "../_cors.js";

export default async function handler(req, res) {
  if (!cors(req, res)) return;
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const params = new URLSearchParams(req.query);
    const { status, data } = await lifiGet(`/status?${params}`);
    res.status(status).json(data);
  } catch (err) {
    res.status(502).json({ error: "lifi_status_failed", message: String(err.message || err) });
  }
}
