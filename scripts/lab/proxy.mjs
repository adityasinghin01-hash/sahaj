#!/usr/bin/env node
// Zero-dependency path proxy for the joined lab (scripts/lab/lab-up2.sh). Node built-ins only.
//
//   door mode     owns the public port (3100 behind the cloudflared tunnel, 3200 when testing) and forwards by path:
//                 Singhal's apps/api routes -> API_URL, everything else -> SHIELD_URL.
//   supabase mode stands in for the Supabase gateway in front of PostgREST for apps/api's supabase-js client:
//                 /rest/v1/* -> PGRST_URL (prefix stripped). /auth/v1 and /storage/v1 answer 501: lab auth is verified
//                 in apps/api itself (SAHAJ_LAB_MODE=1, src/lib/lab-auth.ts) and the lab has no object storage.
//
// Bodies are streamed byte-for-byte in both directions (webhook signatures cover raw bytes), every end-to-end header is
// kept (including Host and duplicates), hop-by-hop headers are dropped, and X-Forwarded-For/-Proto/-Host are added
// (appended to whatever the tunnel already set). Logs never contain query strings, bodies, headers or secret path parts.
//
// Usage:
//   PROXY_MODE=door PROXY_HOST=127.0.0.1 PROXY_PORT=3200 SHIELD_URL=http://127.0.0.1:3201 API_URL=http://127.0.0.1:3202 node scripts/lab/proxy.mjs
//   PROXY_MODE=supabase PROXY_PORT=3203 PGRST_URL=http://127.0.0.1:3204 node scripts/lab/proxy.mjs
import http from "node:http";
import { pathToFileURL } from "node:url";

/**
 * Door routing table. Prefix rules match the path itself or anything below it on a "/" boundary; exact rules match
 * only that path. First match wins; no match -> shield.
 *
 * Paths that exist in BOTH apps (decided here):
 *   /api/health                 -> shield. The phone apps and the live lab already probe it; apps/api health stays
 *                                  reachable as /api/health/liveness and /api/health/readiness (apps/api only).
 *   /api/sarvam/tool/ping       -> api (exact). shield's /api/sarvam/tool/[name] keeps every real tool name.
 *   /api/whatsapp vs /api/whatsapp/webhook -> /api/whatsapp exact -> api, /api/whatsapp/webhook -> shield. WhatsApp is
 *                                  dropped; neither server has WHATSAPP_* env, so both answer "not configured".
 *   /api/cron/tick (api) and /api/cron/shield-jobs (shield) do not collide.
 */
export const DOOR_RULES = [
  { prefix: "/api/core1", to: "api" },
  { prefix: "/api/core2", to: "api" },
  { prefix: "/api/twilio", to: "api" },
  { prefix: "/api/missed-call", to: "api", secretTail: true },
  { prefix: "/api/sarvam/post-call", to: "api", secretTail: true },
  { prefix: "/api/media", to: "api" },
  { prefix: "/api/cron/tick", to: "api" },
  { prefix: "/api/health/liveness", to: "api" },
  { prefix: "/api/health/readiness", to: "api" },
  { exact: "/api/whatsapp", to: "api" },
  { exact: "/api/sarvam/tool/ping", to: "api" },
];

export const SUPABASE_RULES = [
  { prefix: "/rest/v1", to: "pgrst", strip: true },
  { prefix: "/auth/v1", to: "none", status: 501, error: "lab_auth_is_local" },
  { prefix: "/storage/v1", to: "none", status: 501, error: "lab_has_no_storage" },
];

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade",
]);

function matches(rule, path) {
  if (rule.exact) return path === rule.exact;
  return path === rule.prefix || path.startsWith(`${rule.prefix}/`);
}

/** Returns { rule, label } for a pathname. `label` is safe to log (secret path tails and ids are cut). */
export function route(rules, pathname, fallback) {
  for (const rule of rules) {
    if (matches(rule, pathname)) {
      const base = rule.exact ?? rule.prefix;
      return { rule, label: pathname === base ? base : `${base}/…` };
    }
  }
  const parts = pathname.split("/").filter(Boolean).slice(0, 3);
  const label = `/${parts.join("/")}${pathname.split("/").filter(Boolean).length > 3 ? "/…" : ""}`;
  return { rule: fallback, label };
}

