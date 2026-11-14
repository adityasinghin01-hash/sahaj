import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import postgres from "postgres";
const base = process.env.BASE_URL,
  token = process.env.LAB_TOKEN;
const F = "11111111-1111-4111-8111-111111111111",
  P = "22222222-2222-4222-8222-222222222221";
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 2 });
let checks = 0;
async function call(path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": "e2e-app-pair-request",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  return { status: response.status, data };
}
function ok(value, label) {
  assert.ok(value, label);
  checks++;
  console.log(`PASS ${label}`);
}
try {
  const noAuth = await call("/api/app/shield/summary", undefined, {
    Authorization: "",
  });
  ok(noAuth.status === 401, "app requires bearer auth");
  const foreign = await call(
    "/api/app/shield/summary?family_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  ok(foreign.status === 403, "foreign family rejected");
  const pair = await call("/api/app/shield/pair-code", {});
  ok(
    pair.status === 200 && /^\d{6}$/.test(pair.data.code),
    "child creates one-time pairing code",
  );
  const pairReplay = await call("/api/app/shield/pair-code", {});
  ok(
    pairReplay.data.code === pair.data.code,
    "pair request idempotency replays same code",
  );
  const device = await call("/api/shield/pair", {
    code: pair.data.code,
    parent_person_id: P,
    label: "Synthetic Maa phone",
    platform: "android",
    protections: { sms: true, screening: true, notifications: true },
  });
  ok(
    device.status === 200 && device.data.device_secret,
    "fake phone pairs through real route",
  );
  const pairAgain = await call("/api/shield/pair", {
    code: pair.data.code,
    parent_person_id: P,
    platform: "android",
  });
  ok(pairAgain.status === 400, "pair code single-use");
  const body = JSON.stringify({
    idempotency_key: `app-e2e-${randomUUID()}`,
    family_id: F,
    parent_id: P,
    device_id: device.data.device_id,
    channel: "device",
    kind: "sms",
    occurred_at: new Date().toISOString(),
    masked_text:
      "CBI officer arrest warrant money laundering stay on video call do not disconnect the call",
    sender_type: "mobile_10",
    link_domains: [],
    matched_rules: [],
    local_level: "red",
    context: {},
  });
  const ts = String(Date.now()),
    signature = createHmac("sha256", device.data.device_secret)
      .update(`${ts}.${body}`)
      .digest("hex");
  const event = await fetch(`${base}/api/shield/event`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-shield-device": device.data.device_id,
      "x-shield-ts": ts,
      "x-shield-sig": signature,
    },
    body,
  });
  ok(event.status === 200, "signed scam SMS accepted");
  const deadline = Date.now() + 10000;
  let alert;
  while (Date.now() < deadline) {
    const result = await call("/api/app/shield/alerts");
    assert.equal(result.status, 200);
    alert = result.data.alerts.find((a) => a.level === "red");
    if (alert) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  ok(alert, "red verdict visible to child within ten seconds");
  const detail = await call(`/api/app/shield/alerts/${alert.id}`);
  ok(
    detail.status === 200 && detail.data.reasons.length > 0,
    "live alert detail reasons",
  );
  const feedback = await call(`/api/app/shield/alerts/${alert.id}/feedback`, {
    answer: "fraud",
  });
  ok(
    feedback.status === 200 && feedback.data.feedback === "fraud",
    "real child feedback persisted",
  );
  const repeat = await call(`/api/app/shield/alerts/${alert.id}/feedback`, {
    answer: "fraud",
  });
  ok(repeat.status === 200 && repeat.data.repeated, "feedback idempotent");
  const conflict = await call(`/api/app/shield/alerts/${alert.id}/feedback`, {
    answer: "safe",
  });
  ok(conflict.status === 409, "opposite feedback conflicts");
  const summary = await call("/api/app/shield/summary");
  ok(
    summary.status === 200 &&
      summary.data.checks_this_week >= 1 &&
      summary.data.frauds_stopped >= 1,
    "summary reflects event and red verdict",
  );
  ok(
    summary.data.devices.some(
      (d) => d.id === device.data.device_id && d.protections.sms,
    ),
    "paired device protections are real",
  );
  const feed = await call("/api/app/shield/alerts");
  const next = await call(
    "/api/app/shield/alerts?since=" + encodeURIComponent(feed.data.next_cursor),
  );
  ok(
    next.status === 200 && next.data.alerts.length === 0,
    "poll cursor catches up without duplicates",
  );
  const timeline = await call("/api/app/timeline");
  ok(
    timeline.status === 200 && timeline.data.rows.length > 0,
    "signed action timeline populated",
  );
  const verified = await call("/api/app/timeline/verify");
  ok(
    verified.status === 200 && verified.data.valid && verified.data.checked > 0,
    "real SHA-256 timeline verifies",
  );
  const evidence = await call(`/api/app/shield/evidence/${alert.id}`);
  ok(
    evidence.status === 200 && evidence.data.copy_for_1930.includes("1930"),
    "runtime evidence pack exports from signed checkpoint",
  );
  const push = await call("/api/app/push-token", {
    expo_token: "ExpoPushToken[synthetic-lab]",
  });
  ok(push.status === 200, "push registration accepted");
  const [stored] =
    await sql`select count(*)::int as count from public.app_push_tokens`;
  ok(stored.count === 1, "push token persisted");
  // A second authenticated family member must never obtain a full evidence pack.
  const b64 = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
  const data = `${b64({ alg: "HS256" })}.${b64({ sub: "33333333-3333-4333-8333-333333333334", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  const circleToken = `${data}.${createHmac("sha256", process.env.SUPABASE_JWT_SECRET).update(data).digest("base64url")}`;
  const circle = await call(`/api/app/shield/evidence/${alert.id}`, undefined, {
    Authorization: `Bearer ${circleToken}`,
  });
  ok(circle.status === 403, "circle evidence access denied");
  // RLS is on and API roles have no push-token table grants.
  const [rls] =
    await sql`select relrowsecurity from pg_class where oid='public.app_push_tokens'::regclass`;
  const [grants] =
    await sql`select has_table_privilege('authenticated','public.app_push_tokens','insert') as write, has_table_privilege('anon','public.app_push_tokens','select') as read`;
  ok(
    rls.relrowsecurity && !grants.write && !grants.read,
    "push token RLS service-role only",
  );
  console.log(`APP_E2E_CHECKS: ${checks} passed`);
} finally {
  await sql.end();
}
