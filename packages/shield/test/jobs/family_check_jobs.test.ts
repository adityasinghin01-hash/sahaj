import { describe, expect, it } from "vitest";
import {
  CALLBACK_AFTER_MS,
  ESCALATE_AFTER_MS,
  SHIELD_JOBS,
  handleShieldToolJob,
  scaleDelay,
  scheduledShieldTools,
  shieldTools,
  timerScale,
  type ScheduledToolDeps,
} from "../../src";
import { CALLBACK_LINES } from "../../src/messages";
import { makeDeps } from "../tools/fakes";
import { ctx, makeJobDeps } from "./fakes";

const rec = { familyId: "fam_1", toPersonId: "p_rahul", claimedName: "Rahul" };
const payload = (check_id = "c1") => ({ check_id, family_id: "fam_1", parent_id: "maa_1" });
const NO_ANSWER_LINE = "Abhi pata nahi chala. Paise bilkul mat bhejiye. Riya ko bata diya hai.";

describe("shield.family_check.escalate", () => {
  it("still asked → responder call", async () => {
    const { deps } = await makeJobDeps({ checks: { c1: { ...rec, state: "asked" } } });
    expect(await handleShieldToolJob(SHIELD_JOBS.escalate, payload(), deps)).toEqual({
      job: SHIELD_JOBS.escalate,
      outcome: "escalated",
    });
    expect(deps.calls.startResponderCall).toHaveBeenCalledWith({ familyId: "fam_1", toPersonId: "p_rahul", checkId: "c1" });
  });

  it.each(["confirmed", "denied", "no_answer"] as const)("already %s → does nothing", async (state) => {
    const { deps } = await makeJobDeps({ checks: { c1: { ...rec, state } } });
    expect((await handleShieldToolJob(SHIELD_JOBS.escalate, payload(), deps)).outcome).toBe("already_answered");
    expect(deps.calls.startResponderCall).not.toHaveBeenCalled();
    expect(deps.calls.startCallback).not.toHaveBeenCalled();
    expect(deps.atlas.alertChild).not.toHaveBeenCalled();
  });

  it("missing check or another family's check → not_found, nothing called", async () => {
    const { deps } = await makeJobDeps({ checks: { c1: { ...rec, familyId: "fam_2", state: "asked" } } });
    expect((await handleShieldToolJob(SHIELD_JOBS.escalate, payload("zz"), deps)).outcome).toBe("not_found");
    expect((await handleShieldToolJob(SHIELD_JOBS.escalate, payload("c1"), deps)).outcome).toBe("not_found");
    expect(deps.calls.startResponderCall).not.toHaveBeenCalled();
  });

  it("idempotent: running twice rings once", async () => {
    const { deps } = await makeJobDeps({ checks: { c1: { ...rec, state: "asked" } } });
    await handleShieldToolJob(SHIELD_JOBS.escalate, payload(), deps);
    expect((await handleShieldToolJob(SHIELD_JOBS.escalate, payload(), deps)).outcome).toBe("duplicate");
    expect(deps.calls.startResponderCall).toHaveBeenCalledTimes(1);
  });
});

