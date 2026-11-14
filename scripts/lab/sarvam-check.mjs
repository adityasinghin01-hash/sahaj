#!/usr/bin/env node
// Sarvam configuration check for the Sahaj lab.
//
//   node scripts/lab/sarvam-check.mjs                 # DRY RUN (default): reads names/formats only
//   node scripts/lab/sarvam-check.mjs --call-keypad   # places exactly ONE real check-in call to
//                                                     # LAB_PHONE_MAA_KEYPAD (the team's own keypad)
//
// Env precedence matches the lab server (scripts/lab/_common.sh): ~/.sahaj-lab/lab.env first, then
// ${LAB_ENV_FILE:-~/dev/sahaj-secrets/shield.env} on top. process.env only fills names both files lack.
// Never prints a secret value, an ID value or a phone number: only names, booleans and masked shapes.
// The outbound request shape is copied from apps/shield-api/src/ports/calls.ts (Sarvam instant outbound).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

const args = new Set(process.argv.slice(2));
const CALL_KEYPAD = args.has("--call-keypad");
for (const arg of args) {
  if (arg !== "--call-keypad") {
    console.error(`Unknown argument: ${arg}. Only --call-keypad is accepted.`);
    process.exit(2);
  }
}

const LAB_DIR = process.env.LAB_DIR || join(homedir(), ".sahaj-lab");
const LAB_ENV_PATH = join(LAB_DIR, "lab.env");
const SECRETS_PATH =
  process.env.LAB_ENV_FILE !== undefined ? process.env.LAB_ENV_FILE : join(homedir(), "dev", "sahaj-secrets", "shield.env");

// Demo family (synthetic seed: infra/supabase/dev/seed_demo.sql) — Meena "Maa".
const DEMO_FAMILY_ID = "11111111-1111-4111-8111-111111111111";
const DEMO_PARENT_ID = "22222222-2222-4222-8222-222222222221";
const E164 = /^\+[1-9]\d{7,14}$/;

function parseEnvFile(filePath) {
  const out = {};
  if (!filePath || !existsSync(filePath)) return out;
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return out;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = stripped.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const labEnv = parseEnvFile(LAB_ENV_PATH);
const secretsEnv = parseEnvFile(SECRETS_PATH);
const env = { ...labEnv, ...secretsEnv };
for (const [key, value] of Object.entries(process.env)) {
  if (env[key] === undefined && typeof value === "string" && /^(SARVAM_|LAB_PHONE_|ALLOW_ANY_TOOL_IP$|CALL_GATEWAY_ENABLED$|AASHA_DIDI_LINE_ID$)/.test(key)) {
    env[key] = value;
  }
}
const has = (name) => typeof env[name] === "string" && env[name].trim().length > 0;
const val = (name) => (has(name) ? env[name].trim() : "");

function constantTimeEqual(a, b) {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) {
    timingSafeEqual(y, y);
    return false;
  }
  return timingSafeEqual(x, y);
}

/** "+91" + "<MOBILE_10>" style: country code kept, every other digit hidden. */
function maskPhone(phone) {
  if (!phone) return "<missing>";
  const compact = phone.replace(/[\s-]/g, "");
  if (/^\+91\d{10}$/.test(compact)) return "+91<MOBILE_10>";
  if (/^\+\d+$/.test(compact)) return `+<${compact.length - 1}_DIGITS>`;
  return "<not E.164>";
}

console.log("== Sarvam config check (DRY RUN unless --call-keypad; values are never printed)");
console.log(`   lab env     : ${existsSync(LAB_ENV_PATH) ? LAB_ENV_PATH : "(not present)"} — ${Object.keys(labEnv).length} name(s)`);
console.log(`   secrets file: ${existsSync(SECRETS_PATH) ? SECRETS_PATH : `${SECRETS_PATH} (not present)`} — ${Object.keys(secretsEnv).length} name(s)`);
const sarvamNames = Object.keys(env).filter((k) => k.startsWith("SARVAM_") || k.startsWith("LAB_PHONE_")).sort();
console.log(`   names loaded: ${sarvamNames.filter(has).join(" ") || "(none)"}`);
console.log("");

