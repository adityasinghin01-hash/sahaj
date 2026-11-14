import { describe, expect, it, vi } from "vitest";
import { buildShieldGraph, handleScheduledJob, RETRY_PARENT_JOB } from "../../src/brain/index.js";
import { event, fixtures } from "./helpers.js";

const run = (deps: Parameters<typeof buildShieldGraph>[0], e = event()) =>
  buildShieldGraph(deps).invoke({ event: e });

describe("yellow keypad call and retry ladder", () => {
  it.each(["keypad_voice", "gateway_sms"] as const)(
    "yellow %s busy/no_answer → retries at scaled 2 min up to 2 retries then stops, signed and quiet",
    async (channel) => {
      const { deps } = fixtures("yellow");
      deps.env = { DEMO_TIMER_SCALE: "10" };
      deps.calls.callParent
        .mockResolvedValueOnce({ status: "busy" })
        .mockResolvedValueOnce({ status: "no_answer" })
        .mockResolvedValueOnce({ status: "busy" });

      const out = await run(deps, event({ channel }));
      expect(out.decision?.verdict.level).toBe("yellow");
      expect(out.decision?.verdict.actions).toEqual(["alert_child", "speak_clip"]);
      expect(deps.notify.childCard).toHaveBeenCalledWith(expect.objectContaining({ quiet: true, push: true }));
      expect(deps.whatsapp.sendShieldAlert).not.toHaveBeenCalled();

      expect(deps.calls.callParent).toHaveBeenCalledWith(
        expect.objectContaining({ lineId: "line-maa", attempt: 1 }),
      );
      expect(deps.scheduler.after).toHaveBeenCalledWith(12000, RETRY_PARENT_JOB, {
        verdictId: "verdict-a",
        attempt: 2,
      });

      await handleScheduledJob(RETRY_PARENT_JOB, { verdictId: "verdict-a", attempt: 2 }, deps);
      expect(deps.scheduler.after).toHaveBeenCalledWith(12000, RETRY_PARENT_JOB, {
        verdictId: "verdict-a",
        attempt: 3,
      });

      await handleScheduledJob(RETRY_PARENT_JOB, { verdictId: "verdict-a", attempt: 3 }, deps);
      expect(deps.calls.callParent).toHaveBeenCalledTimes(3);
      const retryCalls = deps.scheduler.after.mock.calls.filter(([, name]) => name === RETRY_PARENT_JOB);
      expect(retryCalls).toHaveLength(2);
      expect(deps.scheduler.after.mock.calls.some(([, name]) => name === "shield.no_reaction_check")).toBe(false);

      expect(deps.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "call_parent",
          action: "speak_clip",
          details: expect.objectContaining({ attempt: 1, result: "busy", level: "yellow" }),
        }),
      );
      expect(deps.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          step: "call_parent",
          action: "speak_clip",
          details: expect.objectContaining({ attempt: 3, result: "busy", level: "yellow" }),
        }),
      );
      expect(deps.sign).toHaveBeenCalledWith(
        expect.objectContaining({ step: RETRY_PARENT_JOB, status: "ok" }),
      );
    },
  );

  it("yellow keypad answered on first retry stops without scheduling a second retry", async () => {
    const { deps } = fixtures("yellow");
    deps.calls.callParent
      .mockResolvedValueOnce({ status: "no_answer" })
      .mockResolvedValueOnce({ status: "answered" });

    await run(deps, event({ channel: "keypad_voice" }));
    await handleScheduledJob(RETRY_PARENT_JOB, { verdictId: "verdict-a", attempt: 2 }, deps);

    expect(deps.calls.callParent).toHaveBeenCalledTimes(2);
    expect(deps.scheduler.after.mock.calls.filter(([, name]) => name === RETRY_PARENT_JOB)).toHaveLength(1);
  });

  it("rechecks speak_clip gate on yellow keypad retry and deduplicates claims", async () => {
    const { deps } = fixtures("yellow");
    const claimed = new Set<string>();
    const jobs = { claim: vi.fn(async (key: string) => (claimed.has(key) ? false : (claimed.add(key), true))) };
    deps.calls.callParent.mockResolvedValue({ status: "busy" });

    await run({ ...deps, jobs }, event({ channel: "gateway_sms" }));
    await handleScheduledJob(RETRY_PARENT_JOB, { verdictId: "verdict-a", attempt: 2 }, { ...deps, jobs });
    await handleScheduledJob(RETRY_PARENT_JOB, { verdictId: "verdict-a", attempt: 2 }, { ...deps, jobs });
    expect(deps.calls.callParent).toHaveBeenCalledTimes(2);
    expect(deps.sign).toHaveBeenCalledWith(
      expect.objectContaining({ step: RETRY_PARENT_JOB, status: "skipped", details: { reason: "duplicate", attempt: 2 } }),
    );

    deps.gate.check.mockResolvedValue({ allowed: false });
    await handleScheduledJob(RETRY_PARENT_JOB, { verdictId: "verdict-a", attempt: 3 }, { ...deps, jobs });
    expect(deps.calls.callParent).toHaveBeenCalledTimes(2);
    expect(deps.sign).toHaveBeenCalledWith(
      expect.objectContaining({ step: RETRY_PARENT_JOB, status: "denied", action: "speak_clip" }),
    );
  });

  it.each(["device", "busy_watch"] as const)(
    "yellow smartphone/non-keypad %s stays quiet card only — no call or retry",
    async (channel) => {
      const { deps } = fixtures("yellow");
      const out = await run(deps, event({ channel }));
      expect(out.decision?.verdict.actions).toEqual(["alert_child"]);
      expect(deps.notify.childCard).toHaveBeenCalledWith(expect.objectContaining({ quiet: true, push: true }));
      expect(deps.whatsapp.sendShieldAlert).not.toHaveBeenCalled();
      expect(deps.calls.callParent).not.toHaveBeenCalled();
      expect(deps.scheduler.after).not.toHaveBeenCalled();

      await handleScheduledJob(RETRY_PARENT_JOB, { verdictId: "verdict-a", attempt: 2 }, deps);
      expect(deps.calls.callParent).not.toHaveBeenCalled();
      expect(deps.sign).toHaveBeenCalledWith(
        expect.objectContaining({ step: RETRY_PARENT_JOB, status: "skipped" }),
      );
    },
  );
});