describe("shield.family_check.callback", () => {
  it("confirmed → callback with the confirmed line, no alert", async () => {
    const { deps } = await makeJobDeps({ checks: { c1: { ...rec, state: "confirmed" } } });
    expect((await handleShieldToolJob(SHIELD_JOBS.callback, payload(), deps)).outcome).toBe("callback_confirmed");
    expect(deps.calls.startCallback).toHaveBeenCalledWith({
      familyId: "fam_1",
      parentId: "maa_1",
      line: "Namaste ji, main Aasha Didi bol rahi hoon. Haan, ye Rahul hi the.",
    });
    expect(deps.atlas.alertChild).not.toHaveBeenCalled();
    expect(deps.db.markFamilyCheckNoAnswer).not.toHaveBeenCalled();
  });

  it("denied → callback with the denied line", async () => {
    const { deps } = await makeJobDeps({ checks: { c1: { ...rec, state: "denied" } } });
    expect((await handleShieldToolJob(SHIELD_JOBS.callback, payload(), deps)).outcome).toBe("callback_denied");
    expect(deps.calls.startCallback).toHaveBeenCalledWith(expect.objectContaining({ line: CALLBACK_LINES.denied("Rahul") }));
    expect(CALLBACK_LINES.denied("Rahul")).toContain("Ye Rahul nahi the. Paise bilkul mat bhejiye.");
  });

  it("still pending → marks no_answer, says the no-answer line, alerts the child", async () => {
    const { deps, checks } = await makeJobDeps({ checks: { c1: { ...rec, state: "asked" } } });
    expect((await handleShieldToolJob(SHIELD_JOBS.callback, payload(), deps)).outcome).toBe("callback_no_answer");
    expect(checks.c1!.state).toBe("no_answer");
    expect(deps.calls.startCallback).toHaveBeenCalledWith({ familyId: "fam_1", parentId: "maa_1", line: NO_ANSWER_LINE });
    expect(deps.atlas.alertChild).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: "fam_1", parentId: "maa_1", verdict: expect.objectContaining({ scam_type: "family_in_trouble" }) }),
    );
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ type: "shield.voice.family_check_no_answer" }));
  });

  it("no child name known → generic family wording", async () => {
    const { deps } = await makeJobDeps({ checks: { c1: { ...rec, state: "asked" } }, childName: null });
    await handleShieldToolJob(SHIELD_JOBS.callback, payload(), deps);
    expect(deps.calls.startCallback).toHaveBeenCalledWith(
      expect.objectContaining({ line: "Abhi pata nahi chala. Paise bilkul mat bhejiye. Aapke ghar walon ko bata diya hai." }),
    );
  });

  it("answered between read and write → uses the answer", async () => {
    const { deps, checks } = await makeJobDeps({ checks: { c1: { ...rec, state: "asked" } } });
    deps.db.markFamilyCheckNoAnswer.mockImplementationOnce(async () => {
      checks.c1!.state = "confirmed";
      return false;
    });
    expect((await handleShieldToolJob(SHIELD_JOBS.callback, payload(), deps)).outcome).toBe("callback_confirmed");
    expect(deps.atlas.alertChild).not.toHaveBeenCalled();
  });

  it("idempotent: running twice calls Maa once and alerts once", async () => {
    const { deps } = await makeJobDeps({ checks: { c1: { ...rec, state: "asked" } } });
    await handleShieldToolJob(SHIELD_JOBS.callback, payload(), deps);
    expect((await handleShieldToolJob(SHIELD_JOBS.callback, payload(), deps)).outcome).toBe("duplicate");
    expect(deps.calls.startCallback).toHaveBeenCalledTimes(1);
    expect(deps.atlas.alertChild).toHaveBeenCalledTimes(1);
  });
});

describe("handleShieldToolJob input", () => {
  it("unknown job and bad payload do nothing", async () => {
    const { deps } = await makeJobDeps({ checks: { c1: { ...rec, state: "asked" } } });
    expect((await handleShieldToolJob("shield.other", payload(), deps)).outcome).toBe("unknown_job");
    expect((await handleShieldToolJob(SHIELD_JOBS.escalate, { check_id: "c1" }, deps)).outcome).toBe("invalid_payload");
    expect((await handleShieldToolJob(SHIELD_JOBS.callback, null, deps)).outcome).toBe("invalid_payload");
    expect(deps.calls.startResponderCall).not.toHaveBeenCalled();
    expect(deps.calls.startCallback).not.toHaveBeenCalled();
  });
});

describe("DEMO_TIMER_SCALE", () => {
  it("defaults to 1 and ignores bad values", () => {
    expect(timerScale({})).toBe(1);
    expect(timerScale({ DEMO_TIMER_SCALE: "0" })).toBe(1);
    expect(timerScale({ DEMO_TIMER_SCALE: "-5" })).toBe(1);
    expect(timerScale({ DEMO_TIMER_SCALE: "abc" })).toBe(1);
    expect(scaleDelay(60_000, {})).toBe(60_000);
  });

  it("=10 divides both delays", async () => {
    expect(scaleDelay(ESCALATE_AFTER_MS, { DEMO_TIMER_SCALE: "10" })).toBe(6_000);
    expect(scaleDelay(CALLBACK_AFTER_MS, { DEMO_TIMER_SCALE: "10" })).toBe(12_000);

    const { deps, queued } = await makeJobDeps({ env: { DEMO_TIMER_SCALE: "10" } });
    const out = await scheduledShieldTools.family_check.run(deps, ctx, { claimed_name: "Rahul", asked_for: "paise" });
    await scheduledShieldTools.family_check_result.run(deps, ctx, { check_id: out.check_id! });
    await scheduledShieldTools.family_check_result.run(deps, ctx, { check_id: out.check_id! });
    expect(queued.map((q) => [q.job, q.ms])).toEqual([
      [SHIELD_JOBS.escalate, 6_000],
      [SHIELD_JOBS.callback, 12_000],
    ]);
  });
});

