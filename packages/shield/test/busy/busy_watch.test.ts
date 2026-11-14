import { describe, expect, it } from "vitest";
import {
  BUSY_JOBS,
  buildBusyAlert,
  handleBusyJob,
  median,
  recordBusyAlertReply,
  recordCallStatus,
  shouldAlert,
  type CallStatusInput,
} from "../../src/busy";
import { at, FAM, MAA, makeBusyDeps, MIN } from "./fakes";

type Status = CallStatusInput["status"];
const call = (status: Status, minute: number, inCheckinWindow = true): CallStatusInput => ({
  familyId: FAM,
  parentId: MAA,
  status,
  at: at(minute),
  inCheckinWindow,
});

const EN_50 = "Maa’s phone has been busy for 50 min. You can call her — she will hear a call-waiting beep.";
const HI_50 = "Maa ka phone 50 min se busy hai. Aap unhe call kar sakte hain — unhe call-waiting ki beep sunai degi.";

/** Busy results every 10 min at the given minutes, all inside a check-in window. */
async function busyAt(deps: ReturnType<typeof makeBusyDeps>["deps"], minutes: number[], inWindow = true) {
  const out = [];
  for (const m of minutes) out.push(await recordCallStatus(deps, call("busy", m, inWindow)));
  return out;
}

describe("busy streak math", () => {
  it("busy starts a streak, the next busy extends it, connected closes it", async () => {
    const { deps, rows } = makeBusyDeps();
    const a = await recordCallStatus(deps, call("busy", 0));
    expect(a.streak).toBe("started");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ startedAt: at(0), lastBusyAt: at(0), busyCount: 1, endedAt: null });

    const b = await recordCallStatus(deps, call("busy", 10));
    expect(b).toMatchObject({ streak: "extended", streakId: a.streakId });
    expect(rows[0]).toMatchObject({ startedAt: at(0), lastBusyAt: at(10), busyCount: 2 });

    const c = await recordCallStatus(deps, call("connected", 20));
    expect(c).toMatchObject({ streak: "closed", streakId: a.streakId, retryScheduled: false });
    expect(rows[0]).toMatchObject({ endedAt: at(20), endReason: "connected" });
  });

  it("after a close the next busy starts a new streak", async () => {
    const { deps, rows } = makeBusyDeps();
    await busyAt(deps, [0, 10]);
    await recordCallStatus(deps, call("connected", 15));
    const n = await recordCallStatus(deps, call("busy", 20));
    expect(n.streak).toBe("started");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ startedAt: at(20), busyCount: 1 });
  });

  it("connected with no open streak changes nothing", async () => {
    const { deps, rows } = makeBusyDeps();
    expect((await recordCallStatus(deps, call("connected", 0))).streak).toBe("unchanged");
    expect(rows).toHaveLength(0);
  });

  it("no_answer and failed leave the streak as it is", async () => {
    const { deps, rows } = makeBusyDeps();
    await busyAt(deps, [0]);
    expect((await recordCallStatus(deps, call("no_answer", 5))).streak).toBe("unchanged");
    expect((await recordCallStatus(deps, call("failed", 6))).streak).toBe("unchanged");
    expect(rows[0]).toMatchObject({ busyCount: 1, lastBusyAt: at(0), endedAt: null });
    expect((await recordCallStatus(deps, call("busy", 10))).streak).toBe("extended");
  });

  it("a redelivered (same time) or older busy result is a duplicate: no count, no retry", async () => {
    const { deps, rows, queued } = makeBusyDeps();
    await busyAt(deps, [0, 10]);
    const before = queued.length;
    expect((await recordCallStatus(deps, call("busy", 10))).streak).toBe("duplicate");
    expect((await recordCallStatus(deps, call("busy", 5))).streak).toBe("duplicate");
    expect(rows[0]!.busyCount).toBe(2);
    expect(queued.length).toBe(before);
  });

  it("a busy result more than 30 min after the last one closes the old streak as stale and starts a new one", async () => {
    const { deps, rows } = makeBusyDeps();
    await busyAt(deps, [0, 10]);
    const r = await recordCallStatus(deps, call("busy", 41));
    expect(r.streak).toBe("started");
    expect(rows[0]).toMatchObject({ endedAt: at(10), endReason: "stale" });
    expect(rows[1]).toMatchObject({ startedAt: at(41), busyCount: 1 });
    // Exactly 30 min still extends.
    const { deps: d2, rows: r2 } = makeBusyDeps();
    await busyAt(d2, [0]);
    expect((await recordCallStatus(d2, call("busy", 30))).streak).toBe("extended");
    expect(r2).toHaveLength(1);
  });

  it("rejects bad input", async () => {
    const { deps } = makeBusyDeps();
    await expect(recordCallStatus(deps, { ...call("busy", 0), status: "ringing" as Status })).rejects.toThrow();
  });
});

