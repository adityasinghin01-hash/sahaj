#!/usr/bin/env node
// Joined-lab smoke test through the ONE door (scripts/lab/lab-up2.sh). Synthetic demo family only.
//
//   set -a; source ~/dev/sahaj-secrets/shield.env; set +a
//   LAB_DOOR_URL=http://127.0.0.1:3200 node scripts/lab/joined-smoke.mjs
//
// Checks: both apps' health; lab JWT login on apps/api (good token passes, forged/missing token is refused);
// Core 2 going-home watch create -> "Main safe hoon"; one Core 1 command (check-in for Maa); a signed Shield device
// event (valid signature accepted, one changed byte refused). With TWILIO_AUTH_TOKEN + TWILIO_STATUS_CALLBACK_URL in
// the env (they must match the running apps/api) it also signs a Twilio status callback (valid accepted, tampered 401).
// Prints statuses and ids only; never tokens, secrets or numbers. Exits 1 on any failed check.
import { createHmac, randomUUID } from "node:crypto";

const DOOR = (process.env.LAB_DOOR_URL || "http://127.0.0.1:3200").replace(/\/$/, "");
const SECRET = process.env.SUPABASE_JWT_SECRET;
if (!SECRET || SECRET.length < 32) { console.error("SUPABASE_JWT_SECRET (>= 32 chars) is required"); process.exit(2); }
const FAMILY = "11111111-1111-4111-8111-111111111111";
const MAA = "22222222-2222-4222-8222-222222222221";
const RIYA_USER = "33333333-3333-4333-8333-333333333332";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint(sub, secret = SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, role: "authenticated", iat: now, exp: now + 3600 })}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}
const riya = mint(RIYA_USER);

