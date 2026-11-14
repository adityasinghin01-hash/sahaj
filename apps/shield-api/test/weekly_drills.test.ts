import { describe, expect, it, vi } from "vitest";
import { createRouter, type Provider } from "@sahaj/adapters";
import { HELPER_DRILLS } from "@sahaj/shared";
import {
  createShieldRuntime,
  type DrillContext,
  type DrillRecord,
  type DrillScheduleStore,
  type DrillStore,
  type ExperienceStore,
  type ShieldRuntimeTestPorts,
} from "@sahaj/shield";
import { createWeeklyDrillsCronHandler } from "@/lib/weekly_drills";

const CRON_SECRET = "test-cron-secret-weekly-drills";
const FAMILY_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_ID = "22222222-2222-4222-8222-222222222221";
const CHILD_USER_ID = "33333333-3333-4333-8333-333333333332";
const daytime = new Date("2026-11-14T06:00:00.000Z");

function makeMemoryRuntime(now = daytime) {
  const drills: DrillRecord[] = [];
  const consents = new Set<string>();
  const enabled = new Set<string>();
  const savedVars = new Map<string, { drill_id: string; drill_story: string }>();
  const key = (ctx: DrillContext) => `${ctx.familyId}:${ctx.parentId}`;

  const drillStore: DrillStore = {
    withParentLock: (_ctx, work) => work(drillStore),
    getParent: async ctx => ctx.familyId === FAMILY_ID && ctx.parentId === PARENT_ID,
    recent: async ctx => drills.filter(r => r.family_id === ctx.familyId && r.parent_id === ctx.parentId),
    insert: async row => {
      drills.push({ ...row, id: crypto.randomUUID() } as DrillRecord);
    },
    getAsked: async () => null,
    saveAnswer: async () => {},
    between: async () => [],
  };

  const expStore: ExperienceStore = {
    withParentLock: (_ctx, work) => work(expStore),
    getParent: async ctx => ctx.familyId === FAMILY_ID && ctx.parentId === PARENT_ID,
    recordConsent: async ctx => {
      consents.add(key(ctx));
      return { id: "consent-1" };
    },
    revokeConsent: async ctx => (consents.delete(key(ctx)) ? 1 : 0),
    hasConsent: async ctx => consents.has(key(ctx)),
    setEnabled: async ctx => {
      if (ctx.enabled) enabled.add(key(ctx));
      else enabled.delete(key(ctx));
      return true;
    },
    isEnabled: async ctx => enabled.has(key(ctx)),
    lastExperienceAt: async ctx => {
      const exp = drills
        .filter(r => r.type === "experience" && r.family_id === ctx.familyId && r.parent_id === ctx.parentId)
        .map(r => r.asked_at)
        .sort();
      return exp.at(-1) ?? null;
    },
    insertExperience: async input => {
      drills.push({
        family_id: input.familyId,
        parent_id: input.parentId,
        drill_id: input.drillId,
        type: "experience",
        asked_at: input.askedAt.toISOString(),
        answer_masked: null,
        score: null,
        teach_line_played: false,
      });
    },
    getExperience: async () => null,
    saveExperienceResult: async () => false,
    queueCheckinLine: async () => {},
    takeCheckinLine: async () => null,
  };

  const scheduleStore: DrillScheduleStore = {
    listParents: async () => [{ familyId: FAMILY_ID, parentId: PARENT_ID }],
    hasExperienceEligibility: async ctx => consents.has(key(ctx)) && enabled.has(key(ctx)),
    saveCheckinVariables: async ({ familyId, parentId, variables }) => {
      savedVars.set(`${familyId}:${parentId}`, variables);
    },
  };

  const provider: Provider = vi.fn(async () => ({ kind: "text" as const, text: "{}" }));
  const schedulerAfter = vi.fn(async () => {});
  const ports: ShieldRuntimeTestPorts = {
    db: {
      server: {} as never,
      tools: {} as never,
      brain: {
        getParent: async () => ({ id: PARENT_ID, family_id: FAMILY_ID }),
        getRecentEvents: async () => [],
        insertVerdict: async () => ({ id: "v" }),
        getVerdict: async () => null,
        hasChildReaction: async () => false,
      },
      getEvent: async () => null,
      insertVoiceEvent: async () => ({ id: "e" }),
      getVerdictForEvent: async () => null,
      withEventLock: async (_id, work) => work(ports.db),
      drills: drillStore,
      experience: expStore,
      schedule: scheduleStore,
    } as ShieldRuntimeTestPorts["db"],
    router: createRouter({ claude: provider, muse: provider, gemini: provider }),
    drillStories: HELPER_DRILLS.map(s => ({ ...s, good_answers: [...s.good_answers], risky_answers: [...s.risky_answers] })),
    whatsapp: { sendFamilyCheckCard: async () => {}, sendShieldAlert: async () => {} },
    push: { childCard: async () => {} },
    calls: {
      getParentLine: async () => null,
      callParent: async () => ({ status: "answered" }),
      startResponderCall: async () => {},
      startCallback: async () => {},
    },
    scheduler: { after: schedulerAfter, claim: async () => true },
    atlas: { startCircleChain: async () => {}, bridgeChild: async () => {} },
    gate: { check: async () => ({ allowed: true }) },
    sign: async () => {},
    waitUntil: p => {
      void p;
    },
    env: { SHIELD_DEVICE_PAIRING_SECRET: "weekly-drills-api-test-secret-long-enough" },
    clock: { now: () => now },
    cache: { get: async () => null, set: async () => {} },
  };

  const runtime = createShieldRuntime(ports);
  return { runtime, drills, savedVars, schedulerAfter };
}

