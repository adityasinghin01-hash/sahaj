import { vi } from "vitest";
import type { BusyAlertInput, BusyDb, BusyDeps, BusyStreak } from "../../src/busy";

export const FAM = "fam_1";
export const MAA = "maa_1";
export const T0 = new Date("2026-11-14T04:30:00.000Z"); // 10:00 IST
export const MIN = 60_000;
export const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

/** In-memory BusyDb with the same rules as createBusyPg. */
export function makeBusyDb() {
  const rows: (BusyStreak & { endReason: string | null; alertMinutes: number | null })[] = [];
  let seq = 0;
  const copy = (r: BusyStreak): BusyStreak => ({
    id: r.id,
    familyId: r.familyId,
    parentId: r.parentId,
    startedAt: r.startedAt,
    lastBusyAt: r.lastBusyAt,
    busyCount: r.busyCount,
    endedAt: r.endedAt,
    alertedAt: r.alertedAt,
    childRepliedAt: r.childRepliedAt,
    circledAt: r.circledAt,
  });
  const openOf = (f: string, p: string) => rows.find((r) => r.familyId === f && r.parentId === p && r.endedAt === null);

  const db: BusyDb = {
    getOpenBusyStreak: vi.fn(async (f: string, p: string) => {
      const r = openOf(f, p);
      return r ? copy(r) : null;
    }),
    getBusyStreak: vi.fn(async (id: string) => {
      const r = rows.find((x) => x.id === id);
      return r ? copy(r) : null;
    }),
    startBusyStreak: vi.fn(async ({ familyId, parentId, at }: { familyId: string; parentId: string; at: Date }) => {
      const open = openOf(familyId, parentId);
      if (open) return { streak: copy(open), created: false };
      const r = {
        id: `streak_${++seq}`,
        familyId,
        parentId,
        startedAt: at,
        lastBusyAt: at,
        busyCount: 1,
        endedAt: null,
        alertedAt: null,
        childRepliedAt: null,
        circledAt: null,
        endReason: null,
        alertMinutes: null,
      };
      rows.push(r);
      return { streak: copy(r), created: true };
    }),
    extendBusyStreak: vi.fn(async (id: string, at: Date) => {
      const r = rows.find((x) => x.id === id);
      if (!r || r.endedAt !== null || !(r.lastBusyAt.getTime() < at.getTime())) return null;
      r.lastBusyAt = at;
      r.busyCount += 1;
      return copy(r);
    }),
    closeBusyStreak: vi.fn(async (id: string, endedAt: Date, reason: "connected" | "stale") => {
      const r = rows.find((x) => x.id === id);
      if (!r || r.endedAt !== null) return false;
      r.endedAt = endedAt.getTime() < r.lastBusyAt.getTime() ? r.lastBusyAt : endedAt;
      r.endReason = reason;
      return true;
    }),
    busyStreakDurationsMs: vi.fn(async (f: string, p: string, since: Date, until: Date) =>
      rows
        .filter(
          (r) =>
            r.familyId === f &&
            r.parentId === p &&
            r.endedAt !== null &&
            r.startedAt.getTime() >= since.getTime() &&
            r.startedAt.getTime() < until.getTime(),
        )
        .map((r) => r.endedAt!.getTime() - r.startedAt.getTime()),
    ),
    claimBusyAlert: vi.fn(async (id: string, at: Date, minutes: number) => {
      const r = rows.find((x) => x.id === id);
      if (!r || r.alertedAt !== null) return false;
      r.alertedAt = at;
      r.alertMinutes = minutes;
      return true;
    }),
    markBusyAlertReplied: vi.fn(async (id: string, familyId: string, at: Date) => {
      const r = rows.find((x) => x.id === id && x.familyId === familyId);
      if (!r || r.alertedAt === null || r.childRepliedAt !== null) return false;
      r.childRepliedAt = at;
      return true;
    }),
    claimBusyCircle: vi.fn(async (id: string, at: Date) => {
      const r = rows.find((x) => x.id === id);
      if (!r || r.circledAt !== null || r.childRepliedAt !== null) return false;
      r.circledAt = at;
      return true;
    }),
  };

  /** Seed a closed streak of `minutes` length that started `daysAgo` before T0. */
  function seedClosed(minutes: number, daysAgo: number, parentId = MAA) {
    const start = new Date(T0.getTime() - daysAgo * 24 * 60 * MIN);
    rows.push({
      id: `streak_${++seq}`,
      familyId: FAM,
      parentId,
      startedAt: start,
      lastBusyAt: start,
      busyCount: 1,
      endedAt: new Date(start.getTime() + minutes * MIN),
      alertedAt: null,
      childRepliedAt: null,
      circledAt: null,
      endReason: "connected",
      alertMinutes: null,
    });
  }

  return { db, rows, seedClosed };
}

export interface Queued {
  ms: number;
  job: string;
  payload: Record<string, unknown>;
}

export function makeBusyDeps(opts: { env?: Record<string, string>; parentName?: string | null } = {}) {
  const { db, rows, seedClosed } = makeBusyDb();
  const queued: Queued[] = [];
  const now = { value: T0 };
  const deps = {
    db,
    scheduler: {
      after: vi.fn(async (ms: number, job: string, payload: Record<string, unknown>) => {
        queued.push({ ms, job, payload });
      }),
    },
    alerts: { sendBusyAlert: vi.fn(async (_input: BusyAlertInput) => undefined) },
    atlas: { startCircleChain: vi.fn(async () => undefined) },
    sign: vi.fn(async () => undefined),
    clock: { now: () => now.value },
    env: opts.env ?? {},
    parentName: vi.fn(async () => (opts.parentName === undefined ? "Maa" : opts.parentName)),
  } satisfies BusyDeps;
  return { deps, rows, queued, now, seedClosed };
}