/** [name, required-for-outbound, validator returning null (ok) or a problem string] */
const nonEmptyId = (name) => (/\s/.test(val(name)) ? "contains whitespace" : null);
const CHECKS = [
  ["SARVAM_API_KEY", true, () => null],
  ["SARVAM_ORG_ID", true, nonEmptyId],
  ["SARVAM_WORKSPACE_ID", true, nonEmptyId],
  ["SARVAM_AGENT_ID_CHECKIN", true, nonEmptyId],
  ["SARVAM_AGENT_ID_RESPONDER", false, nonEmptyId],
  ["SARVAM_AGENT_ID_CALLBACK", false, nonEmptyId],
  ["SARVAM_AGENT_VERSION", false, (n) => (/^[1-9]\d*$/.test(val(n)) ? null : "must be a positive whole number")],
  ["SARVAM_CONNECTION_ID", true, nonEmptyId],
  ["SARVAM_AGENT_PHONE_NUMBER", true, (n) => (E164.test(val(n)) ? null : "must be E.164, e.g. +91 followed by 10 digits, no spaces")],
  ["SARVAM_WEBHOOK_SECRET", true, (n) => (val(n).length >= 32 ? null : "must be at least 32 characters")],
  ["SARVAM_WEBHOOK_URL", true, checkWebhookUrl],
  ["SARVAM_TOOL_TOKEN", true, (n) => (val(n).length >= 16 ? null : "looks too short (use 16+ random characters)")],
  ["SARVAM_OUTBOUND_ENABLED", true, (n) => (val(n) === "1" ? null : 'must be exactly "1" to place real calls')],
  ["LAB_PHONE_MAA_KEYPAD", true, (n) => (E164.test(val(n)) ? null : "must be E.164, e.g. +91 followed by 10 digits, no spaces")],
];

