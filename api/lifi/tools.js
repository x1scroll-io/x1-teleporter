// api/lifi/tools.js — proxies LI.Fi /v1/tools (the authoritative list of
// bridges + exchanges per chain). The client uses this to verify, BEFORE any
// ERC-20 approval is signed, that the tool executing a quote step is a tool
// LI.Fi actually lists for the source chain (Step 1.1 audit gate). Server-side
// so the API key never reaches the browser; cached because the tool list is
// effectively static.
import { lifiGet, cors } from "../_lifi.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const params = new URLSearchParams(req.query);
    // Whitelist: only forward `chains` (comma-separated chain ids). Nothing
    // else from the client is passed through.
    const chains = params.get("chains");
    const qs = chains ? `?chains=${encodeURIComponent(chains)}` : "";
    const { status, data } = await lifiGet(`/tools${qs}`);
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate");
    res.status(status).json(data);
  } catch (err) {
    res.status(502).json({ error: "lifi_tools_failed", message: String(err.message || err) });
  }
}
