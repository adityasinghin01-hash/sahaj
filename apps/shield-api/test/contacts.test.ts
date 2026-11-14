import { describe, it, expect, vi } from "vitest";
import type { ISql } from "postgres";
import { encryptWebhook, identityHash } from "@sahaj/adapters";
import { numberFingerprint, createCallGatePg } from "@sahaj/shield";
import { contactContext, createContactsPort } from "../src/ports/contacts";
const F="11111111-1111-4111-8111-111111111111", P="22222222-2222-4222-8222-222222222221";
const env={WEBHOOK_ENCRYPTION_KEY:"19".repeat(32),IDENTITY_HASH_SECRET:"synthetic-contact-index-secret-32-chars",WHATSAPP_PHONE_NUMBER_ID:"synthetic-wa-account",SARVAM_APP_ID:"synthetic-sarvam-app"};
const phone="+919000000001";
function binding(source="whatsapp") {
  const row={family_id:F,person_id:P,source,account_id:source==="whatsapp"?env.WHATSAPP_PHONE_NUMBER_ID:env.SARVAM_APP_ID,external_id_hash:""};
  row.external_id_hash=identityHash(source,row.account_id,phone.slice(1),env.IDENTITY_HASH_SECRET);
  return {...row,contact_ciphertext:encryptWebhook(Buffer.from(phone),env.WEBHOOK_ENCRYPTION_KEY,contactContext(row))};
}
function fake(rows: unknown[]) {
 const queries: {text: string;values: unknown[]}[]=[];
 const sql=vi.fn(async (strings: TemplateStringsArray,...values: unknown[])=>{queries.push({text:strings.join("?"),values});return rows;}) as unknown as ISql;
 return {sql,queries};
}
describe("foundation encrypted contact bridge",()=>{
 it.each(["whatsapp","sarvam"] as const)("resolves only internally for %s with tenant/account/revocation predicates",async source=>{
  const {sql,queries}=fake([binding(source)]);
  const contacts=createContactsPort(sql,env);
  expect(await contacts.resolve({familyId:F,personId:P,source})).toBe(phone);
  expect(queries[0]!.text).toMatch(/family_id=.*person_id=/s);
  expect(queries[0]!.text).toContain("account_id=");
  expect(queries[0]!.text).toContain("binding_kind='contact'");
  expect(queries[0]!.text).toContain("enabled and revoked_at is null");
  expect(JSON.stringify(queries)).not.toContain(phone);
 });
 it("rejects empty, ambiguous, corrupt, transplanted and index-mismatched bindings",async()=>{
  const good=binding();
  for(const rows of [[],[good,good],[{...good,contact_ciphertext:"v1.bad"}],[{...good,person_id:crypto.randomUUID()}],[{...good,external_id_hash:"0".repeat(64)}]]) {
   expect(await createContactsPort(fake(rows).sql,env).resolve({familyId:F,personId:P,source:"whatsapp"})).toBeNull();
  }
 });
 it("missing keys or account never exposes a destination",async()=>{
  for(const config of [{},{...env,WEBHOOK_ENCRYPTION_KEY:""},{...env,IDENTITY_HASH_SECRET:""},{...env,WHATSAPP_PHONE_NUMBER_ID:""}])
   expect(await createContactsPort(fake([binding()]).sql,config).resolve({familyId:F,personId:P,source:"whatsapp"})).toBeNull();
 });
 it("sender lookup uses foundation account-bound HMAC without decrypting",()=>{
  const {sql}=fake([]),port=createContactsPort(sql,env);
  expect(port.senderHash("whatsapp",phone.slice(1))).toBe(identityHash("whatsapp",env.WHATSAPP_PHONE_NUMBER_ID,phone.slice(1),env.IDENTITY_HASH_SECRET));
  expect(port.senderHash("whatsapp","invalid")).toBeNull();
  expect(sql).not.toHaveBeenCalled();
 });
 it("call gateway uses injected decrypted contacts; missing configuration and other accounts fail closed",async()=>{
  const hash=(await numberFingerprint(phone))!;
  const {sql,queries}=fake([binding()]);
  const db=createCallGatePg(sql,createContactsPort(sql,env));
  expect(await db.isFamilyNumber({familyId:F,phoneHash:hash})).toBe(true);
  expect(queries[0]!.text).toContain("family_id=");
  expect(queries[0]!.text).toContain("revoked_at is null");
  expect(await createCallGatePg(sql).isFamilyNumber({familyId:F,phoneHash:hash})).toBe(false);
  expect(await createContactsPort(fake([{...binding(),account_id:"other"}]).sql,env).isFamilyNumber({familyId:F,phoneHash:hash})).toBe(false);
 });
});
