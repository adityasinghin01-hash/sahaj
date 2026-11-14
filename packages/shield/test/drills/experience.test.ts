import { afterEach, describe, expect, it, vi } from "vitest";
import {
  brandTermsFromRules, classifyExperienceTurn, EXPERIENCE_DRILL_JOB, EXPERIENCE_PRAISE_LINE, EXPERIENCE_REFUSAL_LINE,
  EXPERIENCE_SCRIPTS, EXPERIENCE_STOP_LINE, experienceTurn, isQuietHours, maskExperienceAnswer, startExperienceDrill,
  validateExperienceScript, type ExperienceDeps,
} from "../../src/drills";
import { STOP_SCRIPTS } from "../../src/tools";
import { memoryExperienceStore } from "./experience_fakes";

const ctx = { familyId: "family", parentId: "parent" };
const DAY = 86_400_000;
/** 11:30 IST: outside quiet hours. */
const daytime = new Date("2026-11-14T06:00:00.000Z");
afterEach(() => vi.useRealTimers());

function setup(now = daytime) {
  const mem = memoryExperienceStore(ctx);
  let clock = now;
  const deps: ExperienceDeps = { db: mem.store, clock: { now: () => clock }, scheduler: { after: vi.fn(async () => undefined) } };
  return { ...mem, deps, setNow: (date: Date) => { clock = date; } };
}
async function ready(s: ReturnType<typeof setup>) {
  await s.store.recordConsent({ ...ctx, clipRef: "consent/maa-yes.ogg", givenAt: daytime });
  expect(await s.store.setEnabled({ ...ctx, enabled: true, byUserId: "child-user", at: daytime })).toBe(true);
}

describe("experience drill scripts are generic", () => {
  it("every shipped script passes the official-brand check and says it is an AI", () => {
    expect(EXPERIENCE_SCRIPTS.length).toBeGreaterThanOrEqual(3);
    for (const script of EXPERIENCE_SCRIPTS) expect(validateExperienceScript(script)).toBe(script);
  });
  it("takes its brand list from rules.json", () => {
    const terms = brandTermsFromRules();
    for (const term of ["sbi", "hdfc", "yono", "paytm.com", "uidai.gov.in", "bluedart"]) expect(terms).toContain(term);
  });
  it.each(["Main SBI se bol rahi hoon", "HDFC Bank ki taraf se", "apna YONO app kholiye", "paytm.com par jaiye", "Bank of Baroda se call hai"])(
    "rejects a script naming a real brand: %s", line => {
      expect(() => validateExperienceScript({ ...EXPERIENCE_SCRIPTS[0]!, ask_hi: line })).toThrow("names a real brand");
    });
  it("rejects a script that does not say it is an AI, or holds a number", () => {
    expect(() => validateExperienceScript({ ...EXPERIENCE_SCRIPTS[0]!, opening_hi: "Namaste ji, main bank se bol rahi hoon." })).toThrow("AI");
    expect(() => validateExperienceScript({ ...EXPERIENCE_SCRIPTS[0]!, nudge_hi: "Is number par call kijiye 9000000001" })).toThrow("number");
  });
});

describe("experience_turn decision", () => {
  it.each([
    ["4 8 2", "danger"], ["mera code hai 48", "danger"], ["char aath do", "danger"], ["एक दो तीन", "danger"],
    ["OTP aaya hai", "danger"], ["haan bata deti hoon", "danger"], ["theek hai, paise bhej deti hoon", "danger"],
    ["pay kar deti hoon", "danger"], ["PIN", "danger"],
    ["nahi, main OTP nahi bataungi", "refusal"], ["main phone rakh rahi hoon", "refusal"], ["pehle Riya se poochhungi", "refusal"],
    ["ye fraud hai", "refusal"], ["kaun bol raha hai?", "continue"], ["acha ji", "continue"], ["do minute rukiye", "continue"],
  ])("%s → %s", (said, kind) => { expect(classifyExperienceTurn(said)).toBe(kind); });

  it("masks every digit and spoken digit run before storage", () => {
    expect(maskExperienceAnswer("code 4 8 2 aur ९ ")).not.toMatch(/\p{Nd}/u);
    expect(maskExperienceAnswer("char aath do teen")).toBe("<NUM>");
    expect(maskExperienceAnswer("number 9000000001")).not.toMatch(/\p{Nd}/u);
  });
  it("quiet hours are 20:00–09:00 India time", () => {
    expect(isQuietHours(new Date("2026-11-14T15:00:00Z"))).toBe(true);  // 20:30 IST
    expect(isQuietHours(new Date("2026-11-14T03:00:00Z"))).toBe(true);  // 08:30 IST
    expect(isQuietHours(new Date("2026-11-14T03:30:00Z"))).toBe(false); // 09:00 IST
    expect(isQuietHours(daytime)).toBe(false);
  });
});

