/**
 * tools/vite-plugin-dev-api.mjs — DEV-ONLY local mount for the Vercel serverless
 * handlers in /api.
 *
 * WHY: `vite dev` serves the SPA but not `api/*`, so the console cannot request a
 * quote locally — the app renders but has no engine to talk to. This middleware
 * runs the SAME handler files, unmodified, behind a minimal Vercel-compatible
 * req/res shim (req.method / req.query / req.body; res.status().json() /
 * setHeader / end).
 *
 * SCOPE / SAFETY (deliberate):
 *  - apply: "serve" → only exists under `vite dev`. Production still runs the
 *    real serverless functions; no shared prod file is modified.
 *  - Injects NO secrets. Handlers keep their own hardcoded integrator
 *    ("x1-teleporter-labs") and optional LIFI_API_KEY env.
 *  - Does NOT bypass the CORS allowlist in api/_cors.js. A browser request from a
 *    disallowed origin still receives the handler's 403. Same-origin GETs carry
 *    no Origin header (per spec), which is exactly how production calls /api/*.
 *    Consequence: GET quote paths work locally; POST paths (stepTransaction,
 *    warp/signatures) will 403 in dev because browsers send Origin on POST.
 *    That is stated, not worked around.
 *  - Dynamic segments ([chainId]) are resolved to their file with the param
 *    injected into req.query.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const API_DIR = path.join(ROOT, "api");

function resolveHandler(pathname) {
  const rel = pathname.replace(/^\/api\/?/, "");
  if (!rel) return null;
  const direct = path.join(API_DIR, rel + ".js");
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return { file: direct, params: {} };
  const dir = path.dirname(path.join(API_DIR, rel));
  const last = path.basename(rel);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    const dyn = fs.readdirSync(dir).find((f) => /^\[.+\]\.js$/.test(f));
    if (dyn) return { file: path.join(dir, dyn), params: { [dyn.replace(/^\[|\]\.js$/g, "")]: last } };
  }
  return null;
}

export default function devApi() {
  return {
    name: "dev-api-mount",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith("/api/")) return next();
        const u = new URL(req.url, "http://localhost");
        const hit = resolveHandler(u.pathname);
        if (!hit) return next();

        let raw = "";
        await new Promise((done) => {
          req.on("data", (c) => (raw += c));
          req.on("end", done);
        });
        let body = raw;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          /* keep raw string */
        }

        const query = { ...Object.fromEntries(u.searchParams), ...hit.params };
        const reqShim = { method: req.method, url: req.url, headers: req.headers, query, body, cookies: {} };
        const resShim = {
          setHeader: (k, v) => {
            res.setHeader(k, v);
            return resShim;
          },
          getHeader: (k) => res.getHeader(k),
          status(code) {
            res.statusCode = code;
            return resShim;
          },
          json(obj) {
            if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(obj));
            return resShim;
          },
          send(obj) {
            res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
            return resShim;
          },
          end(chunk) {
            res.end(chunk);
            return resShim;
          },
        };

        try {
          const url = "/" + path.relative(ROOT, hit.file).split(path.sep).join("/");
          const mod = await server.ssrLoadModule(url);
          await mod.default(reqShim, resShim);
        } catch (err) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "dev_api_mount_failed", message: String(err?.message || err) }));
          }
        }
      });
    },
  };
}
