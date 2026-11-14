import { describe, expect, it, vi } from "vitest";
import { BUSY_JOBS } from "@sahaj/shield";
import { createPhase2Service } from "@/lib/phase2";

const FAMILY = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const STREAK = "33333333-3333-4333-8333-333333333333";

function service(placeCheckinRetry?: Parameters<typeof createPhase2Service>[0]["placeCheckinRetry"], streak: Record<string, unknown> = {}) {
  const recordBusyRetryOutbox = vi.fn(async () => undefined);
  const sign = vi.fn(async () => undefined);
  const svc = createPhase2Service({
    store: { recordBusyRetryOutbox } as never,
    busyDeps: { db: { getBusyStreak: async () => ({ id: STREAK, familyId: FAMILY, parentId: PARENT, endedAt: null, childRepliedAt: null, ...streak }) }, sign } as never,
    warningsDeps: {} as never,
    clock: { now: () => new Date("2026-11-14T13:00:00Z") },
    fallbackHandleScheduledJob: async () => ({ fallback: true }),
    ...(placeCheckinRetry ? { placeCheckinRetry } : {}),
  });
  return { svc, recordBusyRetryOutbox, sign };
}
const payload = { family_id: FAMILY, parent_id: PARENT, streak_id: STREAK };

describe("busy-line retry places a real check-in call when a caller is configured (step 2.4)", () => {
  it("placed → outcome call_placed, signed, no outbox row", async () => {
    const place = vi.fn(async () => ({ placed: true }));
    const { svc, recordBusyRetryOutbox, sign } = service(place);
    expect(await svc.dispatchScheduledJob(BUSY_JOBS.retry, payload, "job-1")).toMatchObject({ outcome: "call_placed" });
    expect(place).toHaveBeenCalledWith({ familyId: FAMILY, parentId: PARENT, streakId: STREAK, jobId: "job-1" });
    expect(recordBusyRetryOutbox).not.toHaveBeenCalled();
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ type: "shield.busy.retry_call_placed" }));
  });

  it("caller not configured → simulated outbox, as before", async () => {
    const { svc, recordBusyRetryOutbox } = service();
    expect(await svc.dispatchScheduledJob(BUSY_JOBS.retry, payload, "job-2")).toMatchObject({ outcome: "outbox_simulated" });
    expect(recordBusyRetryOutbox).toHaveBeenCalledOnce();
  });

  it("caller says not placed → outbox fallback", async () => {
    const { svc, recordBusyRetryOutbox } = service(async () => ({ placed: false }));
    expect(await svc.dispatchScheduledJob(BUSY_JOBS.retry, payload, "job-3")).toMatchObject({ outcome: "outbox_simulated" });
    expect(recordBusyRetryOutbox).toHaveBeenCalledOnce();
  });

  it("streak already answered by Riya → no call", async () => {
    const place = vi.fn(async () => ({ placed: true }));
    const { svc } = service(place, { childRepliedAt: new Date() });
    expect(await svc.dispatchScheduledJob(BUSY_JOBS.retry, payload, "job-4")).toMatchObject({ outcome: "already_resolved" });
    expect(place).not.toHaveBeenCalled();
  });
});
