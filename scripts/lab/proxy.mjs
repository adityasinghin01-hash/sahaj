#!/usr/bin/env node
// Zero-dependency path proxy for the joined lab (scripts/lab/lab-up2.sh). Node built-ins only.
//
//   door mode     owns the public port (3100 behind the cloudflared tunnel, 3200 when testing) and forwards by path:
//                 Singhal's apps/api routes -> API_URL, everything else -> SHIELD_URL.
//   supabase mode stands in for the Supabase gateway in front of PostgREST for apps/api's supabase-js client:
//                 /rest/v1/* -> PGRST_URL (prefix stripped). /auth/v1 answers 501: lab auth is verified in apps/api
//                 itself (SAHAJ_LAB_MODE=1, src/lib/lab-auth.ts). /storage/v1 is a small LAB-ONLY object store on disk
//                 (LAB_STORAGE_DIR, service-role key required, HMAC-signed GET URLs) when LAB_STORAGE_DIR is set,
//                 otherwise 501. It implements only what apps/api calls: upload, info, sign, signed GET, remove.
//
// Bodies are streamed byte-for-byte in both directions (webhook signatures cover raw bytes), every end-to-end header is
// kept (including Host and duplicates), hop-by-hop headers are dropped, and X-Forwarded-For/-Proto/-Host are added
// (appended to whatever the tunnel already set). Logs never contain query strings, bodies, headers or secret path parts.
//
// Usage:
//   PROXY_MODE=door PROXY_HOST=127.0.0.1 PROXY_PORT=3200 SHIELD_URL=http://127.0.0.1:3201 API_URL=http://127.0.0.1:3202 node scripts/lab/proxy.mjs
//   PROXY_MODE=supabase PROXY_PORT=3203 PGRST_URL=http://127.0.0.1:3204 node scripts/lab/proxy.mjs
import http from "node:http";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
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
  { prefix: "/storage/v1", to: "storage", strip: true },
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

export const WEB_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

export function defaultWebDir() {
  return process.env.LAB2_WEB_DIR || join(process.env.HOME || homedir(), "dev", "sahaj-riya-web");
}

async function serveWeb(req, res, pathname, dir) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(res, 400, { error: "bad_path" });
    return 400;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    sendJson(res, 400, { error: "bad_path" });
    return 400;
  }
  const root = resolve(dir);
  const rel = decoded === "/" ? "index.html" : `.${decoded}`;
  const candidate = resolve(root, rel);
  if ((candidate !== root && !candidate.startsWith(`${root}${sep}`)) || decoded.split("/").includes("..")) {
    sendJson(res, 403, { error: "forbidden" });
    return 403;
  }

  let file = candidate;
  let st = await stat(file).catch(() => null);
  if (st && st.isDirectory()) {
    sendJson(res, 404, { error: "not_found" });
    return 404;
  }
  if (!st || !st.isFile()) {
    if (extname(decoded) !== "") {
      sendJson(res, 404, { error: "not_found" });
      return 404;
    }
    file = resolve(root, "index.html");
    st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) {
      sendJson(res, 404, { error: "not_found" });
      return 404;
    }
  }

  const bytes = await readFile(file);
  const ext = extname(file).toLowerCase();
  const isIndex = file === resolve(root, "index.html");
  const headers = {
    "content-type": WEB_CONTENT_TYPES[ext] ?? "application/octet-stream",
    "content-length": bytes.length,
    ...(isIndex ? { "cache-control": "no-store" } : {}),
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") res.end();
  else res.end(bytes);
  return 200;
}