describe("check-in window retries", () => {
  it("inside a window each busy result queues one retry in 10 min", async () => {
    const { deps, queued } = makeBusyDeps();
    const r = await recordCallStatus(deps, call("busy", 0, true));
    expect(r.retryScheduled).toBe(true);
    expect(queued).toEqual([
      { ms: 10 * MIN, job: BUSY_JOBS.retry, payload: { family_id: FAM, parent_id: MAA, streak_id: r.streakId } },
    ]);
  });

  it("outside a window nothing is queued, but the streak still counts", async () => {
    const { deps, queued, rows } = makeBusyDeps();
    const r = await recordCallStatus(deps, call("busy", 0, false));
    expect(r).toMatchObject({ streak: "started", retryScheduled: false });
    expect(queued).toHaveLength(0);
    expect(rows).toHaveLength(1);
  });

  it("no_answer, failed and connected never queue a retry", async () => {
    const { deps, queued } = makeBusyDeps();
    await recordCallStatus(deps, call("no_answer", 0, true));
    await recordCallStatus(deps, call("failed", 1, true));
    await recordCallStatus(deps, call("connected", 2, true));
    expect(queued).toHaveLength(0);
  });

  it("a failing scheduler is signed and does not throw", async () => {
    const { deps } = makeBusyDeps();
    deps.scheduler.after.mockRejectedValueOnce(new Error("db down"));
    const r = await recordCallStatus(deps, call("busy", 0, true));
    expect(r.retryScheduled).toBe(false);
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ type: "shield.busy.side_effect_failed" }));
  });
});

describe("alert rule", () => {
  it("alerts Riya once, at the first busy result ≥ 45 min in, with the card's text in en + hi", async () => {
    const { deps, queued } = makeBusyDeps();
    const res = await busyAt(deps, [0, 10, 20, 30, 40]);
    expect(res.every((r) => !r.alerted)).toBe(true);
    expect(deps.alerts.sendBusyAlert).not.toHaveBeenCalled();

    const r50 = await recordCallStatus(deps, call("busy", 50));
    expect(r50.alerted).toBe(true);
    expect(deps.alerts.sendBusyAlert).toHaveBeenCalledTimes(1);
    const sent = deps.alerts.sendBusyAlert.mock.calls[0]![0] as unknown as {
      minutes: number;
      streakId: string;
      messages: { en: { body: string }; hi: { body: string } };
    };
    expect(sent.minutes).toBe(50);
    expect(sent.streakId).toBe(r50.streakId);
    expect(sent.messages.en.body).toBe(EN_50);
    expect(sent.messages.hi.body).toBe(HI_50);

    // Circle step queued 5 min out.
    expect(queued.at(-1)).toEqual({
      ms: 5 * MIN,
      job: BUSY_JOBS.circle,
      payload: { streak_id: r50.streakId, family_id: FAM, parent_id: MAA },
    });

    // Still busy: no second alert for the same streak.
    await busyAt(deps, [60, 70, 80]);
    expect(deps.alerts.sendBusyAlert).toHaveBeenCalledTimes(1);
  });

  it("a new streak can alert again (once it is longer than the first one, which is now her normal)", async () => {
    const { deps } = makeBusyDeps();
    await busyAt(deps, [0, 10, 20, 30, 40, 50]);
    await recordCallStatus(deps, call("connected", 55)); // closed streak: 55 min
    await busyAt(deps, [60, 70, 80, 90, 100, 110]); // 50 min: not longer than 55
    expect(deps.alerts.sendBusyAlert).toHaveBeenCalledTimes(1);
    await busyAt(deps, [120]); // 60 min
    expect(deps.alerts.sendBusyAlert).toHaveBeenCalledTimes(2);
  });

  it("also alerts from busy results outside a window (alert does not depend on the window)", async () => {
    const { deps, queued } = makeBusyDeps();
    await busyAt(deps, [0, 20, 40, 50], false);
    expect(deps.alerts.sendBusyAlert).toHaveBeenCalledTimes(1);
    expect(queued.map((q) => q.job)).toEqual([BUSY_JOBS.circle]);
  });

  it("a failed alert send is signed; the streak is still marked alerted (no repeat)", async () => {
    const { deps } = makeBusyDeps();
    deps.alerts.sendBusyAlert.mockRejectedValueOnce(new Error("push down"));
    await busyAt(deps, [0, 10, 20, 30, 40, 50, 60]);
    expect(deps.alerts.sendBusyAlert).toHaveBeenCalledTimes(1);
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ type: "shield.busy.side_effect_failed" }));
  });

  it("uses the family's name for the parent, masked", async () => {
    const { deps } = makeBusyDeps({ parentName: "Nani 9876543210" });
    await busyAt(deps, [0, 10, 20, 30, 40, 50]);
    const sent = deps.alerts.sendBusyAlert.mock.calls[0]![0] as unknown as { messages: { en: { body: string; title: string } } };
    expect(sent.messages.en.body.startsWith("Nani •••’s phone")).toBe(true);
    expect(JSON.stringify(sent)).not.toMatch(/\d{4,}/);
  });
});

