import postgres, { type Sql } from "postgres";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { encryptWebhook, identityHash } from "@sahaj/adapters";
import { numberFingerprint } from "@sahaj/shield";
import { contactContext, createContactsPort } from "../src/ports/contacts";
import { createAppStore } from "../src/lib/app_store";
const url=process.env.DATABASE_URL;
describe.skipIf(!url)("encrypted contacts on the combined foundation",()=>{
 let sql:Sql;
 const familyId=crypto.randomUUID(),personId=crypto.randomUUID(),userId=crypto.randomUUID();
 const env={WEBHOOK_ENCRYPTION_KEY:"19".repeat(32),IDENTITY_HASH_SECRET:"synthetic-contact-pg-test-secret-32-chars",WHATSAPP_PHONE_NUMBER_ID:"synthetic-wa-pg-test"};
 beforeAll(async()=>{
  sql=postgres(url!,{max:2,prepare:false,onnotice:()=>undefined});
  await sql`insert into public.families(id,name) values (${familyId},'Synthetic contacts')`;
  await sql`insert into public.people(id,family_id,display_name,role) values (${personId},${familyId},'Riya','child')`;
  await sql`insert into auth.users(id) values (${userId})`;
  await sql`insert into public.family_memberships(family_id,user_id,person_id,role) values (${familyId},${userId},${personId},'child')`;
 });
 afterAll(async()=>{
  if(!sql)return;
  await sql`delete from public.provider_identities where family_id=${familyId}`;
  await sql`delete from public.family_memberships where family_id=${familyId}`;
  await sql`delete from auth.users where id=${userId}`;
  await sql`delete from public.people where family_id=${familyId}`;
  await sql`delete from public.families where id=${familyId}`;
  await sql.end({timeout:5});
 });
 it("honors tenant, account, enabled/revoked contact and membership state",async()=>{
  const phone='+919000000001';
  const row={family_id:familyId,person_id:personId,source:'whatsapp',account_id:env.WHATSAPP_PHONE_NUMBER_ID,
   external_id_hash:identityHash('whatsapp',env.WHATSAPP_PHONE_NUMBER_ID,phone.slice(1),env.IDENTITY_HASH_SECRET)};
  const cipher=encryptWebhook(Buffer.from(phone),env.WEBHOOK_ENCRYPTION_KEY,contactContext(row));
  await sql`insert into public.provider_identities(family_id,person_id,source,account_id,external_id_hash,contact_ciphertext)
   values (${familyId},${personId},${row.source},${row.account_id},${row.external_id_hash},${cipher})`;
  const port=createContactsPort(sql,env),input={familyId,personId,source:'whatsapp' as const};
  expect(await port.resolve(input)).toBe(phone);
  expect(await port.resolve({...input,familyId:crypto.randomUUID()})).toBeNull();
  expect(await createContactsPort(sql,{...env,WHATSAPP_PHONE_NUMBER_ID:'other'}).resolve(input)).toBeNull();
  expect(await port.isFamilyNumber({familyId,phoneHash:(await numberFingerprint(phone))!})).toBe(true);
  const store=createAppStore(sql);
  expect(await store.memberships(userId)).toHaveLength(1);
  await sql`update public.family_memberships set revoked_at=now() where user_id=${userId}`;
  expect(await store.memberships(userId)).toHaveLength(0);
  await sql`update public.provider_identities set enabled=false where family_id=${familyId}`;
  expect(await port.resolve(input)).toBeNull();
  await sql`update public.provider_identities set enabled=true,revoked_at=now() where family_id=${familyId}`;
  expect(await port.resolve(input)).toBeNull();
 });
});