describe("scheduledShieldTools (tool flow)", () => {
  it("family_check queues escalate at 60 s once the card is sent; output unchanged", async () => {
    const plain = await makeDeps();
    const expected = await shieldTools.family_check.run(plain.deps, ctx, { claimed_name: "Rahul", asked_for: "paise" });

    const { deps, queued } = await makeJobDeps();
    const out = await scheduledShieldTools.family_check.run(deps, ctx, { claimed_name: "Rahul", asked_for: "paise" });
    expect(out).toEqual(expected);
    expect(queued).toEqual([
      { ms: 60_000, job: SHIELD_JOBS.escalate, payload: { check_id: "chk_1", family_id: "fam_1", parent_id: "maa_1" } },
    ]);
    expect(deps.calls.startResponderCall).not.toHaveBeenCalled();
  });

  it("family_check: card failed or unknown person → nothing queued", async () => {
    const { deps, queued } = await makeJobDeps();
    deps.whatsapp.sendFamilyCheckCard.mockRejectedValueOnce(new Error("wa down"));
    expect((await scheduledShieldTools.family_check.run(deps, ctx, { claimed_name: "Rahul", asked_for: "paise" })).status).toBe(
      "checking",
    );
    expect((await scheduledShieldTools.family_check.run(deps, ctx, { claimed_name: "Vicky", asked_for: "paise" })).status).toBe(
      "unknown_person",
    );
    expect(queued).toEqual([]);
  });

  it("family_check_result queues the callback only on the 2nd pending, and only once", async () => {
    const { deps, queued, checks } = await makeJobDeps({ checks: { c1: { ...rec, state: "asked" } } });
    const r1 = await scheduledShieldTools.family_check_result.run(deps, ctx, { check_id: "c1" });
    expect(r1.status).toBe("pending");
    expect(queued).toEqual([]);
    await scheduledShieldTools.family_check_result.run(deps, ctx, { check_id: "c1" });
    await scheduledShieldTools.family_check_result.run(deps, ctx, { check_id: "c1" });
    expect(queued).toEqual([{ ms: 120_000, job: SHIELD_JOBS.callback, payload: payload("c1") }]);

    // The queued job then runs from the scheduler.
    checks.c1!.state = "asked";
    expect((await handleShieldToolJob(queued[0]!.job, queued[0]!.payload, deps)).outcome).toBe("callback_no_answer");
  });

  it("family_check_result: answered checks queue nothing", async () => {
    const { deps, queued } = await makeJobDeps({ checks: { c1: { ...rec, state: "confirmed" } } });
    await scheduledShieldTools.family_check_result.run(deps, ctx, { check_id: "c1" });
    await scheduledShieldTools.family_check_result.run(deps, ctx, { check_id: "c1" });
    expect(queued).toEqual([]);
  });

  it("without deps.scheduler the tools behave as today", async () => {
    const { deps } = await makeDeps({ checks: { c1: { ...rec, state: "asked" } } });
    const d: ScheduledToolDeps = deps;
    const out = await scheduledShieldTools.family_check.run(d, ctx, { claimed_name: "Rahul", asked_for: "paise" });
    expect(out.status).toBe("checking");
    expect((await scheduledShieldTools.family_check_result.run(d, ctx, { check_id: "c1" })).status).toBe("pending");
    expect((await scheduledShieldTools.family_check_result.run(d, ctx, { check_id: "c1" })).status).toBe("pending");
  });

  it("a failing scheduler never changes what Maa hears", async () => {
    const { deps } = await makeJobDeps();
    deps.scheduler.after.mockRejectedValueOnce(new Error("db down"));
    const out = await scheduledShieldTools.family_check.run(deps, ctx, { claimed_name: "Rahul", asked_for: "paise" });
    expect(out.line_hi).toBe("Ek minute rukiye ji, main Rahul se pooch rahi hoon.");
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ type: "shield.voice.side_effect_failed" }));
  });

  it("other tools are the same objects as shieldTools", () => {
    expect(scheduledShieldTools.classify_scam).toBe(shieldTools.classify_scam);
    expect(scheduledShieldTools.money_sent).toBe(shieldTools.money_sent);
    expect(scheduledShieldTools.family_check.name).toBe("family_check");
    expect(scheduledShieldTools.family_check_result.input).toBe(shieldTools.family_check_result.input);
  });
});