describe("normal-length comparison", () => {
  it("default normal is 20 min when there is no history", () => {
    const s = { startedAt: at(0), busyCount: 5 };
    expect(shouldAlert(s, at(45), 20 * MIN)).toBe(true);
    expect(shouldAlert(s, at(44), 20 * MIN)).toBe(false);
  });

  it("does not alert while the streak is within her normal (median 60 min), alerts once it is longer", async () => {
    const { deps, seedClosed } = makeBusyDeps();
    seedClosed(50, 1);
    seedClosed(60, 2);
    seedClosed(70, 3);
    await busyAt(deps, [0, 10, 20, 30, 40, 50, 60]);
    expect(deps.alerts.sendBusyAlert).not.toHaveBeenCalled(); // 60 is not longer than 60
    await recordCallStatus(deps, call("busy", 70));
    expect(deps.alerts.sendBusyAlert).toHaveBeenCalledTimes(1);
    const sent = deps.alerts.sendBusyAlert.mock.calls[0]![0] as unknown as { minutes: number };
    expect(sent.minutes).toBe(70);
  });

  it("only the last 14 days count", async () => {
    const { deps, seedClosed } = makeBusyDeps();
    seedClosed(120, 15);
    seedClosed(120, 20);
    await busyAt(deps, [0, 10, 20, 30, 40, 50]);
    expect(deps.alerts.sendBusyAlert).toHaveBeenCalledTimes(1);
  });

  it("median of an even count is the mean of the middle two; empty is null", () => {
    expect(median([])).toBeNull();
    expect(median([30])).toBe(30);
    expect(median([10, 40, 20, 30])).toBe(25);
    expect(median([5, 1, 3])).toBe(3);
  });
});

describe("DEMO_TIMER_SCALE", () => {
  const env = { DEMO_TIMER_SCALE: "10" };

  it("divides the retry and circle delays", async () => {
    const { deps, queued } = makeBusyDeps({ env });
    await busyAt(deps, [0, 1, 2]);
    expect(queued.filter((q) => q.job === BUSY_JOBS.retry).map((q) => q.ms)).toEqual([60_000, 60_000, 60_000]);
    expect(queued.filter((q) => q.job === BUSY_JOBS.circle).map((q) => q.ms)).toEqual([30_000]);
  });

  it("3 busy results in a row alert (shown as 30 min); 2 do not", async () => {
    const { deps } = makeBusyDeps({ env });
    const [a, b, c] = await busyAt(deps, [0, 1, 2]);
    expect([a!.alerted, b!.alerted, c!.alerted]).toEqual([false, false, true]);
    const sent = deps.alerts.sendBusyAlert.mock.calls[0]![0] as unknown as { minutes: number };
    expect(sent.minutes).toBe(30);
  });

  it("without the scale, 3 quick busy results do not alert", async () => {
    const { deps } = makeBusyDeps();
    await busyAt(deps, [0, 1, 2]);
    expect(deps.alerts.sendBusyAlert).not.toHaveBeenCalled();
  });

  it("still respects her normal in demo mode", async () => {
    const { deps, seedClosed } = makeBusyDeps({ env });
    seedClosed(40, 1); // median 40 min > 3 × 10 min
    await busyAt(deps, [0, 1, 2]);
    expect(deps.alerts.sendBusyAlert).not.toHaveBeenCalled();
    await busyAt(deps, [3, 4]); // 5 results = 50 min > 40
    expect(deps.alerts.sendBusyAlert).toHaveBeenCalledTimes(1);
  });

  it("the stale gap is scaled too (3 min at scale 10)", async () => {
    const { deps, rows } = makeBusyDeps({ env });
    await busyAt(deps, [0]);
    expect((await recordCallStatus(deps, call("busy", 4))).streak).toBe("started");
    expect(rows[0]!.endReason).toBe("stale");
  });
});

