/** K-B8 Part E against real Postgres: saved-family fingerprint match on people.phone. */
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCallGatePg, numberFingerprint } from "../../src";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const DATABASE_URL = env.DATABASE_URL;
if (!DATABASE_URL && env.SHIELD_DB_TEST_REQUIRED) throw new Error("SHIELD_DB_TEST_REQUIRED is set but DATABASE_URL is not");

describe.skipIf(!DATABASE_URL)("call gateway lookups against Postgres", () => {
  let sql: Sql;
  let hasPhone = false;
  const families: string[] = [];
  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { max: 2, prepare: false, max_pipeline: 1, onnotice: () => undefined });
    const [row] = await sql`select count(*)::int as n from information_schema.columns
      where table_schema = 'public' and table_name = 'people' and column_name = 'phone'`;
    hasPhone = row!.n === 1;
  });
  afterAll(async () => {
    if (!sql) return;
    for (const family of families) {
      await sql`delete from public.people where family_id = ${family}`;
      await sql`delete from public.families where id = ${family}`;
    }
    await sql.end({ timeout: 5 });
  });

  it("matches a saved family number by fingerprint, in any format, and never across families", async ctx => {
    if (!hasPhone) return ctx.skip(); // core people.phone column absent in this database
    const familyA = crypto.randomUUID(), familyB = crypto.randomUUID(), maa = crypto.randomUUID();
    families.push(familyA, familyB);
    await sql`insert into public.families (id) values (${familyA}), (${familyB})`;
    await sql`insert into public.people (id, family_id, name, role, phone) values
      (${maa}, ${familyA}, 'Maa', 'parent', '+919000000001'),
      (${crypto.randomUUID()}, ${familyA}, 'Riya', 'child', '+91 90000-00002'),
      (${crypto.randomUUID()}, ${familyA}, 'Rohit', 'child', null),
      (${crypto.randomUUID()}, ${familyB}, 'Sharma uncle', 'other', '9000000004')`;
    const db = createCallGatePg(sql);
    expect(await db.getParent({ familyId: familyA, parentId: maa })).toBe(true);
    expect(await db.getParent({ familyId: familyB, parentId: maa })).toBe(false);
    for (const from of ["9000000002", "+919000000002", "09000000002", "+91 90000 00002", "९००००००००२"]) {
      expect(await db.isFamilyNumber({ familyId: familyA, phoneHash: (await numberFingerprint(from))! })).toBe(true);
    }
    expect(await db.isFamilyNumber({ familyId: familyA, phoneHash: (await numberFingerprint("+919000000004"))! })).toBe(false);
    expect(await db.isFamilyNumber({ familyId: familyB, phoneHash: (await numberFingerprint("+919000000004"))! })).toBe(true);
    expect(await db.isFamilyNumber({ familyId: familyA, phoneHash: (await numberFingerprint("+919000000009"))! })).toBe(false);
    expect(await db.isFamilyNumber({ familyId: familyA, phoneHash: "not-a-hash" })).toBe(false);
  });
});
