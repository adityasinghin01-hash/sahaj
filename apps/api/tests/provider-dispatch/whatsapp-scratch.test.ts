/**
 * Real end-to-end WhatsApp path on the loopback SCRATCH PostgreSQL (all migrations applied; the contact registry migration is
 * applied inside the transaction if absent). Everything runs in one transaction that is rolled back.
 * Skipped unless SAHAJ_SCRATCH_PSQL points at a psql binary. Providers are scripted; no network.
 *   SAHAJ_SCRATCH_PSQL=D:/.../psql.exe pnpm exec vitest run tests/provider-dispatch/whatsapp-scratch.test.ts
 * Path: register contact -> resolve destination -> dispatch (Phase 3 authorization trigger, ledger, message binding)
 *       -> signed POST /api/whatsapp status -> durable raw event -> cron stand-in (claim/dispatch_raw_event) -> status job
 *       -> record_delivery_proof -> Phase 3 outbox_proof.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PsqlSession } from "./psql-session";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../../src/lib/database", () => ({ serviceDatabase: () => holder.db }));

import { createContactResolver, dispatchOutbound, dispatchStore, registerContactIdentity, runStatusNormalizationJob, type RpcClient } from "../../src/lib/provider-dispatch";
import { POST } from "../../src/app/api/whatsapp/route";

const PSQL = process.env.SAHAJ_SCRATCH_PSQL;
const KEY = "ef".repeat(32), SECRET = "synthetic-identity-secret-0123456789abcdef", APP_SECRET = "synthetic-meta-app-secret";
const PNID = "100000000000001";
const F = "b7000000-0000-4000-8000-000000000001", G = "b7000000-0000-4000-8000-000000000002";
const P = "c7000000-0000-4000-8000-000000000001", Q = "c7000000-0000-4000-8000-000000000002", R = "c7000000-0000-4000-8000-000000000003";
const OB = "e7000000-0000-4000-8000-000000000001", LEASE = "f7000000-0000-4000-8000-000000000001", AR = "a7700000-0000-4000-8000-000000000001";
const PRIN = "a7700000-0000-4000-8000-000000000002", PERM = "a7700000-0000-4000-8000-000000000003", SETUP = "a7700000-0000-4000-8000-000000000004";
const P_PHONE = "+919000000101", Q_PHONE = "+919000000102", R_PHONE = "+919000000103", WAMID = "wamid.SYNTHETIC0001";

const signed = (body: string) => new Request("https://api.example.test/api/whatsapp", {
  method: "POST", body, headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex") },
});
const statusBody = (o: { status?: string; recipient?: string; account?: string; ts?: string; id?: string } = {}) => JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550000000", phone_number_id: o.account ?? PNID },
    statuses: [{ id: o.id ?? WAMID, ...(o.recipient === "" ? { recipient_user_id: "IN.synthetic" } : { recipient_id: o.recipient ?? P_PHONE.slice(1) }), status: o.status ?? "delivered", timestamp: o.ts ?? "1794000000" }] } }] }],
});

describe.skipIf(!PSQL)("WhatsApp status -> verified delivery proof on scratch PostgreSQL", () => {
  let s: PsqlSession;
  let db: ReturnType<PsqlSession["db"]["from"]> extends never ? never : PsqlSession["db"];
  beforeAll(async () => {
    s = new PsqlSession(PSQL!); await s.begin(); db = s.db; holder.db = db;
    if ((await s.sql("select to_regprocedure('public.register_contact_identity(uuid,uuid,text,text,text,text)') is null")) === "t") {
      await s.sql(readFileSync(fileURLToPath(new URL("../../../../infra/supabase/migrations/20261114214500_phase2_contact_registry.sql", import.meta.url)), "utf8"));
    }
    // Phase 3 authorization facts for one check_in message to P (what atomic enqueue would have committed).
    await s.sql(`insert into public.families(id,name) values('${F}','Synthetic WA A'),('${G}','Synthetic WA B');
      insert into public.people(id,family_id,display_name,role) values('${P}','${F}','Synthetic Parent','parent'),('${Q}','${F}','Synthetic Child','child'),('${R}','${G}','Synthetic Other','parent');
      insert into public.atlas_principals(id,family_id,label) values('${PRIN}','${F}','Synthetic principal');
      insert into public.consents(id,family_id,person_id,purpose,question,answer,version,created_at) values('${SETUP}','${F}','${P}','setup','Synthetic setup?',true,'v1',now()-interval '1 hour');
      insert into public.permissions(id,family_id,person_id,action,decision,expires_at,consent_id,principal_id,valid_from,period_start,period_end,max_uses,used_count,target_ids)
        values('${PERM}','${F}','${P}','check_in','allow',now()+interval '1 hour','${SETUP}','${PRIN}',now()-interval '1 hour',now()-interval '1 hour',now()+interval '1 hour',5,1,array['${P}']);
      insert into public.action_requests(id,family_id,person_id,action,status,expires_at,principal_id,target_id,consumed_at)
        values('${AR}','${F}','${P}','check_in','executed',now()+interval '1 hour','${PRIN}','${P}',now());
      insert into public.outbox(id,family_id,kind,dedupe_key,payload_ciphertext,status,attempt_count,lease_token,lease_until,action_request_id,action,permission_id)
        values('${OB}','${F}','message','wa-scratch-1','x','processing',1,'${LEASE}',now()+interval '10 minutes','${AR}','check_in','${PERM}');
      set role service_role;`);
    vi.stubEnv("WHATSAPP_APP_SECRET", APP_SECRET); vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", PNID);
    vi.stubEnv("WEBHOOK_ENCRYPTION_KEY", KEY); vi.stubEnv("IDENTITY_HASH_SECRET", SECRET);
  }, 30_000);
  afterAll(async () => { vi.unstubAllEnvs(); await s?.end(); });

  const crypto = { encryptionKeyHex: KEY, identitySecret: SECRET };
  const resolver = () => createContactResolver(db, { ...crypto, accounts: { whatsapp: PNID } });
  const store = () => dispatchStore(db as unknown as RpcClient);
  /** Cron stand-in: the real claim + dispatch_raw_event marks the raw event processed, as the tick does before a status job runs. */
  async function process(providerEventId: string): Promise<string> {
    const id = (await s.sql(`select id from public.raw_events where source='whatsapp' and provider_event_id='${providerEventId}'`)).trim();
    const lease = await s.sql(`select lease_token from public.claim_raw_events('scratch-wa',100,60) where id='${id}'`);
    if (lease) await s.sql(`select public.dispatch_raw_event('${id}','${lease}','core1.provider_status','${id}')`);
    return id;
  }
  const readRaw = async (id: string) => {
    const r = await db.from("raw_events").select("family_id,source,event_type,metadata").eq("id", id).maybeSingle();
    const d = r.data as Record<string, unknown> | null;
    return d ? { familyId: String(d.family_id), source: String(d.source), eventType: String(d.event_type), metadata: d.metadata as Record<string, unknown> } : null;
  };
  const proofs = async () => s.sql(`select coalesce(string_agg(event_type||':'||(metadata->>'outcome'),',' order by event_type),'') from public.raw_events where family_id='${F}' and normalized_proof`);

  it("registers contacts through the service RPC and resolves only the exact person", async () => {
    expect(await registerContactIdentity(db, crypto, { familyId: F, personId: P, source: "whatsapp", accountId: PNID, e164: P_PHONE })).toBe("registered");
    expect(await registerContactIdentity(db, crypto, { familyId: F, personId: Q, source: "whatsapp", accountId: PNID, e164: Q_PHONE })).toBe("registered");
    expect(await registerContactIdentity(db, crypto, { familyId: G, personId: R, source: "whatsapp", accountId: PNID, e164: R_PHONE })).toBe("registered");
    await expect(registerContactIdentity(db, crypto, { familyId: G, personId: R, source: "whatsapp", accountId: PNID, e164: P_PHONE })).rejects.toMatchObject({ code: "identity_owned_elsewhere" });
    expect(await resolver()(F, P, "whatsapp")).toBe(P_PHONE);
    expect(await resolver()(F, R, "whatsapp")).toBeNull(); // R is not in family F
    expect(await resolver()(F, P, "sarvam")).toBeNull();   // no account configured for sarvam
    expect(await s.sql(`select count(*) from public.provider_identities where family_id in ('${F}','${G}') and contact_ciphertext like '%9000000%'`)).toBe("0");
    // a ciphertext moved onto another person's row no longer resolves
    const saved = await s.sql(`select contact_ciphertext from public.provider_identities where person_id='${P}' and binding_kind='contact'`);
    await s.sql(`update public.provider_identities set contact_ciphertext=(select contact_ciphertext from public.provider_identities where person_id='${Q}' and binding_kind='contact') where person_id='${P}' and binding_kind='contact'`);
    expect(await resolver()(F, P, "whatsapp")).toBeNull();
    await s.sql(`update public.provider_identities set contact_ciphertext='${saved}' where person_id='${P}' and binding_kind='contact'`);
    expect(await resolver()(F, P, "whatsapp")).toBe(P_PHONE);
  });

  it("dispatches through the real ledger, Phase 3 authorization trigger and resolver to a scripted provider", async () => {
    expect(await store().bindOutbox({ familyId: F, outboxId: OB, personId: P, provider: "whatsapp", action: "whatsapp.send_text" })).toBe(true);
    const sent: Array<{ url: string; body: unknown }> = [];
    const transport = async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ messages: [{ id: WAMID }] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const out = await dispatchOutbound({
      store: store(), transport, identitySecret: SECRET, resolveDestination: resolver(),
      authorize: async (cmd, key) => ({ decision: "allow", consent: true, personId: cmd.personId, action: cmd.payload.action, idempotencyKey: key, expiresAt: Date.now() + 60_000 }),
      providers: { whatsapp: { accessToken: "synthetic-token", phoneNumberId: PNID, graphVersion: "v23.0", timeoutMs: 2000 } },
    }, { familyId: F, personId: P, outboxId: OB, outboxLease: LEASE, attempt: 1, payload: { action: "whatsapp.send_text", body: "Synthetic check-in" } });
    expect(out).toMatchObject({ status: "dispatched", providerRef: WAMID });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://graph.facebook.com/v23.0/${PNID}/messages`);
    expect((sent[0]!.body as { to: string }).to).toBe(P_PHONE.slice(1));
    expect(await s.sql(`select status||'|'||provider_ref from public.dispatch_ledger where outbox_id='${OB}'`)).toBe(`dispatched|${WAMID}`);
    expect(await s.sql(`select count(*) from public.provider_identities where source='whatsapp' and binding_kind='message' and attempt_id='${WAMID}' and person_id='${P}' and account_id='${PNID}'`)).toBe("1");
  });

  it("a signed delivered status becomes normalized proof that Phase 3 outbox_proof accepts; a duplicate changes nothing", async () => {
    const body = statusBody();
    const res = await POST(signed(body));
    expect(res.status).toBe(200);
    expect(await (await POST(signed(body))).json()).toMatchObject({ accepted: 1 }); // replay: same id and hash, idempotent
    const pe = `${PNID}:${WAMID}:delivered:1794000000`;
    expect(await s.sql(`select count(*)||'|'||(metadata->>'status')||'|'||(metadata->>'provider_ref') from public.raw_events where provider_event_id='${pe}' group by metadata`)).toBe(`1|delivered|${WAMID}`);
    const id = await process(pe);
    expect(await runStatusNormalizationJob({ store: store(), readRaw }, id)).toEqual({ action: "complete", code: "proved_no_unknown_dispatch" });
    expect(await runStatusNormalizationJob({ store: store(), readRaw }, id)).toEqual({ action: "complete", code: "proved_no_unknown_dispatch" });
    expect(await proofs()).toBe("delivery.confirmed:delivered");
    const m = JSON.parse(await s.sql(`select metadata from public.raw_events where family_id='${F}' and normalized_proof`));
    expect(m).toMatchObject({ action: "check_in", provider_action: "whatsapp.send_text", account_id: PNID, provider_ref: WAMID, outbox_id: OB, action_request_id: AR, person_id: P });
    expect(await s.sql(`select sahaj_private.outbox_proof('${OB}')`)).toBe("delivered");
    // a later 'read' without recipient_id (BSUID-only user) is attributed through the message binding and reuses the same proof
    expect((await POST(signed(statusBody({ status: "read", recipient: "", ts: "1794000010" })))).status).toBe(200);
    expect(await runStatusNormalizationJob({ store: store(), readRaw }, await process(`${PNID}:${WAMID}:read:1794000010`))).toEqual({ action: "complete", code: "proved_no_unknown_dispatch" });
    expect(await proofs()).toBe("delivery.confirmed:delivered");
  });

  it("substituted recipient, another business account, unknown status and contradicting status never produce proof", async () => {
    // Q is a registered contact in the same family, but the message was sent to P
    expect((await POST(signed(statusBody({ recipient: Q_PHONE.slice(1), status: "read", ts: "1794000001" })))).status).toBe(200);
    const qid = await process(`${PNID}:${WAMID}:read:1794000001`);
    expect(JSON.parse(await s.sql(`select metadata from public.raw_events where id='${qid}'`))).toMatchObject({ status: "read", binding: "unverified", person_id: Q });
    expect(await runStatusNormalizationJob({ store: store(), readRaw }, qid)).toEqual({ action: "complete", code: "unprovable" });
    // another phone_number_id, and an unregistered recipient
    expect((await POST(signed(statusBody({ account: "100000000000999" })))).status).toBe(403);
    expect((await POST(signed(statusBody({ recipient: "919999999999", ts: "1794000002" })))).status).toBe(403);
    // a bad signature never reaches storage
    const bad = signed(statusBody({ ts: "1794000003" })); bad.headers.set("x-hub-signature-256", "sha256=" + "0".repeat(64));
    expect((await POST(bad)).status).toBe(401);
    // an unknown Meta status is stored but stays pending
    expect((await POST(signed(statusBody({ status: "deleted", ts: "1794000004" })))).status).toBe(200);
    const did = await process(`${PNID}:${WAMID}:deleted:1794000004`);
    expect(await runStatusNormalizationJob({ store: store(), readRaw }, did)).toEqual({ action: "complete", code: "unsupported_status" });
    // 'sent' is not delivery
    expect((await POST(signed(statusBody({ status: "sent", ts: "1794000005" })))).status).toBe(200);
    expect(await runStatusNormalizationJob({ store: store(), readRaw }, await process(`${PNID}:${WAMID}:sent:1794000005`))).toEqual({ action: "complete", code: "unsupported_status" });
    // 'failed' after verified delivery contradicts existing proof and is refused
    expect((await POST(signed(statusBody({ status: "failed", ts: "1794000006" })))).status).toBe(200);
    expect(await runStatusNormalizationJob({ store: store(), readRaw }, await process(`${PNID}:${WAMID}:failed:1794000006`))).toEqual({ action: "complete", code: "unprovable" });
    expect(await proofs()).toBe("delivery.confirmed:delivered");
    expect(await s.sql(`select count(*) from public.raw_events where provider_event_id like '${PNID}:%' and family_id='${G}'`)).toBe("0");
  });
});