describe("circle step (job shield.busy.circle)", () => {
  async function alerted(env: Record<string, string> = {}) {
    const ctx = makeBusyDeps({ env });
    await busyAt(ctx.deps, [0, 10, 20, 30, 40, 50]);
    const job = ctx.queued.find((q) => q.job === BUSY_JOBS.circle)!;
    return { ...ctx, job };
  }

  it("no reply → starts the circle chain once", async () => {
    const { deps, job } = await alerted();
    expect(await handleBusyJob(job.job, job.payload, deps)).toEqual({ job: BUSY_JOBS.circle, outcome: "circled" });
    expect(deps.atlas.startCircleChain).toHaveBeenCalledWith({ familyId: FAM, parentId: MAA, reason: "busy_line_no_reply" });
    expect((await handleBusyJob(job.job, job.payload, deps)).outcome).toBe("duplicate");
    expect(deps.atlas.startCircleChain).toHaveBeenCalledTimes(1);
  });

  it("Riya replied → nothing", async () => {
    const { deps, job } = await alerted();
    expect(await recordBusyAlertReply(deps, { streakId: String(job.payload.streak_id), familyId: FAM })).toBe(true);
    expect(await recordBusyAlertReply(deps, { streakId: String(job.payload.streak_id), familyId: FAM })).toBe(false);
    expect((await handleBusyJob(job.job, job.payload, deps)).outcome).toBe("replied");
    expect(deps.atlas.startCircleChain).not.toHaveBeenCalled();
  });

  it("a reply from another family does not count", async () => {
    const { deps, job } = await alerted();
    expect(await recordBusyAlertReply(deps, { streakId: String(job.payload.streak_id), familyId: "fam_2" })).toBe(false);
  });

  it("another family's streak, a bad payload or an unknown job does nothing", async () => {
    const { deps, job } = await alerted();
    expect((await handleBusyJob(job.job, { ...job.payload, family_id: "fam_2" }, deps)).outcome).toBe("not_found");
    expect((await handleBusyJob(job.job, { streak_id: 1 }, deps)).outcome).toBe("invalid_payload");
    expect((await handleBusyJob(BUSY_JOBS.retry, job.payload, deps)).outcome).toBe("unknown_job");
    expect(deps.atlas.startCircleChain).not.toHaveBeenCalled();
  });

  it("a failing circle chain is signed, not thrown", async () => {
    const { deps, job } = await alerted();
    deps.atlas.startCircleChain.mockRejectedValueOnce(new Error("atlas down"));
    expect((await handleBusyJob(job.job, job.payload, deps)).outcome).toBe("circle_failed");
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ type: "shield.busy.side_effect_failed" }));
  });
});

describe("buildBusyAlert", () => {
  it("en is the default; both languages have the call button first", () => {
    const en = buildBusyAlert({ parentName: "Maa", minutes: 50 });
    expect(en).toEqual({
      title: "Maa’s phone is busy",
      body: EN_50,
      buttons: [
        { id: "call_parent", label: "Call Maa" },
        { id: "seen", label: "Seen" },
      ],
    });
    const hi = buildBusyAlert({ lang: "hi", parentName: "Maa", minutes: 50.9 });
    expect(hi.body).toBe(HI_50);
    expect(hi.buttons.map((b) => b.id)).toEqual(["call_parent", "seen"]);
  });

  it("never holds a 4+ digit run, and falls back to Maa for an empty name", () => {
    for (const lang of ["en", "hi"] as const) {
      const m = buildBusyAlert({ lang, parentName: "  ", minutes: 45 });
      expect(m.body.startsWith("Maa")).toBe(true);
      const n = buildBusyAlert({ lang, parentName: "Amma ९८७६५४३२१०", minutes: 45 });
      expect(JSON.stringify(n)).not.toMatch(/\d{4,}/);
    }
  });
});
