import assert from "node:assert/strict";
import postgres from "postgres";

const BASE_URL = process.env.BASE_URL;
const DEV_TOKEN = process.env.DEV_ADMIN_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

const FAMILY_1 = process.env.FAMILY_1;
const PARENT_1 = process.env.PARENT_1;
const FAMILY_2 = process.env.FAMILY_2;
const PARENT_2 = process.env.PARENT_2;
const VERDICT_F1_FRAUD = process.env.VERDICT_F1_FRAUD;
const VERDICT_F2_FRAUD = process.env.VERDICT_F2_FRAUD;
const VERDICT_F1_SAFE = process.env.VERDICT_F1_SAFE;
const VERDICT_F1_RACE = process.env.VERDICT_F1_RACE;

const sql = postgres(DATABASE_URL, { max: 4 });

async function postJson(route, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function getJson(route, headers = {}) {
  const res = await fetch(`${BASE_URL}${route}`, { method: "GET", headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const adminHeaders = { "x-dev-admin-token": DEV_TOKEN };
const cronHeaders = { "x-cron-secret": CRON_SECRET };

async function run() {
  // 0. Health + dev auth guard
  const health = await getJson("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const unauthCall = await postJson("/api/dev/shield/call-status", {
    family_id: FAMILY_1,
    parent_id: PARENT_1,
    status: "busy",
    in_checkin_window: true,
  });
  assert.equal(unauthCall.status, 401);

  const unauthTip = await getJson(`/api/dev/shield/weekly-tip?family_id=${FAMILY_1}`, {
    "x-dev-admin-token": "wrong-token",
  });
  assert.equal(unauthTip.status, 401);

  // Cross-family & unknown entity rejections before any writes
  const crossParent = await postJson(
    "/api/dev/shield/call-status",
    { family_id: FAMILY_1, parent_id: PARENT_2, status: "busy", in_checkin_window: true },
    adminHeaders,
  );
  assert.equal(crossParent.status, 404);

  const crossFeedback = await postJson(
    "/api/dev/shield/feedback",
    { verdict_id: VERDICT_F1_FRAUD, feedback: "fraud", family_id: FAMILY_2 },
    adminHeaders,
  );
  assert.equal(crossFeedback.status, 403);

  const unknownTip = await getJson(
    "/api/dev/shield/weekly-tip?family_id=99999999-9999-4999-8999-999999999999",
    adminHeaders,
  );
  assert.equal(unknownTip.status, 404);

  // 1 & 2. Busy streak -> alert (outbox) -> no reply -> cron shield.busy.circle escalation + shield.busy.retry outbox
  const t0 = Date.now();
  let streak1Id = "";
  for (let i = 0; i < 3; i++) {
    const at = new Date(t0 + (i - 2) * 10_000).toISOString();
    const res = await postJson(
      "/api/dev/shield/call-status",
      {
        family_id: FAMILY_1,
        parent_id: PARENT_1,
        status: "busy",
        in_checkin_window: true,
        at,
      },
      adminHeaders,
    );
    assert.equal(res.status, 200);
    streak1Id = res.body.result.streakId;
    assert.equal(res.body.result.retryScheduled, true);
    assert.equal(res.body.result.alerted, i === 2);
  }

  // Verify DB streak state + simulated push busy_alert in dev_outbox
  const [s1Row] = await sql`
    select id, busy_count, alerted_at, child_replied_at, circled_at, ended_at
    from public.busy_streaks where id = ${streak1Id}`;
  assert.equal(s1Row.busy_count, 3);
  assert.ok(s1Row.alerted_at);
  assert.equal(s1Row.circled_at, null);

  const outboxAlert = await sql`
    select channel, kind, dedupe_key, payload
    from public.dev_outbox
    where dedupe_key = ${`push:busy_alert:${streak1Id}`}`;
  assert.equal(outboxAlert.length, 1);
  assert.equal(outboxAlert[0].channel, "push");

  // Cross-family busy reply must fail with 403
  const crossReply = await postJson(
    "/api/dev/shield/busy-reply",
    { streak_id: streak1Id, family_id: FAMILY_2 },
    adminHeaders,
  );
  assert.equal(crossReply.status, 403);

  // Wait > 5s so DEMO_TIMER_SCALE=120 makes 5m circle (2.5s) & 10m retry (5s) due in Postgres
  await new Promise((r) => setTimeout(r, 5_600));

  const cron1 = await getJson("/api/cron/shield-jobs", cronHeaders);
  assert.equal(cron1.status, 200);
  assert.ok(
    cron1.body.results.some((r) => r.name === "shield.busy.circle" && r.status === "done" && r.result?.outcome === "circled"),
    `expected circled outcome, got ${JSON.stringify(cron1.body)}`,
  );
  assert.ok(
    cron1.body.results.some((r) => r.name === "shield.busy.retry" && r.status === "done" && r.result?.outcome === "outbox_simulated"),
    `expected outbox_simulated retry outcome, got ${JSON.stringify(cron1.body)}`,
  );

  const [s1AfterCircle] = await sql`select circled_at from public.busy_streaks where id = ${streak1Id}`;
  assert.ok(s1AfterCircle.circled_at);

  const circleOutbox = await sql`
    select channel, kind, payload from public.dev_outbox where kind = 'start_circle_chain'`;
  assert.equal(circleOutbox.length, 1);
  assert.equal(circleOutbox[0].payload.reason, "busy_line_no_reply");

  const retryOutbox = await sql`
    select channel, kind, payload from public.dev_outbox where kind = 'busy_checkin_retry_requested'`;
  assert.ok(retryOutbox.length >= 1);
  assert.equal(retryOutbox[0].payload.simulated, true);
  assert.equal(retryOutbox[0].payload.delivery_claimed, false);

  // Close streak 1 with connected
  const close1 = await postJson(
    "/api/dev/shield/call-status",
    {
      family_id: FAMILY_1,
      parent_id: PARENT_1,
      status: "connected",
      in_checkin_window: true,
      at: new Date().toISOString(),
    },
    adminHeaders,
  );
  assert.equal(close1.status, 200);
  assert.equal(close1.body.result.streak, "closed");

  // 3. Second busy streak -> alert -> child replies -> shield.busy.circle must NOT start circle chain
  const t1 = Date.now();
  let streak2Id = "";
  for (let i = 0; i < 3; i++) {
    const at = new Date(t1 + (i - 2) * 10_000).toISOString();
    const res = await postJson(
      "/api/dev/shield/call-status",
      {
        family_id: FAMILY_1,
        parent_id: PARENT_1,
        status: "busy",
        in_checkin_window: false,
        at,
      },
      adminHeaders,
    );
    assert.equal(res.status, 200);
    streak2Id = res.body.result.streakId;
    assert.equal(res.body.result.alerted, i === 2);
  }
  assert.notEqual(streak2Id, streak1Id);

  const reply2 = await postJson(
    "/api/dev/shield/busy-reply",
    { streak_id: streak2Id, family_id: FAMILY_1 },
    adminHeaders,
  );
  assert.equal(reply2.status, 200);
  assert.equal(reply2.body.replied, true);
  assert.equal(reply2.body.parent_id, PARENT_1);

  await new Promise((r) => setTimeout(r, 3_000));
  const cron2 = await getJson("/api/cron/shield-jobs", cronHeaders);
  assert.equal(cron2.status, 200);
  assert.ok(
    cron2.body.results.some((r) => r.name === "shield.busy.circle" && r.status === "done" && r.result?.outcome === "replied"),
    `expected replied outcome, got ${JSON.stringify(cron2.body)}`,
  );

  const [s2Row] = await sql`select child_replied_at, circled_at from public.busy_streaks where id = ${streak2Id}`;
  assert.ok(s2Row.child_replied_at);
  assert.equal(s2Row.circled_at, null);

  const circleOutboxAfterReply = await sql`
    select count(*)::int as n from public.dev_outbox where kind = 'start_circle_chain'`;
  assert.equal(circleOutboxAfterReply[0].n, 1);

  // Close streak 2
  await postJson(
    "/api/dev/shield/call-status",
    { family_id: FAMILY_1, parent_id: PARENT_1, status: "connected", in_checkin_window: false },
    adminHeaders,
  );

  // 4. Unsupported cron job rejected explicitly
  const [badJob] = await sql`
    insert into public.shield_jobs (name, payload, run_at, status)
    values ('shield.unsupported.e2e', '{}'::jsonb, now() - interval '1 second', 'pending')
    returning id`;
  const cronBad = await getJson("/api/cron/shield-jobs", cronHeaders);
  assert.equal(cronBad.status, 200);
  const badRes = cronBad.body.results.find((r) => r.id === badJob.id);
  assert.equal(badRes?.status, "failed");
  assert.equal(badRes?.error, "Unknown Shield scheduled job");
  const [badJobDb] = await sql`select status, last_error from public.shield_jobs where id = ${badJob.id}`;
  assert.equal(badJobDb.status, "failed");
  assert.equal(badJobDb.last_error, "Unknown Shield scheduled job");

  // 5. Safe feedback persists child_feedback='safe' and creates zero sightings
  const safeRes = await postJson(
    "/api/dev/shield/feedback",
    { verdict_id: VERDICT_F1_SAFE, feedback: "safe" },
    adminHeaders,
  );
  assert.equal(safeRes.status, 200);
  assert.equal(safeRes.body.result.outcome, "ignored_safe");
  const [safeVerdictRow] = await sql`
    select child_feedback, feedback_at from public.shield_verdicts where id = ${VERDICT_F1_SAFE}`;
  assert.equal(safeVerdictRow.child_feedback, "safe");
  assert.ok(safeVerdictRow.feedback_at);
  const [safeSightingCount] = await sql`
    select count(*)::int as n from public.scam_indicator_sightings where verdict_id = ${VERDICT_F1_SAFE}`;
  assert.equal(safeSightingCount.n, 0);

  // 6. Concurrent Safe vs Fraud race on VERDICT_F1_RACE must agree 100% in Postgres
  const [raceA, raceB] = await Promise.all([
    postJson("/api/dev/shield/feedback", { verdict_id: VERDICT_F1_RACE, feedback: "safe" }, adminHeaders),
    postJson("/api/dev/shield/feedback", { verdict_id: VERDICT_F1_RACE, feedback: "fraud" }, adminHeaders),
  ]);
  const raceStatuses = [raceA.status, raceB.status].sort((a, b) => a - b);
  assert.deepEqual(raceStatuses, [200, 409]);
  const [raceVerdictRow] = await sql`
    select child_feedback from public.shield_verdicts where id = ${VERDICT_F1_RACE}`;
  const [raceSightings] = await sql`
    select count(*)::int as n from public.scam_indicator_sightings where verdict_id = ${VERDICT_F1_RACE}`;
  if (raceVerdictRow.child_feedback === "safe") {
    assert.equal(raceSightings.n, 0);
  } else {
    assert.equal(raceVerdictRow.child_feedback, "fraud");
    assert.ok(raceSightings.n > 0);
  }

  // 7. Concurrent/repeated Fraud feedback on Family 1 stays unconfirmed (families_affected = 1),
  //    then Family 2 confirms shared indicator (confirmed = true, families_affected = 2),
  //    and GET /api/dev/shield/weekly-tip returns a tip derived from Postgres.
  const [f1A, f1B] = await Promise.all([
    postJson("/api/dev/shield/feedback", { verdict_id: VERDICT_F1_FRAUD, feedback: "fraud" }, adminHeaders),
    postJson("/api/dev/shield/feedback", { verdict_id: VERDICT_F1_FRAUD, feedback: "fraud" }, adminHeaders),
  ]);
  assert.equal(f1A.status, 200);
  assert.equal(f1B.status, 200);
  const [preConfirmMax] = await sql`
    select max(i.families_affected)::int as max_fam, bool_or(i.confirmed) as any_confirmed
    from public.scam_indicators i
    join public.scam_indicator_sightings s on s.indicator_id = i.id
    where s.verdict_id = ${VERDICT_F1_FRAUD}`;
  assert.equal(preConfirmMax.max_fam, 1);
  assert.equal(preConfirmMax.any_confirmed, false);

  const f2 = await postJson(
    "/api/dev/shield/feedback",
    { verdict_id: VERDICT_F2_FRAUD, feedback: "fraud" },
    adminHeaders,
  );
  assert.equal(f2.status, 200);
  assert.ok(
    f2.body.result.indicators.some((i) => i.confirmed === true && i.familiesAffected === 2),
    `expected confirmed indicator for 2nd family, got ${JSON.stringify(f2.body)}`,
  );

  const [confirmedCount] = await sql`
    select count(*)::int as n from public.scam_indicators where confirmed = true and families_affected >= 2`;
  assert.ok(confirmedCount.n >= 1);

  const tipRes = await getJson(`/api/dev/shield/weekly-tip?family_id=${FAMILY_1}`, adminHeaders);
  assert.equal(tipRes.status, 200);
  assert.equal(tipRes.body.simulated_checkin, true);
  assert.ok(tipRes.body.tip.fraud_tip_en.includes("KYC") || tipRes.body.tip.fraud_tip_en.length > 10);
  assert.ok(tipRes.body.tip.fraud_tip_hi.length > 10);

  const [timelineCount] = await sql`select count(*)::int as n from public.dev_timeline`;
  const [outboxCount] = await sql`select count(*)::int as n from public.dev_outbox`;
  const [alertOutboxCount] = await sql`
    select count(*)::int as n from public.dev_outbox where kind = 'busy_alert'`;

  console.log(
    JSON.stringify(
      {
        real_postgres_http_verified: {
          busy_streaks_closed: 2,
          streak1_circled: true,
          streak2_replied_stopped_circle: true,
          unsupported_job_rejected: true,
          safe_verdict_sightings: safeSightingCount.n,
          concurrent_race_persisted_choice: raceVerdictRow.child_feedback,
          concurrent_race_sightings: raceSightings.n,
          confirmed_indicators_2_families: confirmedCount.n,
          weekly_tip_en: tipRes.body.tip.fraud_tip_en,
          dev_timeline_rows: timelineCount.n,
        },
        simulated_outbox_only: {
          dev_outbox_rows: outboxCount.n,
          push_busy_alerts: alertOutboxCount.n,
          atlas_circle_chains: circleOutboxAfterReply[0].n,
          calls_checkin_retries_requested: retryOutbox.length,
          checkin_tip_delivery: "data_returned_only_singhal_owns_checkin_caller",
        },
      },
      null,
      2,
    ),
  );
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 2 });
  });
