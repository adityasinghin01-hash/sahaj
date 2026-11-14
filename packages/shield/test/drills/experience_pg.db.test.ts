/**
 * K-B8 Part D against real Postgres: migration 20261114000800 (consents, child switch, check-in lines),
 * createExperiencePg, RLS and the joined runtime. Run with infra/supabase/test/run-shield-db-test.sh.
 */
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createExperiencePg, EXPERIENCE_DRILL_JOB, EXPERIENCE_PRAISE_LINE } from "../../src/drills";
import { createShieldRuntime } from "../../src/runtime";
import { makeRuntime } from "../runtime/ports";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const DATABASE_URL = env.DATABASE_URL;
if (!DATABASE_URL && env.SHIELD_DB_TEST_REQUIRED) throw new Error("SHIELD_DB_TEST_REQUIRED is set but DATABASE_URL is not");
const daytime = new Date("2026-11-14T06:00:00.000Z");

describe.skipIf(!DATABASE_URL)("experience drills against Postgres", () => {
  let sql: Sql;
  const families: string[] = [];
  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { max: 6, prepare: false, max_pipeline: 1, onnotice: () => undefined });
    const [row] = await sql`select to_regclass('public.shield_drill_consents')::text as t`;
    if (!row?.t) throw new Error("Apply migration 20261114000800 before these tests");
  });
  afterAll(async () => {
    if (!sql) return;
    for (const family of families) {
      await sql`delete from public.shield_checkin_lines where family_id = ${family}`;
      await sql`delete from public.shield_experience_settings where family_id = ${family}`;
      await sql`delete from public.shield_drill_consents where family_id = ${family}`;
      await sql`delete from public.drills where family_id = ${family}`;
      await sql`delete from public.family_members where family_id = ${family}`;
      await sql`delete from public.people where family_id = ${family}`;
      await sql`delete from public.families where id = ${family}`;
    }
    await sql.end({ timeout: 5 });
  });
  async function seed() {
    const familyId = crypto.randomUUID(), parentId = crypto.randomUUID(), childUser = crypto.randomUUID(), parentUser = crypto.randomUUID();
    families.push(familyId);
    await sql`insert into public.families (id) values (${familyId})`;
    await sql`insert into public.people (id, family_id, name, role) values (${parentId}, ${familyId}, 'Maa', 'parent')`;
    await sql`insert into public.family_members (family_id, user_id, role) values (${familyId}, ${childUser}, 'child'), (${familyId}, ${parentUser}, 'parent')`;
    return { ctx: { familyId, parentId }, childUser, parentUser };
  }
  async function asUser<T>(userId: string, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return sql.begin(async tx => {
      await tx`set local role authenticated`;
      await tx`select set_config('request.jwt.claim.sub', ${userId}, true)`;
      return work(tx);
    }) as Promise<T>;
  }

  it("stores consent, the child switch and masked results; one active consent per parent", async () => {
    const { ctx, childUser, parentUser } = await seed();
    const store = createExperiencePg(sql);
    expect(await store.recordConsent({ ...ctx, clipRef: "consent/maa-yes.ogg", givenAt: daytime })).toMatchObject({ id: expect.any(String) });
    expect(await store.recordConsent({ ...ctx, clipRef: "consent/maa-yes-2.ogg", givenAt: new Date(daytime.getTime() + 1000) })).toBeTruthy();
    const consents = await sql`select clip_ref, revoked_at from public.shield_drill_consents where family_id = ${ctx.familyId} order by given_at`;
    expect(consents.map(row => [row.clip_ref, row.revoked_at === null])).toEqual([["consent/maa-yes.ogg", false], ["consent/maa-yes-2.ogg", true]]);
    expect(await store.hasConsent(ctx)).toBe(true);
    expect(await store.recordConsent({ familyId: ctx.familyId, parentId: crypto.randomUUID(), clipRef: "x", givenAt: daytime })).toBeNull();

    expect(await store.setEnabled({ ...ctx, enabled: true, byUserId: parentUser, at: daytime })).toBe(false);
    expect(await store.isEnabled(ctx)).toBe(false);
    expect(await store.setEnabled({ ...ctx, enabled: true, byUserId: childUser, at: daytime })).toBe(true);
    expect(await store.isEnabled(ctx)).toBe(true);
    const [setting] = await sql`select enabled_by, enabled_at from public.shield_experience_settings where parent_id = ${ctx.parentId}`;
    expect(setting).toMatchObject({ enabled_by: childUser });

    await store.insertExperience({ ...ctx, drillId: "exp.generic_kyc.a", askedAt: daytime });
    expect(await store.lastExperienceAt(ctx)).toBe(daytime.toISOString());
    expect(await store.saveExperienceResult({ ...ctx, drillId: "exp.generic_kyc.a", answerMasked: "code 4 8 2 9 1 3", score: 0 })).toBe(true);
    expect(await store.saveExperienceResult({ ...ctx, drillId: "exp.generic_kyc.a", answerMasked: "nahi", score: 2 })).toBe(false);
    const [drill] = await sql`select answer_masked, score, teach_line_played, type from public.drills where family_id = ${ctx.familyId}`;
    expect(drill).toMatchObject({ score: 0, teach_line_played: true, type: "experience" });
    expect(drill!.answer_masked).not.toMatch(/[0-9]/);

    await store.queueCheckinLine({ ...ctx, line: EXPERIENCE_PRAISE_LINE, at: daytime });
    expect(await store.takeCheckinLine({ ...ctx, at: daytime })).toBe(EXPERIENCE_PRAISE_LINE);
    expect(await store.takeCheckinLine({ ...ctx, at: daytime })).toBeNull();
    expect(await store.revokeConsent({ ...ctx, at: new Date(daytime.getTime() + 5000) })).toBe(1);
    expect(await store.hasConsent(ctx)).toBe(false);
  });

  it("rejects cross-family scope, digits in check-in lines and a switch without a child (service role)", async () => {
    const a = await seed(); const b = await seed();
    await expect(sql`insert into public.shield_drill_consents (family_id, parent_id, kind, clip_ref, given_at)
      values (${a.ctx.familyId}, ${b.ctx.parentId}, 'experience_drill', 'x', now())`).rejects.toThrow(/scope/);
    await expect(sql`insert into public.shield_checkin_lines (family_id, parent_id, kind, line, created_at)
      values (${a.ctx.familyId}, ${a.ctx.parentId}, 'experience_praise', 'OTP 482913', now())`).rejects.toThrow(/check/);
    await expect(sql`insert into public.shield_experience_settings (family_id, parent_id, experience_drills_enabled, enabled_by, enabled_at)
      values (${a.ctx.familyId}, ${a.ctx.parentId}, true, ${b.childUser}, now())`).rejects.toThrow(/child/);
    await expect(sql`insert into public.shield_drill_consents (family_id, parent_id, kind, clip_ref, given_at)
      values (${a.ctx.familyId}, ${a.ctx.parentId}, 'other_kind', 'x', now())`).rejects.toThrow(/check/);
  });

  it("RLS: family members read their own family's rows only; authenticated users cannot write", async () => {
    const a = await seed(); const b = await seed();
    const store = createExperiencePg(sql);
    for (const s of [a, b]) {
      await store.recordConsent({ ...s.ctx, clipRef: "consent/yes.ogg", givenAt: daytime });
      await store.setEnabled({ ...s.ctx, enabled: true, byUserId: s.childUser, at: daytime });
      await store.queueCheckinLine({ ...s.ctx, line: EXPERIENCE_PRAISE_LINE, at: daytime });
    }
    const seen = await asUser(a.childUser, async tx => ({
      consents: (await tx`select family_id from public.shield_drill_consents where family_id in (${a.ctx.familyId}, ${b.ctx.familyId})`).map(r => r.family_id),
      settings: (await tx`select family_id from public.shield_experience_settings where family_id in (${a.ctx.familyId}, ${b.ctx.familyId})`).map(r => r.family_id),
      lines: (await tx`select family_id from public.shield_checkin_lines where family_id in (${a.ctx.familyId}, ${b.ctx.familyId})`).map(r => r.family_id),
    }));
    expect(seen).toEqual({ consents: [a.ctx.familyId], settings: [a.ctx.familyId], lines: [a.ctx.familyId] });
    await expect(asUser(a.childUser, tx => tx`update public.shield_experience_settings set experience_drills_enabled = false
      where parent_id = ${a.ctx.parentId}`)).rejects.toThrow(/permission denied/);
    await expect(asUser(a.childUser, tx => tx`insert into public.shield_drill_consents (family_id, parent_id, kind, clip_ref, given_at)
      values (${a.ctx.familyId}, ${a.ctx.parentId}, 'experience_drill', 'x', now())`)).rejects.toThrow(/permission denied/);
    for (const table of ["shield_drill_consents", "shield_experience_settings", "shield_checkin_lines"]) {
      await expect(sql.begin(async tx => {
        await tx`set local role anon`;
        await tx`select 1 from ${tx("public." + table)} limit 1`;
      })).rejects.toThrow(/permission denied/);
    }
  });

  it("joined runtime: consent + switch + start + job + turn against the real tables", async () => {
    const { ctx, childUser } = await seed();
    const { ports } = makeRuntime({} as never, { now: () => daytime });
    const runtime = createShieldRuntime({ ...ports, db: undefined as never, sql } as never);
    expect(await runtime.startExperienceDrill(ctx)).toEqual({ ok: false, reason: "no_consent" });
    await runtime.recordDrillConsent({ ...ctx, clipRef: "consent/maa-yes.ogg" });
    await runtime.setExperienceDrills({ ...ctx, enabled: true, byUserId: childUser });
    const started = await runtime.startExperienceDrill(ctx);
    if (!started.ok) throw new Error(`not started: ${started.reason}`);
    const payload = vi.mocked(ports.scheduler.after).mock.calls[0]![2];
    expect(await runtime.handleScheduledJob(EXPERIENCE_DRILL_JOB, payload)).toMatchObject({ outcome: "started" });
    expect(ports.calls.startResponderCall).toHaveBeenCalledWith(expect.objectContaining({ purpose: "experience_drill", checkId: started.drill_id }));
    expect(await runtime.shieldTools.run("experience_turn", ctx, { drill_id: started.drill_id, hung_up: true })).toMatchObject({ stop: true, score: 2 });
    expect(await runtime.takeCheckinPraise(ctx)).toEqual({ drill_praise: EXPERIENCE_PRAISE_LINE });
    expect(await runtime.scamSense({ ...ctx, month: "2026-11" })).toMatchObject({ by_type: { experience: { drills: 1, score_out_of_5: 5 } } });
    expect(await runtime.startExperienceDrill(ctx)).toEqual({ ok: false, reason: "too_soon" });
  });
});
