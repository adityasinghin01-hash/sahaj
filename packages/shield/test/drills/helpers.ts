import { vi } from "vitest";
import type { DrillDeps, DrillRecord, DrillStory } from "../../src/drills";
export const stories: DrillStory[] = [
  { id: "power", scam_type: "electricity_cut", story_hi: "Bijli kaatne ki dhamki par kya karengi?", good_answers: ["phone rakh dena", "Riya ko batana"], risky_answers: ["paise bhejna", "link kholna"], teach_line_hi: "Bilkul sahi, aur ek baat: Riya se jaanch karaiye." },
  { id: "otp", scam_type: "otp_theft", story_hi: "Bank ka code maange to kya karengi?", good_answers: ["code nahi batana", "Riya ko batana"], risky_answers: ["code batana"], teach_line_hi: "Code kisi ko mat bataiye." },
];
export const now = new Date("2026-11-14T10:00:00Z");
export function fixture(context = { familyId: "family", parentId: "parent" }) {
  const ctx = context;
  const rows: DrillRecord[] = [];
  let lock = Promise.resolve();
  const deps: DrillDeps = {
    stories, clock: { now: () => now },
    router: { understand: vi.fn(async () => ({ ok: false as const, reason: "all_failed" })) },
    db: {
      async withParentLock(_ctx, work) {
        const previous = lock; let release!: () => void;
        lock = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try { return await work(deps.db); } finally { release(); }
      },
      async getParent(input) { return input.familyId === ctx.familyId && input.parentId === ctx.parentId; },
      async recent() { return rows.filter(row => row.type === "helper").sort((a, b) => b.asked_at.localeCompare(a.asked_at)).slice(0, 10); },
      async insert(row) { rows.push(row); },
      async getAsked(input) { return rows.find(row => row.type === "helper" && row.drill_id === input.drillId && row.family_id === input.familyId && row.parent_id === input.parentId) ?? null; },
      async saveAnswer(input) { const row = rows.find(r => r.drill_id === input.drillId)!; if (row.score === null) Object.assign(row, { score: input.score, answer_masked: input.answerMasked, teach_line_played: input.teachLinePlayed ?? true }); },
      async between(input) { return rows.filter(row => row.asked_at >= input.since && row.asked_at < input.until); },
    },
  };
  return { deps, rows };
}
