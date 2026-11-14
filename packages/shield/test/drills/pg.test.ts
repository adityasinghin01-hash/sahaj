import { seedMembership } from "../foundation";
/** Run with test/drills/run-postgres.sh; legacy C-03 runner applies only its own two migrations. */
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDrillPg, drillAnswer, pickDrill, scamSense } from "../../src/drills";
import { buildEvidencePack, createEvidencePg, decodeChainHash } from "../../src/evidence";
import { createShieldRuntimePg } from "../../src/runtime";
import { fixture, stories, now } from "./helpers";

const enabled = !!process.env.DATABASE_URL && process.env.SHIELD_DRILLS_DB_TEST_REQUIRED === "1";
if (process.env.SHIELD_DRILLS_DB_TEST_REQUIRED && !process.env.DATABASE_URL) throw new Error("C-04 Postgres tests require DATABASE_URL");
const families: string[] = [];
let sql: Sql;
describe.skipIf(!enabled)("C-04 real Postgres storage and RLS", () => {
  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL!, { max: 8, prepare: false, max_pipeline: 1, onnotice: () => {} });
    const [row] = await sql`select to_regclass('public.drills') as drills, to_regclass('public.evidence_packs') as packs`;
    if (!row?.drills || !row?.packs) throw new Error("Apply migration 20261114160400 before C-04 tests");
  });
  afterAll(async () => {
    if (sql) {
      for (const family of families) {
        await sql`delete from public.family_memberships where family_id = ${family}`;
        await sql`delete from public.shield_verdicts where family_id = ${family}`;
        await sql`delete from public.shield_events where family_id = ${family}`;
        await sql`delete from public.people where family_id = ${family}`;
        await sql`delete from public.families where id = ${family}`;
      }
      await sql.end({ timeout: 5 });
    }
  });
  async function seed() {
    const familyId = crypto.randomUUID(), parentId = crypto.randomUUID(), viewerUserId = crypto.randomUUID();
    families.push(familyId);
    await sql`insert into public.families (id,name) values (${familyId}, 'Synthetic family')`;
    await sql`insert into public.people(id, family_id, role, display_name) values (${parentId}, ${familyId}, 'parent', 'Maa')`;
    await seedMembership(sql, familyId, viewerUserId, "child");
    return { familyId, parentId, viewerUserId };
  }
  it("serializes concurrent workers, stores only masked first answers, maps timestamps and scales monthly results", async () => {
    const ctx = await seed();
    const db = createShieldRuntimePg(sql);
    const deps = { ...fixture(ctx).deps, db: db.drills!, stories };
    const issued = await Promise.all(Array.from({ length: 8 }, (_, index) => pickDrill(deps, { ...ctx,
      familyId: index % 2 ? ctx.familyId.toUpperCase() : ctx.familyId,
      parentId: index % 2 ? ctx.parentId.toUpperCase() : ctx.parentId, now })));
    expect(issued.filter(Boolean)).toHaveLength(1);
    expect(await drillAnswer.run(deps, ctx, { drill_id: "power", said: "Riya ko batana OTP १२३४५६ phone 90000 00001" })).toMatchObject({ score: 1 });
    expect(await drillAnswer.run(deps, ctx, { drill_id: "power", said: "paise bhejna" })).toMatchObject({ score: 1 });
    const rows = await sql`select * from public.drills where family_id = ${ctx.familyId}`;
    expect(rows).toHaveLength(1); expect(rows[0]!.answer_masked).not.toMatch(/123456|१२३४५६|90000|00001/);
    expect(rows[0]!.teach_line_played).toBe(true);
    expect(await scamSense(deps, { ...ctx, month: "2026-11" })).toMatchObject({ score_out_of_5: 2.5, trend: "flat", drills_this_month: 1 });
    expect(await pickDrill(deps, { ...ctx, now: new Date(now.getTime() + 7 * 86400000) })).toMatchObject({ drill_id: "otp" });
    // K-B8: the catalogue rotates (least recently asked story) instead of running dry.
    expect(await pickDrill(deps, { ...ctx, now: new Date(now.getTime() + 14 * 86400000) })).toMatchObject({ drill_id: "power" });
  });
  it("enforces family/parent scope, score and masked-answer constraints", async () => {
    const a = await seed(), b = await seed();
    await expect(sql`insert into public.drills(family_id,parent_id,drill_id,type,asked_at) values (${b.familyId},${a.parentId},'bad','helper',${now})`).rejects.toThrow();
    await expect(sql`insert into public.drills(family_id,parent_id,drill_id,type,asked_at,score,answer_masked) values (${a.familyId},${a.parentId},'bad','helper',${now},3,'masked')`).rejects.toThrow();
    await expect(sql`insert into public.drills(family_id,parent_id,drill_id,type,asked_at,score,answer_masked) values (${a.familyId},${a.parentId},'bad','helper',${now},1,'OTP 123456')`).rejects.toThrow();
    const child = crypto.randomUUID();
    await sql`insert into public.people(id,family_id,role,display_name) values (${child},${a.familyId},'child','Riya')`;
    expect(await createDrillPg(sql).getParent({ familyId: a.familyId, parentId: child })).toBe(false);
  });
  it("maps multi-event incidents, stores stable hashes and restricts receipt reads to children", async () => {
    const ctx = await seed(); const a = crypto.randomUUID(), b = crypto.randomUUID(), verdictId = crypto.randomUUID();
    for (const id of [a, b]) await sql`insert into public.shield_events(id,family_id,parent_id,idempotency_key,channel,kind,occurred_at,masked_text,context)
      values (${id},${ctx.familyId},${ctx.parentId},${id},'device','sms',${now},'OTP <NUM>',${sql.json({ money_sent: true })})`;
    await sql`insert into public.shield_verdicts(id,family_id,parent_id,event_ids,level,scam_type,reasons,confidence,actions)
      values (${verdictId},${ctx.familyId},${ctx.parentId},${[b,a]}::uuid[],'red','otp_theft',${sql.json([{ rule_id: 'P1', en: 'OTP during call', hi: 'Call par OTP' }])},1,${['offer_1930']}::text[])`;
    const deps = { db: createEvidencePg(sql), clock: { now: () => now }, timeline: { entriesFor: async () => [{ at: now.toISOString(), step: "alert_child", status: "ok" as const }], chainHashFor: async () => "1234abcd".repeat(8) } };
    const pack = await buildEvidencePack(deps, { ...ctx, verdictId });
    expect(decodeChainHash(pack.chain_hash)).toBe("1234abcd".repeat(8));
    expect(pack.summary_en.match(/SMS/g)).toHaveLength(2);
    expect(pack.summary_en).toContain("Money sent? yes");
    const input = { ...ctx, verdictId };
    await buildEvidencePack(deps, input);
    const receipts = await sql`select * from public.evidence_packs where family_id = ${ctx.familyId}`;
    expect(receipts).toHaveLength(2); expect(receipts[0]!.contents_hash).toBe(receipts[1]!.contents_hash);
    expect(receipts[0]!.chain_hash).toBe("1234abcd".repeat(8));
    const parentUser = crypto.randomUUID();
    await seedMembership(sql, ctx.familyId, parentUser, "parent");
    await pickDrill({ ...fixture(ctx).deps, db: createDrillPg(sql) }, { ...ctx, now });
    async function asUser(user: string) {
      return sql.begin(async tx => {
        await tx`set local role authenticated`;
        await tx`select set_config('request.jwt.claim.sub',${user},true)`;
        return { packs: await tx`select * from public.evidence_packs where family_id = ${ctx.familyId}`,
          drills: await tx`select * from public.drills where family_id = ${ctx.familyId}` };
      });
    }
    expect((await asUser(ctx.viewerUserId)).packs).toHaveLength(2);
    expect((await asUser(ctx.viewerUserId)).drills).toHaveLength(1);
    expect((await asUser(parentUser)).drills).toHaveLength(1);
    expect((await asUser(crypto.randomUUID())).drills).toHaveLength(0);
    expect((await asUser(parentUser)).packs).toHaveLength(0);
    expect((await asUser(crypto.randomUUID())).packs).toHaveLength(0);
    await expect(buildEvidencePack(deps, { ...input, viewerUserId: parentUser })).rejects.toThrow("Evidence child access required");
    await expect(sql.begin(async tx => { await tx`set local role authenticated`; return tx`delete from public.evidence_packs`; })).rejects.toThrow();
    await expect(sql.begin(async tx => { await tx`set local role anon`; return tx`select * from public.evidence_packs`; })).rejects.toThrow();
    await expect(sql.begin(async tx => { await tx`set local role authenticated`; return tx`delete from public.drills`; })).rejects.toThrow();
    // Direct service writes still cannot manufacture a cross-family receipt.
    const other = await seed();
    await expect(sql`insert into public.evidence_packs(family_id,verdict_id,created_for,contents_hash,chain_hash,created_at)
      values (${other.familyId},${verdictId},${other.viewerUserId},${"a".repeat(64)},${"b".repeat(64)},${now})`).rejects.toThrow();
    await expect(deps.db.savePack({ ...other, verdictId, contentsHash: "a".repeat(64), chainHash: "b".repeat(64), createdAt: now })).rejects.toThrow();
  });
});
