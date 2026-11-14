import { seedMembership } from "../foundation";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stories } from "./helpers";
import {
  checkinDrillCacheKey,
  createDrillPg,
  createExperiencePg,
  createSchedulePg,
  createShieldRuntime,
  EXPERIENCE_DRILL_JOB,
  pickDrill,
  planWeeklyDrills,
  readCheckinDrillVariablesPg,
  startExperienceDrill,
} from "../../src";
import { makeRuntime } from "../runtime/ports";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const DATABASE_URL = env.DATABASE_URL;
const daytime = new Date("2026-11-14T06:00:00.000Z");

describe.skipIf(!DATABASE_URL)("weekly drill scheduler against Postgres", () => {
  let sql: Sql;
  const families: string[] = [];

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { max: 6, prepare: false, max_pipeline: 1, onnotice: () => undefined });
    const [row] = await sql`select to_regclass('public.shield_drill_consents')::text as t`;
    if (!row?.t) throw new Error("Apply migration 20261114160800 before these tests");
  });

  afterAll(async () => {
    if (!sql) return;
    for (const family of families) {
      await sql`delete from public.dev_cache where key like ${`shield.checkin_drill.v1:${family}:%`}`;
      await sql`delete from public.shield_checkin_lines where family_id = ${family}`;
      await sql`delete from public.shield_experience_settings where family_id = ${family}`;
      await sql`delete from public.shield_drill_consents where family_id = ${family}`;
      await sql`delete from public.drills where family_id = ${family}`;
      await sql`delete from public.family_memberships where family_id = ${family}`;
      await sql`delete from public.people where family_id = ${family}`;
      await sql`delete from public.families where id = ${family}`;
    }
    await sql.end({ timeout: 5 });
  });

  async function seedParent() {
    const familyId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    const childUser = crypto.randomUUID();
    families.push(familyId);
    await sql`insert into public.families (id,name) values (${familyId}, 'Synthetic family')`;
    await sql`insert into public.people (id, family_id, display_name, role) values (${parentId}, ${familyId}, 'Maa', 'parent')`;
    await seedMembership(sql, familyId, childUser, "child");
    return { ctx: { familyId, parentId }, childUser };
  }

  it("plans helper drill + experience drill for consented & switched-on parent and is idempotent", async () => {
    const eligible = await seedParent();
    const switchOff = await seedParent();
    const noConsent = await seedParent();

    const { ports } = makeRuntime({} as never, { now: () => daytime });
    const runtime = createShieldRuntime({ ...ports, sql });

    await runtime.recordDrillConsent({ ...eligible.ctx, clipRef: "clip://yes-1" });
    await runtime.setExperienceDrills({ ...eligible.ctx, enabled: true, byUserId: eligible.childUser });

    await runtime.recordDrillConsent({ ...switchOff.ctx, clipRef: "clip://yes-2" });
    await runtime.setExperienceDrills({ ...switchOff.ctx, enabled: false, byUserId: switchOff.childUser });

    await runtime.setExperienceDrills({ ...noConsent.ctx, enabled: true, byUserId: noConsent.childUser });

    const first = await runtime.planWeeklyDrills({ now: daytime });
    expect(first.helper_planned).toBeGreaterThanOrEqual(3);
    expect(first.experience_started).toBeGreaterThanOrEqual(1);

    // Every seeded parent got exactly one helper drill and stored check-in variables.
    for (const ctx of [eligible.ctx, switchOff.ctx, noConsent.ctx]) {
      const helpers = await sql`
        select drill_id from public.drills
        where family_id = ${ctx.familyId} and parent_id = ${ctx.parentId} and type = 'helper'`;
      expect(helpers).toHaveLength(1);
      const cached = await readCheckinDrillVariablesPg(sql, ctx, daytime);
      expect(cached).toMatchObject({ drill_id: helpers[0]!.drill_id });
      expect(cached!.drill_story).not.toMatch(/\d{4,}/);
      expect(checkinDrillCacheKey(ctx)).toBe(`shield.checkin_drill.v1:${ctx.familyId}:${ctx.parentId}`);
    }

    // Only eligible parent got an experience drill row & job.
    const eligibleExp = await sql`
      select drill_id from public.drills
      where family_id = ${eligible.ctx.familyId} and parent_id = ${eligible.ctx.parentId} and type = 'experience'`;
    expect(eligibleExp).toHaveLength(1);
    const afterCalls = vi.mocked(ports.scheduler.after).mock.calls;
    expect(
      afterCalls.filter(
        ([, name, payload]) => name === EXPERIENCE_DRILL_JOB && payload.parent_id === eligible.ctx.parentId,
      ),
    ).toHaveLength(1);

    for (const ctx of [switchOff.ctx, noConsent.ctx]) {
      const otherExp = await sql`
        select id from public.drills
        where family_id = ${ctx.familyId} and parent_id = ${ctx.parentId} and type = 'experience'`;
      expect(otherExp).toHaveLength(0);
      expect(
        afterCalls.filter(
          ([, name, payload]) => name === EXPERIENCE_DRILL_JOB && payload.parent_id === ctx.parentId,
        ),
      ).toHaveLength(0);
    }
    expect(ports.scheduler.after).toHaveBeenCalled();

    // Repeat within the same week: no new helper or experience drills for any of this test's seeded parents.
    const second = await runtime.planWeeklyDrills({ now: new Date("2026-11-15T06:00:00.000Z") });
    expect(second.experience_refused.too_soon ?? 0).toBeGreaterThanOrEqual(1);

    for (const ctx of [eligible.ctx, switchOff.ctx, noConsent.ctx]) {
      const helpersAfter = await sql`
        select id from public.drills
        where family_id = ${ctx.familyId} and parent_id = ${ctx.parentId} and type = 'helper'`;
      expect(helpersAfter).toHaveLength(1);
    }
    const eligibleExpAfter = await sql`
      select id from public.drills
      where family_id = ${eligible.ctx.familyId} and parent_id = ${eligible.ctx.parentId} and type = 'experience'`;
    expect(eligibleExpAfter).toHaveLength(1);
  }, 15_000);

  it("skips a parent deleted between list and insert (FK 23503), counts parent_gone = 1, and still plans drills for remaining parents", async () => {
    const vanishing = await seedParent();
    const surviving = await seedParent();

    const { ports } = makeRuntime({} as never, { now: () => daytime });
    const runtime = createShieldRuntime({ ...ports, sql });

    await runtime.recordDrillConsent({ ...surviving.ctx, clipRef: "clip://surviving-yes" });
    await runtime.setExperienceDrills({ ...surviving.ctx, enabled: true, byUserId: surviving.childUser });

    const schedulePg = createSchedulePg(sql);
    const drillPg = createDrillPg(sql);
    const expPg = createExperiencePg(sql);
    const ownFamilies = new Set<string>([vanishing.ctx.familyId, surviving.ctx.familyId]);

    const result = await planWeeklyDrills(
      {
        schedule: {
          ...schedulePg,
          async listParents() {
            const all = await schedulePg.listParents();
            return all.filter((p) => ownFamilies.has(p.familyId));
          },
        },
        pickDrill: async (input) => {
          if (input.parentId === vanishing.ctx.parentId) {
            // Simulate concurrent family deletion right after listParents() / getParent() and before insert into public.drills.
            await sql`delete from public.family_memberships where family_id = ${vanishing.ctx.familyId}`;
            await sql`delete from public.people where family_id = ${vanishing.ctx.familyId}`;
            await sql`delete from public.families where id = ${vanishing.ctx.familyId}`;
            await drillPg.insert({
              family_id: input.familyId,
              parent_id: input.parentId,
              drill_id: stories[0]!.id,
              type: "helper",
              asked_at: input.now.toISOString(),
              answer_masked: null,
              score: null,
              teach_line_played: false,
            });
          }
          return pickDrill({ db: drillPg, router: ports.router, stories, clock: { now: () => daytime } }, input);
        },
        startExperienceDrill: (ctx) =>
          startExperienceDrill({ db: expPg, clock: { now: () => daytime }, scheduler: ports.scheduler }, ctx),
      },
      { now: daytime },
    );

    expect(result).toEqual({
      helper_planned: 1,
      experience_started: 1,
      experience_refused: {},
      parent_gone: 1,
    });

    const vanishingDrills = await sql`
      select id from public.drills where family_id = ${vanishing.ctx.familyId} or parent_id = ${vanishing.ctx.parentId}`;
    expect(vanishingDrills).toHaveLength(0);

    const survivingHelpers = await sql`
      select drill_id from public.drills
      where family_id = ${surviving.ctx.familyId} and parent_id = ${surviving.ctx.parentId} and type = 'helper'`;
    const survivingExp = await sql`
      select drill_id from public.drills
      where family_id = ${surviving.ctx.familyId} and parent_id = ${surviving.ctx.parentId} and type = 'experience'`;
    expect(survivingHelpers).toHaveLength(1);
    expect(survivingExp).toHaveLength(1);

    // Any non-23503 error still throws immediately.
    await expect(
      planWeeklyDrills(
        {
          schedule: {
            listParents: async () => [surviving.ctx],
            hasExperienceEligibility: async () => false,
          },
          pickDrill: async () => {
            throw Object.assign(new Error("unexpected db failure"), { code: "42P01" });
          },
          startExperienceDrill: async () => ({ ok: false, reason: "disabled" }),
        },
        { now: daytime },
      ),
    ).rejects.toThrow("unexpected db failure");
  }, 15_000);
});