describe("GET /api/cron/weekly-drills", () => {
  const req = (secret?: string) =>
    new Request("http://localhost/api/cron/weekly-drills", {
      method: "GET",
      headers: secret ? { "x-cron-secret": secret } : undefined,
    });

  it("rejects missing, wrong, or unconfigured x-cron-secret with 401", async () => {
    const planWeeklyDrills = vi.fn();
    const handler = createWeeklyDrillsCronHandler(() => ({
      env: { CRON_SECRET },
      runtime: { planWeeklyDrills } as never,
    }));

    expect((await handler(req())).status).toBe(401);
    expect((await handler(req("wrong"))).status).toBe(401);

    const noSecretHandler = createWeeklyDrillsCronHandler(() => ({
      env: {},
      runtime: { planWeeklyDrills } as never,
    }));
    expect((await noSecretHandler(req(CRON_SECRET))).status).toBe(401);
    expect(planWeeklyDrills).not.toHaveBeenCalled();
  });

  it("returns 501 if runtime.planWeeklyDrills is unavailable", async () => {
    const handler = createWeeklyDrillsCronHandler(() => ({
      env: { CRON_SECRET },
      runtime: {} as never,
    }));
    const res = await handler(req(CRON_SECRET));
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "weekly_drills_unavailable" });
  });

  it("plans weekly helper and experience drills idempotently with valid x-cron-secret", async () => {
    const { runtime, drills, savedVars, schedulerAfter } = makeMemoryRuntime();
    await runtime.recordDrillConsent({ familyId: FAMILY_ID, parentId: PARENT_ID, clipRef: "clip://ok" });
    await runtime.setExperienceDrills({
      familyId: FAMILY_ID,
      parentId: PARENT_ID,
      enabled: true,
      byUserId: CHILD_USER_ID,
    });

    const handler = createWeeklyDrillsCronHandler(
      () => ({ env: { CRON_SECRET }, runtime }),
      () => daytime,
    );

    const first = await handler(req(CRON_SECRET));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      helper_planned: 1,
      experience_started: 1,
      experience_refused: {},
    });
    expect(savedVars.get(`${FAMILY_ID}:${PARENT_ID}`)).toEqual({
      drill_id: HELPER_DRILLS[0]!.id,
      drill_story: HELPER_DRILLS[0]!.story_hi,
    });
    expect(schedulerAfter).toHaveBeenCalledOnce();
    expect(drills).toHaveLength(2);

    const second = await handler(req(CRON_SECRET));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      ok: true,
      helper_planned: 0,
      experience_started: 0,
      experience_refused: { too_soon: 1 },
    });
    expect(schedulerAfter).toHaveBeenCalledOnce();
    expect(drills).toHaveLength(2);
  });
});
