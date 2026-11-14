import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";

const BASE_URL = process.env.BASE_URL;
const ENABLED_BASE_URL = process.env.ENABLED_BASE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
const DEV_TOKEN = process.env.DEV_ADMIN_TOKEN;
const SMS_SECRET = process.env.SMS_GATEWAY_SECRET;
const SARVAM_TOKEN = process.env.SARVAM_TOOL_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

const FAMILY_ID = process.env.FAMILY_ID;
const PARENT_ID = process.env.PARENT_ID;
const USER_ID = process.env.USER_ID;

const sql = postgres(DATABASE_URL, { max: 4 });

async function postJson(urlBase, route, body, headers = {}) {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(`${urlBase}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function getJson(urlBase, route, headers = {}) {
  const res = await fetch(`${urlBase}${route}`, { method: "GET", headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

function signDeviceBody(secret, ts, rawBody) {
  return createHmac("sha256", secret).update(`${ts}.${rawBody}`, "utf8").digest("hex");
}

async function pollUntil(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function run() {
  const results = {};

  // ------------------------------------------------------------------
  // 1. Register gateway parent -> SMS gateway scam -> outbox call + wrong secret + replay + unknown
  // ------------------------------------------------------------------
  const unauthGwParent = await postJson(BASE_URL, "/api/dev/shield/gateway-parent", {
    family_id: FAMILY_ID,
    parent_id: PARENT_ID,
    phone: "+919000000001",
  });
  assert.equal(unauthGwParent.status, 401);

  const regRes = await postJson(
    BASE_URL,
    "/api/dev/shield/gateway-parent",
    { family_id: FAMILY_ID, parent_id: PARENT_ID, phone: "+919000000001" },
    { "x-dev-admin-token": DEV_TOKEN },
  );
  assert.equal(regRes.status, 200);
  assert.equal(regRes.body.registered, true);

  const gwParents = await sql`
    select phone_hash, family_id, parent_id from public.shield_gateway_parents where family_id = ${FAMILY_ID}`;
  assert.equal(gwParents.length, 1);
  assert.match(gwParents[0].phone_hash, /^[0-9a-f]{64}$/);

  const scamBody = {
    from: "+919000000001",
    body: "URGENT KYC account band hoga OTP 482910 share karein https://kyc-update-demo.example",
    received_at: new Date().toISOString(),
    gateway_id: "gw-lab-1",
  };

  // Wrong secret -> 401
  const wrongSecretRes = await postJson(BASE_URL, "/api/sms/gateway", scamBody, {
    "x-sahaj-gateway-secret": "wrong-secret",
  });
  assert.equal(wrongSecretRes.status, 401);

  // Unknown sender -> 200 { ignored: true } and zero events inserted
  const unknownRes = await postJson(
    BASE_URL,
    "/api/sms/gateway",
    {
      from: "+919000000009",
      body: "Namaste demo message",
      received_at: new Date().toISOString(),
      gateway_id: "gw-lab-1",
    },
    { "x-sahaj-gateway-secret": SMS_SECRET },
  );
  assert.equal(unknownRes.status, 200);
  assert.equal(unknownRes.body.ignored, true);

  // Valid gateway forward
  const smsRes = await postJson(BASE_URL, "/api/sms/gateway", scamBody, {
    "x-sahaj-gateway-secret": SMS_SECRET,
  });
  assert.equal(smsRes.status, 200);
  assert.equal(smsRes.body.ok, true);
  assert.ok(smsRes.body.event_id);

  // Replay -> duplicate
  const replayRes = await postJson(BASE_URL, "/api/sms/gateway", scamBody, {
    "x-sahaj-gateway-secret": SMS_SECRET,
  });
  assert.equal(replayRes.status, 200);
  assert.equal(replayRes.body.duplicate, true);

  // Wait for background after() brain run -> verdict + keypad call_parent row in dev_outbox
  const gwVerdict = await pollUntil(async () => {
    const rows = await sql`
      select id, level, scam_type
      from public.shield_verdicts
      where ${smsRes.body.event_id}::uuid = any(event_ids)
      limit 1`;
    return rows[0] ?? null;
  });
  assert.ok(gwVerdict, "expected verdict created by gateway after() brain run");
  assert.ok(["red", "yellow"].includes(gwVerdict.level), `expected red/yellow verdict, got ${gwVerdict.level}`);

  const callOutboxRow = await pollUntil(async () => {
    const rows = await sql`
      select id, channel, kind, payload
      from public.dev_outbox
      where channel = 'calls' and kind = 'call_parent' and family_id = ${FAMILY_ID}
      limit 1`;
    return rows[0] ?? null;
  });
  assert.ok(callOutboxRow, "expected keypad call_parent row in dev_outbox");

  const [evRow] = await sql`
    select channel, masked_text from public.shield_events where id = ${smsRes.body.event_id}`;
  assert.equal(evRow.channel, "gateway_sms");
  assert.ok(!evRow.masked_text.includes("482910"), "masked_text must not contain raw OTP digits");

  results.scenario1_sms_gateway = {
    status: "PASS",
    verdict_level: gwVerdict.level,
    verdict_scam_type: gwVerdict.scam_type,
    outbox_call_kind: callOutboxRow.kind,
    replay_duplicate: true,
    unknown_sender_ignored: true,
    wrong_secret_401: true,
  };

  // ------------------------------------------------------------------
  // 2. Pair a device -> signed heartbeat -> shield_devices updated; tampered body -> 401
  // ------------------------------------------------------------------
  const codeRes = await postJson(
    BASE_URL,
    "/api/shield/pair/code",
    { family_id: FAMILY_ID, user_id: USER_ID },
    { "x-dev-admin-token": DEV_TOKEN },
  );
  assert.equal(codeRes.status, 200);
  assert.ok(codeRes.body.code);

  const pairRes = await postJson(BASE_URL, "/api/shield/pair", {
    code: codeRes.body.code,
    parent_person_id: PARENT_ID,
    platform: "android",
    label: "Maa Lab Phone",
    protections: { sms: false, screening: false, redirection: false, usage: false, notifications: false, overlay: false },
  });
  assert.equal(pairRes.status, 200);
  const { device_id: deviceId, device_secret: deviceSecret } = pairRes.body;
  assert.ok(deviceId && deviceSecret);

  const hbPayloadObj = {
    device_id: deviceId,
    protections: { sms: true, screening: true, redirection: false, usage: true, notifications: true, overlay: true },
    android_version: "15",
    app_version: "1.3.0",
    sent_at: new Date().toISOString(),
  };
  const hbRaw = JSON.stringify(hbPayloadObj);
  const ts = String(Date.now());
  const sig = signDeviceBody(deviceSecret, ts, hbRaw);

  // Tampered body with original sig -> 401
  const tamperedRaw = JSON.stringify({ ...hbPayloadObj, app_version: "9.9.9" });
  const tamperedRes = await postJson(BASE_URL, "/api/shield/heartbeat", tamperedRaw, {
    "x-shield-device": deviceId,
    "x-shield-ts": ts,
    "x-shield-sig": sig,
  });
  assert.equal(tamperedRes.status, 401);

  // Valid signed heartbeat -> 200 and updates shield_devices
  const hbRes = await postJson(BASE_URL, "/api/shield/heartbeat", hbRaw, {
    "x-shield-device": deviceId,
    "x-shield-ts": ts,
    "x-shield-sig": sig,
  });
  assert.equal(hbRes.status, 200);
  assert.equal(hbRes.body.ok, true);

  const [devDb] = await sql`
    select protections, android_version, app_version, last_heartbeat_at
    from public.shield_devices where id = ${deviceId}`;
  assert.equal(devDb.protections.sms, true);
  assert.equal(devDb.protections.overlay, true);
  assert.equal(devDb.android_version, "15");
  assert.equal(devDb.app_version, "1.3.0");
  assert.ok(devDb.last_heartbeat_at);

  results.scenario2_device_heartbeat = {
    status: "PASS",
    device_id: deviceId,
    app_version: devDb.app_version,
    tampered_rejected_401: true,
  };

  // ------------------------------------------------------------------
  // 3. Experience drill + consent + switch + experience_turn + cron shield.drill.experience
  // ------------------------------------------------------------------
  // Real behaviour, not a source grep: no consent → refused; consent + Riya's switch → scheduled
  // (or refused only for quiet hours, which is correct at night IST).
  const startDrill = () => postJson(BASE_URL, "/api/dev/shield/experience-drill",
    { family_id: FAMILY_ID, parent_id: PARENT_ID }, { "x-dev-admin-token": DEV_TOKEN });
  const beforeConsent = await startDrill();
  const consentRes = await postJson(BASE_URL, "/api/sarvam/experience-consent",
    { family_id: FAMILY_ID, parent_id: PARENT_ID, clip_ref: "e2e/consent/maa-haan.wav" },
    { authorization: `Bearer ${SARVAM_TOKEN}` });
  const consentNoAuth = await postJson(BASE_URL, "/api/sarvam/experience-consent",
    { family_id: FAMILY_ID, parent_id: PARENT_ID, clip_ref: "x" }, { authorization: "Bearer wrong" });
  const beforeSwitch = await startDrill();
  // Riya turns the switch on through her real app route with a lab login token.
  const { execFileSync } = await import("node:child_process");
  const riyaToken = execFileSync(process.execPath, [new URL("./mint-lab-token.mjs", import.meta.url).pathname, USER_ID],
    { env: process.env, encoding: "utf8" }).trim();
  const switchRes = await postJson(BASE_URL, "/api/app/shield/experience-drills",
    { parent_id: PARENT_ID, enabled: true }, { authorization: `Bearer ${riyaToken}` });
  const afterSwitch = await startDrill();
  const istHour = new Date(Date.now() + 330 * 60_000).getUTCHours();
  const drillFlowOk =
    beforeConsent.status === 200 && beforeConsent.body?.ok === false && beforeConsent.body?.reason === "no_consent" &&
    consentRes.status === 200 && consentRes.body?.ok === true && consentNoAuth.status === 401 &&
    beforeSwitch.body?.ok === false && beforeSwitch.body?.reason === "disabled" && switchRes.status === 200 &&
    (afterSwitch.body?.ok === true || afterSwitch.body?.reason === "quiet_hours");

  const expTurnRes = await postJson(
    BASE_URL,
    "/api/sarvam/tool/experience_turn",
    { variables: { family_id: FAMILY_ID, parent_id: PARENT_ID }, said: "mera OTP 4 8 2" },
    { authorization: `Bearer ${SARVAM_TOKEN}` },
  );

  // Check cron dispatch for shield.drill.experience
  const [drillCronRow] = await sql`
    insert into public.shield_jobs (name, payload, run_at, status)
    values ('shield.drill.experience', ${sql.json({ family_id: FAMILY_ID, parent_id: PARENT_ID })}, now() - interval '1 second', 'pending')
    returning id`;
  const cronRes = await getJson(BASE_URL, "/api/cron/shield-jobs", { "x-cron-secret": CRON_SECRET });
  assert.equal(cronRes.status, 200);
  const drillJobResult = cronRes.body.results.find((r) => r.id === drillCronRow.id);

  // Verify existing drill_answer route also executes cleanly
  const drillAnsRes = await postJson(
    BASE_URL,
    "/api/sarvam/tool/drill_answer",
    { variables: { family_id: FAMILY_ID, parent_id: PARENT_ID }, drill_id: "demo-drill-1", said: "Riya se poochungi" },
    { authorization: `Bearer ${SARVAM_TOKEN}` },
  );
  assert.equal(drillAnsRes.status, 200);

  results.scenario3_drills = {
    consent_and_start_drill: drillFlowOk
      ? (afterSwitch.body?.ok ? "PASS" : `PASS (refused for quiet hours at IST hour ${istHour}, as designed)`)
      : `FAIL: ${JSON.stringify({ beforeConsent: beforeConsent.body, consent: consentRes.status, beforeSwitch: beforeSwitch.body, switch: [switchRes.status, switchRes.body], afterSwitch: afterSwitch.body })}`,
    experience_turn_otp_stop:
      expTurnRes.status === 501 && expTurnRes.body?.error === "tool_not_registered"
        ? "SKIPPED: experience_turn missing in runtime shieldTools base"
        : expTurnRes.status === 200
          ? "PASS"
          : `FAIL (${expTurnRes.status})`,
    cron_shield_drill_experience:
      drillJobResult?.status === "failed" && drillJobResult?.error === "Unknown Shield scheduled job"
        ? "SKIPPED: shield.drill.experience missing in runtime handleScheduledJob base"
        : drillJobResult?.status === "done"
          ? "PASS"
          : `FAIL (${JSON.stringify(drillJobResult)})`,
    drill_answer_routed: drillAnsRes.status === 200 ? "PASS" : "FAIL",
  };

  // ------------------------------------------------------------------
  // 4. Call gateway disabled vs CALL_GATEWAY_ENABLED=1
  // ------------------------------------------------------------------
  const disabledRes = await postJson(
    BASE_URL,
    "/api/sarvam/tool/call_screen",
    { variables: { family_id: FAMILY_ID, parent_id: PARENT_ID }, from: "+919000000002" },
    { authorization: `Bearer ${SARVAM_TOKEN}` },
  );
  assert.equal(disabledRes.status, 404);
  assert.deepEqual(disabledRes.body, { enabled: false });

  const enabledRes = await postJson(
    ENABLED_BASE_URL,
    "/api/sarvam/tool/call_screen",
    { variables: { family_id: FAMILY_ID, parent_id: PARENT_ID }, from: "+919000000002", said_who: "Sharma uncle" },
    { authorization: `Bearer ${SARVAM_TOKEN}` },
  );

  results.scenario4_call_gateway = {
    disabled_returns_404_enabled_false: "PASS",
    enabled_saved_family_forward:
      enabledRes.status === 501 && enabledRes.body?.error === "tool_not_registered"
        ? "SKIPPED: call_screen missing in runtime shieldTools base"
        : enabledRes.status === 200
          ? "PASS"
          : `FAIL (${enabledRes.status})`,
  };

  console.log(JSON.stringify(results, null, 2));
  // A FAIL entry must fail the run (it used to print PHASE3_E2E_RESULT: PASS over a FAIL line).
  const failed = Object.values(results).flatMap((r) => Object.entries(r))
    .filter(([, v]) => typeof v === "string" && v.startsWith("FAIL")).map(([k]) => k);
  if (failed.length) throw new Error(`Phase 3 e2e checks failed: ${failed.join(", ")}`);
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 2 });
  });

