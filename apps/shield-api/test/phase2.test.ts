import { beforeEach, describe, expect, it } from "vitest";
import {
  BUSY_JOBS,
  createShieldRuntime,
  type BusyDb,
  type BusyDeps,
  type BusyStreak,
  type FeedbackVerdict,
  type IndicatorRecord,
  type RecordIndicatorInput,
  type ShieldRuntimeDb,
  type ShieldRuntimeTestPorts,
  type WarningsDb,
  type WarningsDeps,
} from "@sahaj/shield";
import type { ShieldApp, OutboxRow } from "@/lib/app";
import { runDueShieldJobs } from "@/lib/cron";
import {
  createBusyReplyHandler,
  createCallStatusHandler,
  createChildFeedbackHandler,
  createWeeklyTipGetHandler,
  createWeeklyTipPostHandler,
} from "@/lib/dev_shield_handlers";
import { createCronJobsHandler } from "@/lib/handlers";
import { createKeyedAsyncMutex, createPhase2Service, type VerdictFeedbackRow } from "@/lib/phase2";
import { createGatePort } from "@/ports/gate";

const FAMILY_1 = "11111111-1111-4111-8111-111111111111";
const PARENT_1 = "22222222-2222-4222-8222-222222222221";
const FAMILY_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PARENT_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERDICT_1 = "55555555-5555-4555-8555-555555555551";
const VERDICT_2 = "55555555-5555-4555-8555-555555555552";
const VERDICT_3 = "55555555-5555-4555-8555-555555555553";
const DEV_TOKEN = "dev-admin-secret";
const CRON_TOKEN = "cron-secret-value";

interface FakeJob {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  runAt: Date;
  status: "pending" | "done" | "failed";
  last_error: string | null;
}

interface IndicatorState {
  id: string;
  kind: RecordIndicatorInput["kind"];
  fingerprint: string;
  scamType: string;
  summaryHi: string;
  summaryEn: string;
  confirmed: boolean;
  sightings: Map<string, { familyId: string; seenAt: Date }>;
}

