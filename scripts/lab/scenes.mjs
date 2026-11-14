#!/usr/bin/env node
/**
 * AGY-11 Part B — Local Shield Scene Player (no phones needed).
 * Plays 14 Shield scenarios against the running lab server (http://127.0.0.1:3100)
 * and prints: input -> server verdict -> dev_outbox effects -> Riya's app view.
 *
 * Usage:
 *   node scripts/lab/scenes.mjs
 *   node scripts/lab/scenes.mjs --only A,C
 *   node scripts/lab/scenes.mjs --only 1,3,14
 */

import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const LAB_DIR = process.env.LAB_DIR || join(homedir(), ".sahaj-lab");
const LAB_ENV_PATH = join(LAB_DIR, "lab.env");
const SECRETS_PATH =
  process.env.LAB_ENV_FILE !== undefined
    ? process.env.LAB_ENV_FILE
    : join(homedir(), "dev", "sahaj-secrets", "shield.env");

const FAMILY_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_ID = "22222222-2222-4222-8222-222222222221";
const RIYA_USER_ID = "33333333-3333-4333-8333-333333333332";

function parseEnvFile(filePath) {
  const out = {};
  if (!filePath || !existsSync(filePath)) return out;
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let val = stripped.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

const labFileEnv = parseEnvFile(LAB_ENV_PATH);
const secretsFileEnv = parseEnvFile(SECRETS_PATH);
const env = { ...labFileEnv, ...secretsFileEnv, ...process.env };

const BASE_URL = env.LAB_API_URL || "http://127.0.0.1:3100";
const DATABASE_URL =
  env.DATABASE_URL || "postgres://service_role@127.0.0.1:54329/sahaj_lab";

for (const reqKey of [
  "SUPABASE_JWT_SECRET",
  "SARVAM_TOOL_TOKEN",
  "SARVAM_WEBHOOK_SECRET",
  "DEV_ADMIN_TOKEN",
  "SMS_GATEWAY_SECRET",
]) {
  if (!env[reqKey]) {
    console.error(
      `ERROR: missing ${reqKey}. Start the lab first with: bash scripts/lab/lab-up.sh`,
    );
    process.exit(2);
  }
}

function parseOnlyArg(argv) {
  const idx = argv.indexOf("--only");
  if (idx === -1) return null;
  const raw = argv[idx + 1] ?? "";
  if (!raw || raw.startsWith("-")) {
    console.error("Usage: node scripts/lab/scenes.mjs [--only A,C]");
    process.exit(2);
  }
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const onlyTokens = parseOnlyArg(process.argv.slice(2));

const AI_KEYS = ["ANTHROPIC_API_KEY", "MUSE_API_KEY", "GEMINI_API_KEY"];
const loadedAiNames = AI_KEYS.filter((k) => Boolean(env[k] && env[k].trim()));
if (loadedAiNames.length > 0) {
  console.log(
    `AI mode: REAL AI KEYS LOADED (${loadedAiNames.join(", ")}) — real AI calls cost a little money.`,
  );
} else {
  console.log(
    "AI mode: RULES-ONLY (no ANTHROPIC_API_KEY / MUSE_API_KEY / GEMINI_API_KEY loaded; 0 paid AI calls).",
  );
}
console.log(`Target : ${BASE_URL} | Family: ${FAMILY_ID} | Parent: ${PARENT_ID}`);
console.log("");

function mintRiyaToken(secret) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({
    sub: RIYA_USER_ID,
    role: "authenticated",
    iat: now,
    exp: now + 12 * 3600,
  });
  const unsigned = `${header}.${payload}`;
  const sig = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${sig}`;
}

async function reqJson(path, { method = "GET", body, headers = {} } = {}) {
  const rawBody =
    body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(rawBody !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(rawBody !== undefined ? { body: rawBody } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, data: json };
}

async function pollUntil(fn, timeoutMs = 8000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

const sql = postgres(DATABASE_URL, { prepare: false, max: 4 });
const riyaToken = mintRiyaToken(env.SUPABASE_JWT_SECRET);
const riyaHeaders = { Authorization: `Bearer ${riyaToken}` };
const sarvamHeaders = { Authorization: `Bearer ${env.SARVAM_TOOL_TOKEN}` };

async function pairLabDevice() {
  const pairCodeRes = await reqJson("/api/app/shield/pair-code", {
    method: "POST",
    body: {},
    headers: {
      ...riyaHeaders,
      "Idempotency-Key": `lab-pair-${randomUUID()}`,
    },
  });
  if (pairCodeRes.status !== 200 || !pairCodeRes.data?.code) {
    throw new Error(
      `Failed to mint pair code (${pairCodeRes.status}): ${JSON.stringify(pairCodeRes.data)}`,
    );
  }
  const pairRes = await reqJson("/api/shield/pair", {
    method: "POST",
    body: {
      code: pairCodeRes.data.code,
      parent_person_id: PARENT_ID,
      label: "Lab Synthetic Phone",
      platform: "android",
      protections: {
        sms: true,
        screening: true,
        redirection: true,
        usage: true,
        notifications: true,
        overlay: true,
      },
    },
  });
  if (pairRes.status !== 200 || !pairRes.data?.device_secret) {
    throw new Error(
      `Failed to pair lab device (${pairRes.status}): ${JSON.stringify(pairRes.data)}`,
    );
  }
  return {
    deviceId: pairRes.data.device_id,
    deviceSecret: pairRes.data.device_secret,
  };
}

// Sign events with exact same HMAC format as apps/shield-api/scripts/e2e-app-verify.mjs.
async function postSignedDeviceEvent(device, payload) {
  const fullEvent = {
    idempotency_key: `lab-${randomUUID()}`,
    family_id: FAMILY_ID,
    parent_id: PARENT_ID,
    device_id: device.deviceId,
    channel: "device",
    occurred_at: new Date().toISOString(),
    link_domains: [],
    matched_rules: [],
    context: {},
    ...payload,
  };
  const body = JSON.stringify(fullEvent);
  const ts = String(Date.now());
  const sig = createHmac("sha256", device.deviceSecret)
    .update(`${ts}.${body}`)
    .digest("hex");

  const res = await reqJson("/api/shield/event", {
    method: "POST",
    body,
    headers: {
      "x-shield-device": device.deviceId,
      "x-shield-ts": ts,
      "x-shield-sig": sig,
    },
  });
  if (res.status !== 200) {
    throw new Error(
      `Signed /api/shield/event failed (${res.status}): ${JSON.stringify(res.data)}`,
    );
  }
  return fullEvent.idempotency_key;
}

async function waitForEventRow(idempotencyKey) {
  const row = await pollUntil(async () => {
    const rows = await sql`
      select id from public.shield_events
      where idempotency_key = ${idempotencyKey}
      limit 1`;
    return rows[0] ?? null;
  });
  if (!row) {
    throw new Error(`Timed out waiting for shield_events row (${idempotencyKey})`);
  }
  return row.id;
}

async function waitForVerdictByEventId(eventId) {
  const verdict = await pollUntil(async () => {
    const rows = await sql`
      select id, level, scam_type, reasons, checks_fired, created_at
      from public.shield_verdicts
      where ${eventId}::uuid = any(event_ids)
      order by created_at desc
      limit 1`;
    return rows[0] ?? null;
  });
  if (!verdict) {
    throw new Error(`Timed out waiting for verdict for event ${eventId}`);
  }
  return verdict;
}

async function waitForVerdictSince(sinceDate, ruleIdPrefix) {
  const verdict = await pollUntil(async () => {
    const rows = await sql`
      select id, level, scam_type, reasons, checks_fired, created_at
      from public.shield_verdicts
      where family_id = ${FAMILY_ID}
        and created_at >= ${sinceDate.toISOString()}::timestamptz
      order by created_at desc`;
    if (ruleIdPrefix) {
      return (
        rows.find(
          (r) =>
            Array.isArray(r.reasons) &&
            r.reasons.some((rsn) => String(rsn.rule_id || "").startsWith(ruleIdPrefix)),
        ) ?? null
      );
    }
    return rows[0] ?? null;
  });
  return verdict;
}

async function getOutboxDelta(afterSeqOrTime) {
  // Pause briefly so fire-and-forget alert branches flush to dev_outbox.
  await new Promise((r) => setTimeout(r, 250));
  return sql`
    select channel, kind, created_at
    from public.dev_outbox
    where (family_id = ${FAMILY_ID} or family_id is null)
      and created_at >= ${afterSeqOrTime.toISOString()}::timestamptz
    order by created_at asc, id asc`;
}

async function getRiyaAlert(verdictId) {
  const res = await reqJson("/api/app/shield/alerts?limit=25", {
    headers: riyaHeaders,
  });
  if (res.status !== 200) {
    throw new Error(`GET /api/app/shield/alerts failed (${res.status})`);
  }
  const match = verdictId
    ? res.data.alerts.find((a) => a.id === verdictId) ?? null
    : res.data.alerts[0] ?? null;
  return { status: res.status, total: res.data.alerts.length, match };
}

function englishReasons(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return "(none)";
  return reasons.map((r) => r.en || r.rule_id).join("; ");
}

function summarizeEffects(outboxRows) {
  if (!outboxRows || outboxRows.length === 0) return "none (0 rows in dev_outbox)";
  const items = outboxRows.map((r) => `${r.channel}:${r.kind}`);
  return `${outboxRows.length} row(s) in dev_outbox [${items.join(", ")}]`;
}

function printSceneResult({
  num,
  code,
  title,
  expected,
  actual,
  passed,
  inputSummary,
  scamType,
  reasonsText,
  effectsSummary,
  riyaSummary,
}) {
  const mark = passed ? "PASS" : "FAIL";
  console.log(
    `[${num}/${code}] ${title} — ${mark} (expected ${expected}, got ${actual})`,
  );
  console.log(`  input   : ${inputSummary}`);
  console.log(
    `  verdict : ${actual}${scamType ? ` (${scamType})` : ""} | reasons(en): ${reasonsText}`,
  );
  console.log(`  effects : ${effectsSummary}`);
  console.log(`  riyaApp : ${riyaSummary}`);
  console.log("");
}

const state = {
  sceneBVerdictId: null,
};

function makeScenes(device) {
  return [
    {
      num: 1,
      code: "A",
      aliases: ["1", "a", "kyc"],
      title: "Smartphone KYC scam SMS (signed device event)",
      expectedLevel: "red",
      async run() {
        const mark = new Date();
        const inputSummary =
          'POST /api/shield/event (kind=sms, sender_type=mobile_10, "URGENT bank account KYC blocked update http://kyc-update-demo.example")';
        const key = await postSignedDeviceEvent(device, {
          kind: "sms",
          sender_type: "mobile_10",
          masked_text:
            "URGENT bank account KYC blocked update immediately at http://kyc-update-demo.example",
          link_domains: ["kyc-update-demo.example"],
          local_level: "yellow",
        });
        const eventId = await waitForEventRow(key);
        const verdict = await waitForVerdictByEventId(eventId);
        const outbox = await getOutboxDelta(mark);
        const riya = await getRiyaAlert(verdict.id);
        return {
          actual: verdict.level,
          passed: verdict.level === "red" && Boolean(riya.match),
          inputSummary,
          scamType: verdict.scam_type,
          reasonsText: englishReasons(verdict.reasons),
          effectsSummary: summarizeEffects(outbox),
          riyaSummary: riya.match
            ? `GET /api/app/shield/alerts -> visible id=${riya.match.id} level=${riya.match.level} snippet="${riya.match.masked_snippet}"`
            : `GET /api/app/shield/alerts -> NOT visible (${riya.total} alerts)`,
        };
      },
    },
    {
      num: 2,
      code: "B",
      aliases: ["2", "b", "otp", "p1"],
      title: "Unknown call + OTP SMS during it (P1)",
      expectedLevel: "red",
      async run() {
        const mark = new Date();
        const t0 = new Date(Date.now() - 2000).toISOString();
        const t1 = new Date().toISOString();
        const callKey = await postSignedDeviceEvent(device, {
          kind: "call_in",
          caller_type: "mobile_10",
          occurred_at: t0,
          context: { call_started_at: t0 },
        });
        await waitForEventRow(callKey);
        const smsKey = await postSignedDeviceEvent(device, {
          kind: "sms",
          sender_type: "mobile_10",
          occurred_at: t1,
          masked_text: "Your bank OTP is ****** do not share with anyone",
          context: {},
        });
        const smsEventId = await waitForEventRow(smsKey);
        const verdict = await waitForVerdictByEventId(smsEventId);
        state.sceneBVerdictId = verdict.id;
        const outbox = await getOutboxDelta(mark);
        const riya = await getRiyaAlert(verdict.id);
        return {
          actual: verdict.level,
          passed: verdict.level === "red" && Boolean(riya.match),
          inputSummary:
            'POST /api/shield/event call_in(mobile_10) -> sms("Your bank OTP is ****** do not share")',
          scamType: verdict.scam_type,
          reasonsText: englishReasons(verdict.reasons),
          effectsSummary: summarizeEffects(outbox),
          riyaSummary: riya.match
            ? `GET /api/app/shield/alerts -> visible id=${riya.match.id} level=${riya.match.level} checks=[${(riya.match.checks_fired || []).join(",")}]`
            : "GET /api/app/shield/alerts -> NOT visible",
        };
      },
    },
    {
      num: 3,
      code: "C",
      aliases: ["3", "c", "family_check"],
      title: 'Keypad: "Rohit ka phone aaya, paise maang raha tha" -> family_check -> Rohit denies -> red',
      expectedLevel: "red",
      async run() {
        if (!env.WHATSAPP_APP_SECRET || env.WHATSAPP_APP_SECRET.length < 32) {
          throw new Error("Scene C needs lab-only WHATSAPP_APP_SECRET (at least 32 characters) in the lab and player env");
        }
        // Upgrade only the masked demo fixture; never replace or impersonate a real number.
        const rohitId = "22222222-2222-4222-8222-222222222223";
        await sql`update public.people set phone='+919000000003'
          where id=${rohitId} and family_id=${FAMILY_ID} and phone like '%X%'`;
        const [rohit] = await sql`select id from public.people
          where id=${rohitId} and family_id=${FAMILY_ID} and phone='+919000000003'`;
        if (!rohit) throw new Error("Scene C needs the synthetic Rohit phone fixture; real routing data is never impersonated");
        const mark = new Date();
        const startRes = await reqJson("/api/sarvam/tool/family_check", {
          method: "POST",
          headers: sarvamHeaders,
          body: {
            variables: { family_id: FAMILY_ID, parent_id: PARENT_ID },
            claimed_name: "Rohit",
            asked_for: "paise maang raha tha",
          },
        });
        if (startRes.status !== 200 || !startRes.data?.check_id) {
          throw new Error(
            `family_check failed (${startRes.status}): ${JSON.stringify(startRes.data)}`,
          );
        }
        const checkId = startRes.data.check_id;
        const webhookBody = JSON.stringify({
          object: "whatsapp_business_account",
          entry: [{ changes: [{ field: "messages", value: {
            messaging_product: "whatsapp",
            messages: [{ id: `wamid.lab.${randomUUID()}`, from: "919000000003", type: "text", text: { body: "DENIED" } }],
          } }] }],
        });
        const signature = createHmac("sha256", env.WHATSAPP_APP_SECRET).update(webhookBody).digest("hex");
        const inbound = await reqJson("/api/whatsapp/webhook", {
          method: "POST", body: webhookBody, headers: { "X-Hub-Signature-256": `sha256=${signature}` },
        });
        if (inbound.status !== 200) throw new Error(`WhatsApp webhook failed (${inbound.status})`);
        // The webhook acknowledges promptly and processes through Next's after lifecycle.
        const answered = await pollUntil(async () => {
          const [check] = await sql`select state from public.family_checks where id=${checkId}`;
          return check?.state === "denied";
        });
        if (!answered) throw new Error("WhatsApp webhook did not record the synthetic DENIED answer");
        const resultRes = await reqJson("/api/sarvam/tool/family_check_result", {
          method: "POST",
          headers: sarvamHeaders,
          body: {
            variables: { family_id: FAMILY_ID, parent_id: PARENT_ID },
            check_id: checkId,
          },
        });
        if (resultRes.status !== 200) {
          throw new Error(
            `family_check_result failed (${resultRes.status}): ${JSON.stringify(resultRes.data)}`,
          );
        }
        const verdict = await waitForVerdictSince(mark, "voice.family_check.denied");
        const outbox = await getOutboxDelta(mark);
        const riya = verdict ? await getRiyaAlert(verdict.id) : { match: null, total: 0 };
        const actual = resultRes.data.level;
        return {
          actual,
          passed:
            resultRes.data.status === "denied" &&
            actual === "red" &&
            Boolean(verdict) &&
            Boolean(riya.match),
          inputSummary:
            'POST /api/sarvam/tool/family_check(Rohit) -> POST /api/whatsapp/webhook(DENIED, signed) -> /api/sarvam/tool/family_check_result',
          scamType: verdict?.scam_type || "family_in_trouble",
          reasonsText: verdict
            ? englishReasons(verdict.reasons)
            : "Rohit denied calling Maa",
          effectsSummary: summarizeEffects(outbox),
          riyaSummary: riya.match
            ? `GET /api/app/shield/alerts -> visible id=${riya.match.id} level=${riya.match.level} channel=${riya.match.channel}`
            : "GET /api/app/shield/alerts -> NOT visible",
        };
      },
    },
    {
      num: 4,
      code: "D",
      aliases: ["4", "d", "classify_scam"],
      title: 'Keypad: "Police wale arrest bol rahe hain" -> classify_scam -> bridge Riya',
      expectedLevel: "red",
      async run() {
        const mark = new Date();
        const res = await reqJson("/api/sarvam/tool/classify_scam", {
          method: "POST",
          headers: sarvamHeaders,
          body: {
            variables: { family_id: FAMILY_ID, parent_id: PARENT_ID },
            said: "Police wale digital arrest bol rahe hain, giraftar karne ki dhamki aur video call pe rehna hoga bol ke verification ke liye paise transfer maang rahe hain",
          },
        });
        if (res.status !== 200) {
          throw new Error(`classify_scam failed (${res.status}): ${JSON.stringify(res.data)}`);
        }
        const verdict = await waitForVerdictSince(mark, "voice.classify_scam");
        const outbox = await getOutboxDelta(mark);
        const riya = verdict ? await getRiyaAlert(verdict.id) : { match: null, total: 0 };
        return {
          actual: res.data.level,
          passed:
            res.data.level === "red" &&
            res.data.scam_type === "digital_arrest" &&
            res.data.bridge_to === "child" &&
            Boolean(riya.match),
          inputSummary:
            'POST /api/sarvam/tool/classify_scam ("Police wale digital arrest bol rahe hain...")',
          scamType: res.data.scam_type,
          reasonsText: verdict
            ? `${englishReasons(verdict.reasons)} (bridge_to=${res.data.bridge_to}, stop_script_id=${res.data.stop_script_id})`
            : `bridge_to=${res.data.bridge_to}`,
          effectsSummary: summarizeEffects(outbox),
          riyaSummary: riya.match
            ? `GET /api/app/shield/alerts -> visible id=${riya.match.id} level=${riya.match.level} bridge_to=${res.data.bridge_to}`
            : "GET /api/app/shield/alerts -> NOT visible",
        };
      },
    },
    {
      num: 5,
      code: "P9",
      aliases: ["5", "p9"],
      title: "Banking app opened during unknown call (P9)",
      expectedLevel: "red",
      async run() {
        const mark = new Date();
        const key = await postSignedDeviceEvent(device, {
          kind: "app_open",
          caller_type: "mobile_10",
          context: { package: "com.phonepe.app", on_call_with_unsaved: true },
        });
        const eventId = await waitForEventRow(key);
        const verdict = await waitForVerdictByEventId(eventId);
        const outbox = await getOutboxDelta(mark);
        const riya = await getRiyaAlert(verdict.id);
        return {
          actual: verdict.level,
          passed: verdict.level === "red" && Boolean(riya.match),
          inputSummary:
            "POST /api/shield/event (kind=app_open, package=com.phonepe.app, on_call_with_unsaved=true)",
          scamType: verdict.scam_type,
          reasonsText: englishReasons(verdict.reasons),
          effectsSummary: summarizeEffects(outbox),
          riyaSummary: riya.match
            ? `GET /api/app/shield/alerts -> visible id=${riya.match.id} level=${riya.match.level} checks=[${(riya.match.checks_fired || []).join(",")}]`
            : "GET /api/app/shield/alerts -> NOT visible",
        };
      },
    },
    {
      num: 6,
      code: "P2",
      aliases: ["6", "p2"],
      title: "WhatsApp video call 11 min with unknown number (P2)",
      expectedLevel: "red",
      async run() {
        const mark = new Date();
        const key = await postSignedDeviceEvent(device, {
          kind: "notification",
          caller_type: "mobile_10",
          context: {
            whatsapp_call_unsaved: true,
            call_seconds: 660,
            source: "whatsapp",
          },
        });
        const eventId = await waitForEventRow(key);
        const verdict = await waitForVerdictByEventId(eventId);
        const outbox = await getOutboxDelta(mark);
        const riya = await getRiyaAlert(verdict.id);
        return {
          actual: verdict.level,
          passed: verdict.level === "red" && Boolean(riya.match),
          inputSummary:
            "POST /api/shield/event (kind=notification, whatsapp_call_unsaved=true, call_seconds=660)",
          scamType: verdict.scam_type,
          reasonsText: englishReasons(verdict.reasons),
          effectsSummary: summarizeEffects(outbox),
          riyaSummary: riya.match
            ? `GET /api/app/shield/alerts -> visible id=${riya.match.id} level=${riya.match.level} checks=[${(riya.match.checks_fired || []).join(",")}]`
            : "GET /api/app/shield/alerts -> NOT visible",
        };
      },
    },
    {
      num: 7,
      code: "P3",
      aliases: ["7", "p3", "apk"],
      title: "Message with .apk attachment (P3)",
      expectedLevel: "red",
      async run() {
        const mark = new Date();
        const key = await postSignedDeviceEvent(device, {
          kind: "notification",
          masked_text: "Wedding invitation [.apk]",
          context: { attachment_apk: true, source: "whatsapp" },
        });
        const eventId = await waitForEventRow(key);
        const verdict = await waitForVerdictByEventId(eventId);
        const outbox = await getOutboxDelta(mark);
        const riya = await getRiyaAlert(verdict.id);
        return {
          actual: verdict.level,
          passed: verdict.level === "red" && Boolean(riya.match),
          inputSummary:
            'POST /api/shield/event (kind=notification, attachment_apk=true, "Wedding invitation [.apk]")',
          scamType: verdict.scam_type,
          reasonsText: englishReasons(verdict.reasons),
          effectsSummary: summarizeEffects(outbox),
          riyaSummary: riya.match
            ? `GET /api/app/shield/alerts -> visible id=${riya.match.id} level=${riya.match.level} checks=[${(riya.match.checks_fired || []).join(",")}]`
            : "GET /api/app/shield/alerts -> NOT visible",
        };
      },
    },
    {
      num: 8,
      code: "P4",
      aliases: ["8", "p4", "anydesk"],
      title: "AnyDesk remote-access install (P4)",
      expectedLevel: "red",
      async run() {
        const mark = new Date();
        const key = await postSignedDeviceEvent(device, {
          kind: "install",
          context: {
            package: "com.anydesk.anydeskandroid",
            installer: "com.android.vending",
            installed_hours_ago: 0,
          },
        });
        const eventId = await waitForEventRow(key);
        const verdict = await waitForVerdictByEventId(eventId);
        const outbox = await getOutboxDelta(mark);
        const riya = await getRiyaAlert(verdict.id);
        return {
          actual: verdict.level,
          passed: verdict.level === "red" && Boolean(riya.match),
          inputSummary:
            "POST /api/shield/event (kind=install, package=com.anydesk.anydeskandroid)",
          scamType: verdict.scam_type,
          reasonsText: englishReasons(verdict.reasons),
          effectsSummary: summarizeEffects(outbox),
          riyaSummary: riya.match
            ? `GET /api/app/shield/alerts -> visible id=${riya.match.id} level=${riya.match.level} checks=[${(riya.match.checks_fired || []).join(",")}]`
            : "GET /api/app/shield/alerts -> NOT visible",
        };
      },
    },
    {
      num: 9,
      code: "P6",
      aliases: ["9", "p6"],
      title: "Long unknown voice call vs parent's normal (P6)",
      expectedLevel: "yellow",
      async run() {
        const mark = new Date();
        const key = await postSignedDeviceEvent(device, {
          kind: "call_in",
          caller_type: "mobile_10",
          context: { duration_ms: 1320000, long_vs_normal: true },
        });
        const eventId = await waitForEventRow(key);
        const verdict = await waitForVerdictByEventId(eventId);
        const outbox = await getOutboxDelta(mark);
        const riya = await getRiyaAlert(verdict.id);
        return {
          actual: verdict.level,
          passed: verdict.level === "yellow" && Boolean(riya.match),
          inputSummary:
            "POST /api/shield/event (kind=call_in, caller_type=mobile_10, duration_ms=1320000, long_vs_normal=true)",
          scamType: verdict.scam_type,
          reasonsText: englishReasons(verdict.reasons),
          effectsSummary: summarizeEffects(outbox),
          riyaSummary: riya.match
            ? `GET /api/app/shield/alerts -> visible id=${riya.match.id} level=${riya.match.level} checks=[${(riya.match.checks_fired || []).join(",")}]`
            : "GET /api/app/shield/alerts -> NOT visible",
        };
      },
    },
    {
      num: 10,
      code: "P7",
      aliases: ["10", "p7"],
      title: '"Bank se bola tha" from a mobile number (P7)',
      expectedLevel: "yellow",
      async run() {
        const mark = new Date();
        const key = await postSignedDeviceEvent(device, {
          kind: "voice_report",
          caller_type: "mobile_10",
          masked_text: "Caller said bank se bola tha KYC update ke liye",
          context: { claimed_bank: true },
        });
        const eventId = await waitForEventRow(key);
        const verdict = await waitForVerdictByEventId(eventId);
        const outbox = await getOutboxDelta(mark);
        const riya = await getRiyaAlert(verdict.id);
        return {
          actual: verdict.level,
          passed: verdict.level === "yellow" && Boolean(riya.match),
          inputSummary:
            'POST /api/shield/event (kind=voice_report, caller_type=mobile_10, claimed_bank=true, "bank se bola tha")',
          scamType: verdict.scam_type,
          reasonsText: englishReasons(verdict.reasons),
          effectsSummary: summarizeEffects(outbox),
          riyaSummary: riya.match
            ? `GET /api/app/shield/alerts -> visible id=${riya.match.id} level=${riya.match.level} checks=[${(riya.match.checks_fired || []).join(",")}]`
            : "GET /api/app/shield/alerts -> NOT visible",
        };
      },
    },
    {
      num: 11,
      code: "P8",
      aliases: ["11", "p8"],
      title: '"Mat karo" paused callback to unknown flagged number (P8)',
      expectedLevel: "yellow",
      async run() {
        const mark = new Date();
        const key = await postSignedDeviceEvent(device, {
          kind: "call_out",
          caller_type: "mobile_10",
          context: { paused: true },
        });
        const eventId = await waitForEventRow(key);
        const verdict = await waitForVerdictByEventId(eventId);
        const outbox = await getOutboxDelta(mark);
        const riya = await getRiyaAlert(verdict.id);
        return {
          actual: verdict.level,
          passed: verdict.level === "yellow" && Boolean(riya.match),
          inputSummary: "POST /api/shield/event (kind=call_out, caller_type=mobile_10, paused=true)",
          scamType: verdict.scam_type,
          reasonsText: englishReasons(verdict.reasons),
          effectsSummary: summarizeEffects(outbox),
          riyaSummary: riya.match
            ? `GET /api/app/shield/alerts -> visible id=${riya.match.id} level=${riya.match.level} checks=[${(riya.match.checks_fired || []).join(",")}]`
            : "GET /api/app/shield/alerts -> NOT visible",
        };
      },
    },
    {
      num: 12,
      code: "BUSY",
      aliases: ["12", "busy", "busy_line"],
      title: "Busy-line watch — 3 busy check-in statuses via Sarvam webhook",
      expectedLevel: "alerted=true (streak=3)",
      async run() {
        const webhookPath = `/api/sarvam/webhook/${env.SARVAM_WEBHOOK_SECRET}`;
        // Close any active streak from prior lab runs before starting a fresh 3-busy sequence.
        await reqJson(webhookPath, {
          method: "POST",
          body: {
            status: "connected",
            agent_variables: {
              purpose: "checkin",
              family_id: FAMILY_ID,
              parent_id: PARENT_ID,
              in_checkin_window: true,
            },
            ended_at: new Date().toISOString(),
          },
        });
        const mark = new Date();
        const baseMs = Date.now();
        let lastRes = null;
        for (let i = 0; i < 3; i++) {
          lastRes = await reqJson(webhookPath, {
            method: "POST",
            body: {
              status: "busy",
              agent_variables: {
                purpose: "checkin",
                family_id: FAMILY_ID,
                parent_id: PARENT_ID,
                in_checkin_window: true,
              },
              ended_at: new Date(baseMs + i * 10_000).toISOString(),
            },
          });
          if (lastRes.status !== 200) {
            throw new Error(
              `Sarvam webhook failed (${lastRes.status}): ${JSON.stringify(lastRes.data)}`,
            );
          }
        }
        const [dbStreak] = await sql`
          select id, busy_count, alerted_at
          from public.busy_streaks
          where family_id = ${FAMILY_ID}
            and parent_id = ${PARENT_ID}
            and ended_at is null
          order by started_at desc
          limit 1`;
        const outbox = await getOutboxDelta(mark);
        const riya = await getRiyaAlert(null);
        const passed =
          lastRes.data.alerted === true &&
          dbStreak?.busy_count === 3 &&
          outbox.some((o) => o.channel === "push" && o.kind === "busy_alert");
        return {
          actual: `alerted=${lastRes.data.alerted} (streak=${dbStreak?.busy_count})`,
          passed,
          inputSummary:
            "3x POST /api/sarvam/webhook/<secret> (purpose=checkin, status=busy, in_checkin_window=true)",
          scamType: "busy_line_watch",
          reasonsText:
            "3 consecutive busy check-in attempts triggered quiet busy alert and scheduled circle escalation",
          effectsSummary: summarizeEffects(outbox),
          riyaSummary: `GET /api/app/shield/alerts -> ${riya.total} verdict(s); busy streak id=${dbStreak?.id} busy_count=${dbStreak?.busy_count} (push:busy_alert queued)`,
        };
      },
    },
    {
      num: 13,
      code: "GW",
      aliases: ["13", "gw", "gateway"],
      title: "Keypad SMS gateway — register Maa (admin) + forward scam SMS",
      expectedLevel: "red",
      async run() {
        const regRes = await reqJson("/api/dev/shield/gateway-parent", {
          method: "POST",
          headers: { "x-dev-admin-token": env.DEV_ADMIN_TOKEN },
          body: {
            family_id: FAMILY_ID,
            parent_id: PARENT_ID,
            phone: "+919000000001",
          },
        });
        if (regRes.status !== 200 || !regRes.data?.registered) {
          throw new Error(
            `gateway-parent registration failed (${regRes.status}): ${JSON.stringify(regRes.data)}`,
          );
        }
        const mark = new Date();
        const gwRes = await reqJson("/api/sms/gateway", {
          method: "POST",
          headers: { "x-sahaj-gateway-secret": env.SMS_GATEWAY_SECRET },
          body: {
            from: "+919000000001",
            body: "URGENT bank account KYC blocked update http://kyc-update-demo.example OTP 482910",
            received_at: new Date().toISOString(),
            gateway_id: `lab-gw-${randomUUID()}`,
          },
        });
        if (gwRes.status !== 200 || !gwRes.data?.event_id) {
          throw new Error(`/api/sms/gateway failed (${gwRes.status}): ${JSON.stringify(gwRes.data)}`);
        }
        const verdict = await waitForVerdictByEventId(gwRes.data.event_id);
        const outbox = await getOutboxDelta(mark);
        const riya = await getRiyaAlert(verdict.id);
        const passed =
          verdict.level === "red" &&
          Boolean(riya.match) &&
          outbox.some((o) => o.channel === "calls" && o.kind === "call_parent");
        return {
          actual: verdict.level,
          passed,
          inputSummary:
            "POST /api/dev/shield/gateway-parent(+919000000001) -> POST /api/sms/gateway(KYC scam SMS)",
          scamType: verdict.scam_type,
          reasonsText: englishReasons(verdict.reasons),
          effectsSummary: summarizeEffects(outbox),
          riyaSummary: riya.match
            ? `GET /api/app/shield/alerts -> visible id=${riya.match.id} level=${riya.match.level} channel=${riya.match.channel}`
            : "GET /api/app/shield/alerts -> NOT visible",
        };
      },
    },
    {
      num: 14,
      code: "EVIDENCE",
      aliases: ["14", "evidence", "pack"],
      title: "Evidence pack + timeline verify for Scene B",
      expectedLevel: "valid=true (red incident)",
      async run() {
        let targetId = state.sceneBVerdictId;
        if (!targetId) {
          const rows = await sql`
            select v.id from public.shield_verdicts v
            where v.family_id = ${FAMILY_ID}
              and v.level = 'red'
              and 'pattern.P1' = any(v.checks_fired)
            order by v.created_at desc
            limit 1`;
          targetId = rows[0]?.id ?? null;
        }
        if (!targetId) {
          throw new Error(
            "Scene B verdict not found; run Scene B first or include B with --only B,EVIDENCE",
          );
        }
        const evRes = await reqJson(`/api/app/shield/evidence/${targetId}`, {
          headers: riyaHeaders,
        });
        if (evRes.status !== 200) {
          throw new Error(
            `GET /api/app/shield/evidence/${targetId} failed (${evRes.status}): ${JSON.stringify(evRes.data)}`,
          );
        }
        const verifyRes = await reqJson("/api/app/timeline/verify", {
          headers: riyaHeaders,
        });
        if (verifyRes.status !== 200) {
          throw new Error(
            `GET /api/app/timeline/verify failed (${verifyRes.status}): ${JSON.stringify(verifyRes.data)}`,
          );
        }
        const riya = await getRiyaAlert(targetId);
        const summaryLines = String(evRes.data.summary_en || "").split("\n");
        const shortSummary = summaryLines.slice(0, 4).join(" | ");
        const passed =
          Boolean(evRes.data.summary_en) &&
          String(evRes.data.copy_for_1930 || "").includes("1930") &&
          evRes.data.cybercrime_url === "https://cybercrime.gov.in" &&
          Boolean(evRes.data.chain_hash) &&
          verifyRes.data.valid === true &&
          verifyRes.data.checked > 0 &&
          Boolean(riya.match);
        return {
          actual: `valid=${verifyRes.data.valid} (checked=${verifyRes.data.checked})`,
          passed,
          inputSummary: `GET /api/app/shield/evidence/${targetId} + GET /api/app/timeline/verify`,
          scamType: riya.match?.scam_type || "otp_theft",
          reasonsText: `${shortSummary} | 1930 copy ready (${evRes.data.cybercrime_url})`,
          effectsSummary: `no dev_outbox write; SHA-256 timeline verified (${verifyRes.data.checked} rows); chain_hash=${String(evRes.data.chain_hash).slice(0, 12)}...`,
          riyaSummary: `GET /api/app/shield/alerts -> Scene B id=${targetId} visible=${Boolean(riya.match)}; 1930 pack ready`,
        };
      },
    },
  ];
}

async function main() {
  const health = await reqJson("/api/health");
  if (health.status !== 200 || !health.data?.ok) {
    throw new Error(
      `Lab server ${BASE_URL}/api/health not ready (${health.status}). Run: bash scripts/lab/lab-up.sh`,
    );
  }

  const device = await pairLabDevice();
  const allScenes = makeScenes(device);

  let selected = allScenes;
  if (onlyTokens) {
    selected = allScenes.filter(
      (s) =>
        onlyTokens.includes(s.code.toLowerCase()) ||
        onlyTokens.includes(String(s.num)) ||
        s.aliases.some((a) => onlyTokens.includes(a)),
    );
    if (selected.length === 0) {
      console.error(
        `No scenes matched --only ${onlyTokens.join(",")}. Valid scenes: ${allScenes.map((s) => `${s.code}(${s.num})`).join(", ")}`,
      );
      process.exit(2);
    }
  }

  let passedCount = 0;
  let failedCount = 0;
  for (const scene of selected) {
    try {
      const outcome = await scene.run();
      printSceneResult({
        num: scene.num,
        code: scene.code,
        title: scene.title,
        expected: scene.expectedLevel,
        ...outcome,
      });
      if (outcome.passed) passedCount++;
      else failedCount++;
    } catch (err) {
      failedCount++;
      const msg = err instanceof Error ? err.message : String(err);
      printSceneResult({
        num: scene.num,
        code: scene.code,
        title: scene.title,
        expected: scene.expectedLevel,
        actual: "ERROR",
        passed: false,
        inputSummary: scene.title,
        scamType: null,
        reasonsText: msg,
        effectsSummary: "error before completion",
        riyaSummary: "unavailable",
      });
    }
  }

  console.log(
    `LAB_SCENES_SUMMARY: ${passedCount}/${selected.length} passed, ${failedCount} failed`,
  );
  if (failedCount > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 2 });
  });

