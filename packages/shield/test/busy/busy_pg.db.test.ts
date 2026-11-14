/**
 * createBusyPg against a real Postgres (card K-B5). Run through infra/supabase/test/run-shield-db-test.sh,
 * which applies all three Shield migrations and sets DATABASE_URL. Skips without DATABASE_URL.
 */
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBusyPg } from "../../src/db";
import { BUSY_JOBS, handleBusyJob, recordBusyAlertReply, recordCallStatus, type BusyDb, type BusyDeps } from "../../src/busy";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const DATABASE_URL = env.DATABASE_URL;
if (!DATABASE_URL && env.SHIELD_DB_TEST_REQUIRED) throw new Error("SHIELD_DB_TEST_REQUIRED is set but DATABASE_URL is not");

const T0 = new Date("2026-11-14T04:30:00.000Z");
const MIN = 60_000;
const at = (m: number) => new Date(T0.getTime() + m * MIN);

describe.skipIf(!DATABASE_URL)("createBusyPg against Postgres", () => {
  let sql: Sql;
  let db: BusyDb;

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 10, onnotice: () => undefined });
    db = createBusyPg(sql);
  });
  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  async function seedFamily() {
    const [fam] = await sql<{ id: string }[]>`insert into public.families(name) values ('Synthetic family') returning id`;
    const [maa] = await sql<{ id: string }[]>`
      insert into public.people (family_id, display_name, role) values (${fam!.id}, 'Maa', 'parent') returning id`;
    return { familyId: fam!.id, parentId: maa!.id };
  }

  function deps(): BusyDeps & { alerts: { sendBusyAlert: ReturnType<typeof vi.fn> }; atlas: { startCircleChain: ReturnType<typeof vi.fn> } } {
    return {
      db,
      scheduler: { after: vi.fn(async () => undefined) },
      alerts: { sendBusyAlert: vi.fn(async () => undefined) },
      atlas: { startCircleChain: vi.fn(async () => undefined) },
      sign: vi.fn(async () => undefined),
      clock: { now: () => at(60) },
      env: {},
    };
  }

  it("start → extend → close, with one open streak per parent", async () => {
    const f = await seedFamily();
    expect(await db.getOpenBusyStreak(f.familyId, f.parentId)).toBeNull();
    const s = await db.startBusyStreak({ ...f, at: at(0) });
    expect(s.created).toBe(true);
    expect(s.streak).toMatchObject({ ...f, startedAt: at(0), lastBusyAt: at(0), busyCount: 1, endedAt: null, alertedAt: null });

    const again = await db.startBusyStreak({ ...f, at: at(1) });
    expect(again).toMatchObject({ created: false, streak: { id: s.streak.id } });

    const e = await db.extendBusyStreak(s.streak.id, at(10));
    expect(e).toMatchObject({ busyCount: 2, lastBusyAt: at(10) });
    expect(await db.extendBusyStreak(s.streak.id, at(10))).toBeNull(); // same time = duplicate
    expect(await db.extendBusyStreak(s.streak.id, at(5))).toBeNull(); // older

    expect(await db.closeBusyStreak(s.streak.id, at(5), "connected")).toBe(true);
    expect(await db.closeBusyStreak(s.streak.id, at(20), "connected")).toBe(false);
    const closed = await db.getBusyStreak(s.streak.id);
    expect(closed!.endedAt).toEqual(at(10)); // never before the last busy result
    expect(await db.extendBusyStreak(s.streak.id, at(30))).toBeNull();

    const next = await db.startBusyStreak({ ...f, at: at(40) });
    expect(next.created).toBe(true);
    expect(next.streak.id).not.toBe(s.streak.id);
  });

  it("10 parallel starts for one parent create exactly one streak", async () => {
    const f = await seedFamily();
    const res = await Promise.all(Array.from({ length: 10 }, () => db.startBusyStreak({ ...f, at: at(0) })));
    expect(res.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(res.map((r) => r.streak.id)).size).toBe(1);
  });

  it("durations: closed streaks in the window only, for that parent only", async () => {
    const f = await seedFamily();
    const g = await seedFamily();
    const mk = async (fam: typeof f, start: number, end: number | null) => {
      const s = await db.startBusyStreak({ ...fam, at: at(start) });
      if (end !== null) await db.closeBusyStreak(s.streak.id, at(end), "connected");
    };
    await mk(f, -20 * 24 * 60, -20 * 24 * 60 + 90); // 20 days ago, outside
    await mk(f, -3 * 24 * 60, -3 * 24 * 60 + 25);
    await mk(f, -2 * 24 * 60, -2 * 24 * 60 + 35);
    await mk(g, -1 * 24 * 60, -1 * 24 * 60 + 99); // other family
    await mk(f, 0, null); // open
    const ms = await db.busyStreakDurationsMs(f.familyId, f.parentId, at(-14 * 24 * 60), at(1));
    expect(ms).toEqual([25 * MIN, 35 * MIN]);
  });

  it("alert, reply and circle claims succeed exactly once", async () => {
    const f = await seedFamily();
    const { streak } = await db.startBusyStreak({ ...f, at: at(0) });
    expect(await db.markBusyAlertReplied(streak.id, f.familyId, at(1))).toBe(false); // not alerted yet

    const claims = await Promise.all(Array.from({ length: 8 }, () => db.claimBusyAlert(streak.id, at(50), 50)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const [row] = await sql<{ alert_minutes: number }[]>`select alert_minutes from public.busy_streaks where id = ${streak.id}`;
    expect(row!.alert_minutes).toBe(50);

    const other = await seedFamily();
    expect(await db.markBusyAlertReplied(streak.id, other.familyId, at(51))).toBe(false);
    expect(await db.markBusyAlertReplied(streak.id, f.familyId, at(51))).toBe(true);
    expect(await db.markBusyAlertReplied(streak.id, f.familyId, at(52))).toBe(false);
    expect(await db.claimBusyCircle(streak.id, at(55))).toBe(false); // replied → no circle

    const { streak: s2 } = await db.startBusyStreak({ ...other, at: at(0) });
    await db.claimBusyAlert(s2.id, at(50), 50);
    const circles = await Promise.all(Array.from({ length: 5 }, () => db.claimBusyCircle(s2.id, at(55))));
    expect(circles.filter(Boolean)).toHaveLength(1);
  });

  it("another family's id, a non-uuid id, or a check-constraint violation", async () => {
    const f = await seedFamily();
    const g = await seedFamily();
    await db.startBusyStreak({ ...f, at: at(0) });
    expect(await db.getOpenBusyStreak(g.familyId, f.parentId)).toBeNull();
    expect(await db.getOpenBusyStreak("maa_1", f.parentId)).toBeNull();
    expect(await db.getBusyStreak("x'; drop table busy_streaks; --")).toBeNull();
    await expect(
      sql`insert into public.busy_streaks (family_id, parent_id, started_at, last_busy_at, ended_at)
          values (${f.familyId}, ${f.parentId}, ${at(10)}::timestamptz, ${at(10)}::timestamptz, ${at(11)}::timestamptz)`,
    ).rejects.toMatchObject({ code: "23514" }); // ended_at without end_reason
  });

  it("end to end: recordCallStatus + handleBusyJob on the real tables", async () => {
    const f = await seedFamily();
    const d = deps();
    for (const m of [0, 10, 20, 30, 40, 50, 60]) {
      await recordCallStatus(d, { ...f, status: "busy", at: at(m), inCheckinWindow: true });
    }
    expect(d.alerts.sendBusyAlert).toHaveBeenCalledTimes(1);
    const sent = d.alerts.sendBusyAlert.mock.calls[0]![0] as { streakId: string; minutes: number };
    expect(sent.minutes).toBe(50);

    const payload = { streak_id: sent.streakId, family_id: f.familyId, parent_id: f.parentId };
    expect((await handleBusyJob(BUSY_JOBS.circle, payload, d)).outcome).toBe("circled");
    expect((await handleBusyJob(BUSY_JOBS.circle, payload, d)).outcome).toBe("duplicate");
    expect(d.atlas.startCircleChain).toHaveBeenCalledTimes(1);
    expect(await recordBusyAlertReply(d, { streakId: sent.streakId, familyId: f.familyId, at: at(70) })).toBe(true);

    const closed = await recordCallStatus(d, { ...f, status: "connected", at: at(65), inCheckinWindow: true });
    expect(closed.streak).toBe("closed");
    const [row] = await sql<{ busy_count: number; end_reason: string; ended_at: Date }[]>`
      select busy_count, end_reason, ended_at from public.busy_streaks where id = ${sent.streakId}`;
    expect(row).toEqual({ busy_count: 7, end_reason: "connected", ended_at: at(65) });
  });
});
