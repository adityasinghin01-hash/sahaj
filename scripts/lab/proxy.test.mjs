// node --test scripts/lab/proxy.test.mjs   (loopback only, no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createProxy, DOOR_RULES, SUPABASE_RULES, route } from "./proxy.mjs";

function echo(name) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      res.setHeader("x-upstream", name);
      res.setHeader("set-cookie", ["a=1", "b=2"]);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ name, url: req.url, sha: createHash("sha256").update(body).digest("hex"), headers: req.headers, raw: req.rawHeaders }));
    });
  });
}
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(new URL(`http://127.0.0.1:${s.address().port}`))));

test("routing table", () => {
  const r = (p) => route(DOOR_RULES, p, { to: "shield" }).rule.to;
  assert.equal(r("/api/core1"), "api");
  assert.equal(r("/api/core1/check-in"), "api");
  assert.equal(r("/api/core2/watches/x/safe"), "api");
  assert.equal(r("/api/core10"), "shield");
  assert.equal(r("/api/twilio/status"), "api");
  assert.equal(r("/api/missed-call/s3cret"), "api");
  assert.equal(r("/api/sarvam/post-call/s3cret"), "api");
  assert.equal(r("/api/sarvam/tool/ping"), "api");
  assert.equal(r("/api/sarvam/tool/lookup_contact"), "shield");
  assert.equal(r("/api/sarvam/webhook/s3cret"), "shield");
  assert.equal(r("/api/health"), "shield");
  assert.equal(r("/api/health/readiness"), "api");
  assert.equal(r("/api/whatsapp"), "api");
  assert.equal(r("/api/whatsapp/webhook"), "shield");
  assert.equal(r("/api/cron/tick"), "api");
  assert.equal(r("/api/cron/shield-jobs"), "shield");
  assert.equal(r("/api/shield/event"), "shield");
  // Secret path tails never reach the log label.
  assert.equal(route(DOOR_RULES, "/api/missed-call/s3cret", { to: "shield" }).label, "/api/missed-call/…");
  assert.equal(route(DOOR_RULES, "/api/sarvam/webhook/s3cret", { to: "shield" }).label, "/api/sarvam/webhook/…");
});

test("door streams bytes unchanged, keeps headers, adds X-Forwarded-*", async (t) => {
  const shield = echo("shield"), api = echo("api");
  const [su, au] = [await listen(shield), await listen(api)];
  const logs = [];
  const proxy = createProxy({ rules: DOOR_RULES, targets: { shield: su, api: au }, fallback: { to: "shield" }, log: (l) => logs.push(l) });
  const pu = await listen(proxy);
  t.after(() => { proxy.close(); shield.close(); api.close(); });

  const body = randomBytes(256 * 1024);
  const res = await fetch(new URL("/api/twilio/status?x=1", pu), {
    method: "POST", body,
    headers: { "x-twilio-signature": "sig==", "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" },
  });
  const out = await res.json();
  assert.equal(out.name, "api");
  assert.equal(out.url, "/api/twilio/status?x=1");
  assert.equal(out.sha, createHash("sha256").update(body).digest("hex"));
  assert.equal(out.headers["x-twilio-signature"], "sig==");
  assert.equal(out.headers.host, pu.host);
  assert.equal(out.headers["x-forwarded-for"], "203.0.113.9, 127.0.0.1");
  assert.equal(out.headers["x-forwarded-proto"], "https");
  assert.equal(out.headers["x-forwarded-host"], pu.host);
  assert.deepEqual(res.headers.getSetCookie(), ["a=1", "b=2"]);

  const s = await (await fetch(new URL("/api/shield/event", pu), { method: "POST", body: "{}" })).json();
  assert.equal(s.name, "shield");
  assert.ok(logs.every((l) => !l.includes("x=1")));
});

test("supabase gateway strips /rest/v1 and refuses auth/storage", async (t) => {
  const pg = echo("pgrst");
  const pgu = await listen(pg);
  const proxy = createProxy({ rules: SUPABASE_RULES, targets: { pgrst: pgu }, fallback: { to: "none", status: 404, error: "not_found" } });
  const pu = await listen(proxy);
  t.after(() => { proxy.close(); pg.close(); });
  const out = await (await fetch(new URL("/rest/v1/rpc/foundation_readiness?select=*", pu), { method: "POST", body: "{}" })).json();
  assert.equal(out.url, "/rpc/foundation_readiness?select=*");
  assert.equal((await fetch(new URL("/auth/v1/user", pu))).status, 501);
  assert.equal((await fetch(new URL("/storage/v1/object/x", pu))).status, 501);
  assert.equal((await fetch(new URL("/other", pu))).status, 404);
});

test("upstream down -> 502 JSON", async (t) => {
  const dead = new URL("http://127.0.0.1:1");
  const proxy = createProxy({ rules: DOOR_RULES, targets: { shield: dead, api: dead }, fallback: { to: "shield" } });
  const pu = await listen(proxy);
  t.after(() => proxy.close());
  const res = await fetch(new URL("/api/health", pu));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "upstream_unavailable" });
});