function makeFakePhase2App(envOverrides: Record<string, string | undefined> = {}) {
  let now = new Date("2026-11-14T10:00:00.000Z");
  let writeCount = 0;

  const families = new Set<string>([FAMILY_1, FAMILY_2]);
  const parents = new Map<string, { id: string; familyId: string; name: string }>([
    [PARENT_1, { id: PARENT_1, familyId: FAMILY_1, name: "Meena" }],
    [PARENT_2, { id: PARENT_2, familyId: FAMILY_2, name: "Kavita" }],
  ]);

  const streaks = new Map<string, BusyStreak & { endReason?: "connected" | "stale" | null }>();
  const verdicts = new Map<
    string,
    {
      row: VerdictFeedbackRow;
      scamType: string;
      linkDomains: string[];
      maskedTexts: string[];
      numberFingerprints: string[];
    }
  >([
    [
      VERDICT_1,
      {
        row: { id: VERDICT_1, family_id: FAMILY_1, parent_id: PARENT_1, child_feedback: null, feedback_at: null },
        scamType: "kyc",
        linkDomains: ["kyc-fake.example"],
        maskedTexts: ["Your KYC is blocked share OTP urgent <URL:kyc-fake.example>"],
        numberFingerprints: [],
      },
    ],
    [
      VERDICT_2,
      {
        row: { id: VERDICT_2, family_id: FAMILY_2, parent_id: PARENT_2, child_feedback: null, feedback_at: null },
        scamType: "kyc",
        linkDomains: ["kyc-fake.example"],
        maskedTexts: ["Bank account suspended click <URL:kyc-fake.example> for KYC"],
        numberFingerprints: [],
      },
    ],
    [
      VERDICT_3,
      {
        row: { id: VERDICT_3, family_id: FAMILY_1, parent_id: PARENT_1, child_feedback: null, feedback_at: null },
        scamType: "parcel",
        linkDomains: ["parcel-verify.example"],
        maskedTexts: ["Courier parcel pending verify <URL:parcel-verify.example>"],
        numberFingerprints: [],
      },
    ],
  ]);

  const indicators = new Map<string, IndicatorState>();
  const jobs: FakeJob[] = [];
  const outbox: OutboxRow[] = [];
  const timeline: { familyId: string; label: string; data?: Record<string, unknown> }[] = [];
  const withMutex = createKeyedAsyncMutex();

  const busyDb: BusyDb = {
    async getOpenBusyStreak(familyId, parentId) {
      return (
        [...streaks.values()].find(
          (s) => s.familyId === familyId && s.parentId === parentId && s.endedAt === null,
        ) ?? null
      );
    },
    async getBusyStreak(id) {
      return streaks.get(id) ?? null;
    },
    async startBusyStreak(input) {
      const existing = await this.getOpenBusyStreak(input.familyId, input.parentId);
      if (existing) return { streak: existing, created: false };
      writeCount++;
      const created: BusyStreak & { endReason?: "connected" | "stale" | null } = {
        id: crypto.randomUUID(),
        familyId: input.familyId,
        parentId: input.parentId,
        startedAt: input.at,
        lastBusyAt: input.at,
        busyCount: 1,
        endedAt: null,
        alertedAt: null,
        childRepliedAt: null,
        circledAt: null,
        endReason: null,
      };
      streaks.set(created.id, created);
      return { streak: created, created: true };
    },
    async extendBusyStreak(id, at) {
      const row = streaks.get(id);
      if (!row || row.endedAt !== null || at <= row.lastBusyAt) return null;
      writeCount++;
      row.busyCount += 1;
      row.lastBusyAt = at;
      return { ...row };
    },
    async closeBusyStreak(id, endedAt, reason) {
      const row = streaks.get(id);
      if (!row || row.endedAt !== null) return false;
      writeCount++;
      row.endedAt = endedAt;
      row.endReason = reason;
      return true;
    },
    async busyStreakDurationsMs(familyId, parentId, since, until) {
      return [...streaks.values()]
        .filter(
          (s) =>
            s.familyId === familyId &&
            s.parentId === parentId &&
            s.endedAt !== null &&
            s.startedAt >= since &&
            s.startedAt < until,
        )
        .map((s) => (s.endedAt ? s.endedAt.getTime() - s.startedAt.getTime() : 0));
    },
    async claimBusyAlert(id, at) {
      const row = streaks.get(id);
      if (!row || row.endedAt !== null || row.alertedAt !== null) return false;
      writeCount++;
      row.alertedAt = at;
      return true;
    },
    async markBusyAlertReplied(id, familyId, at) {
      const row = streaks.get(id);
      if (!row || row.familyId !== familyId || row.endedAt !== null || row.alertedAt === null || row.childRepliedAt !== null) {
        return false;
      }
      writeCount++;
      row.childRepliedAt = at;
      return true;
    },
    async claimBusyCircle(id, at) {
      const row = streaks.get(id);
      if (!row || row.endedAt !== null || row.childRepliedAt !== null || row.circledAt !== null) {
        return false;
      }
      writeCount++;
      row.circledAt = at;
      return true;
    },
  };

  const warningsDb: WarningsDb = {
    async getVerdictForFeedback(verdictId): Promise<FeedbackVerdict | null> {
      const v = verdicts.get(verdictId);
      if (!v) return null;
      return {
        id: v.row.id,
        familyId: v.row.family_id,
        scamType: v.scamType,
        childFeedback: v.row.child_feedback,
        linkDomains: v.linkDomains,
        maskedTexts: v.maskedTexts,
        numberFingerprints: v.numberFingerprints,
      };
    },
    async recordScamIndicator(input): Promise<IndicatorRecord> {
      writeCount++;
      let state = [...indicators.values()].find(
        (i) => i.fingerprint === input.fingerprint && i.kind === input.kind,
      );
      if (!state) {
        state = {
          id: crypto.randomUUID(),
          kind: input.kind,
          fingerprint: input.fingerprint,
          scamType: input.scamType,
          summaryHi: input.summaryHi,
          summaryEn: input.summaryEn,
          confirmed: false,
          sightings: new Map(),
        };
        indicators.set(state.id, state);
      }
      const alreadyCounted = state.sightings.has(input.verdictId);
      if (!alreadyCounted) {
        state.sightings.set(input.verdictId, { familyId: input.familyId, seenAt: input.seenAt });
      }
      const familiesAffected = new Set([...state.sightings.values()].map((s) => s.familyId)).size;
      if (familiesAffected >= input.confirmMinFamilies) {
        state.confirmed = true;
      }
      return {
        id: state.id,
        timesSeen: state.sightings.size,
        familiesAffected,
        confirmed: state.confirmed,
        counted: !alreadyCounted,
      };
    },
    async topConfirmedIndicator(since, until) {
      const matches = [...indicators.values()]
        .filter((i) => i.confirmed)
        .map((i) => {
          const recentSightings = [...i.sightings.values()].filter(
            (s) => s.seenAt > since && s.seenAt <= until,
          ).length;
          return {
            scamType: i.scamType,
            summaryHi: i.summaryHi,
            summaryEn: i.summaryEn,
            recentSightings,
          };
        })
        .filter((r) => r.recentSightings > 0)
        .sort((a, b) => b.recentSightings - a.recentSightings);
      return matches[0] ?? null;
    },
  };

  const sign: ShieldRuntimeTestPorts["sign"] = async (entry) => {
    writeCount++;
    timeline.push({
      familyId: entry.familyId,
      label: "step" in entry ? entry.step : entry.type,
      data: "details" in entry ? entry.details : "data" in entry ? entry.data : undefined,
    });
  };

  const clock = { now: () => now };
  const scheduler = {
    async after(delayMs: number, name: string, payload: Record<string, unknown>) {
      writeCount++;
      jobs.push({
        id: crypto.randomUUID(),
        name,
        payload,
        runAt: new Date(now.getTime() + delayMs),
        status: "pending",
        last_error: null,
      });
    },
    async claim() {
      return true;
    },
  };

  const env: Record<string, string | undefined> = {
    DEV_ADMIN_TOKEN: DEV_TOKEN,
    CRON_SECRET: CRON_TOKEN,
    SHIELD_DEVICE_PAIRING_SECRET: "test-pairing-secret-at-least-32-chars",
    DEMO_TIMER_SCALE: "60",
    ...envOverrides,
  };

  const busyDeps: BusyDeps = {
    db: busyDb,
    scheduler: { after: scheduler.after },
    alerts: {
      async sendBusyAlert(input) {
        writeCount++;
        outbox.push({
          id: crypto.randomUUID(),
          created_at: now.toISOString(),
          channel: "push",
          kind: "busy_alert",
          family_id: input.familyId,
          parent_id: input.parentId,
          dedupe_key: `push:busy_alert:${input.streakId}`,
          payload: { streak_id: input.streakId, minutes: input.minutes, messages: input.messages },
        });
      },
    },
    atlas: {
      async startCircleChain(input) {
        writeCount++;
        const streakId = "streakId" in input ? input.streakId : undefined;
        outbox.push({
          id: crypto.randomUUID(),
          created_at: now.toISOString(),
          channel: "atlas",
          kind: "start_circle_chain",
          family_id: input.familyId,
          parent_id: input.parentId,
          dedupe_key: streakId ? `atlas:circle_chain:streak:${streakId}` : null,
          payload: {
            reason: "reason" in input ? input.reason : "unknown",
            ...(streakId ? { streak_id: streakId } : {}),
          },
        });
      },
    },
    sign,
    clock,
    env: { DEMO_TIMER_SCALE: env.DEMO_TIMER_SCALE },
    async parentName(familyId, parentId) {
      const p = parents.get(parentId);
      return p && p.familyId === familyId ? p.name : null;
    },
  };

  const warningsDeps: WarningsDeps = {
    db: warningsDb,
    llm: {
      async understand() {
        return { ok: false as const, reason: "offline" };
      },
    },
    clock,
  };

  const noopDb = {} as ShieldRuntimeDb;
  const noopPorts: ShieldRuntimeTestPorts = {
    db: noopDb,
    router: {
      understand: async () => ({ ok: false, reason: "all_failed", attempts: [] }),
      twoLock: async () => ({
        claude: { ok: false, reason: "all_failed", attempts: [] },
        muse: { ok: false, reason: "all_failed", attempts: [] },
      }),
    },
    whatsapp: { sendShieldAlert: async () => undefined, sendFamilyCheckCard: async () => undefined },
    push: { childCard: async () => undefined },
    calls: {
      getParentLine: async () => null,
      callParent: async () => ({ status: "no_answer" }),
      startResponderCall: async () => undefined,
      startCallback: async () => undefined,
    },
    scheduler,
    atlas: { bridgeChild: async () => undefined, startCircleChain: busyDeps.atlas.startCircleChain },
    gate: createGatePort(sign),
    sign,
    waitUntil: () => undefined,
    env: { SHIELD_DEVICE_PAIRING_SECRET: env.SHIELD_DEVICE_PAIRING_SECRET ?? "", DEMO_TIMER_SCALE: env.DEMO_TIMER_SCALE },
    clock,
    cache: { get: async () => null, set: async () => undefined },
  };
  const runtime = createShieldRuntime(noopPorts);

  const phase2 = createPhase2Service({
    store: {
      async hasParentInFamily(familyId, parentId) {
        const p = parents.get(parentId);
        return Boolean(p && p.familyId === familyId);
      },
      async hasFamily(familyId) {
        return families.has(familyId);
      },
      async withVerdictFeedbackLock(verdictId, fn) {
        return withMutex(verdictId, async () => {
          await Promise.resolve();
          return fn();
        });
      },
      async getVerdictRow(verdictId) {
        const v = verdicts.get(verdictId);
        return v ? { ...v.row } : null;
      },
      async setVerdictFeedbackIfUnset(verdictId, feedback, at) {
        writeCount++;
        const v = verdicts.get(verdictId);
        if (!v || v.row.child_feedback !== null) return null;
        v.row.child_feedback = feedback;
        v.row.feedback_at = at.toISOString();
        return { ...v.row };
      },
      async recordBusyRetryOutbox(input) {
        writeCount++;
        outbox.push({
          id: crypto.randomUUID(),
          created_at: now.toISOString(),
          channel: "calls",
          kind: "busy_checkin_retry_requested",
          family_id: input.familyId,
          parent_id: input.parentId,
          dedupe_key: `calls:busy_retry:${input.jobId}`,
          payload: {
            streak_id: input.streakId,
            simulated: true,
            delivery_claimed: false,
            owner: "singhal_checkin_caller",
          },
        });
      },
    },
    busyDeps,
    warningsDeps,
    clock,
    fallbackHandleScheduledJob: (name, payload) => runtime.handleScheduledJob(name, payload),
  });

  const app: ShieldApp = {
    env,
    portsStatus: {
      sql: "real",
      router: "unconfigured",
      whatsapp: "outbox",
      push: "outbox",
      calls: "outbox",
      atlas: "outbox",
      scheduler: "real",
      gate: "real",
      sign: "dev_timeline_sha256",
      cache: "real",
    },
    runtime,
    recordBusyCallStatus: phase2.submitCallStatus,
    recordBusyReply: phase2.submitBusyReply,
    recordChildFeedback: phase2.submitChildFeedback,
    getWeeklyTip: phase2.fetchWeeklyTip,
    async runDueJobs() {
      const results: { id: string; name: string; status: "done" | "failed"; result?: unknown; error?: string }[] = [];
      for (const job of jobs) {
        if (job.status === "pending" && job.runAt <= now) {
          try {
            const result = await phase2.dispatchScheduledJob(job.name, job.payload, job.id);
            job.status = "done";
            results.push({ id: job.id, name: job.name, status: "done", result });
          } catch (err) {
            const msg = err instanceof Error ? err.message.slice(0, 200) : "job_failed";
            job.status = "failed";
            job.last_error = msg;
            results.push({ id: job.id, name: job.name, status: "failed", error: msg });
          }
        }
      }
      return { processed: results.length, results };
    },
    async checkDb() {
      return true;
    },
    async listOutbox(limit = 50) {
      return outbox.slice(0, limit);
    },
  };

  return {
    app,
    get writeCount() {
      return writeCount;
    },
    advanceMs(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    jobs,
    outbox,
    timeline,
    streaks,
    verdicts,
    indicators,
  };
}

function devReq(path: string, method: "GET" | "POST", body?: unknown, token: string | null = DEV_TOKEN) {
  const headers: Record<string, string> = {};
  if (token !== null) headers["x-dev-admin-token"] = token;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("@sahaj/shield-api Phase 2 busy-watch & shared-warnings", () => {
  let ctx: ReturnType<typeof makeFakePhase2App>;

  beforeEach(() => {
    ctx = makeFakePhase2App();
  });

  it("enforces x-dev-admin-token and validates payloads with zero writes on rejection", async () => {
    const callStatus = createCallStatusHandler(() => ctx.app);
    const busyReply = createBusyReplyHandler(() => ctx.app);
    const feedback = createChildFeedbackHandler(() => ctx.app);
    const weeklyTipGet = createWeeklyTipGetHandler(() => ctx.app);
    const weeklyTipPost = createWeeklyTipPostHandler(() => ctx.app);

    for (const badReq of [
      callStatus(devReq("/api/dev/shield/call-status", "POST", {}, null)),
      busyReply(devReq("/api/dev/shield/busy-reply", "POST", {}, "wrong")),
      feedback(devReq("/api/dev/shield/feedback", "POST", {}, "wrong")),
      weeklyTipGet(devReq(`/api/dev/shield/weekly-tip?family_id=${FAMILY_1}`, "GET", undefined, null)),
      weeklyTipPost(devReq("/api/dev/shield/weekly-tip", "POST", { family_id: FAMILY_1 }, "wrong")),
    ]) {
      expect((await badReq).status).toBe(401);
    }

    expect((await callStatus(devReq("/api/dev/shield/call-status", "POST", { status: "busy" }))).status).toBe(400);
    expect((await busyReply(devReq("/api/dev/shield/busy-reply", "POST", { streak_id: "bad" }))).status).toBe(400);
    expect((await feedback(devReq("/api/dev/shield/feedback", "POST", { verdict_id: VERDICT_1, feedback: "maybe" }))).status).toBe(400);
    expect((await weeklyTipGet(devReq("/api/dev/shield/weekly-tip?family_id=not-uuid", "GET"))).status).toBe(400);

    // Cross-family parent rejection
    const crossParent = await callStatus(
      devReq("/api/dev/shield/call-status", "POST", {
        family_id: FAMILY_1,
        parent_id: PARENT_2,
        status: "busy",
        in_checkin_window: true,
      }),
    );
    expect(crossParent.status).toBe(404);
    expect(ctx.writeCount).toBe(0);
  });

  it("handles busy streak -> retry outbox -> alert -> unanswered circle escalation", async () => {
    const callStatus = createCallStatusHandler(() => ctx.app);
    const cron = createCronJobsHandler(() => ctx.app);

    let streakId: string | undefined;
    for (let i = 1; i <= 3; i++) {
      ctx.advanceMs(5_000);
      const res = await callStatus(
        devReq("/api/dev/shield/call-status", "POST", {
          family_id: FAMILY_1,
          parent_id: PARENT_1,
          status: "busy",
          in_checkin_window: true,
        }),
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      streakId = data.result.streakId;
      expect(data.result.retryScheduled).toBe(true);
      if (i < 3) {
        expect(data.result.streak).toBe(i === 1 ? "started" : "extended");
        expect(data.result.alerted).toBe(false);
      } else {
        expect(data.result.streak).toBe("extended");
        expect(data.result.alerted).toBe(true);
      }
    }

    expect(ctx.outbox.some((o) => o.kind === "busy_alert" && o.channel === "push")).toBe(true);
    expect(ctx.jobs.some((j) => j.name === BUSY_JOBS.retry)).toBe(true);
    expect(ctx.jobs.some((j) => j.name === BUSY_JOBS.circle)).toBe(true);

    // Advance past scaled retry + circle timers (DEMO_TIMER_SCALE=60 => 10m=10s, 5m=5s)
    ctx.advanceMs(20_000);
    const cronRes = await cron(
      new Request("http://localhost/api/cron/shield-jobs", {
        method: "GET",
        headers: { "x-cron-secret": CRON_TOKEN },
      }),
    );
    expect(cronRes.status).toBe(200);
    const cronData = await cronRes.json();
    expect(cronData.results.some((r: { name: string; status: string }) => r.name === BUSY_JOBS.retry && r.status === "done")).toBe(true);
    expect(cronData.results.some((r: { name: string; status: string }) => r.name === BUSY_JOBS.circle && r.status === "done")).toBe(true);
    expect(ctx.outbox.some((o) => o.kind === "busy_checkin_retry_requested" && o.channel === "calls")).toBe(true);
    expect(
      ctx.outbox.some(
        (o) =>
          o.kind === "start_circle_chain" &&
          o.channel === "atlas" &&
          o.payload.reason === "busy_line_no_reply" &&
          o.family_id === FAMILY_1,
      ),
    ).toBe(true);
    expect(ctx.streaks.get(streakId!)?.circledAt).not.toBeNull();
  });

  it("rejects cross-family busy reply and stops circle escalation once child replies", async () => {
    const callStatus = createCallStatusHandler(() => ctx.app);
    const busyReply = createBusyReplyHandler(() => ctx.app);
    const cron = createCronJobsHandler(() => ctx.app);

    let streakId = "";
    for (let i = 0; i < 3; i++) {
      ctx.advanceMs(5_000);
      const r = await (
        await callStatus(
          devReq("/api/dev/shield/call-status", "POST", {
            family_id: FAMILY_1,
            parent_id: PARENT_1,
            status: "busy",
            in_checkin_window: true,
          }),
        )
      ).json();
      streakId = r.result.streakId;
    }

    // Cross-family busy reply must be rejected
    const forbidden = await busyReply(
      devReq("/api/dev/shield/busy-reply", "POST", { streak_id: streakId, family_id: FAMILY_2 }),
    );
    expect(forbidden.status).toBe(403);

    const okReply = await busyReply(
      devReq("/api/dev/shield/busy-reply", "POST", { streak_id: streakId, family_id: FAMILY_1 }),
    );
    expect(okReply.status).toBe(200);
    const replyData = await okReply.json();
    expect(replyData.replied).toBe(true);
    expect(replyData.parent_id).toBe(PARENT_1);

    ctx.advanceMs(20_000);
    await cron(
      new Request("http://localhost/api/cron/shield-jobs", {
        method: "GET",
        headers: { "x-cron-secret": CRON_TOKEN },
      }),
    );
    expect(ctx.outbox.some((o) => o.kind === "start_circle_chain")).toBe(false);
  });

  it("rejects unsupported cron job names explicitly", async () => {
    ctx.jobs.push({
      id: crypto.randomUUID(),
      name: "shield.unknown.job",
      payload: {},
      runAt: new Date("2026-11-14T09:59:00.000Z"),
      status: "pending",
      last_error: null,
    });
    const result = await ctx.app.runDueJobs();
    expect(result.processed).toBe(1);
    expect(result.results[0]).toMatchObject({
      name: "shield.unknown.job",
      status: "failed",
      error: "Unknown Shield scheduled job",
    });
  });

  it("keeps persisted feedback and scam indicators consistent under concurrent Safe/Fraud races, and serves weekly tips after 2 families confirm", async () => {
    const feedback = createChildFeedbackHandler(() => ctx.app);
    const weeklyTip = createWeeklyTipGetHandler(() => ctx.app);

    // Cross-family rejection before write
    const badFamily = await feedback(
      devReq("/api/dev/shield/feedback", "POST", {
        verdict_id: VERDICT_1,
        feedback: "fraud",
        family_id: FAMILY_2,
      }),
    );
    expect(badFamily.status).toBe(403);

    // Concurrent Safe + Fraud on VERDICT_3: whichever wins must match sightings 100%.
    const [rA, rB] = await Promise.all([
      feedback(devReq("/api/dev/shield/feedback", "POST", { verdict_id: VERDICT_3, feedback: "safe" })),
      feedback(devReq("/api/dev/shield/feedback", "POST", { verdict_id: VERDICT_3, feedback: "fraud" })),
    ]);
    const statuses = [rA.status, rB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const v3 = ctx.verdicts.get(VERDICT_3)!.row;
    const v3Sightings = [...ctx.indicators.values()].filter((ind) => ind.sightings.has(VERDICT_3));
    if (v3.child_feedback === "safe") {
      expect(v3Sightings).toHaveLength(0);
    } else {
      expect(v3.child_feedback).toBe("fraud");
      expect(v3Sightings.length).toBeGreaterThan(0);
    }

    // Two distinct families confirm kyc-fake.example
    const f1 = await feedback(
      devReq("/api/dev/shield/feedback", "POST", { verdict_id: VERDICT_1, feedback: "fraud" }),
    );
    expect(f1.status).toBe(200);
    const d1 = await f1.json();
    expect(d1.result.outcome).toBe("recorded");
    expect(d1.result.indicators.length).toBeGreaterThanOrEqual(1);
    expect(d1.result.indicators.every((i: { confirmed: boolean }) => !i.confirmed)).toBe(true);

    // Repeated identical feedback on VERDICT_1 stays idempotent without confirming prematurely
    const f1Repeat = await feedback(
      devReq("/api/dev/shield/feedback", "POST", { verdict_id: VERDICT_1, feedback: "fraud" }),
    );
    expect(f1Repeat.status).toBe(200);
    const d1Repeat = await f1Repeat.json();
    expect(d1Repeat.repeated).toBe(true);
    expect(
      d1Repeat.result.indicators.every(
        (i: { familiesAffected: number; confirmed: boolean }) => i.familiesAffected === 1 && !i.confirmed,
      ),
    ).toBe(true);

    // Second family confirms shared indicator -> confirmed: true, familiesAffected: 2
    const f2 = await feedback(
      devReq("/api/dev/shield/feedback", "POST", { verdict_id: VERDICT_2, feedback: "fraud" }),
    );
    expect(f2.status).toBe(200);
    const d2 = await f2.json();
    expect(
      d2.result.indicators.some(
        (i: { confirmed: boolean; familiesAffected: number }) => i.confirmed && i.familiesAffected === 2,
      ),
    ).toBe(true);

    // Weekly tip reflects confirmed indicator for existing family, rejects unknown family
    const badTip = await weeklyTip(
      devReq("/api/dev/shield/weekly-tip?family_id=99999999-9999-4999-8999-999999999999", "GET"),
    );
    expect(badTip.status).toBe(404);

    const okTip = await weeklyTip(devReq(`/api/dev/shield/weekly-tip?family_id=${FAMILY_1}`, "GET"));
    expect(okTip.status).toBe(200);
    const tipData = await okTip.json();
    expect(tipData.simulated_checkin).toBe(true);
    expect(tipData.tip.fraud_tip_en.length).toBeGreaterThan(10);
    expect(tipData.tip.fraud_tip_hi.length).toBeGreaterThan(10);
  });
});

// Keep cron handler import verified as wired cleanly
void createCronJobsHandler;
void runDueShieldJobs;
