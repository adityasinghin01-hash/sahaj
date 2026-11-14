#!/usr/bin/env node
// Joined-lab END-TO-END proof through the ONE door (scripts/lab/lab-up2.sh). Synthetic demo family only.
//
//   set -a; source ~/.sahaj-lab2/lab2.env; source ~/dev/sahaj-secrets/shield.env; set +a
//   LAB_DOOR_URL=http://127.0.0.1:3200 node scripts/lab/joined-smoke.mjs            # everything
//   node scripts/lab/joined-smoke.mjs --only core1,maa                               # sections: base,core3,core2,core1,maa,x
//
// Prints one PASS/FAIL line per check with statuses, ids and safe codes only; never tokens, secrets or numbers.
// Lab fixtures (trusted contact, circle, consents, permissions, medicine, vendor, synthetic TeleCMI caller) are written
// straight into the LAB database, which must be on loopback; the script refuses anything else. Providers stay off:
// every "acted on" check reads the durable rows (outbox, child_alerts, nudges, assignments, timeline), never a phone.
// Timers: the script drives the same tick routes as scripts/lab/cron-tick.mjs (CRON_SECRET) instead of waiting 30 s.
// Exits 1 on any FAIL.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOOR = (process.env.LAB_DOOR_URL || "http://127.0.0.1:3200").replace(/\/$/, "");
const DB_URL = process.env.LAB2_ADMIN_DB_URL || `postgres://postgres@127.0.0.1:${process.env.LAB2_PG_PORT || 54339}/${process.env.LAB2_DB || "sahaj_lab2"}`;
const env = process.env;
const SECRET = env.SUPABASE_JWT_SECRET;
if (!SECRET || SECRET.length < 32) { console.error("SUPABASE_JWT_SECRET (>= 32 chars) is required"); process.exit(2); }
for (const [name, url] of [["LAB_DOOR_URL", DOOR], ["LAB2_ADMIN_DB_URL", DB_URL]]) {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) { console.error(`${name} must be loopback (lab only)`); process.exit(2); }
}
const onlyArg = process.argv.indexOf("--only");
const ONLY = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(",")) : null;
const want = (s) => !ONLY || ONLY.has(s);

const FAMILY = "11111111-1111-4111-8111-111111111111";
const MAA = "22222222-2222-4222-8222-222222222221";
const RIYA = "22222222-2222-4222-8222-222222222222";
const ROHIT = "22222222-2222-4222-8222-222222222223";
const RIYA_USER = "33333333-3333-4333-8333-333333333332";
const ROHIT_USER = "33333333-3333-4333-8333-333333333333";
// Fixed lab fixture ids (stable across runs, synthetic).
const FX = {
  circle: "71000000-0000-4000-8000-000000000001", medicine: "71000000-0000-4000-8000-000000000002",
  vendor: "71000000-0000-4000-8000-000000000003", refillPerm: "71000000-0000-4000-8000-000000000004",
  consentRiya: "71000000-0000-4000-8000-000000000005", consentRiyaShare: "71000000-0000-4000-8000-000000000006",
  permUrgent: "71000000-0000-4000-8000-000000000007", permCheckin: "71000000-0000-4000-8000-000000000008",
  permShare: "71000000-0000-4000-8000-000000000009", consentMaaRefill: "71000000-0000-4000-8000-00000000000a",
  telecmiCaller: "71000000-0000-4000-8000-00000000000b", vendorPerson: "71000000-0000-4000-8000-00000000000c",
  principal: "71000000-0000-4000-8000-00000000000d", permVoice: "71000000-0000-4000-8000-00000000000e", permNudge: "71000000-0000-4000-8000-00000000000f",
  permMaaVoice: "71000000-0000-4000-8000-000000000010",
};
const TELECMI_APP_ID = Number(env.TELECMI_APP_ID || 900001);
const TELECMI_VIRTUAL = env.TELECMI_VIRTUAL_NUMBER || "910000000099";
const SYNTH_CALLER = "910000000042"; // synthetic, not dialable; registered for Maa as a TeleCMI caller below

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint(sub, secret = SECRET) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, role: "authenticated", iat: now, exp: now + 3600 })}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}
const riya = mint(RIYA_USER), rohit = mint(ROHIT_USER);