export function createProxy({ rules, targets, fallback, webDir, log = () => {} }) {
  return http.createServer((req, res) => {
    const started = Date.now();
    const rawUrl = req.url ?? "/";
    const q = rawUrl.indexOf("?");
    const pathname = q === -1 ? rawUrl : rawUrl.slice(0, q);
    const search = q === -1 ? "" : rawUrl.slice(q);
    if (!pathname.startsWith("/") || pathname.includes("\\")) return sendJson(res, 400, { error: "bad_path" });
    const { rule, label } = route(rules, pathname, fallback);
    const done = (status, to) => log(`${req.method} ${label} -> ${to} ${status} ${Date.now() - started}ms`);
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      !pathname.startsWith("/api") &&
      (webDir !== undefined ? Boolean(webDir) : rules === DOOR_RULES)
    ) {
      return serveWeb(req, res, pathname, webDir || defaultWebDir()).then(
        (status) => done(status, "web"),
        () => { done(500, "web"); sendJson(res, 500, { error: "web_static_failed" }); },
      );
    }
    if (rule.to === "none") {
      done(rule.status, "local");
      return sendJson(res, rule.status, { error: rule.error });
    }
    const target = targets[rule.to];
    if (typeof target === "function") {
      const sub = rule.strip ? (pathname.slice(rule.prefix.length) || "/") : pathname;
      return Promise.resolve(target(req, res, sub, search)).then((status) => done(status, `${rule.to}(local)`),
        () => { done(500, rule.to); sendJson(res, 500, { error: "local_handler_failed" }); });
    }
    if (!target) {
      if (rule.to === "storage") { done(501, "local"); return sendJson(res, 501, { error: "lab_has_no_storage" }); }
      done(502, rule.to); return sendJson(res, 502, { error: "upstream_not_configured" });
    }
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

const SEGMENT = /^[A-Za-z0-9._=-]{1,128}$/;
/** Validated [bucket, ...segments] or null. No "..", no empty segments, no encoded separators. */
function objectPath(raw) {
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  const parts = decoded.split("/").filter((p) => p.length > 0);
  if (parts.length < 2 || parts.length > 12 || parts.some((p) => !SEGMENT.test(p) || p === "." || p === "..")) return null;
  return parts;
}
async function readBody(req, max) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw Object.assign(new Error("too_large"), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

/**
 * LAB-ONLY stand-in for Supabase Storage (never used outside scripts/lab). Objects live under `dir/<bucket>/<path>` with
 * a `.meta.json` sidecar (content type, size). Every call except a signed GET needs the service-role key that
 * apps/api sends; signed GET URLs carry an HMAC over bucket/path/expiry with a per-process secret.
 */
// `index` mirrors Supabase Storage's storage.objects row (create_family_voice_post checks it): put(bucket, name, id) after
// the bytes are written, remove(bucket, name) after a delete. Optional so unit tests run without a database.
export function createLabStorage({ dir, serviceKey, signingSecret = randomBytes(32).toString("hex"), maxBytes = 20 * 1024 * 1024, now = () => Date.now(), index = null }) {
  const fileOf = (parts) => join(dir, ...parts);
  const sign = (key, exp) => createHmac("sha256", signingSecret).update(`${key}\n${exp}`).digest("base64url");
  const authorized = (req) => {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(bearer || String(req.headers.apikey ?? "")), b = Buffer.from(serviceKey);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  return async (req, res, sub, search) => {
    const m = sub.match(/^\/object(?:\/(info|sign))?\/(.+)$/);
    if (!m) { sendJson(res, 404, { statusCode: "404", error: "not_found" }); return 404; }
    const [, verb, rest] = m;
    const parts = objectPath(rest);
    if (!parts) { sendJson(res, 400, { statusCode: "400", error: "invalid_key" }); return 400; }
    const key = parts.join("/"), file = fileOf(parts);
    if (verb === "sign" && req.method === "GET") {
      const qs = new URLSearchParams(search.replace(/^\?/, ""));
      const [exp, sig] = String(qs.get("token") ?? "").split(".");
      const expected = /^\d+$/.test(exp ?? "") ? sign(key, exp) : "";
      const good = !!sig && !!expected && Number(exp) > now() && sig.length === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
      if (!good) { sendJson(res, 400, { statusCode: "400", error: "invalid_signature" }); return 400; }
      try {
        const meta = JSON.parse(await readFile(`${file}.meta.json`, "utf8"));
        const bytes = await readFile(file);
        res.writeHead(200, { "content-type": meta.contentType, "content-length": bytes.length, "cache-control": "no-store" });
        res.end(bytes); return 200;
      } catch { sendJson(res, 404, { statusCode: "404", error: "not_found" }); return 404; }
    }
    if (!authorized(req)) { sendJson(res, 403, { statusCode: "403", error: "unauthorized" }); return 403; }
    if (verb === "sign" && req.method === "POST") {
      let expiresIn = 60;
      try { expiresIn = Number(JSON.parse((await readBody(req, 4096)).toString("utf8")).expiresIn); } catch { /* default */ }
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 7 * 86400) { sendJson(res, 400, { statusCode: "400", error: "invalid_expiry" }); return 400; }
      try { await stat(file); } catch { sendJson(res, 404, { statusCode: "404", error: "not_found" }); return 404; }
      const exp = String(now() + expiresIn * 1000);
      sendJson(res, 200, { signedURL: `/object/sign/${parts.map(encodeURIComponent).join("/")}?token=${exp}.${sign(key, exp)}` }); return 200;
    }
    if (verb === "info" && req.method === "GET") {
      try {
        const meta = JSON.parse(await readFile(`${file}.meta.json`, "utf8"));
        sendJson(res, 200, { id: meta.id, name: parts.slice(1).join("/"), bucket_id: parts[0], size: meta.size, content_type: meta.contentType, created_at: meta.createdAt });
        return 200;
      } catch { sendJson(res, 404, { statusCode: "404", error: "not_found" }); return 404; }
    }
    if (!verb && (req.method === "POST" || req.method === "PUT")) {
      const type = String(req.headers["content-type"] ?? "application/octet-stream");
      if (type.startsWith("multipart/")) { sendJson(res, 415, { statusCode: "415", error: "lab_storage_raw_bodies_only" }); return 415; }
      let bytes;
      try { bytes = await readBody(req, maxBytes); } catch (e) { sendJson(res, e.status ?? 400, { statusCode: String(e.status ?? 400), error: "payload_too_large" }); return e.status ?? 400; }
      const upsert = req.method === "PUT" || String(req.headers["x-upsert"]) === "true";
      const exists = await stat(file).then(() => true, () => false);
      if (exists && !upsert) { sendJson(res, 400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" }); return 400; }
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const id = randomUUID();
      await writeFile(file, bytes, { mode: 0o600 });
      await writeFile(`${file}.meta.json`, JSON.stringify({ id, size: bytes.length, contentType: type, createdAt: new Date(now()).toISOString() }), { mode: 0o600 });
      if (index) {
        try { await index.put(parts[0], parts.slice(1).join("/"), id); } catch {
          await rm(file, { force: true }); await rm(`${file}.meta.json`, { force: true });
          sendJson(res, 503, { statusCode: "503", error: "storage_index_failed" }); return 503;
        }
      }
      sendJson(res, 200, { Id: id, Key: key }); return 200;
    }
    if (!verb && req.method === "DELETE" && parts.length >= 1) {
      sendJson(res, 400, { statusCode: "400", error: "use_bucket_delete" }); return 400;
    }
    sendJson(res, 405, { statusCode: "405", error: "method_not_allowed" }); return 405;
  };
}

/** DELETE /object/<bucket> { prefixes: [...] } (storage-js remove). Separate because the key is in the body. */
export function withLabStorageRemove(handler, { dir, serviceKey, index = null }) {
  return async (req, res, sub, search) => {
    const m = sub.match(/^\/object\/([A-Za-z0-9._-]{1,128})\/?$/);
    if (!(req.method === "DELETE" && m)) return handler(req, res, sub, search);
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(bearer), b = Buffer.from(serviceKey);
    if (!(a.length === b.length && timingSafeEqual(a, b))) { sendJson(res, 403, { statusCode: "403", error: "unauthorized" }); return 403; }
    let prefixes = [];
    try { prefixes = JSON.parse((await readBody(req, 65536)).toString("utf8")).prefixes ?? []; } catch { /* none */ }
    const removed = [];
    for (const p of Array.isArray(prefixes) ? prefixes : []) {
      const parts = objectPath(`${m[1]}/${p}`);
      if (!parts) continue;
      const file = join(dir, ...parts);
      try { await rm(file); await rm(`${file}.meta.json`, { force: true }); removed.push({ name: parts.slice(1).join("/"), bucket_id: m[1] }); } catch { /* absent */ }
      if (index) await index.remove(parts[0], parts.slice(1).join("/")).catch(() => undefined);
    }
    sendJson(res, 200, removed); return 200;
  };
}

/** storage.objects mirror over a loopback Postgres connection (lab only; the URL carries no password). */
async function labStorageIndex(url) {
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(url).hostname)) throw new Error("LAB_STORAGE_DB_URL must be loopback");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  return {
    put: (bucket, name, id) => pool.query(`insert into storage.objects(id, bucket_id, name) values ($1, $2, $3)
      on conflict (id) do nothing`, [id, bucket, name]).then(() => pool.query(
      `delete from storage.objects where bucket_id = $1 and name = $2 and id <> $3`, [bucket, name, id])),
    remove: (bucket, name) => pool.query(`delete from storage.objects where bucket_id = $1 and name = $2`, [bucket, name]),
  };
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
    const dir = process.env.LAB_STORAGE_DIR, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const index = dir && process.env.LAB_STORAGE_DB_URL ? await labStorageIndex(process.env.LAB_STORAGE_DB_URL) : null;
    const storage = dir && serviceKey && serviceKey.length >= 32 ? withLabStorageRemove(createLabStorage({ dir, serviceKey, index }), { dir, serviceKey, index }) : null;
    server = createProxy({ rules: SUPABASE_RULES, targets: { pgrst, ...(storage ? { storage } : {}) }, fallback: { to: "none", status: 404, error: "not_found" }, log: console.log });
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
