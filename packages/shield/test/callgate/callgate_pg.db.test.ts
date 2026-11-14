/** Real foundation parent isolation; host-owned encrypted contact resolution is injected. */
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCallGatePg, numberFingerprint } from "../../src";
const env=process.env, DATABASE_URL=env.DATABASE_URL;
if (!DATABASE_URL && env.SHIELD_DB_TEST_REQUIRED) throw new Error("SHIELD_DB_TEST_REQUIRED is set but DATABASE_URL is not");
describe.skipIf(!DATABASE_URL)("call gateway foundation lookups",()=>{
 let sql:Sql;
 const families:string[]=[];
 beforeAll(()=>{sql=postgres(DATABASE_URL!,{max:2,prepare:false,onnotice:()=>undefined});});
 afterAll(async()=>{
  if(!sql)return;
  for(const family of families){await sql`delete from public.people where family_id=${family}`;await sql`delete from public.families where id=${family}`;}
  await sql.end({timeout:5});
 });
 it("checks foundation family identity and delegates routing without any plaintext contact column",async()=>{
  const familyA=crypto.randomUUID(),familyB=crypto.randomUUID(),maa=crypto.randomUUID();families.push(familyA,familyB);
  await sql`insert into public.families(id,name) values (${familyA},'Synthetic A'),(${familyB},'Synthetic B')`;
  await sql`insert into public.people(id,family_id,display_name,role) values (${maa},${familyA},'Maa','parent')`;
  const hash=(await numberFingerprint('+919000000002'))!;
  const db=createCallGatePg(sql,{isFamilyNumber:async input=>input.familyId===familyA && input.phoneHash===hash});
  expect(await db.getParent({familyId:familyA,parentId:maa})).toBe(true);
  expect(await db.getParent({familyId:familyB,parentId:maa})).toBe(false);
  expect(await db.isFamilyNumber({familyId:familyA,phoneHash:hash})).toBe(true);
  expect(await db.isFamilyNumber({familyId:familyB,phoneHash:hash})).toBe(false);
  expect(await createCallGatePg(sql).isFamilyNumber({familyId:familyA,phoneHash:hash})).toBe(false);
 });
});
