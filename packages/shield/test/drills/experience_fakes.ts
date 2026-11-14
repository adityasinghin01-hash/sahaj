import type { DrillRecord, ExperienceStore } from "../../src/drills";

/** In-memory ExperienceStore with the same rules as createExperiencePg. rows are shared with the helper fixture. */
export function memoryExperienceStore(ctx: { familyId: string; parentId: string }, rows: DrillRecord[] = [],
  children: string[] = ["child-user"]) {
  const consents: { id: string; familyId: string; parentId: string; clipRef: string; givenAt: string; revokedAt: string | null }[] = [];
  const settings = new Map<string, { familyId: string; enabled: boolean; by: string; at: string }>();
  const lines: { familyId: string; parentId: string; line: string; createdAt: string; deliveredAt: string | null }[] = [];
  let lock = Promise.resolve();
  const isParent = (input: { familyId: string; parentId: string }) => input.familyId === ctx.familyId && input.parentId === ctx.parentId;
  const store: ExperienceStore = {
    async withParentLock(_ctx, work) {
      const previous = lock; let release!: () => void;
      lock = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try { return await work(store); } finally { release(); }
    },
    async getParent(input) { return isParent(input); },
    async recordConsent(input) {
      if (!isParent(input)) return null;
      for (const row of consents) if (row.parentId === input.parentId && !row.revokedAt) row.revokedAt = input.givenAt.toISOString();
      const id = crypto.randomUUID();
      consents.push({ id, familyId: input.familyId, parentId: input.parentId, clipRef: input.clipRef, givenAt: input.givenAt.toISOString(), revokedAt: null });
      return { id };
    },
    async revokeConsent(input) {
      let n = 0;
      for (const row of consents) if (row.familyId === input.familyId && row.parentId === input.parentId && !row.revokedAt) { row.revokedAt = input.at.toISOString(); n++; }
      return n;
    },
    async hasConsent(input) { return consents.some(row => row.familyId === input.familyId && row.parentId === input.parentId && !row.revokedAt); },
    async setEnabled(input) {
      if (!isParent(input) || !children.includes(input.byUserId)) return false;
      settings.set(input.parentId, { familyId: input.familyId, enabled: input.enabled, by: input.byUserId, at: input.at.toISOString() });
      return true;
    },
    async isEnabled(input) { const row = settings.get(input.parentId); return row?.familyId === input.familyId && row.enabled === true; },
    async lastExperienceAt(input) {
      const asked = rows.filter(row => row.type === "experience" && row.family_id === input.familyId && row.parent_id === input.parentId)
        .map(row => row.asked_at).sort();
      return asked.at(-1) ?? null;
    },
    async insertExperience(input) {
      rows.push({ family_id: input.familyId, parent_id: input.parentId, drill_id: input.drillId, type: "experience",
        asked_at: input.askedAt.toISOString(), answer_masked: null, score: null, teach_line_played: false });
    },
    async getExperience(input) {
      return rows.find(row => row.type === "experience" && row.drill_id === input.drillId && row.family_id === input.familyId && row.parent_id === input.parentId) ?? null;
    },
    async saveExperienceResult(input) {
      const row = rows.find(r => r.type === "experience" && r.drill_id === input.drillId && r.family_id === input.familyId && r.parent_id === input.parentId);
      if (!row || row.score !== null) return false;
      Object.assign(row, { score: input.score, answer_masked: input.answerMasked, teach_line_played: input.score < 2 });
      return true;
    },
    async queueCheckinLine(input) { lines.push({ familyId: input.familyId, parentId: input.parentId, line: input.line, createdAt: input.at.toISOString(), deliveredAt: null }); },
    async takeCheckinLine(input) {
      const row = lines.find(item => item.familyId === input.familyId && item.parentId === input.parentId && !item.deliveredAt);
      if (!row) return null;
      row.deliveredAt = input.at.toISOString(); return row.line;
    },
  };
  return { store, rows, consents, settings, lines };
}
