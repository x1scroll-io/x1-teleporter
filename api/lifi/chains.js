// api/lifi/chains.js — reference list of LiFi-supported chains.
import { lifiGet, cors } from "../_lifi.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const { status, data } = await lifiGet(`/chains`);
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate");
    res.status(status).json(data);
  } catch (err) {
    res.status(502).json({ error: "lifi_chains_failed", message: String(err.message || err) });
  }
}