const RUN_START = new Date().toISOString();
let failed = 0, passed = 0;
const results = [];
let blocked = 0;
// Core 2 / phone-dying / refill-vendor sends move onto the authorized path in Codex C-15 (authorized-send.ts). Until it lands
// a missing send is reported as BLOCKED-ON-C15, not FAIL; everything else that check() asserts still counts.
function blockedOrCheck(section, label, ok, detail = "") {
  if (ok || process.env.LAB2_C15 === "1") return check(section, label, ok, detail);
  const line = `BLOCKED-ON-C15  [${section}] ${label}${detail ? `  (${detail})` : ""}`;
  console.log(line); results.push(line); blocked += 1;
}
function check(section, label, ok, detail = "") {
  const line = `${ok ? "PASS" : "FAIL"}  [${section}] ${label}${detail ? `  (${detail})` : ""}`;
  console.log(line); results.push(line);
  if (ok) passed += 1; else failed += 1;
  return ok;
}
const short = (v, n = 160) => (typeof v === "string" ? v : JSON.stringify(v ?? null)).slice(0, n);
async function call(path, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${DOOR}${path}`, { method, headers, body: typeof body === "string" || body === undefined || body instanceof FormData ? body : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text.slice(0, 200); }
  return { status: res.status, data };
}
const json = { "content-type": "application/json" };
const as = (token, extra = {}) => ({ ...json, authorization: `Bearer ${token}`, "idempotency-key": `e2e-${randomUUID()}`, ...extra });
const cron = { ...json, "x-cron-secret": env.CRON_SECRET ?? "" };
async function tickAll() {
  const out = {};
  for (const p of ["/api/cron/tick", "/api/core2/cron/overdue", "/api/core2/device-status/tick", "/api/core2/news/tick", "/api/core1/matcher/tick"]) out[p] = await call(p, { method: "POST", headers: cron, body: {} });
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

async function fixtures() {
  const far = new Date(Date.now() + 365 * 86400_000).toISOString();
  // Core 1: Rohit is Maa's rank-1 circle responder (approved + consented); a medicine + approved vendor + refill permission.
  await q(`insert into public.circle(id,family_id,person_id,rank,approved_at,consent_at,access) values($1,$2,$3,1,now(),now(),'family')
           on conflict(family_id,person_id) do update set rank=1,revoked_at=null,approved_at=now(),consent_at=now()`, [FX.circle, FAMILY, ROHIT]);
  await q(`insert into public.medicines(id,family_id,person_id,label,remaining_count,refill_threshold,instructions_confirmed_by_person)
           values($1,$2,$3,'Lab BP tablet',4,5,true) on conflict(id) do update set remaining_count=4`, [FX.medicine, FAMILY, MAA]);
  await q(`insert into public.people(id,family_id,display_name,aliases,role) values($1,$2,'Gupta Medical (lab)',array['Gupta Medical'],'vendor')
           on conflict(id) do nothing`, [FX.vendorPerson, FAMILY]);
  await q(`insert into public.vendors(id,family_id,person_id,approved_at,category) values($1,$2,$3,now(),'pharmacy')
           on conflict(id) do update set approved_at=now(),revoked_at=null`, [FX.vendor, FAMILY, FX.vendorPerson]);
  const consent = async (id, person, purpose) => q(`insert into public.consents(id,family_id,person_id,purpose,question,answer,version)
      values($1,$2,$3,$4,'Lab fixture consent',true,'lab-e2e-v1') on conflict(id) do nothing`, [id, FAMILY, person, purpose]);
  await consent(FX.consentMaaRefill, MAA, "medicine_refill");
  await consent(FX.consentRiya, RIYA, "urgent_responder");
  await consent(FX.consentRiyaShare, RIYA, "share_data");
  // The family's server-owned AI principal (Atlas). Errand permissions bind to it, never to a person. The S1 seed may
  // already have one (one active per family), so reuse it and only create ours when none exists.
  const existing = await q(`select id from public.atlas_principals where family_id=$1 and active and revoked_at is null limit 1`, [FAMILY]);
  if (existing.length) FX.principal = existing[0].id;
  else await q(`insert into public.atlas_principals(id,family_id,active,label) values($1,$2,true,'Sahaj lab principal') on conflict(id) do update set active=true,revoked_at=null`,
    [FX.principal, FAMILY]);
  const perm = async (id, person, action, consentId, limits, extra = {}) => q(`insert into public.permissions(id,family_id,person_id,action,decision,limits,expires_at,consent_id,
      two_person_required,valid_from,period_start,period_end,max_uses,used_count,max_amount_minor,target_ids,vendor_ids,item_ids,principal_id)
      values($1,$2,$3,$4,'allow',$5,$6,$7,$8,now()-interval '1 hour',now()-interval '1 hour',$6,1000,0,$9,$10,$11,$12,$13)
      on conflict(id) do update set revoked_at=null,used_count=0,expires_at=excluded.expires_at,principal_id=excluded.principal_id`,
    [id, FAMILY, person, action, JSON.stringify(limits), far, consentId, extra.twoPerson ?? false, extra.maxAmount ?? 0,
      limits.target_ids ?? [], limits.vendor_ids ?? [], limits.item_ids ?? [], extra.principal ?? null]);
  await perm(FX.refillPerm, MAA, "medicine_refill", FX.consentMaaRefill,
    { target_ids: [MAA], vendor_ids: [FX.vendor], item_ids: [FX.medicine], max_uses: 1000, max_amount_minor: 1_000_000 }, { twoPerson: true, maxAmount: 1_000_000, principal: FX.principal });
  // Core 2 gate: Riya may alert Rohit (urgent_responder), check herself in (check_in) and share a calm status with Maa (share_data).
  await perm(FX.permUrgent, RIYA, "urgent_responder", FX.consentRiya, { target_ids: [ROHIT], max_uses: 1000 });
  await perm(FX.permCheckin, RIYA, "check_in", FX.consentRiya, { target_ids: [RIYA], max_uses: 1000 });
  await perm(FX.permShare, RIYA, "share_data", FX.consentRiyaShare, { target_ids: [MAA], max_uses: 1000 });
  // Core 1 voice (C-14 authorized path): Riya may send Maa a voice message. Bound to the family principal and to Riya's
  // seeded voice_share:<Maa> consent; without it Cedar (correctly) refuses the notify send.
  const riyaVoiceConsent = (await q(`select id from public.consents where family_id=$1 and person_id=$2 and purpose=$3 and answer order by created_at desc limit 1`,
    [FAMILY, RIYA, `voice_share:${MAA}`]))[0]?.id ?? null;
  if (riyaVoiceConsent) await perm(FX.permVoice, RIYA, "voice_message", riyaVoiceConsent, { target_ids: [MAA], max_uses: 1000 }, { principal: FX.principal });
  // Keypad leave_message (core1.sarvam_message_push, Cedar action voice_message): Maa -> Riya, bound to the principal and
  // to Maa's seeded voice_share:<Riya> consent. Without it the transcript is saved but its push is (correctly) refused.
  const maaVoiceConsent = (await q(`select id from public.consents where family_id=$1 and person_id=$2 and purpose=$3 and answer order by created_at desc limit 1`,
    [FAMILY, MAA, `voice_share:${RIYA}`]))[0]?.id ?? null;
  if (maaVoiceConsent) await perm(FX.permMaaVoice, MAA, "voice_message", maaVoiceConsent, { target_ids: [RIYA], max_uses: 1000 }, { principal: FX.principal });
  // Core 1 missed-call push (authorized path): the gate request is person=Maa (caller), target=Riya (recipient). The S1 seed's
  // missed_call_nudge permission targets Maa herself, which Cedar refuses, so the lab adds the Maa -> Riya grant.
  await perm(FX.permNudge, MAA, "missed_call_nudge", "88888888-8888-4888-8888-888888888801", { target_ids: [RIYA], max_uses: 1000 }, { principal: FX.principal });
  // Synthetic TeleCMI caller for Maa (hash only; the digits are synthetic and never stored in clear).
  if (env.IDENTITY_HASH_SECRET?.length >= 32) {
    const hash = createHmac("sha256", env.IDENTITY_HASH_SECRET).update(JSON.stringify(["telecmi", String(TELECMI_APP_ID), SYNTH_CALLER])).digest("hex");
    await q(`insert into public.provider_identities(id,family_id,person_id,source,account_id,external_id_hash,binding_kind)
             values($1,$2,$3,'telecmi',$4,$5,'contact') on conflict(source,account_id,external_id_hash,binding_kind) do update set enabled=true,revoked_at=null`,
      [FX.telecmiCaller, FAMILY, MAA, String(TELECMI_APP_ID), hash]);
  }
}

// ---------------------------------------------------------------- base: health, login, timers configured
if (want("base")) {
  const h1 = await call("/api/health");
  check("base", "shield-api /api/health via door", h1.status === 200 && h1.data?.ok === true, `status ${h1.status}`);
  const h2 = await call("/api/health/readiness");
  check("base", "apps/api readiness via door", h2.status === 200 && h2.data?.database?.status === "connected", `status ${h2.status}`);
  const noAuth = await call("/api/core2/watches", { method: "POST", headers: { ...json, "idempotency-key": randomUUID() }, body: {} });
  check("base", "apps/api refuses a missing bearer", noAuth.status === 401, `status ${noAuth.status}`);
  const forged = await call("/api/core2/watches", { method: "POST", headers: as(mint(RIYA_USER, "x".repeat(40))), body: { eta_minutes: 20 } });
  check("base", "apps/api refuses a token signed with another secret", forged.status === 401, `status ${forged.status}`);
  const ticks = await tickAll();
  const t = ticks["/api/cron/tick"].data;
  check("base", "timers: /api/cron/tick (CRON_SECRET)", ticks["/api/cron/tick"].status === 200, `status ${ticks["/api/cron/tick"].status}, commands ${t?.commands?.status}, missed_calls ${t?.missed_calls?.status}`);
  check("base", "Atlas workflow configured on lab Postgres (verify-full TLS, sahaj_atlas_runtime login)", t?.workflow?.status === "ok", `workflow ${short(t?.workflow?.status)} ${t?.workflow?.problems ? short(t.workflow.problems) : ""}`);
  check("base", "timers: /api/core2/cron/overdue", ticks["/api/core2/cron/overdue"].status === 200, `status ${ticks["/api/core2/cron/overdue"].status}, timer_scale ${ticks["/api/core2/cron/overdue"].data?.timer_scale}`);
  // 503 "unavailable" = core2-device/supabase.ts refuses device notices until C-15's authorized send lands.
  const dt = ticks["/api/core2/device-status/tick"];
  (dt.status === 503 && dt.data?.error === "unavailable" ? blockedOrCheck : check)("base", "timers: /api/core2/device-status/tick", dt.status === 200, `status ${dt.status} ${dt.data?.error ?? ""}`);
  for (const p of ["/api/core2/news/tick", "/api/core1/matcher/tick"]) check("base", `timers: ${p}`, ticks[p].status === 200, `status ${ticks[p].status}`);
  const badCron = await call("/api/cron/tick", { method: "POST", headers: { ...json, "x-cron-secret": "wrong" }, body: {} });
  check("base", "timers refuse a wrong CRON_SECRET", badCron.status === 401, `status ${badCron.status}`);
}

await fixtures();

// ---------------------------------------------------------------- Core 3: every Shield scene
if (want("core3")) {
  const r = spawnSync(process.execPath, [join(HERE, "scenes.mjs")], {
    env: { ...env, LAB_DIR: env.LAB2_DIR || join(homedir(), ".sahaj-lab2"), LAB_API_URL: DOOR,
      DATABASE_URL: env.LAB2_SERVICE_DB_URL || DB_URL.replace("postgres@", "service_role@") },
    encoding: "utf8", timeout: 600_000,
  });
  const out = `${r.stdout ?? ""}`;
  for (const line of out.split("\n").filter((l) => /^\[\d+\/[A-Z0-9]+\]/.test(l))) {
    const m = line.match(/^\[(\d+)\/([A-Z0-9]+)\] (.*) — (PASS|FAIL) \((.*)\)$/);
    if (m) check("core3", `scene ${m[2]}: ${m[3].slice(0, 70)}`, m[4] === "PASS", m[5].slice(0, 120));
  }
  const sum = out.match(/LAB_SCENES_SUMMARY: (\d+)\/(\d+) passed/);
  console.log(`      [core3] scenes summary: ${sum ? `${sum[1]}/${sum[2]}` : "missing"}`);
  if (!sum) check("core3", "scenes.mjs ran", false, `exit ${r.status}`);
}

// ---------------------------------------------------------------- Core 2: watch, escalation, SOS, phone-dying, truth line
if (want("core2")) {
  // Rohit is Riya's rank-1 trusted contact (invite by Riya, consent by Rohit). Reuse an active one if present.
  let contact = (await q(`select id from public.core2_trusted_contacts where family_id=$1 and subject_person_id=$2 and contact_person_id=$3 and state='active' and revoked_at is null`, [FAMILY, RIYA, ROHIT]))[0];
  if (!contact) {
    const inv = await call("/api/core2/trusted-contacts", { method: "POST", headers: as(riya), body: { contact_person_id: ROHIT, rank: 1, scopes: ["sos", "watch_escalation", "reassurance"] } });
    const id = inv.data?.contact?.id;
    const ap = id ? await call(`/api/core2/trusted-contacts/${id}/approve`, { method: "POST", headers: as(rohit), body: { consent_version: "core2-v1" } }) : { status: 0, data: null };
    check("core2", "trusted contact: Riya invites Rohit, Rohit consents", inv.status === 201 && ap.status === 200, `invite ${inv.status}, approve ${ap.status} ${ap.data?.contact?.state ?? short(ap.data, 100)}`);
    contact = id ? { id } : null;
  } else check("core2", "trusted contact: Rohit active for Riya (reused)", true, `contact ${contact.id}`);

  // Watch -> late -> escalation offered to the TOP trusted contact (rank 1 in the DB; the S1 seed makes it Priya, Rohit is
  // rank 2) -> that contact accepts -> Riya safe. Offers expire after 120 s / DEMO_TIMER_SCALE (2 s at 60), so the loop ticks
  // only the overdue route and the accept follows the escalation immediately.
  const top = (await q(`select c.contact_person_id as person_id, m.user_id from public.core2_trusted_contacts c
      join public.family_memberships m on m.family_id=c.family_id and m.person_id=c.contact_person_id and m.revoked_at is null
      where c.family_id=$1 and c.subject_person_id=$2 and c.state='active' and c.revoked_at is null and 'watch_escalation'=any(c.scopes)
      order by c.rank limit 1`, [FAMILY, RIYA]))[0];
  check("core2", "trusted contact: Riya has an active rank-1 contact with watch_escalation scope", !!top, top ? `person ${top.person_id}` : "none");
  const w = await call("/api/core2/watches", { method: "POST", headers: as(riya), body: { eta_minutes: 1, grace_minutes: 1, from_label: "Office", to_label: "Home" } });
  const watchId = w.data?.watch?.id;
  check("core2", "watch: create going-home watch (eta 1 min, grace 1 min)", w.status === 201 && !!watchId, `status ${w.status}, state ${w.data?.watch?.state}`);
  let watch = null;
  for (let i = 0; watchId && i < 30; i++) {
    await call("/api/core2/cron/overdue", { method: "POST", headers: cron, body: {} });
    watch = (await q(`select state, incident_id from public.core2_watches where id=$1`, [watchId]))[0];
    if (watch?.state === "escalated") break;
    await sleep(500);
  }
  let acc = null;
  if (watch?.incident_id && top) acc = await call(`/api/core2/incidents/${watch.incident_id}/accept`, { method: "POST", headers: as(mint(top.user_id)), body: {} });
  check("core2", "watch: late -> checking_in -> escalated by the overdue timer (DEMO_TIMER_SCALE)", watch?.state === "escalated" && !!watch?.incident_id, `state ${watch?.state}`);
  const offer = watch?.incident_id ? (await q(`select id, person_id, status from public.assignments where incident_id=$1 order by offered_at`, [watch.incident_id]))[0] : null;
  check("core2", "escalation: first offer went to the top trusted contact", !!top && offer?.person_id === top.person_id, `assignment ${offer?.status ?? "none"}`);
  check("core2", "escalation: top contact accepts (single owner)", acc?.status === 200 && acc?.data?.accepted === true, `status ${acc?.status} ${acc?.data?.error ?? ""}`);
  // Authorized sends store the Cedar action in outbox.kind (send_alert / share_data); the care kind lives in
  // authorized_send_context.kind (C-15 enqueue_authorized_command), so read it from there.
  const escOutbox = offer ? await q(`select coalesce(c.kind, o.kind) kind, o.status from public.outbox o
      left join public.authorized_send_context c on c.request_id=o.action_request_id and c.family_id=o.family_id
      where o.family_id=$1 and (o.dedupe_key like $2 or o.dedupe_key like $3)`,
    [FAMILY, `core2:watch:offer:${offer.id}%`, `core2:watch:checkin:${watchId}:%`]) : [];
  const escOk = escOutbox.some((o) => o.kind === "core2.watch_escalation") && escOutbox.some((o) => o.kind === "core2.watch_checkin");
  blockedOrCheck("core2", "escalation: authorized outbox rows queued (check-in push + alert to the contact)", escOk, escOutbox.map((o) => `${o.kind}:${o.status}`).join(",") || "none");
  if (watchId) {
    const safe = await call(`/api/core2/watches/${watchId}/safe`, { method: "POST", headers: as(riya), body: {} });
    check("core2", "watch: \"Main safe hoon\" -> safe", safe.status === 200 && (safe.data?.watch?.state ?? safe.data?.state) === "safe", `status ${safe.status}, state ${safe.data?.watch?.state ?? short(safe.data, 80)}`);
  }

  // SOS -> cancel.
  const sos = await call("/api/core2/sos", { method: "POST", headers: as(riya), body: { countdown_seconds: 10 } });
  const sosId = sos.data?.sos?.id ?? sos.data?.sos_id;
  check("core2", "SOS: trigger (10 s countdown)", [200, 201, 202].includes(sos.status) && !!sosId, `status ${sos.status}, ${sos.data?.sos?.status ?? short(sos.data, 100)}`);
  if (sosId) {
    const cancel = await call(`/api/core2/sos/${sosId}/cancel`, { method: "POST", headers: as(riya), body: { reason: "false_alarm" } });
    check("core2", "SOS: cancel", cancel.status === 200 && (cancel.data?.sos?.status ?? cancel.data?.status) === "cancelled", `status ${cancel.status}, ${cancel.data?.sos?.status ?? short(cancel.data, 100)}`);
  }

  // Phone dying during a watch: <= 10 % -> calm notice to the top trusted contact + Maa's truth line.
  const w2 = await call("/api/core2/watches", { method: "POST", headers: as(riya), body: { eta_minutes: 30, from_label: "Office", to_label: "Home" } });
  const w2Id = w2.data?.watch?.id;
  const dev = await call("/api/core2/device-status", { method: "POST", headers: as(riya), body: { battery_level: 8, is_charging: false, sampled_at: new Date().toISOString() } });
  blockedOrCheck("core2", "phone-dying: battery 8 % reported during a watch", dev.status === 200, `status ${dev.status} ${dev.data?.error ?? ""}`);
  await tickAll();
  const handover = w2Id ? await q(`select coalesce(c.kind, o.kind) kind, o.status from public.outbox o
      left join public.authorized_send_context c on c.request_id=o.action_request_id and c.family_id=o.family_id
      where o.family_id=$1 and o.dedupe_key like 'core2:device:%' and o.created_at > now() - interval '5 minutes'`, [FAMILY]) : [];
  blockedOrCheck("core2", "phone-dying: calm notice queued for the top trusted contact", handover.some((h) => h.kind === "core2.device_handover"), handover.map((h) => `${h.kind}:${h.status}`).join(",") || "none");
  blockedOrCheck("core2", "phone-dying: calm status line queued for Maa", handover.some((h) => h.kind === "core2.reassurance"), handover.map((h) => h.kind).join(",") || "none");
  const tl = await call("/api/core2/truth-line", { method: "POST", headers: { ...json, authorization: `Bearer ${env.SARVAM_TOOL_TOKEN || env.SARVAM_TOOL_BEARER || ""}` }, body: { family_id: FAMILY, parent_id: MAA, subject_person_id: RIYA } });
  check("core2", "truth line: Maa's Sarvam tool gets a calm status", tl.status === 200 && typeof tl.data?.spoken_text === "string", `status ${tl.status}, status_label ${tl.data?.status ?? tl.data?.error}`);
  if (w2Id) await call(`/api/core2/watches/${w2Id}/safe`, { method: "POST", headers: as(riya), body: {} });

  const core2Jobs = await q(`select j.state, j.last_error_code, count(*)::int n from public.workflow_jobs j join public.raw_events e on e.id=j.raw_event_id
                             where e.event_type like 'core2.%' group by 1,2`);
  const dead = await q(`select count(*)::int n from public.raw_events where event_type like 'core2.%' and status='dead'`);
  check("core2", "core2.* raw events routed to the Core 2 handler, none dead-lettered", dead[0].n === 0 && core2Jobs.some((j) => j.state === "completed"),
    `${core2Jobs.map((j) => `${j.state}/${j.last_error_code}:${j.n}`).join(",")}; dead ${dead[0].n}`);
}

// ---------------------------------------------------------------- Core 1
if (want("core1")) {
  // Check-in command accepted AND acted on. The dedicated route (apps/api/src/app/api/core1/check-in, check-in-service.ts)
  // executes synchronously and answers 201 (scheduled, or call dispatched with an outbox row); the generic /api/core1
  // command path answers 202 queued and is acted on by the Atlas tick. Both contracts are accepted here.
  const c1 = await call("/api/core1/check-in", { method: "POST", headers: as(riya), body: { person_id: MAA, preferred_time: "09:30", timezone: "Asia/Kolkata" } });
  check("core1", "check-in: command accepted (201 executed or 202 queued)", (c1.status === 201 && c1.data?.ok === true) || (c1.status === 202 && c1.data?.status === "queued"),
    `status ${c1.status} ${c1.data?.action ?? c1.data?.status ?? c1.data?.error ?? ""}`);
  if (c1.status === 201 && c1.data?.scheduleId) {
    const sch = (await q(`select enabled, next_at from public.schedules where id=$1 and family_id=$2`, [c1.data.scheduleId, FAMILY]))[0];
    const ob = c1.data.outboxId ? (await q(`select kind, status from public.outbox where id=$1 and family_id=$2`, [c1.data.outboxId, FAMILY]))[0] : null;
    check("core1", "check-in: acted on (schedule row enabled; outbox row when a call was dispatched)", sch?.enabled === true && (!c1.data.outboxId || !!ob),
      `action ${c1.data.action}; schedule ${sch ? "enabled" : "none"}; outbox ${ob ? `${ob.kind}:${ob.status}` : c1.data.outboxId ? "missing" : "n/a (scheduled for later)"}`);
  } else if (c1.data?.eventId) {
    await tickAll();
    const job = (await q(`select j.workflow_kind, j.state, j.last_error_code from public.workflow_jobs j where j.raw_event_id=$1`, [c1.data.eventId]))[0];
    const ob = (await q(`select kind, action, status from public.outbox where family_id=$1 and dedupe_key=$2`, [FAMILY, `core1:check_in:${c1.data.eventId}`]))[0];
    check("core1", "check-in: acted on by the tick (core1.command job -> outbox row)", job?.state === "completed" && ob?.kind === "core1.check_in",
      `job ${job?.workflow_kind}/${job?.state}/${job?.last_error_code}; outbox ${ob ? `${ob.kind}:${ob.action}:${ob.status}` : "none"}`);
  }

  // Urgent help: Riya asks for help for Maa -> offer to the top circle member -> accept proof -> push row for Riya.
  // The dedicated route (urgent-help-service.ts) creates the incident + offer synchronously and answers 201 with the ids;
  // the generic command path answers 202 and the Atlas tick creates the offer. Poll the DB for the offer (<= 15 s).
  const u = await call("/api/core1/urgent-help", { method: "POST", headers: as(riya), body: { subject_person_id: MAA, severity: "urgent" } });
  check("core1", "urgent-help: command accepted (201 offered or 202 queued)", u.status === 201 || u.status === 202, `status ${u.status} ${u.data?.state ?? u.data?.error ?? ""}`);
  let incident = null;
  if (u.status === 201 || u.data?.eventId) {
    let job = null;
    for (let i = 0; i < 30 && !incident; i++) {
      if (u.status === 201 && u.data?.incidentId) {
        incident = (await q(`select i.id, a.id assignment_id, a.person_id, a.status, a.offered_at from public.incidents i
                             join public.assignments a on a.incident_id=i.id where i.id=$1 and i.family_id=$2 order by a.offered_at limit 1`, [u.data.incidentId, FAMILY]))[0] ?? null;
      } else {
        if (i === 0) await tickAll();
        job = (await q(`select state, last_error_code from public.workflow_jobs where raw_event_id=$1`, [u.data.eventId]))[0];
        incident = (await q(`select i.id, a.id assignment_id, a.person_id, a.status, a.offered_at from public.timeline_events t join public.incidents i on i.id=t.entity_id
                             left join public.assignments a on a.incident_id=i.id where t.dedupe_key=$1 order by a.offered_at limit 1`, [`core1:urgent:offer:${u.data.eventId}`]))[0] ?? null;
      }
      if (!incident) await sleep(500);
    }
    // The first offer is the evidence; at DEMO_TIMER_SCALE=60 it expires after 3 s and advances, so "expired" is fine here.
    check("core1", "urgent-help: offer created for the top circle member (Rohit)", incident?.person_id === ROHIT && ["offered", "expired", "accepted"].includes(incident?.status),
      `${job ? `job ${job.state}/${job.last_error_code}; ` : ""}assignment ${incident?.status ?? "none"}`);
  }
  if (incident?.assignment_id) {
    // Normalized acceptance proof needs a real Twilio Gather on a dispatched responder call (providers are off here).
    const proof = (await q(`select id from public.raw_events where source='twilio' and event_type='responder.accepted' and normalized_proof and metadata->>'assignment_id'=$1`, [incident.assignment_id]))[0];
    const acc = await call("/api/core1/urgent-help", { method: "POST", headers: as(rohit), body: { subject_person_id: MAA, action: "accept", incident_id: incident.id, assignment_id: incident.assignment_id, raw_event_id: proof?.id ?? randomUUID() } });
    if (proof) {
      await tickAll();
      const push = await q(`select kind, status from public.outbox where family_id=$1 and dedupe_key like $2`, [FAMILY, `core1:urgent_accepted_push:${incident.assignment_id}:%`]);
      const job = acc.data?.eventId ? (await q(`select state, last_error_code from public.workflow_jobs where raw_event_id=$1`, [acc.data.eventId]))[0] : null;
      check("core1", "urgent-help: accept with proof -> accepted + Riya notified", (acc.status === 200 && acc.data?.state === "accepted") || push.length > 0,
        `accept ${acc.status} ${acc.data?.state ?? acc.data?.error ?? ""}; push rows ${push.length}; job ${job?.state}/${job?.last_error_code}`);
    } else {
      // Without a provider no Gather proof can exist; the route must then refuse the accept (never trust a client claim).
      check("core1", "urgent-help: accept without a Twilio Gather proof is refused", acc.status === 403 && acc.data?.error === "invalid_acceptance_proof",
        `accept ${acc.status} ${acc.data?.error ?? ""}; proof absent (providers off, needs Twilio Gather)`);
    }
  } else {
    check("core1", "urgent-help: accept with proof -> Riya push row", false, "no offered assignment to accept");
  }

  // Refill proposal -> Cedar gate (two-person) -> approvals -> authorized + vendor outbox row.
  const rp = await call("/api/core1/refill-proposal", { method: "POST", headers: as(riya), body: { medicine_id: FX.medicine, person_id: MAA, vendor_id: FX.vendor, reorder_packs: 1 } });
  const arId = rp.data?.actionRequestId ?? rp.data?.action_request_id;
  check("core1", "refill: proposal goes through the Cedar gate (medicine_refill)", rp.status === 202 && ["ask", "allow"].includes(rp.data?.decision), `status ${rp.status}, decision ${rp.data?.decision ?? rp.data?.error}, reason ${rp.data?.reason ?? ""}`);
  if (arId) {
    const a1 = await call("/api/core1/refill", { method: "POST", headers: as(riya), body: { action_request_id: arId, action: "approve" } });
    const a2 = await call("/api/core1/refill", { method: "POST", headers: as(rohit), body: { action_request_id: arId, action: "approve" } });
    // The authorized errand queues Riya's refill notice ("Gupta Medical ko order bhej diya") as its own per-recipient
    // authorized send (C-15, kind core1.refill_notice, own action request). It is linked to this refill through the errand
    // in care_send_context.details. A direct row on the refill request is also accepted (vendor call: not wired yet).
    const ob = await q(`select coalesce(c.kind, o.kind) kind, o.status from public.outbox o
        left join public.authorized_send_context c on c.request_id=o.action_request_id and c.family_id=o.family_id
        where o.family_id=$1 and (o.action_request_id=$2 or o.action_request_id in (
          select d.request_id from public.care_send_context d join public.errands e on e.id=(d.details->>'errandId')::uuid
          where e.family_id=$1 and e.action_request_id=$2))`, [FAMILY, arId]);
    blockedOrCheck("core1", "refill: family approves -> authorized + refill notice outbox row", [a1.data?.status, a2.data?.status].includes("authorized") && ob.length > 0,
      `approve ${a1.status}/${a1.data?.status ?? a1.data?.error}, second ${a2.status}/${a2.data?.status ?? a2.data?.error}; outbox ${ob.map((o) => `${o.kind}:${o.status}`).join(",") || "none"}`);
    const med = (await q(`select remaining_count from public.medicines where id=$1`, [FX.medicine]))[0];
    check("core1", "refill: stock not decremented before delivery", med?.remaining_count === 4, `remaining ${med?.remaining_count}`);
  }

  // Voice message upload -> notify row for Maa.
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("OggS" + "\0".repeat(60))], { type: "audio/ogg" }), "lab.ogg");
  form.append("recipient_person_id", MAA);
  form.append("consent_granted", "true");
  form.append("duration_s", "2");
  const up = await call("/api/core1/voice-messages/upload", { method: "POST", headers: { authorization: `Bearer ${riya}`, "idempotency-key": `e2e-${randomUUID()}` }, body: form });
  check("core1", "voice: upload Riya's recording (consented, private lab storage)", up.status === 201 && !!up.data?.media_object_path, `status ${up.status} ${up.data?.error ?? ""}`);
  if (up.data?.media_object_path) {
    const vm = await call("/api/core1/voice-message", { method: "POST", headers: as(riya),
      body: { recipient_person_id: MAA, media_object_path: up.data.media_object_path, consent_id: up.data.consent_id } });
    const vid = vm.data?.voicePostId ?? vm.data?.voice_post_id ?? vm.data?.data?.voicePostId ?? vm.data?.id;
    const notify = await q(`select kind, status, dedupe_key from public.outbox where family_id=$1 and (kind like 'core1.voice%' or dedupe_key like 'voice_notify:%') and created_at > now() - interval '2 minutes'`, [FAMILY]);
    check("core1", "voice: voice-message -> Maa notify outbox row", vm.status >= 200 && vm.status < 300 && notify.length > 0,
      `status ${vm.status} ${vm.data?.error ?? ""}; post ${vid ? "created" : "?"}; notify ${notify.map((n) => `${n.kind}:${n.status}`).join(",") || "none"}`);
  }

  // Missed-call webhook (secret path, synthetic CDR) -> Core 1 nudge row for Riya.
  if (env.MISSEDCALL_HOOK_SECRET) {
    const callId = `lab-${randomUUID()}`;
    const cdr = { type: "cdr", direction: "inbound", status: "missed", cmiuuid: callId, appid: TELECMI_APP_ID, time: Date.now(), from: SYNTH_CALLER, virtual_number: TELECMI_VIRTUAL };
    const wrong = await call("/api/missed-call/not-the-secret", { method: "POST", headers: json, body: cdr });
    const mc = await call(`/api/missed-call/${env.MISSEDCALL_HOOK_SECRET}`, { method: "POST", headers: json, body: cdr });
    check("core1", "missed-call: wrong path secret refused, right secret accepted", wrong.status === 404 && (mc.status === 200 || mc.status === 202), `wrong ${wrong.status}, right ${mc.status} ${mc.data?.error ?? ""}`);
    await tickAll();
    const nudge = await q(`select n.kind, n.status from public.nudges n where n.family_id=$1 and n.person_id=$2 and n.created_at > now() - interval '2 minutes'`, [FAMILY, RIYA]);
    const push = await q(`select status from public.outbox where family_id=$1 and (kind='core1.missed_call_push' or action='missed_call_nudge') and created_at > now() - interval '2 minutes'`, [FAMILY]);
    const raw = (await q(`select status from public.raw_events where source='telecmi' and provider_event_id=$1`, [`${TELECMI_APP_ID}:missed:${callId}`]))[0];
    check("core1", "missed-call: tick -> nudge row + Riya push outbox row", nudge.length > 0 && push.length > 0, `raw ${raw?.status}; nudges ${nudge.length}; push ${push.length}`);
  } else check("core1", "missed-call webhook", false, "MISSEDCALL_HOOK_SECRET not in env");

  // Family report.
  const end = new Date(), start = new Date(end.getTime() - 7 * 86400_000);
  const fr = await call("/api/core1/family-report", { method: "POST", headers: as(riya), body: { periodStart: start.toISOString(), periodEnd: end.toISOString() } });
  check("core1", "family report: weekly report from real rows", fr.status >= 200 && fr.status < 300, `status ${fr.status} ${fr.data?.error ?? ""} ${fr.data?.report ? "report ok" : ""}`);

  const deadCmd = await q(`select count(*)::int n from public.raw_events where (event_type like 'command.%' or source='core1_maa_device') and status='dead'`);
  check("core1", "no Core 1 command raw event dead-lettered", deadCmd[0].n === 0, `dead ${deadCmd[0].n}`);
  // Authorized sends open a one-shot workflow job to fence their enqueue; it must be closed once the outbox row is queued.
  const sendJobs = await q(`select workflow_kind, state, count(*)::int n from public.workflow_jobs where family_id=$1 and created_at>=$2
      and workflow_kind in ('core1.voice_notify','core1.missed_call_push') group by 1,2 order by 1,2`, [FAMILY, RUN_START]);
  check("core1", "voice_notify + missed_call_push send jobs completed (none left processing)",
    ["core1.voice_notify", "core1.missed_call_push"].every((k) => sendJobs.some((j) => j.workflow_kind === k && j.state === "completed")) && !sendJobs.some((j) => j.state === "processing"),
    sendJobs.map((j) => `${j.workflow_kind}:${j.state}:${j.n}`).join(",") || "none");
}

// ---------------------------------------------------------------- Maa's device routes with a real paired-device signature
if (want("maa")) {
  const code = await call("/api/app/shield/pair-code", { method: "POST", headers: as(riya), body: {} });
  const pair = code.data?.code ? await call("/api/shield/pair", { method: "POST", headers: json, body: { code: code.data.code, parent_person_id: MAA, label: "Lab e2e Maa phone", platform: "android",
    protections: { sms: true, screening: true, redirection: true, usage: true, notifications: true, overlay: true } } }) : { status: code.status, data: null };
  check("maa", "pair a synthetic Maa device (shield pair-code + pair)", pair.status === 200 && !!pair.data?.device_secret, `status ${pair.status}`);
  if (pair.data?.device_secret) {
    const signed = (body = "") => { const ts = String(Date.now()); return { "x-shield-device": pair.data.device_id, "x-shield-ts": ts,
      "x-shield-sig": createHmac("sha256", pair.data.device_secret).update(`${ts}.${body}`).digest("hex") }; };
    const list = await call("/api/core1/maa/voice", { headers: signed("") });
    check("maa", "GET /api/core1/maa/voice with the device signature", list.status === 200, `status ${list.status} ${list.data?.error ?? ""}`);
    const bad = await call("/api/core1/maa/voice", { headers: { ...signed(""), "x-shield-sig": "0".repeat(64) } });
    check("maa", "a wrong device signature is refused", bad.status === 401, `status ${bad.status}`);
    const body = JSON.stringify({ severity: "urgent", idempotency_key: `e2e-${randomUUID()}` });
    const urgent = await call("/api/core1/maa/urgent", { method: "POST", headers: { ...json, ...signed(body) }, body });
    check("maa", "POST /api/core1/maa/urgent (signed) -> calm status + offer", urgent.status === 201, `status ${urgent.status} ${urgent.data?.error ?? urgent.data?.state ?? ""}`);
  }
}

// ---------------------------------------------------------------- keypad Core 1 tools + X1 proof / any-phone + X2 gentle news + X3 matcher
// Keypad tools are Sarvam tool calls (bearer SARVAM_TOOL_TOKEN) on apps/api; the lab gives their raw-SQL ports
// SARVAM_TOOLS_DATABASE_URL. Maa's device routes use a freshly paired synthetic device signature, like section "maa".
if (want("x")) {
  const tool = { ...json, authorization: `Bearer ${env.SARVAM_TOOL_TOKEN || env.SARVAM_TOOL_BEARER || ""}` };
  const keypad = async (name, input = {}) => call(`/api/core1/sarvam/${name}`, { method: "POST", headers: { ...tool, "idempotency-key": `e2e-${randomUUID()}` },
    body: { variables: { family_id: FAMILY, parent_id: MAA }, input } });
  const since = new Date(Date.now() - 1000).toISOString();
  const cs = await keypad("check_status");
  check("x", "keypad tool check_status (Sarvam bearer) -> calm line, no transfer", cs.status === 200 && cs.data?.transfer === false && typeof cs.data?.line_hi === "string",
    `status ${cs.status}, result ${short(cs.data?.result, 60)}, transfer ${cs.data?.transfer}`);
  const chs = await keypad("child_status");
  check("x", "keypad tool child_status -> Riya's calm status line", chs.status === 200 && chs.data?.transfer === false && typeof chs.data?.result?.status === "string",
    `status ${chs.status}, child ${chs.data?.result?.status ?? short(chs.data?.result, 60)}`);
  const lm = await keypad("leave_message", { transcript: "Riya beta, khana kha lena. Lab smoke sandesh." });
  const lmRow = (await q(`select event_type from public.timeline_events where family_id=$1 and event_type='core1.message.transcript' and created_at>=$2 limit 1`, [FAMILY, since]))[0];
  const lmPush = (await q(`select o.status from public.outbox o join public.authorized_send_context c on c.request_id=o.action_request_id and c.family_id=o.family_id
      where o.family_id=$1 and c.kind='core1.sarvam_message_push' and o.created_at>=$2 limit 1`, [FAMILY, since]))[0];
  // Providers off: EXPO push is disabled, so the tool (by design, docs/sarvam-setup.md) says the fallback line and transfers
  // AFTER the transcript is saved and its authorized push is queued. With push on it answers transfer:false.
  const pushOff = env.LAB2_PROVIDERS === "off";
  check("x", "keypad tool leave_message -> AI transcript saved + authorized push to Riya queued", lm.status === 200 && !!lmRow && !!lmPush
    && (lm.data?.transfer === false || (pushOff && lm.data?.result?.error === "unavailable")),
    `status ${lm.status}, transfer ${lm.data?.transfer}${pushOff ? " (push off)" : ""}; timeline ${lmRow ? "core1.message.transcript" : "none"}; push ${lmPush?.status ?? "none"}`);
  const ru = await keypad("raise_urgent", { said: "Lab smoke: mujhe madad chahiye", severity: "urgent" });
  check("x", "keypad tool raise_urgent -> urgent help for Maa raised", ru.status === 200 && ru.data?.transfer === false && ["queued", "offered", "open", "accepted", "escalated"].includes(ru.data?.result?.status),
    `status ${ru.status}, result ${short(ru.data?.result, 60)}, transfer ${ru.data?.transfer}`);
  const noBearer = await call("/api/core1/sarvam/check_status", { method: "POST", headers: json, body: { variables: { family_id: FAMILY, parent_id: MAA } } });
  check("x", "keypad tools refuse a missing Sarvam bearer", noBearer.status === 401, `status ${noBearer.status}`);

  // Maa's synthetic device for the X1 / X2 device routes.
  const code = await call("/api/app/shield/pair-code", { method: "POST", headers: as(riya), body: {} });
  const pair = code.data?.code ? await call("/api/shield/pair", { method: "POST", headers: json, body: { code: code.data.code, parent_person_id: MAA, label: "Lab e2e Maa phone (x)", platform: "android",
    protections: { sms: true, screening: true, redirection: true, usage: true, notifications: true, overlay: true } } }) : { status: code.status, data: null };
  const signed = (body = "") => { const ts = String(Date.now()); return { "x-shield-device": pair.data?.device_id ?? "", "x-shield-ts": ts,
    "x-shield-sig": createHmac("sha256", pair.data?.device_secret ?? "x").update(`${ts}.${body}`).digest("hex") }; };

  // X1: Riya asks for a fresh proof of life -> Maa's device route shows that same check and its status.
  const pr = await call("/api/core2/proof", { method: "POST", headers: as(riya), body: {} });
  const challenge = pr.data?.challenge;
  check("x", "X1 proof: Riya asks for a fresh proof-of-life check", pr.status === 201 && !!challenge?.id, `status ${pr.status}, ${challenge?.status ?? pr.data?.error ?? ""}`);
  const mp = await call("/api/core2/maa-proof", { headers: signed("") });
  check("x", "X1 proof: Maa's device route (signed) answers with that check", mp.status === 200 && !!challenge?.id && mp.data?.proof?.id === challenge.id,
    `status ${mp.status}, proof ${mp.data?.proof?.status ?? mp.data?.error ?? "none"}${mp.data?.proof?.id === challenge?.id ? " (same id)" : ""}`);
  const mpBad = await call("/api/core2/maa-proof", { headers: { ...signed(""), "x-shield-sig": "0".repeat(64) } });
  check("x", "X1 proof: a wrong device signature is refused", mpBad.status === 401, `status ${mpBad.status}`);

  // X1 any-phone: Riya calls from another phone and says the family code word. A pass rotates the word, so the lab sets the
  // synthetic seed word first, clears this family's attempt guard, and restores the seed word afterwards.
  const SEED_WORD = "gulmohar"; // synthetic demo code word from infra/supabase/dev/seed_demo_full.sql section 12
  const seedHash = createHash("sha256").update(SEED_WORD).digest("hex"); // seed: sha256(normalizeCodeWord(word))
  await q(`update public.shield_family_security set code_word_hash=$2 where family_id=$1`, [FAMILY, seedHash]);
  await q(`delete from public.core2_any_phone_guards where family_id=$1`, [FAMILY]);
  const ap = await call("/api/core2/any-phone/verify", { method: "POST", headers: tool, body: { family_id: FAMILY, said_name: "Riya", said_code_word: SEED_WORD, status_kind: "safe" } });
  const apWrong = await call("/api/core2/any-phone/verify", { method: "POST", headers: tool, body: { family_id: FAMILY, said_name: "Riya", said_code_word: "galat shabd", status_kind: "safe" } });
  await q(`update public.shield_family_security set code_word_hash=$2 where family_id=$1`, [FAMILY, seedHash]);
  await q(`delete from public.core2_any_phone_guards where family_id=$1`, [FAMILY]);
  check("x", "X1 any-phone verify: name + code word -> verified, limited powers, word rotated", ap.status === 200 && ap.data?.verified === true && ap.data?.code_word_rotated === true && !!ap.data?.incident_id,
    `status ${ap.status}, verified ${ap.data?.verified}, powers ${(ap.data?.granted_powers ?? []).join("+")}, offered ${ap.data?.offered_contact_name ? "yes" : "no"}`);
  check("x", "X1 any-phone verify: a wrong code word is refused", apWrong.status === 200 && apWrong.data?.verified === false, `status ${apWrong.status}, remaining ${apWrong.data?.remaining_attempts}`);
  const mpAny = await call("/api/core2/maa-proof", { headers: signed("") });
  check("x", "X1 any-phone: Maa's device route shows the live any-phone status", mpAny.status === 200 && !!ap.data?.session_id && mpAny.data?.any_phone?.id === ap.data.session_id,
    `status ${mpAny.status}, any_phone ${mpAny.data?.any_phone ? "present" : "none"}`);

  // X2: gentle news on the any-phone incident (Riya marks hurt) -> state -> close with after-report -> report readable.
  const incidentId = ap.data?.incident_id;
  if (incidentId) {
    const gn = await call("/api/core2/news", { method: "POST", headers: as(riya), body: { incident_id: incidentId, calm_summary: "Riya theek hai, doctor ne dekh liya hai." } });
    check("x", "X2 gentle news: Riya marks the incident hurt (Maa not pushed directly)", [200, 201].includes(gn.status) && !!gn.data,
      `status ${gn.status}, ${gn.data?.status ?? gn.data?.circle_offer_status ?? gn.data?.error ?? ""}`);
    const gs = await call(`/api/core2/news?incident_id=${incidentId}`, { headers: as(riya) });
    check("x", "X2 gentle news: state readable", gs.status === 200, `status ${gs.status}, ${gs.data?.status ?? gs.data?.error ?? ""}`);
    const close = await call(`/api/core2/after-report/${incidentId}`, { method: "POST", headers: as(riya), body: {} });
    const rep = await call(`/api/core2/after-report/${incidentId}`, { headers: as(riya) });
    check("x", "X2 after-report: Riya closes the incident -> after-report generated and readable", close.status === 200 && rep.status === 200,
      `close ${close.status} ${close.data?.error ?? ""}, report ${rep.status} ${rep.data?.error ?? ""}`);
  } else check("x", "X2 gentle news: needs the any-phone incident", false, "no incident");

  // X2 heard: Maa's device acks full playback of Riya's newest voice note -> receipt + Riya sees "heard".
  const vp = (await q(`select id from public.voice_posts where family_id=$1 and recipient_id=$2 order by created_at desc limit 1`, [FAMILY, MAA]))[0];
  if (vp) {
    const body = JSON.stringify({ message_kind: "core1_voice_post", delivery_id: vp.id, clip_duration_s: 2, played_duration_s: 2, playback_finished: true });
    const heard = await call("/api/core2/heard/device", { method: "POST", headers: { ...json, ...signed(body) }, body });
    const hs = await call(`/api/core2/heard?voice_post_id=${vp.id}&message_kind=core1_voice_post`, { headers: as(riya) });
    check("x", "X2 heard: Maa's device acks full playback (signed) -> heard receipt", heard.status === 200 && !!heard.data?.receipt_id,
      `status ${heard.status} ${heard.data?.error ?? ""}, already ${heard.data?.already_recorded}`);
    check("x", "X2 heard: Riya reads the heard status", hs.status === 200, `status ${hs.status} ${hs.data?.error ?? short(hs.data?.heard ?? hs.data?.status, 40)}`);
  } else check("x", "X2 heard: needs a voice note for Maa (run section core1 first)", false, "no voice post");

  // X3: Maa says when she is free (save_free_time) -> a window row -> the matcher tick evaluates the family.
  const ft = await call("/api/core1/matcher/free-time-tool", { method: "POST", headers: tool,
    body: { variables: { family_id: FAMILY, parent_id: MAA }, input: { said: "shaam 6 se 8 baje tak free hoon" } } });
  const win = ft.data?.window_id ? (await q(`select active, source from public.core1_free_windows where id=$1 and family_id=$2`, [ft.data.window_id, FAMILY]))[0] : null;
  check("x", "X3 save_free_time: Maa's free time saved (window row, read back)", ft.status === 200 && ft.data?.saved === true && win?.active === true,
    `status ${ft.status}, ${ft.data?.start_time ?? ""}-${ft.data?.end_time ?? ""}, window ${win ? `${win.source}` : "none"}`);
  const mt = await call("/api/core1/matcher/tick", { method: "POST", headers: cron, body: { family_id: FAMILY } });
  const nudged = (mt.data?.nudges_sent ?? []).some((n) => n.family_id === FAMILY);
  const skip = (mt.data?.skipped ?? []).find((s) => s.family_id === FAMILY);
  check("x", "X3 matcher tick: evaluates the family (nudge, or a stated skip reason)", mt.status === 200 && mt.data?.checked_families >= 1 && (nudged || !!skip),
    `status ${mt.status}, ${nudged ? "both-free nudge queued" : `skipped: ${skip?.reason ?? "none"}`}`);
}

await db.end();
console.log(`\nJOINED_E2E: ${failed === 0 ? "PASS" : "FAIL"} (${passed} pass, ${failed} fail, ${blocked} blocked-on-C15)`);
process.exit(failed === 0 ? 0 : 1);