/** Copies end-to-end headers from a rawHeaders array, dropping hop-by-hop ones (and any named in Connection). */
export function forwardHeaders(rawHeaders, { remoteAddress, defaultProto = "http" } = {}) {
  const connectionListed = new Set();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === "connection") {
      for (const token of rawHeaders[i + 1].split(",")) connectionListed.add(token.trim().toLowerCase());
    }
  }
  const out = [];
  let xff = null, proto = null, fhost = null, host = null;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i], value = rawHeaders[i + 1], lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || connectionListed.has(lower)) continue;
    if (lower === "x-forwarded-for") { xff = xff ? `${xff}, ${value}` : value; continue; }
    if (lower === "x-forwarded-proto") { proto ??= value; continue; }
    if (lower === "x-forwarded-host") { fhost ??= value; continue; }
    if (lower === "host") host = value;
    out.push(name, value);
  }
  const client = remoteAddress ? remoteAddress.replace(/^::ffff:/, "") : null;
  if (client) xff = xff ? `${xff}, ${client}` : client;
  if (xff) out.push("X-Forwarded-For", xff);
  out.push("X-Forwarded-Proto", proto ?? defaultProto);
  if (fhost ?? host) out.push("X-Forwarded-Host", fhost ?? host);
  return out;
}

function responseHeaders(rawHeaders) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (!HOP_BY_HOP.has(rawHeaders[i].toLowerCase())) out.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  return out;
}

function sendJson(res, status, body) {
  if (res.headersSent) { res.destroy(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function createProxy({ rules, targets, fallback, log = () => {} }) {
  return http.createServer((req, res) => {
    const started = Date.now();
    const rawUrl = req.url ?? "/";
    const q = rawUrl.indexOf("?");
    const pathname = q === -1 ? rawUrl : rawUrl.slice(0, q);
    const search = q === -1 ? "" : rawUrl.slice(q);
    if (!pathname.startsWith("/") || pathname.includes("\\")) return sendJson(res, 400, { error: "bad_path" });
    const { rule, label } = route(rules, pathname, fallback);
    const done = (status, to) => log(`${req.method} ${label} -> ${to} ${status} ${Date.now() - started}ms`);
    if (rule.to === "none") {
      done(rule.status, "local");
      return sendJson(res, rule.status, { error: rule.error });
    }
    const target = targets[rule.to];
    if (!target) { done(502, rule.to); return sendJson(res, 502, { error: "upstream_not_configured" }); }
    const upstreamPath = rule.strip ? (pathname.slice(rule.prefix.length) || "/") + search : rawUrl;
    const upstream = http.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port,
      method: req.method, path: upstreamPath,
      headers: forwardHeaders(req.rawHeaders, { remoteAddress: req.socket.remoteAddress }),
      setHost: false,
    });
    upstream.setTimeout(120_000, () => upstream.destroy(new Error("upstream_timeout")));
    upstream.on("response", (up) => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, responseHeaders(up.rawHeaders));
      up.pipe(res);
      up.on("end", () => done(up.statusCode, rule.to));
      up.on("error", () => res.destroy());
    });
    upstream.on("error", () => { done(502, rule.to); sendJson(res, 502, { error: "upstream_unavailable" }); });
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  });
}

function targetFrom(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "http:") throw new Error(`${name} must be an http:// loopback URL`);
  return url;
}

async function main() {
  const mode = process.env.PROXY_MODE ?? "door";
  const host = process.env.PROXY_HOST ?? "127.0.0.1";
  const port = Number(process.env.PROXY_PORT ?? (mode === "door" ? 3200 : 3203));
  let server;
  if (mode === "door") {
    const shield = targetFrom("SHIELD_URL"), api = targetFrom("API_URL");
    if (!shield || !api) throw new Error("door mode needs SHIELD_URL and API_URL");
    server = createProxy({ rules: DOOR_RULES, targets: { shield, api }, fallback: { to: "shield" }, log: console.log });
  } else if (mode === "supabase") {
    const pgrst = targetFrom("PGRST_URL");
    if (!pgrst) throw new Error("supabase mode needs PGRST_URL");
    server = createProxy({ rules: SUPABASE_RULES, targets: { pgrst }, fallback: { to: "none", status: 404, error: "not_found" }, log: console.log });
  } else {
    throw new Error(`unknown PROXY_MODE ${mode}`);
  }
  server.keepAliveTimeout = 65_000;
  server.listen(port, host, () => console.log(`proxy(${mode}) listening on http://${host}:${port}`));
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.close(() => process.exit(0)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { console.error(`proxy failed: ${error.message}`); process.exit(2); });
}