let failed = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed += 1;
}
async function call(path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${DOOR}${path}`, { method, headers, body: typeof body === "string" || body === undefined ? body : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
  return { status: res.status, data };
}
const json = { "content-type": "application/json" };
const asRiya = (extra = {}) => ({ ...json, authorization: `Bearer ${riya}`, ...extra });

// 1. Health of both apps through the door.
const h1 = await call("/api/health");
check("shield-api /api/health via door", h1.status === 200 && h1.data?.ok === true, `status ${h1.status}, db ${h1.data?.db}`);
const h2 = await call("/api/health/readiness");
check("apps/api /api/health/readiness via door", h2.status === 200 && h2.data?.database?.status === "connected", `status ${h2.status}, db ${h2.data?.database?.status}`);

// 2. Lab login on apps/api.
const noAuth = await call("/api/core2/watches", { method: "POST", headers: { ...json, "idempotency-key": randomUUID() }, body: {} });
check("apps/api refuses a missing bearer", noAuth.status === 401, `status ${noAuth.status}`);
const forged = await call("/api/core2/watches", { method: "POST", headers: { ...json, authorization: `Bearer ${mint(RIYA_USER, "x".repeat(40))}`, "idempotency-key": randomUUID() }, body: { eta_minutes: 20, from_label: "Office", to_label: "Home" } });
check("apps/api refuses a token signed with another secret", forged.status === 401, `status ${forged.status}`);

// 3. Core 2: create a going-home watch, then "Main safe hoon".
const watch = await call("/api/core2/watches", {
  method: "POST", headers: asRiya({ "idempotency-key": `smoke-watch-${randomUUID()}` }),
  body: { eta_minutes: 25, grace_minutes: 10, from_label: "Office", to_label: "Home" },
});
const watchId = watch.data?.watch?.id ?? watch.data?.watch_id ?? watch.data?.id;
check("Core 2 create watch (lab JWT)", watch.status >= 200 && watch.status < 300 && typeof watchId === "string", `status ${watch.status}, watch ${watchId ?? JSON.stringify(watch.data).slice(0, 160)}`);
if (watchId) {
  const safe = await call(`/api/core2/watches/${watchId}/safe`, { method: "POST", headers: asRiya({ "idempotency-key": `smoke-safe-${randomUUID()}` }), body: {} });
  const state = safe.data?.watch?.state ?? safe.data?.state ?? safe.data?.status;
  check("Core 2 watch -> safe", safe.status >= 200 && safe.status < 300, `status ${safe.status}, state ${state ?? JSON.stringify(safe.data).slice(0, 160)}`);
}

// 4. Core 1: one command (check-in for Maa, by Riya).
const c1 = await call("/api/core1/check-in", {
  method: "POST", headers: asRiya({ "idempotency-key": `smoke-c1-${randomUUID()}` }),
  body: { person_id: MAA, preferred_time: "09:30", timezone: "Asia/Kolkata" },
});
check("Core 1 check-in command (lab JWT)", c1.status === 202, `status ${c1.status}, ${JSON.stringify(c1.data).slice(0, 160)}`);

// 5. Shield: pair a lab device, then a signed device event (valid accepted; one changed byte refused).
const code = await call("/api/app/shield/pair-code", { method: "POST", headers: asRiya({ "idempotency-key": `smoke-pair-${randomUUID()}` }), body: {} });
const pair = code.data?.code ? await call("/api/shield/pair", {
  method: "POST", headers: json,
  body: { code: code.data.code, parent_person_id: MAA, label: "Joined smoke phone", platform: "android",
    protections: { sms: true, screening: true, redirection: true, usage: true, notifications: true, overlay: true } },
}) : { status: code.status, data: null };
check("Shield pair device via door", pair.status === 200 && !!pair.data?.device_secret, `status ${pair.status}`);
if (pair.data?.device_secret) {
  const event = JSON.stringify({ idempotency_key: `smoke-${randomUUID()}`, family_id: FAMILY, parent_id: MAA, device_id: pair.data.device_id,
    channel: "device", occurred_at: new Date().toISOString(), link_domains: [], matched_rules: [], context: {},
    kind: "sms", sender_type: "mobile_10", text: "Namaste Maa, dinner at 8?" });
  const ts = String(Date.now());
  const sig = createHmac("sha256", pair.data.device_secret).update(`${ts}.${event}`).digest("hex");
  const headers = { ...json, "x-shield-device": pair.data.device_id, "x-shield-ts": ts, "x-shield-sig": sig };
  const good = await call("/api/shield/event", { method: "POST", headers, body: event });
  check("Shield signed device event accepted through door", good.status === 200, `status ${good.status}, level ${good.data?.verdict?.level ?? good.data?.level ?? "?"}`);
  const tampered = await call("/api/shield/event", { method: "POST", headers, body: event.replace("dinner", "dinnel") });
  check("Shield tampered device event refused", tampered.status === 401, `status ${tampered.status}`);
}

// 6. Optional: Twilio status callback signature through the door (apps/api verifies over its configured public URL).
const { TWILIO_AUTH_TOKEN: tToken, TWILIO_STATUS_CALLBACK_URL: tUrl, TWILIO_ACCOUNT_SID: tSid } = process.env;
if (tToken && tUrl && tSid) {
  const params = new URLSearchParams({ AccountSid: tSid, CallSid: `CA${"0".repeat(32)}`, CallStatus: "completed", To: "+910000000000", From: "+910000000001" });
  const sorted = [...new Set(params.keys())].sort();
  const data = tUrl + sorted.map((k) => params.getAll(k).map((v) => k + v).join("")).join("");
  const tsig = createHmac("sha1", tToken).update(data).digest("base64");
  const form = { "content-type": "application/x-www-form-urlencoded" };
  const ok = await call("/api/twilio/status", { method: "POST", headers: { ...form, "x-twilio-signature": tsig }, body: params.toString() });
  // apps/api answers 401 only for a bad signature; a synthetic CallSid then fails later as 403 unknown_call.
  check("Twilio signed status callback passes signature check through door", ok.status !== 401, `status ${ok.status}, ${JSON.stringify(ok.data).slice(0, 120)}`);
  params.set("CallStatus", "failed");
  const bad = await call("/api/twilio/status", { method: "POST", headers: { ...form, "x-twilio-signature": tsig }, body: params.toString() });
  check("Twilio tampered status callback refused", bad.status === 401, `status ${bad.status}`);
} else {
  console.log("SKIP  Twilio signature (TWILIO_AUTH_TOKEN / TWILIO_STATUS_CALLBACK_URL / TWILIO_ACCOUNT_SID not set)");
}

console.log(`\nJOINED_SMOKE: ${failed === 0 ? "PASS" : `FAIL (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
