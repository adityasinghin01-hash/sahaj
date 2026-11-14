import { describe, expect, it, vi } from "vitest";
import { escalateFamilyCheck, scheduleCallback, shieldTools } from "../../src/tools";
import { LINES } from "../../src/tools/lines";
import { ctx, makeDeps } from "./fakes";

describe("family_check", () => {
  it("known name → creates check, sends WhatsApp card, answers at once", async () => {
    const { deps, checks } = await makeDeps();
    const out = await shieldTools.family_check.run(deps, ctx, { claimed_name: "Rahul", asked_for: "5000 rupaye UPI pe" });

    expect(out).toEqual({
      check_id: "chk_1",
      status: "checking",
      line_id: 8,
      line_hi: "Ek minute rukiye ji, main Rahul se pooch rahi hoon.",
    });
    expect(deps.db.createFamilyCheck).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: "fam_1", parentId: "maa_1", toPersonId: "p_rahul", state: "asked", askedWhat: "<NUM> rupaye UPI pe" }),
    );
    expect(deps.whatsapp.sendFamilyCheckCard).toHaveBeenCalledWith({
      familyId: "fam_1",
      toPersonId: "p_rahul",
      claimedName: "Rahul",
      askedWhat: "<NUM> rupaye UPI pe",
      checkId: "chk_1",
    });
    expect(checks.chk_1!.state).toBe("asked");
    expect(deps.calls.startResponderCall).not.toHaveBeenCalled();
    expect(deps.atlas.alertChild).not.toHaveBeenCalled();
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ type: "shield.voice.family_check" }));
  });

  it("unknown name → generic line, no check created, child alerted", async () => {
    const { deps } = await makeDeps();
    const out = await shieldTools.family_check.run(deps, ctx, { claimed_name: "Vicky", asked_for: "paise" });
    expect(out).toEqual({ check_id: null, status: "unknown_person", line_id: 8, line_hi: LINES.familyCheckUnknown });
    expect(out.line_hi).toContain("aapke bete/beti se");
    expect(deps.db.createFamilyCheck).not.toHaveBeenCalled();
    expect(deps.whatsapp.sendFamilyCheckCard).not.toHaveBeenCalled();
    expect(deps.atlas.alertChild).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: expect.objectContaining({ scam_type: "family_in_trouble" }) }),
    );
  });

  it("WhatsApp card fails → rings the family member straight away", async () => {
    const { deps } = await makeDeps();
    deps.whatsapp.sendFamilyCheckCard.mockRejectedValueOnce(new Error("wa down"));
    const out = await shieldTools.family_check.run(deps, ctx, { claimed_name: "rahul", asked_for: "paise" });
    expect(out.status).toBe("checking");
    await vi.waitFor(() =>
      expect(deps.calls.startResponderCall).toHaveBeenCalledWith({ familyId: "fam_1", toPersonId: "p_rahul", checkId: "chk_1" }),
    );
  });
});

describe("family_check_result", () => {
  const rec = { familyId: "fam_1", toPersonId: "p_rahul", claimedName: "Rahul" };

  it("confirmed → 'Haan, ye Rahul hi the.'", async () => {
    const { deps } = await makeDeps({ checks: { c1: { ...rec, state: "confirmed" } } });
    const out = await shieldTools.family_check_result.run(deps, ctx, { check_id: "c1" });
    expect(out).toEqual({ status: "confirmed", level: "green", line_id: null, line_hi: "Haan, ye Rahul hi the." });
    expect(deps.atlas.alertChild).not.toHaveBeenCalled();
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ type: "shield.voice.family_check_result" }));
  });

  it("denied → red, 'Paise mat bhejiye', child alerted", async () => {
    const { deps } = await makeDeps({ checks: { c1: { ...rec, state: "denied" } } });
    const out = await shieldTools.family_check_result.run(deps, ctx, { check_id: "c1" });
    expect(out).toEqual({ status: "denied", level: "red", line_id: null, line_hi: "Ye Rahul nahi the. Paise mat bhejiye." });
    expect(deps.atlas.alertChild).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: expect.objectContaining({ level: "red" }) }),
    );
  });

  it("asked → pending", async () => {
    const { deps } = await makeDeps({ checks: { c1: { ...rec, state: "asked" } } });
    const out = await shieldTools.family_check_result.run(deps, ctx, { check_id: "c1" });
    expect(out.status).toBe("pending");
    expect(out.line_hi).toBe(LINES.familyPending);
    expect(deps.atlas.alertChild).not.toHaveBeenCalled();
  });

  it("no_answer → safe no-answer line", async () => {
    const { deps } = await makeDeps({ checks: { c1: { ...rec, state: "no_answer" } } });
    const out = await shieldTools.family_check_result.run(deps, ctx, { check_id: "c1" });
    expect(out.status).toBe("no_answer");
    expect(out.line_hi).toBe(LINES.familyNoAnswer);
  });

  it("unknown id or another family's check → not_found", async () => {
    const { deps } = await makeDeps({ checks: { other: { ...rec, familyId: "fam_2", state: "confirmed" } } });
    expect((await shieldTools.family_check_result.run(deps, ctx, { check_id: "nope" })).status).toBe("not_found");
    const out = await shieldTools.family_check_result.run(deps, ctx, { check_id: "other" });
    expect(out.status).toBe("not_found");
    expect(out.line_hi).not.toContain("Rahul");
  });

  it("record without a name → generic family wording", async () => {
    const { deps } = await makeDeps({ checks: { c1: { state: "confirmed" } } });
    const out = await shieldTools.family_check_result.run(deps, ctx, { check_id: "c1" });
    expect(out.line_hi).toBe("Haan, ye aapke ghar wale hi the.");
  });
});

describe("escalateFamilyCheck / scheduleCallback", () => {
  it("escalates an unanswered check with a responder call", async () => {
    const { deps } = await makeDeps({
      checks: { c1: { state: "asked", familyId: "fam_1", toPersonId: "p_rahul", claimedName: "Rahul" } },
    });
    expect(await escalateFamilyCheck(deps, "c1")).toEqual({ escalated: true });
    expect(deps.calls.startResponderCall).toHaveBeenCalledWith({ familyId: "fam_1", toPersonId: "p_rahul", checkId: "c1" });
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ type: "shield.voice.family_check_escalated" }));
  });

  it("does not escalate an answered or missing check", async () => {
    const { deps } = await makeDeps({ checks: { c1: { state: "confirmed", familyId: "fam_1", toPersonId: "p" } } });
    expect(await escalateFamilyCheck(deps, "c1")).toEqual({ escalated: false, reason: "already_answered" });
    expect(await escalateFamilyCheck(deps, "zz")).toEqual({ escalated: false, reason: "not_found" });
    expect(deps.calls.startResponderCall).not.toHaveBeenCalled();
  });

  it("scheduleCallback starts a callback to Maa", async () => {
    const { deps } = await makeDeps();
    expect(await scheduleCallback(deps, ctx)).toEqual({ ok: true });
    expect(deps.calls.startCallback).toHaveBeenCalledWith({ familyId: "fam_1", parentId: "maa_1", line: LINES.callbackDefault });
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ type: "shield.voice.callback_scheduled" }));
  });
});
