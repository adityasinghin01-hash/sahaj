import { describe, expect, it, vi } from "vitest";
import { createRouter } from "@sahaj/adapters";
import {
  createShieldRuntime,
  EXPERIENCE_DRILL_JOB,
  planWeeklyDrills,
  type DrillScheduleStore,
  type PickedDrill,
  type ShieldRuntimeTestPorts,
} from "../../src";
import { memoryExperienceStore } from "./experience_fakes";
import { fixture as makeDrillFixture, stories } from "./helpers";

const daytime = new Date("2026-11-14T06:00:00.000Z"); // 11:30 IST
const quietTime = new Date("2026-11-14T16:00:00.000Z"); // 21:30 IST

describe("planWeeklyDrills (unit + memory runtime)", () => {
  it("plans helper drills once per 7 days, stores checkin_variables, and only starts consented+enabled experience drills", async () => {
    const parents = [
      { familyId: "fam-1", parentId: "p-eligible" },
      { familyId: "fam-2", parentId: "p-switch-off" },
      { familyId: "fam-3", parentId: "p-no-consent" },
      { familyId: "fam-4", parentId: "p-too-soon" },
    ];
    const savedVars: Array<{ familyId: string; parentId: string; drill_id: string; drill_story: string }> = [];
    const schedule: DrillScheduleStore = {
      listParents: async () => parents,
      hasExperienceEligibility: async ({ parentId }) =>
        parentId === "p-eligible" || parentId === "p-too-soon",
      saveCheckinVariables: async ({ familyId, parentId, variables }) => {
        savedVars.push({ familyId, parentId, ...variables });
      },
    };

    const helperAsked = new Set<string>(["p-switch-off"]);
    const pickDrill = vi.fn(async ({ parentId }: { familyId: string; parentId: string; now: Date }): Promise<PickedDrill | null> => {
      if (helperAsked.has(parentId)) return null;
      helperAsked.add(parentId);
      const story = stories[0]!;
      return {
        drill_id: story.id,
        story_hi: story.story_hi,
        checkin_variables: { drill_id: story.id, drill_story: story.story_hi },
      };
    });

    const expAsked = new Set<string>(["p-too-soon"]);
    const startExperienceDrill = vi.fn(async ({ parentId }: { familyId: string; parentId: string }) => {
      if (expAsked.has(parentId)) return { ok: false as const, reason: "too_soon" as const };
      expAsked.add(parentId);
      return { ok: true as const, drill_id: `exp.generic_kyc.${parentId}`, script_id: "generic_kyc" };
    });

    const signed: unknown[] = [];
    const first = await planWeeklyDrills(
      {
        schedule,
        pickDrill,
        startExperienceDrill,
        sign: async entry => {
          signed.push(entry);
        },
      },
      { now: daytime },
    );

    expect(first).toEqual({
      helper_planned: 3,
      experience_started: 1,
      experience_refused: { too_soon: 1 },
    });
    expect(startExperienceDrill).toHaveBeenCalledTimes(2);
    expect(savedVars).toHaveLength(3);
    expect(savedVars[0]).toMatchObject({
      familyId: "fam-1",
      parentId: "p-eligible",
      drill_id: stories[0]!.id,
      drill_story: stories[0]!.story_hi,
    });
    expect(signed).toHaveLength(3);

    // Idempotent when called again in the same week.
    const second = await planWeeklyDrills({ schedule, pickDrill, startExperienceDrill }, { now: daytime });
    expect(second).toEqual({
      helper_planned: 0,
      experience_started: 0,
      experience_refused: { too_soon: 2 },
    });
    expect(savedVars).toHaveLength(3);
  });

  it("refuses experience drill during quiet hours, then allows starting later the same day without duplicating helper drill", async () => {
    const ctx = { familyId: "fam-1", parentId: "p-1" };
    const drillFx = makeDrillFixture(ctx);
    const exp = memoryExperienceStore(ctx, drillFx.rows, ["child-1"]);
    await exp.store.recordConsent({ ...ctx, clipRef: "consent://1", givenAt: daytime });
    await exp.store.setEnabled({ ...ctx, enabled: true, byUserId: "child-1", at: daytime });

    const saved = new Map<string, { drill_id: string; drill_story: string }>();
    const sign = vi.fn(async () => undefined);
    const schedulerAfter = vi.fn(async () => undefined);
    const provider = vi.fn(async () => ({ kind: "text" as const, text: "{}" }));

    const scheduleStore: DrillScheduleStore = {
      listParents: async () => [ctx],
      hasExperienceEligibility: async c =>
        (await exp.store.hasConsent(c)) && (await exp.store.isEnabled(c)),
      saveCheckinVariables: async ({ familyId, parentId, variables }) => {
        saved.set(`${familyId}:${parentId}`, variables);
      },
    };

    const ports: ShieldRuntimeTestPorts = {
      db: {
        server: {} as never,
        tools: {} as never,
        brain: {
          getParent: async () => ({ id: ctx.parentId, family_id: ctx.familyId }),
          getRecentEvents: async () => [],
          insertVerdict: async () => ({ id: "v" }),
          getVerdict: async () => null,
          hasChildReaction: async () => false,
        },
        getEvent: async () => null,
        insertVoiceEvent: async () => ({ id: "e" }),
        getVerdictForEvent: async () => null,
        withEventLock: async (_id, work) => work(ports.db),
        drills: drillFx.deps.db,
        experience: exp.store,
        schedule: scheduleStore,
      } as ShieldRuntimeTestPorts["db"],
      router: createRouter({ claude: provider, muse: provider, gemini: provider }),
      drillStories: stories,
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
      sign,
      waitUntil: promise => {
        void promise;
      },
      env: { SHIELD_DEVICE_PAIRING_SECRET: "ag12-schedule-test-secret-at-least-32-chars" },
      clock: { now: () => daytime },
      cache: { get: async () => null, set: async () => {} },
    };

    const runtime = createShieldRuntime(ports);

    const quietRun = await runtime.planWeeklyDrills({ now: quietTime });
    expect(quietRun).toEqual({
      helper_planned: 1,
      experience_started: 0,
      experience_refused: { quiet_hours: 1 },
    });
    expect(saved.get(`${ctx.familyId}:${ctx.parentId}`)).toEqual({
      drill_id: stories[0]!.id,
      drill_story: stories[0]!.story_hi,
    });
    expect(schedulerAfter).not.toHaveBeenCalled();

    // Next morning daytime run: helper stays skipped for 7 days; experience drill now starts.
    const nextMorning = new Date("2026-11-15T05:00:00.000Z");
    const dayRun = await runtime.planWeeklyDrills({ now: nextMorning });
    expect(dayRun).toEqual({
      helper_planned: 0,
      experience_started: 1,
      experience_refused: {},
    });
    expect(schedulerAfter).toHaveBeenCalledWith(0, EXPERIENCE_DRILL_JOB, expect.objectContaining({
      family_id: ctx.familyId,
      parent_id: ctx.parentId,
    }));

    // Same week repeat: neither helper nor experience restarts.
    const repeatRun = await runtime.planWeeklyDrills({ now: new Date("2026-11-16T05:00:00.000Z") });
    expect(repeatRun).toEqual({
      helper_planned: 0,
      experience_started: 0,
      experience_refused: { too_soon: 1 },
    });
  });
});