function checkWebhookUrl(name) {
  let url;
  try {
    url = new URL(val(name));
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "https:") return "must start with https://";
  const m = /\/api\/sarvam\/webhook\/([^/?#]+)\/?$/.exec(url.pathname);
  if (!m) return "must end with /api/sarvam/webhook/<SARVAM_WEBHOOK_SECRET>";
  if (!has("SARVAM_WEBHOOK_SECRET")) return "cannot compare: SARVAM_WEBHOOK_SECRET is missing";
  if (!constantTimeEqual(decodeURIComponent(m[1]), val("SARVAM_WEBHOOK_SECRET"))) {
    return "last path segment does not match SARVAM_WEBHOOK_SECRET";
  }
  return null;
}

const problems = [];
const missingRequired = [];
for (const [name, required, validate] of CHECKS) {
  if (!has(name)) {
    if (required) missingRequired.push(name);
    const note = name === "SARVAM_AGENT_VERSION" ? "missing (server defaults to 1)" : required ? "MISSING" : "missing (optional for a check-in call)";
    console.log(`   ${required ? "✗" : "·"} ${name.padEnd(28)} ${note}`);
    continue;
  }
  const problem = validate(name);
  if (problem) problems.push(`${name}: ${problem}`);
  let extra = "";
  if (name === "SARVAM_WEBHOOK_URL" && !problem) extra = ` (host ${new URL(val(name)).host})`;
  if (name.startsWith("LAB_PHONE_") || name === "SARVAM_AGENT_PHONE_NUMBER") extra = ` (${maskPhone(val(name))})`;
  console.log(`   ${problem ? "✗" : "✓"} ${name.padEnd(28)} ${problem ? `present, BAD FORMAT: ${problem}` : "present, format ok"}${extra}`);
}
console.log("");
console.log(`   ALLOW_ANY_TOOL_IP=${env.ALLOW_ANY_TOOL_IP === "1" ? "1 (lab: tool calls accepted from any IP)" : "not 1 (only Sarvam's IPs may call tools)"}`);
console.log(`   CALL_GATEWAY_ENABLED=${env.CALL_GATEWAY_ENABLED === "1" ? "1 (call_screen on)" : "off (call_screen answers {enabled:false})"}`);
console.log(`   AASHA_DIDI_LINE_ID ${has("AASHA_DIDI_LINE_ID") ? "present" : "missing (server uses dev-outbox-line)"}`);

// Same rule as isSarvamOutboundConfigured() in apps/shield-api/src/ports/calls.ts.
const outboundReady = (purpose) =>
  ["SARVAM_API_KEY", "SARVAM_ORG_ID", "SARVAM_WORKSPACE_ID", `SARVAM_AGENT_ID_${purpose}`, "SARVAM_CONNECTION_ID", "SARVAM_AGENT_PHONE_NUMBER", "SARVAM_WEBHOOK_URL"].every(has) &&
  env.SARVAM_OUTBOUND_ENABLED === "1";
console.log("");
for (const purpose of ["CHECKIN", "RESPONDER", "CALLBACK"]) {
  console.log(`   server would place real ${purpose.toLowerCase().padEnd(9)} calls: ${outboundReady(purpose) ? "YES" : "no (writes dev_outbox instead)"}`);
}

// ---- The exact request the server's calls port would send for a check-in call (masked).
function buildRequest({ masked }) {
  const pick = (name) => (masked ? `<${name}>` : val(name));
  const webhookUrl = masked
    ? has("SARVAM_WEBHOOK_URL")
      ? val("SARVAM_WEBHOOK_URL").replace(/\/api\/sarvam\/webhook\/[^/?#]+/, "/api/sarvam/webhook/<SARVAM_WEBHOOK_SECRET>")
      : "<SARVAM_WEBHOOK_URL>"
    : val("SARVAM_WEBHOOK_URL");
  const purpose = "CHECKIN";
  return {
    url: `https://apps.sarvam.ai/api/outbounds/v1/orgs/${masked ? "<SARVAM_ORG_ID>" : encodeURIComponent(val("SARVAM_ORG_ID"))}/workspaces/${masked ? "<SARVAM_WORKSPACE_ID>" : encodeURIComponent(val("SARVAM_WORKSPACE_ID"))}/outbounds`,
    headers: { "Content-Type": "application/json", "X-API-Key": masked ? "<SARVAM_API_KEY>" : val("SARVAM_API_KEY") },
    body: {
      app_config: {
        app_id: pick(`SARVAM_AGENT_ID_${purpose}`),
        app_version: Number(env.SARVAM_AGENT_VERSION ?? "1"),
        connection_config: {
          connection_id: pick("SARVAM_CONNECTION_ID"),
          agent_phone_number: masked ? maskPhone(val("SARVAM_AGENT_PHONE_NUMBER")) : val("SARVAM_AGENT_PHONE_NUMBER"),
        },
        agent_variables: {
          purpose: purpose.toLowerCase(),
          introduction: "Main Sahaj ki AI sahayak hoon.",
        },
        app_overrides: {
          initial_bot_message: "Main Sahaj ki AI sahayak hoon. Main kabhi OTP, PIN, paise ya bank details nahi maangti.",
        },
      },
      user_config: { user_phone_number: masked ? maskPhone(val("LAB_PHONE_MAA_KEYPAD")) : val("LAB_PHONE_MAA_KEYPAD") },
      webhook_config: {
        url: webhookUrl,
        metadata: {
          family_id: DEMO_FAMILY_ID,
          person_id: DEMO_PARENT_ID,
          receipt_id: masked ? "<provider receipt id>" : `lab-sarvam-check-${Date.now().toString(36)}`,
          purpose: purpose.toLowerCase(),
          lab_check: true,
        },
      },
    },
  };
}

const preview = buildRequest({ masked: true });
console.log("");
console.log("== Check-in call the server WOULD send to LAB_PHONE_MAA_KEYPAD (masked; nothing sent)");
console.log(`POST ${preview.url}`);
console.log(`Content-Type: ${preview.headers["Content-Type"]}`);
console.log(`X-API-Key: ${preview.headers["X-API-Key"]}`);
console.log(JSON.stringify(preview.body, null, 2));
console.log("   (receipt_id: the server uses its provider_receipts id; this check uses lab-sarvam-check-<time>.)");

console.log("");
if (problems.length) console.log(`== format problems: ${problems.length}\n   - ${problems.join("\n   - ")}`);
if (missingRequired.length) console.log(`== missing for a real check-in call: ${missingRequired.join(" ")}`);
if (!problems.length && !missingRequired.length) console.log("== all settings for a real check-in call are present and well-formed");

if (!CALL_KEYPAD) {
  console.log("== DRY RUN: no request was sent to Sarvam. (--call-keypad places ONE call to LAB_PHONE_MAA_KEYPAD.)");
  process.exit(0);
}

// ---- --call-keypad: exactly one outbound call, only to LAB_PHONE_MAA_KEYPAD.
if (missingRequired.length || problems.length) {
  console.error("REFUSED: fix the missing/bad settings above before --call-keypad. No call placed.");
  process.exit(2);
}
const real = buildRequest({ masked: false });
if (real.body.user_config.user_phone_number !== val("LAB_PHONE_MAA_KEYPAD") || !E164.test(real.body.user_config.user_phone_number)) {
  console.error("REFUSED: destination is not LAB_PHONE_MAA_KEYPAD. No call placed.");
  process.exit(2);
}
console.log(`== --call-keypad: placing ONE check-in call to LAB_PHONE_MAA_KEYPAD (${maskPhone(val("LAB_PHONE_MAA_KEYPAD"))})`);
try {
  const response = await fetch(real.url, {
    method: "POST",
    headers: real.headers,
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify(real.body),
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  const accepted = response.ok && typeof data.attempt_id === "string";
  console.log(`   HTTP ${response.status} — ${accepted ? "accepted (attempt_id received)" : "NOT accepted"}`);
  if (!accepted && data && typeof data === "object") {
    // Field names only: provider error bodies may echo request values.
    console.log(`   response fields: ${Object.keys(data).join(", ") || "(none)"}`);
  }
  process.exit(accepted ? 0 : 1);
} catch (err) {
  console.error(`   request failed: ${err instanceof Error ? err.name : "error"} (no retry; exactly one attempt)`);
  process.exit(1);
}
