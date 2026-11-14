/** K-B8 Part F against real Postgres: receipt id, getPack and verifyEvidencePack on evidence_packs. */
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidencePack, createEvidencePg, verifyEvidencePack, type EvidenceDeps } from "../../src/evidence";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const DATABASE_URL = env.DATABASE_URL;
if (!DATABASE_URL && env.SHIELD_DB_TEST_REQUIRED) throw new Error("SHIELD_DB_TEST_REQUIRED is set but DATABASE_URL is not");

describe.skipIf(!DATABASE_URL)("evidence receipts against Postgres", () => {
  let sql: Sql;
  const families: string[] = [];
  beforeAll(async () => { sql = postgres(DATABASE_URL!, { max: 2, prepare: false, max_pipeline: 1, onnotice: () => undefined }); });
  afterAll(async () => {
    if (!sql) return;
    for (const family of families) {
      await sql`delete from public.evidence_packs where family_id = ${family}`;
      await sql`delete from public.shield_verdicts where family_id = ${family}`;
      await sql`delete from public.shield_events where family_id = ${family}`;
      await sql`delete from public.family_members where family_id = ${family}`;
      await sql`delete from public.people where family_id = ${family}`;
      await sql`delete from public.families where id = ${family}`;
    }
    await sql.end({ timeout: 5 });
  });

  it("buildEvidencePack returns a pack_ref; verifyEvidencePack recomputes it; tampering is detected", async () => {
    const familyId = crypto.randomUUID(), parentId = crypto.randomUUID(), child = crypto.randomUUID();
    families.push(familyId);
    await sql`insert into public.families (id) values (${familyId})`;
    await sql`insert into public.people (id, family_id, name, role) values (${parentId}, ${familyId}, 'Maa', 'parent')`;
    await sql`insert into public.family_members (family_id, user_id, role) values (${familyId}, ${child}, 'child')`;
    const [event] = await sql<{ id: string }[]>`insert into public.shield_events (idempotency_key, family_id, parent_id, channel, kind, occurred_at, masked_text, context)
      values (${`k-b8-evidence-${familyId}`}, ${familyId}, ${parentId}, 'gateway_sms', 'sms', '2026-11-14T09:58:00Z', 'KYC band, OTP <NUM> bataiye', ${sql.json({ asks_for: "otp" })})
      returning id`;
    const [verdict] = await sql<{ id: string }[]>`insert into public.shield_verdicts (family_id, parent_id, event_ids, level, scam_type, reasons, checks_fired, ai_used, models_agreed, confidence, actions)
      values (${familyId}, ${parentId}, ${[event!.id]}::uuid[], 'red', 'kyc_block', ${sql.json([{ rule_id: "otp", hi: "OTP maanga", en: "Asked for OTP" }])},
        '{P1}'::text[], false, '{}'::text[], 1, '{alert_child}'::text[]) returning id`;
    const deps: EvidenceDeps = { db: createEvidencePg(sql), clock: { now: () => new Date("2026-11-14T10:05:00Z") },
      timeline: { entriesFor: async () => [], chainHashFor: async () => "ab".repeat(32) } };
    const pack = await buildEvidencePack(deps, { familyId, verdictId: verdict!.id, viewerUserId: child });
    expect(pack.pack_ref).toMatch(/^ref-ap:[a-p]{32}$/);
    expect(pack.asked_for).toEqual(["otp"]);
    expect(await verifyEvidencePack(deps, { familyId, packId: pack.pack_ref! })).toMatchObject({ ok: true, verdict_id: verdict!.id });
    await expect(verifyEvidencePack(deps, { familyId: crypto.randomUUID(), packId: pack.pack_ref! })).rejects.toThrow("Evidence pack not found");
    await sql`update public.shield_verdicts set reasons = ${sql.json([{ rule_id: "otp", hi: "badla", en: "Changed" }])} where id = ${verdict!.id}`;
    expect(await verifyEvidencePack(deps, { familyId, packId: pack.pack_ref! })).toMatchObject({ ok: false, contents_match: false, chain_match: true });
  });
});