describe("startExperienceDrill locks", () => {
  it("refuses without consent, without the child's switch, or a switch set by a non-child", async () => {
    const s = setup();
    expect(await startExperienceDrill(s.deps, ctx)).toEqual({ ok: false, reason: "no_consent" });
    await s.store.recordConsent({ ...ctx, clipRef: "consent/maa-yes.ogg", givenAt: daytime });
    expect(await startExperienceDrill(s.deps, ctx)).toEqual({ ok: false, reason: "disabled" });
    expect(await s.store.setEnabled({ ...ctx, enabled: true, byUserId: "stranger", at: daytime })).toBe(false);
    expect(await startExperienceDrill(s.deps, ctx)).toEqual({ ok: false, reason: "disabled" });
    expect(await startExperienceDrill(s.deps, { ...ctx, parentId: "other" })).toEqual({ ok: false, reason: "not_found" });
    expect(s.deps.scheduler.after).not.toHaveBeenCalled();
    expect(s.rows).toHaveLength(0);
  });
  it("with consent AND switch: records the drill and schedules the job; then once per 7 days; never in quiet hours", async () => {
    const s = setup(); await ready(s);
    const first = await startExperienceDrill(s.deps, ctx);
    expect(first).toMatchObject({ ok: true, drill_id: expect.stringMatching(/^exp\.generic_[a-z]+\./) });
    expect(s.deps.scheduler.after).toHaveBeenCalledWith(0, EXPERIENCE_DRILL_JOB, { family_id: "family", parent_id: "parent", drill_id: (first as { drill_id: string }).drill_id });
    expect(s.rows).toMatchObject([{ type: "experience", score: null }]);
    s.setNow(new Date(daytime.getTime() + 7 * DAY - 60_000));
    expect(await startExperienceDrill(s.deps, ctx)).toEqual({ ok: false, reason: "too_soon" });
    s.setNow(new Date(daytime.getTime() + 7 * DAY + 9 * 3_600_000)); // 20:30 IST
    expect(await startExperienceDrill(s.deps, ctx)).toEqual({ ok: false, reason: "quiet_hours" });
    s.setNow(new Date(daytime.getTime() + 7 * DAY));
    expect(await startExperienceDrill(s.deps, ctx)).toMatchObject({ ok: true });
    expect(s.rows).toHaveLength(2);
  });
  it("a revoked consent or a switch turned off refuses again", async () => {
    const s = setup(); await ready(s);
    await s.store.revokeConsent({ ...ctx, at: daytime });
    expect(await startExperienceDrill(s.deps, ctx)).toEqual({ ok: false, reason: "no_consent" });
    await s.store.recordConsent({ ...ctx, clipRef: "consent/maa-yes-2.ogg", givenAt: daytime });
    await s.store.setEnabled({ ...ctx, enabled: false, byUserId: "child-user", at: daytime });
    expect(await startExperienceDrill(s.deps, ctx)).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("experience_turn tool", () => {
  async function started() {
    const s = setup(); await ready(s);
    const result = await startExperienceDrill(s.deps, ctx);
    if (!result.ok) throw new Error("not started");
    return { ...s, drillId: result.drill_id };
  }
  it("stops the moment Maa starts giving digits: line 9 + teach, score 0, no digit stored", async () => {
    const s = await started();
    const out = await experienceTurn.run(s.deps, ctx, { drill_id: s.drillId, said: "haan ji, code hai 4 8 2 9" });
    expect(out).toEqual({ stop: true, line: EXPERIENCE_STOP_LINE, score: 0 });
    expect(out.line!.startsWith(STOP_SCRIPTS[9])).toBe(true);
    expect(s.rows[0]).toMatchObject({ score: 0, teach_line_played: true });
    expect(s.rows[0]!.answer_masked).not.toMatch(/\p{Nd}/u);
    expect(s.lines).toHaveLength(0);
  });
  it("a refusal ends the drill with line 9 and queues praise for the next check-in", async () => {
    const s = await started();
    expect(await experienceTurn.run(s.deps, ctx, { drill_id: s.drillId, said: "Nahi, main koi code nahi bataungi" }))
      .toEqual({ stop: true, line: EXPERIENCE_REFUSAL_LINE, score: 2 });
    expect(s.rows[0]).toMatchObject({ score: 2, teach_line_played: false });
    expect(await s.store.takeCheckinLine({ ...ctx, at: daytime })).toBe(EXPERIENCE_PRAISE_LINE);
    expect(await s.store.takeCheckinLine({ ...ctx, at: daytime })).toBeNull();
    // Replay after the result is stored: still stopped, nothing rewritten.
    expect(await experienceTurn.run(s.deps, ctx, { drill_id: s.drillId, said: "OTP 123" })).toEqual({ stop: true, line: null, score: 2 });
    expect(s.rows[0]!.score).toBe(2);
  });
  it("a hang-up scores 2 and queues praise, with nothing spoken", async () => {
    const s = await started();
    expect(await experienceTurn.run(s.deps, ctx, { drill_id: s.drillId, hung_up: true })).toEqual({ stop: true, line: null, score: 2 });
    expect(s.rows[0]!.answer_masked).toBe("<hung_up>");
    expect(s.lines).toHaveLength(1);
  });
  it("an ordinary reply continues and stores nothing; an unknown drill or wrong parent stops", async () => {
    const s = await started();
    expect(await experienceTurn.run(s.deps, ctx, { drill_id: s.drillId, said: "kaun bol raha hai?" })).toEqual({ stop: false, line: null });
    expect(s.rows[0]!.score).toBeNull();
    expect(await experienceTurn.run(s.deps, ctx, { drill_id: "exp.generic_kyc.unknown", said: "acha" })).toEqual({ stop: true, line: EXPERIENCE_STOP_LINE });
    expect(await experienceTurn.run(s.deps, { ...ctx, parentId: "other" }, { drill_id: s.drillId, said: "acha" })).toEqual({ stop: true, line: EXPERIENCE_STOP_LINE });
    expect(await experienceTurn.run(s.deps, ctx, { drill_id: "", said: "acha" } as never)).toEqual({ stop: true, line: EXPERIENCE_STOP_LINE });
  });
  it("a hung store still stops a risky turn inside the 3 s budget", async () => {
    vi.useFakeTimers();
    const s = await started();
    s.deps.db = { ...s.deps.db, withParentLock: () => new Promise(() => {}) };
    const reply = experienceTurn.run(s.deps, ctx, { drill_id: s.drillId, said: "OTP bata deti hoon" });
    await vi.advanceTimersByTimeAsync(2800);
    expect(await reply).toEqual({ stop: true, line: EXPERIENCE_STOP_LINE, score: 0 });
  });
});
