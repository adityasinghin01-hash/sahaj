import postgres from "postgres";
import type { ShieldEvent } from "@sahaj/shared";
import type { StoredVerdict } from "../../src/brain/types.js";
import type { FamilyCheckStateValue, CreateFamilyCheckInput } from "../../src/tools/types";
import type { ShieldRuntimeDb } from "../../src/runtime/types";
import { createShieldRuntimePg } from "../../src/runtime/pg";
import { normalizePersonName } from "../../src/db/pg";
import { makeServerDeps } from "../server/fakes";

export async function storage() {
  const familyId = crypto.randomUUID(), parentId = crypto.randomUUID(), personId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const ctx = { familyId, parentId };
  if (process.env.DATABASE_URL) {
    const sql = postgres(process.env.DATABASE_URL, { max: 5, prepare: false, max_pipeline: 1, onnotice: () => undefined });
    await sql`insert into public.families (id,name) values (${familyId}, 'Synthetic family')`;
    await sql`insert into public.people (id, family_id, display_name, role)
      values (${parentId}, ${familyId}, 'Maa', 'parent'), (${personId}, ${familyId}, 'Aman', 'child')`;
    const db = createShieldRuntimePg(sql);
    return { ctx, userId, db, sql,
      async answer(checkId: string, state: FamilyCheckStateValue) {
        await sql`update public.family_checks set state = ${state}, answered_at = now() where id = ${checkId} and family_id = ${familyId}`;
      },
      async feedback(verdictId: string) {
        await sql`update public.shield_verdicts set feedback_at = now() where id = ${verdictId} and family_id = ${familyId}`;
      },
      async setCodeWord(hash: string) { await sql`insert into public.shield_family_security(family_id,code_word_hash) values (${familyId},${hash}) on conflict(family_id) do update set code_word_hash=excluded.code_word_hash`; },
      async verdicts() {
        const rows = await sql<{ id: string }[]>`select id from public.shield_verdicts where family_id = ${familyId} order by created_at, id`;
        return Promise.all(rows.map(async row => (await db.brain.getVerdict(row.id))!));
      },
      async close() {
        // Only this fixture's rows; tolerate production core people FKs without cascades.
        await sql`delete from public.shield_verdicts where family_id = ${familyId}`;
        await sql`delete from public.family_checks where family_id = ${familyId}`;
        await sql`delete from public.shield_events where family_id = ${familyId}`;
        await sql`delete from public.shield_devices where family_id = ${familyId}`;
        await sql`delete from public.shield_pairing_codes where family_id = ${familyId}`;
        await sql`delete from public.shield_pairing_failures where family_id = ${familyId}`;
        await sql`delete from public.shield_pairing_locks where family_id = ${familyId}`;
        await sql`delete from public.people where family_id = ${familyId}`;
        await sql`delete from public.families where id = ${familyId}`;
        await sql.end({ timeout: 5 });
      } };
  }
  const server = makeServerDeps({ people: { [parentId]: { id: parentId, family_id: familyId } } });
  const checks = new Map<string, Omit<CreateFamilyCheckInput, "state"> & { state: FamilyCheckStateValue }>();
  const records = new Map<string, StoredVerdict>();
  const reactions = new Set<string>();
  const locks = new Map<string, Promise<unknown>>();
  let codeWordHash: string | null = null;
  const event = (id: string): ShieldEvent | null => {
    const row = [...server.events.values()].find(row => row.id === id);
    if (!row) return null;
    return { idempotency_key: row.idempotency_key, family_id: row.family_id, parent_id: row.parent_id,
      device_id: row.device_id || undefined, channel: row.channel as ShieldEvent["channel"],
      kind: row.kind as ShieldEvent["kind"], occurred_at: row.occurred_at,
      masked_text: row.masked_text ?? undefined, sender_type: row.sender_type as ShieldEvent["sender_type"] ?? undefined,
      caller_type: row.caller_type as ShieldEvent["caller_type"] ?? undefined, local_level: row.local_level as ShieldEvent["local_level"] ?? undefined,
      link_domains: row.link_domains, matched_rules: row.matched_rules, context: row.context };
  };
  const db: ShieldRuntimeDb = {
    server: server.db,
    tools: {
      async createFamilyCheck(input) { const id = crypto.randomUUID(); checks.set(id, { ...input }); return { id }; },
      async getFamilyCheck(id) {
        const row = checks.get(id);
        return row ? { familyId: row.familyId, claimedName: row.claimedName, toPersonId: row.toPersonId, state: row.state } : null;
      },
      async findPersonByName(family, name) {
        return family === familyId && normalizePersonName(name) === "aman" ? { id: personId, name: "Aman" } : null;
      },
      async getCodeWordHash(family) { return family === familyId ? codeWordHash : null; },
      async markFamilyCheckNoAnswer(id) {
        const row = checks.get(id);
        if (!row || row.state !== "asked") return false;
        row.state = "no_answer"; return true;
      },
    },
    getEvent: async id => event(id),
    async insertVoiceEvent(input) {
      const result = await server.db.insertEvent({ ...input, device_id: "", masked_text: input.masked_text ?? null,
        sender_type: input.sender_type ?? null, caller_type: input.caller_type ?? null, local_level: input.local_level ?? null });
      if (!result.id) throw new Error("Duplicate voice fixture event");
      return { id: result.id };
    },
    getVerdictForEvent: async id => [...records.values()].find(row => row.event.idempotency_key === event(id)?.idempotency_key) ?? null,
    brain: {
      async getParent(input) { return input.familyId === familyId && input.parentId === parentId ? { id: parentId, family_id: familyId } : null; },
      async getRecentEvents(input) {
        return [...server.events.values()].map(row => event(row.id)!).filter(row =>
          row.family_id === input.familyId && row.parent_id === input.parentId && row.occurred_at >= input.since && row.occurred_at <= input.until);
      },
      async insertVerdict(input) { const id = crypto.randomUUID(); records.set(id, structuredClone({ ...input, id })); return { id }; },
      async getVerdict(id) { return records.get(id) ?? null; },
      async hasChildReaction({ verdictId }) { return reactions.has(verdictId); },
    },
    async withEventLock(id, work) {
      const previous = locks.get(id) ?? Promise.resolve();
      const running = previous.catch(() => undefined).then(() => work(db));
      locks.set(id, running);
      try { return await running; } finally { if (locks.get(id) === running) locks.delete(id); }
    },
  };
  return { ctx, userId, db, sql: undefined,
    async answer(id: string, state: FamilyCheckStateValue) { checks.get(id)!.state = state; },
    async feedback(id: string) { reactions.add(id); },
    async setCodeWord(hash: string) { codeWordHash = hash; },
    async verdicts() { return [...records.values()]; },
    async close() {},
  };
}
