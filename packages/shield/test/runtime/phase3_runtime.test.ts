/** K-B8: joined-runtime wiring of drills, experience drills, call gateway and evidence verify (memory storage). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HELPER_DRILLS, ShieldEvent, Verdict } from "@sahaj/shared";
import {
  EXPERIENCE_DRILL_JOB, EXPERIENCE_PRAISE_LINE, EXPERIENCE_REFUSAL_LINE, EXPERIENCE_STOP_LINE, brandTermsFromRules,
  isShieldToolName, numberFingerprint, shieldTools,
} from "../../src";
import { storage } from "../e2e/storage";
import { fixture as drillFixture } from "../drills/helpers";
import { memoryExperienceStore } from "../drills/experience_fakes";
import { makeRuntime } from "./ports";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const daytime = new Date("2026-11-14T06:00:00.000Z");

async function setup(env: Record<string, string> = {}) {
  const store = await storage(); cleanups.push(store.close);
  const drills = drillFixture(store.ctx);
  const experience = memoryExperienceStore(store.ctx, drills.rows, [store.userId]);
  store.db.drills = drills.deps.db;
  store.db.experience = experience.store;
  const rt = makeRuntime(store.db, { now: () => daytime, env });
  return { store, drills, experience, ...rt };
}

describe("runtime registration", () => {
  it("registers drill_answer, experience_turn and call_screen next to the voice tools", () => {
    for (const name of ["classify_scam", "check_message", "family_check", "family_check_result", "check_code_word", "money_sent",
      "drill_answer", "experience_turn", "call_screen"]) expect(isShieldToolName(name)).toBe(true);
    expect(shieldTools.experience_turn.name).toBe("experience_turn");
    expect(shieldTools.call_screen.name).toBe("call_screen");
  });
  it("pickDrill uses the shared ten-story catalogue by default and returns the Sarvam variables", async () => {
    const f = await setup();
    const picked = await f.runtime.pickDrill({ ...f.store.ctx, now: daytime });
    expect(picked).toMatchObject({ drill_id: HELPER_DRILLS[0].id, checkin_variables: { drill_id: HELPER_DRILLS[0].id } });
    expect(picked!.checkin_variables.drill_story).toBe(picked!.story_hi);
    const answer = await f.runtime.shieldTools.run("drill_answer", f.store.ctx, { drill_id: HELPER_DRILLS[0].id, said: "video call kaat dena" });
    expect(answer).toMatchObject({ score: 1, teach: true, teach_line_hi: HELPER_DRILLS[0].teach_line_hi });
  });
});

describe("experience drills through the runtime", () => {
  it("consent + child switch + start → job places a GENERIC responder call; turn → praise at next check-in → scamSense", async () => {
    const f = await setup();
    const ctx = f.store.ctx;
    expect(await f.runtime.startExperienceDrill(ctx)).toEqual({ ok: false, reason: "no_consent" });
    expect(await f.runtime.recordDrillConsent({ ...ctx, clipRef: "consent/maa-yes.ogg" })).toMatchObject({ ok: true });
    await expect(f.runtime.setExperienceDrills({ ...ctx, enabled: true, byUserId: "someone-else" })).rejects.toThrow("child access required");
    expect(await f.runtime.setExperienceDrills({ ...ctx, enabled: true, byUserId: f.store.userId })).toEqual({ ok: true, enabled: true });
    const started = await f.runtime.startExperienceDrill(ctx);
    expect(started).toMatchObject({ ok: true });
    if (!started.ok) throw new Error("not started");
    const [[delay, job, payload]] = vi.mocked(f.ports.scheduler.after).mock.calls as [[number, string, Record<string, unknown>]];
    expect([delay, job]).toEqual([0, EXPERIENCE_DRILL_JOB]);

    expect(await f.runtime.handleScheduledJob(job, payload)).toEqual({ job: EXPERIENCE_DRILL_JOB, outcome: "started" });
    const call = vi.mocked(f.ports.calls.startResponderCall).mock.calls[0]![0];
    expect(call).toMatchObject({ familyId: ctx.familyId, toPersonId: ctx.parentId, checkId: started.drill_id, purpose: "experience_drill" });
    const spoken = JSON.stringify(call.script).toLowerCase();
    for (const term of brandTermsFromRules()) expect(spoken.includes(` ${term} `)).toBe(false);
    expect(call.script!.opening_hi).toMatch(/\bAI\b/);

    // Run-once: the same job delivered twice does not ring Maa twice.
    vi.mocked(f.ports.scheduler.claim).mockResolvedValueOnce(false);
    expect(await f.runtime.handleScheduledJob(job, payload)).toMatchObject({ outcome: "duplicate" });
    expect(f.ports.calls.startResponderCall).toHaveBeenCalledOnce();

    expect(await f.runtime.shieldTools.run("experience_turn", ctx, { drill_id: started.drill_id, said: "Nahi ji, main phone rakh rahi hoon" }))
      .toEqual({ stop: true, line: EXPERIENCE_REFUSAL_LINE, score: 2 });
    expect(await f.runtime.takeCheckinPraise(ctx)).toEqual({ drill_praise: EXPERIENCE_PRAISE_LINE });
    expect(await f.runtime.takeCheckinPraise(ctx)).toBeNull();
    expect(await f.runtime.scamSense({ ...ctx, month: "2026-11" })).toMatchObject({ by_type: { experience: { drills: 1, score_out_of_5: 5 } } });
    // Second start within 7 days is refused.
    expect(await f.runtime.startExperienceDrill(ctx)).toEqual({ ok: false, reason: "too_soon" });
  });

  it("the job rechecks every lock at call time and respects the gate", async () => {
    const f = await setup();
    const ctx = f.store.ctx;
    await f.runtime.recordDrillConsent({ ...ctx, clipRef: "consent/maa-yes.ogg" });
    await f.runtime.setExperienceDrills({ ...ctx, enabled: true, byUserId: f.store.userId });
    const started = await f.runtime.startExperienceDrill(ctx);
    if (!started.ok) throw new Error("not started");
    const payload = { family_id: ctx.familyId, parent_id: ctx.parentId, drill_id: started.drill_id };
    await f.runtime.revokeDrillConsent(ctx);
    expect(await f.runtime.handleScheduledJob(EXPERIENCE_DRILL_JOB, payload)).toMatchObject({ outcome: "no_consent" });
    await f.runtime.recordDrillConsent({ ...ctx, clipRef: "consent/maa-yes-2.ogg" });
    await f.runtime.setExperienceDrills({ ...ctx, enabled: false, byUserId: f.store.userId });
    expect(await f.runtime.handleScheduledJob(EXPERIENCE_DRILL_JOB, payload)).toMatchObject({ outcome: "disabled" });
    await f.runtime.setExperienceDrills({ ...ctx, enabled: true, byUserId: f.store.userId });
    vi.mocked(f.ports.gate.check).mockResolvedValueOnce({ allowed: false });
    expect(await f.runtime.handleScheduledJob(EXPERIENCE_DRILL_JOB, payload)).toMatchObject({ outcome: "denied" });
    expect(await f.runtime.handleScheduledJob(EXPERIENCE_DRILL_JOB, { ...payload, extra: 1 })).toMatchObject({ outcome: "invalid_payload" });
    expect(f.ports.calls.startResponderCall).not.toHaveBeenCalled();
  });

  it("experience_turn stops a risky turn and never stores digits; without storage it still stops", async () => {
    const f = await setup();
    const ctx = f.store.ctx;
    await f.runtime.recordDrillConsent({ ...ctx, clipRef: "consent/maa-yes.ogg" });
    await f.runtime.setExperienceDrills({ ...ctx, enabled: true, byUserId: f.store.userId });
    const started = await f.runtime.startExperienceDrill(ctx);
    if (!started.ok) throw new Error("not started");
    expect(await f.runtime.shieldTools.run("experience_turn", ctx, { drill_id: started.drill_id, said: "haan code hai 4 8 2 9 1 3" }))
      .toEqual({ stop: true, line: EXPERIENCE_STOP_LINE, score: 0 });
    expect(JSON.stringify(f.drills.rows)).not.toMatch(/4 ?8 ?2 ?9/);
    expect(JSON.stringify(vi.mocked(f.ports.sign).mock.calls)).not.toMatch(/4 8 2 9/);
    delete f.store.db.experience;
    expect(await f.runtime.shieldTools.run("experience_turn", ctx, { drill_id: started.drill_id, said: "acha" }))
      .toEqual({ stop: true, line: EXPERIENCE_STOP_LINE });
  });
});

describe("call gateway through the runtime", () => {
  const SCAM = "Main police se bol raha hoon. Aapke naam par arrest warrant hai, digital arrest hoga. Video call par rahiye aur kisi ko mat bataiye.";
  it("is off by default", async () => {
    const f = await setup();
    expect(await f.runtime.screenCall({ ...f.store.ctx, from: "+919000000005", saidWho: "Police", saidWhy: SCAM })).toEqual({ enabled: false });
    expect(await f.runtime.shieldTools.run("call_screen", f.store.ctx, { from: "+919000000005", said_who: "Police", said_why: SCAM })).toEqual({ enabled: false });
  });
  it("when enabled: saved family number forwards; a scam ends the screening leg and alerts Riya's app", async () => {
    const f = await setup({ CALL_GATEWAY_ENABLED: "1" });
    const riya = await numberFingerprint("+919000000002");
    f.store.db.callgate = {
      getParent: async input => !!await f.store.db.brain.getParent(input),
      isFamilyNumber: async input => input.familyId === f.store.ctx.familyId && input.phoneHash === riya,
    };
    expect(await f.runtime.screenCall({ ...f.store.ctx, from: "9000000002", saidWho: "Riya", saidWhy: "" }))
      .toMatchObject({ enabled: true, action: "forward", reason: "saved_family" });
    const ended = await f.runtime.shieldTools.run("call_screen", f.store.ctx, { from: "+919000000005", said_who: "Police", said_why: SCAM });
    expect(ended).toMatchObject({ enabled: true, action: "end", notify_parent: true });
    await f.flush();
    expect(f.ports.push.childCard).toHaveBeenCalledWith(expect.objectContaining({ ...f.store.ctx, quiet: false }));
    expect(f.ports.whatsapp.sendShieldAlert).toHaveBeenCalledOnce();
    expect(JSON.stringify([vi.mocked(f.ports.sign).mock.calls, vi.mocked(f.ports.push.childCard).mock.calls])).not.toMatch(/9000000005/);
  });
});

describe("evidence verify through the runtime", () => {
  it("verifyEvidencePack recomputes a receipt written by buildEvidencePack", async () => {
    const f = await setup();
    const receipts: { id: string; contentsHash: string; chainHash: string }[] = [];
    f.store.db.evidence = {
      isChild: async input => input.familyId === f.store.ctx.familyId && input.viewerUserId === f.store.userId,
      getIncident: async () => ({ ...f.store.ctx, verdictId: "incident", createdAt: daytime.toISOString(), eventIds: ["event"],
        verdict: Verdict.parse({ level: "red", scam_type: "otp_theft", reasons: [], checks_fired: [], ai_used: false, confidence: 1, actions: [] }),
        events: [{ id: "event", event: ShieldEvent.parse({ family_id: f.store.ctx.familyId, parent_id: f.store.ctx.parentId,
          idempotency_key: "k-b8-runtime-evidence", channel: "keypad_voice", kind: "voice_report", occurred_at: daytime.toISOString(), masked_text: "OTP <NUM>" }) }] }),
      async savePack(input) { const id = crypto.randomUUID(); receipts.push({ id, contentsHash: input.contentsHash, chainHash: input.chainHash }); return { id }; },
      async getPack({ familyId, packId }) {
        const r = receipts.find(item => item.id === packId);
        return r && familyId === f.store.ctx.familyId ? { ...r, familyId, verdictId: "incident", createdFor: f.store.userId, createdAt: daytime.toISOString() } : null;
      },
    };
    f.ports.timeline = { entriesFor: async () => [], chainHashFor: async () => "c".repeat(64) };
    const pack = await f.runtime.buildEvidencePack({ familyId: f.store.ctx.familyId, verdictId: "incident", viewerUserId: f.store.userId });
    expect(await f.runtime.verifyEvidencePack({ familyId: f.store.ctx.familyId, packId: pack.pack_ref! })).toMatchObject({ ok: true });
  });
});
