import { afterEach, describe, expect, it, vi } from "vitest";
import { drillAnswer, pickDrill, scamSense, type DrillDeps } from "../../src/drills";

import { maskPrivate } from "../../src/drills/privacy";
import { fixture, stories, now } from "./helpers";
const ctx = { familyId: "family", parentId: "parent" };
const ask = (deps: DrillDeps, date = now) => pickDrill(deps, { ...ctx, now: date });
afterEach(() => vi.useRealTimers());

describe("helper drills", () => {
  it.each(["123456", "१२३४५६", "١٢٣٤٥٦", "1     2 - 3 - 4", "1\u200b2\u200b3\u200b4"])("masks contiguous and split Unicode secrets (%s)", secret => {
    expect(maskPrivate(`OTP ${secret}`)).toBe("OTP <NUM>");
  });
  it("atomically limits a parent to once per rolling week, including unanswered drills", async () => {
    const { deps, rows } = fixture();
    expect((await Promise.all([ask(deps), ask(deps)])).filter(Boolean)).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(await ask(deps, new Date(now.getTime() + 7 * 86400000 - 1))).toBeNull();
    expect(await ask(deps, new Date(now.getTime() + 7 * 86400000))).toMatchObject({ drill_id: "otp" });
  });
  it("excludes all ten recent stories and returns null when the pool is exhausted", async () => {
    const { deps, rows } = fixture();
    await ask(deps); await ask(deps, new Date(now.getTime() + 7 * 86400000));
    expect(await ask(deps, new Date(now.getTime() + 14 * 86400000))).toBeNull();
    for (let i = 0; i < 10; i++) rows.push({ ...rows[0]!, drill_id: `other-${i}`, asked_at: new Date(now.getTime() + (i + 3) * 7 * 86400000).toISOString() });
    expect(await ask(deps, new Date(now.getTime() + 14 * 7 * 86400000))).toMatchObject({ drill_id: "power" });
  });
  it("validates a low-effort rubric and only passes/stores masked speech", async () => {
    const { deps, rows } = fixture(); await ask(deps);
    vi.mocked(deps.router.understand).mockResolvedValue({ ok: true, data: { score: 2, matched_good: ["Riya ko batana"], matched_risky: [], reason_en: "Safe" }, model: "claude" });
    expect(await drillAnswer.run(deps, ctx, { drill_id: "power", said: "Riya ko batana OTP १२३४५६ number 98765 43210" })).toEqual({ score: 2, teach_line_hi: stories[0]!.teach_line_hi });
    const request = vi.mocked(deps.router.understand).mock.calls[0]![0];
    expect(request.effort).toBe("low");
    expect(request.schema.safeParse({ score: 3, matched_good: [], matched_risky: [], reason_en: "bad" }).success).toBe(false);
    expect(JSON.stringify(request)).not.toMatch(/123456|१२३४५६|98765|43210/);
    expect(rows[0]).toMatchObject({ score: 2, teach_line_played: true });
    expect(rows[0]!.answer_masked).not.toMatch(/\p{Nd}{4,}/u);
  });
  it("uses keyword fallback on router failure, thrown errors or invalid rubrics", async () => {
    for (const mode of ["failed", "thrown", "invalid"]) {
      const { deps, rows } = fixture(); await ask(deps);
      if (mode === "thrown") vi.mocked(deps.router.understand).mockRejectedValue(new Error("provider"));
      if (mode === "invalid") vi.mocked(deps.router.understand).mockResolvedValue({ ok: true, data: { score: 12 }, model: "claude" });
      expect(await drillAnswer.run(deps, ctx, { drill_id: "power", said: "phone rakh dena aur Riya ko batana" })).toMatchObject({ score: 2 });
      expect(rows[0]!.score).toBe(2);
    }
  });
  it.each([["Riya ko batana", 1], ["paise bhejna aur Riya ko batana", 0], ["pata nahi", 0], ["Riya ko batana nahi", 0], ["not paise bhejna, Riya ko batana", 1], ["paise bhejna nahi, Riya ko batana", 1]])("scores fallback %s as %i", async (said, score) => {
    const { deps } = fixture(); await ask(deps);
    expect(await drillAnswer.run(deps, ctx, { drill_id: "power", said })).toMatchObject({ score });
  });
  it("bounds router and storage hangs below three seconds; late router results cannot overwrite fallback", async () => {
    vi.useFakeTimers(); const { deps, rows } = fixture(); await ask(deps);
    let resolve!: (value: Awaited<ReturnType<DrillDeps["router"]["understand"]>>) => void;
    vi.mocked(deps.router.understand).mockImplementation(() => new Promise(r => { resolve = r; }) as ReturnType<DrillDeps["router"]["understand"]>);
    const reply = drillAnswer.run(deps, ctx, { drill_id: "power", said: "Riya ko batana" });
    await vi.advanceTimersByTimeAsync(2400);
    expect(await reply).toMatchObject({ score: 1 });
    resolve({ ok: true, data: { score: 2 }, model: "claude" }); await vi.advanceTimersByTimeAsync(10);
    expect(rows[0]!.score).toBe(1);
    deps.db.getAsked = () => new Promise(() => {});
    const hung = drillAnswer.run(deps, ctx, { drill_id: "power", said: "answer" });
    await vi.advanceTimersByTimeAsync(2800);
    expect(await hung).toMatchObject({ score: 0, teach_line_hi: expect.any(String) });
  });
  it("rejects wrong parents, unsolicited/invalid answers; replays return the first stored score", async () => {
    const { deps, rows } = fixture();
    expect(await pickDrill(deps, { ...ctx, familyId: "other", now })).toBeNull();
    await drillAnswer.run(deps, ctx, { drill_id: "power", said: "unasked" }); expect(rows).toHaveLength(0);
    await ask(deps);
    await drillAnswer.run(deps, { ...ctx, familyId: "other" }, { drill_id: "power", said: "Riya ko batana" });
    expect(rows[0]!.score).toBeNull();
    await drillAnswer.run(deps, ctx, { drill_id: "power", said: "Riya ko batana" });
    expect(await drillAnswer.run(deps, ctx, { drill_id: "power", said: "paise bhejna" })).toMatchObject({ score: 1 });
    expect(deps.router.understand).toHaveBeenCalledOnce();
    expect(await drillAnswer.run(deps, ctx, { drill_id: "power", said: "" })).toMatchObject({ score: 0 });
  });
  it.each([["1930", 1], ["९९९९", 0]])("matches a public-helpline keyword locally without equating masked numeric answers (%s)", async (said, score) => {
    const { deps, rows } = fixture();
    deps.stories = [{ ...stories[0]!, good_answers: ["1930"] }, stories[1]!];
    await ask(deps);
    expect(await drillAnswer.run(deps, ctx, { drill_id: "power", said })).toMatchObject({ score });
    expect(rows[0]!.answer_masked).not.toMatch(/\p{Nd}{4,}/u);
    expect(JSON.stringify(vi.mocked(deps.router.understand).mock.calls)).not.toMatch(/1930|९९९९/);
  });
  it("returns a fallback under three seconds with a real stalled store", async () => {
    const { deps } = fixture();
    deps.db.withParentLock = () => new Promise(() => {});
    const started = performance.now();
    expect(await drillAnswer.run(deps, ctx, { drill_id: "power", said: "Riya ko batana" })).toMatchObject({ score: 0 });
    expect(performance.now() - started).toBeLessThan(3000);
  });
  it("stores only the first concurrent answer, and does not save a late storage read after timeout", async () => {
    const { deps, rows } = fixture(); await ask(deps);
    expect(await Promise.all([
      drillAnswer.run(deps, ctx, { drill_id: "power", said: "Riya ko batana" }),
      drillAnswer.run(deps, ctx, { drill_id: "power", said: "paise bhejna" }),
    ])).toEqual([{ score: 1, teach_line_hi: stories[0]!.teach_line_hi }, { score: 1, teach_line_hi: stories[0]!.teach_line_hi }]);
    expect(deps.router.understand).toHaveBeenCalledOnce();
    expect(rows[0]!.answer_masked).toBe("Riya ko batana");
    vi.useFakeTimers(); rows[0]!.score = null;
    const record = rows[0]!;
    let release!: (row: typeof record) => void;
    deps.db.getAsked = () => new Promise(resolve => { release = resolve; });
    const answer = drillAnswer.run(deps, ctx, { drill_id: "power", said: "Riya ko batana" });
    await vi.advanceTimersByTimeAsync(2800);
    expect(await answer).toMatchObject({ score: 0 });
    release(record); await vi.advanceTimersByTimeAsync(1);
    expect(rows[0]!.score).toBeNull();
  });
  it("computes nontrivial averages across month boundaries and excludes unanswered drills", async () => {
    const { deps, rows } = fixture(); await ask(deps);
    const base = rows[0]!;
    rows.splice(0, rows.length,
      { ...base, score: 2, asked_at: "2026-12-31T23:59:59.999Z" },
      { ...base, score: 0, asked_at: "2027-01-01T00:00:00.000Z" },
      { ...base, score: 1, asked_at: "2027-01-07T00:00:00.000Z" },
      { ...base, score: 1, asked_at: "2027-01-14T00:00:00.000Z" },
      { ...base, score: null, asked_at: "2027-01-21T00:00:00.000Z" },
      { ...base, score: 2, asked_at: "2027-02-01T00:00:00.000Z" });
    expect(await scamSense(deps, { ...ctx, month: "2027-01" })).toEqual({ score_out_of_5: 1.7, trend: "down", drills_this_month: 3 });
    expect(await scamSense(deps, { ...ctx, month: "2027-03" })).toEqual({ score_out_of_5: 0, trend: "flat", drills_this_month: 0 });
  });
  it("scales the answered monthly average to five; compares unrounded previous month averages", async () => {
    const { deps, rows } = fixture(); await ask(deps);
    rows.push({ ...rows[0]!, asked_at: "2026-10-15T00:00:00Z", score: 1 });
    rows[0]!.score = 2;
    expect(await scamSense(deps, { ...ctx, month: "2026-11" })).toEqual({ score_out_of_5: 5, trend: "up", drills_this_month: 1 });
    rows[0]!.score = 1;
    expect(await scamSense(deps, { ...ctx, month: "2026-11" })).toMatchObject({ score_out_of_5: 2.5, trend: "flat" });
    rows[0]!.score = 0;
    expect(await scamSense(deps, { ...ctx, month: "2026-11" })).toMatchObject({ score_out_of_5: 0, trend: "down" });
    rows[0]!.score = null;
    expect(await scamSense(deps, { ...ctx, month: "2026-11" })).toEqual({ score_out_of_5: 0, trend: "flat", drills_this_month: 0 });
    await expect(scamSense(deps, { ...ctx, month: "2026-13" })).rejects.toThrow();
    await expect(scamSense(deps, { ...ctx, familyId: "other", month: "2026-11" })).rejects.toThrow();
  });
});
