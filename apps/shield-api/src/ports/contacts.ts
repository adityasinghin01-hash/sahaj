import type { ISql, Sql } from "postgres";
import { decryptWebhook, encryptWebhook, identityHash } from "@sahaj/adapters";
import { numberFingerprint } from "@sahaj/shield";
import type { ContactSource, ShieldContacts } from "./contacts.types";
export type { ShieldContacts, ContactSource } from "./contacts.types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164 = /^\+[1-9][0-9]{9,14}$/;
/** No contact writer existed upstream. This AAD binds each new contact to its tenant,
 * person, provider account and identity index using the foundation's v1 AES-GCM envelope. */
export const contactContext = (r: { family_id: string; person_id: string; source: string; account_id: string; external_id_hash: string }) =>
  JSON.stringify(["contact", r.family_id, r.person_id, r.source, r.account_id, r.external_id_hash]);

const contactAccount = (env: Readonly<Record<string, string | undefined>>, source: ContactSource) =>
  source === "whatsapp" ? env.WHATSAPP_PHONE_NUMBER_ID : env.SARVAM_APP_ID ?? env.SARVAM_AGENT_ID_CHECKIN;

/** Pure index reduction for verified webhooks; no plaintext enters background work. */
export function contactSenderHash(env: Readonly<Record<string, string | undefined>>, source: ContactSource, digits: string): string | null {
  const account = contactAccount(env, source);
  if (!account || !/^[1-9][0-9]{9,14}$/.test(digits) || !env.IDENTITY_HASH_SECRET) return null;
  try { return identityHash(source, account, digits, env.IDENTITY_HASH_SECRET); } catch { return null; }
}

export type BindContactResult = "bound" | "account_not_configured" | "keys_not_configured" | "invalid" | "conflict";

/**
 * Lab/admin writer for the same encrypted binding `resolve` reads. Server-only: the number is encrypted with the
 * foundation v1 envelope under `contactContext` and indexed with the account-bound identity HMAC; it is never returned,
 * logged or put in an error. With `primary` (the default) every other enabled contact for this person/source/account is
 * disabled, so `resolve` keeps seeing exactly one row. A hash already bound to a different person is a conflict and is
 * left untouched.
 */
export function createContactWriter(sql: Sql, env: Readonly<Record<string, string | undefined>>) {
  return {
    async bind(input: { familyId: string; personId: string; source: ContactSource; phoneE164: string; primary?: boolean }): Promise<BindContactResult> {
      const primary = input.primary ?? true;
      if (!UUID.test(input.familyId) || !UUID.test(input.personId) || !E164.test(input.phoneE164)) return "invalid";
      const accountId = contactAccount(env, input.source);
      if (!accountId) return "account_not_configured";
      const key = env.WEBHOOK_ENCRYPTION_KEY, secret = env.IDENTITY_HASH_SECRET;
      if (!key || !/^[0-9a-fA-F]{64}$/.test(key) || !secret || secret.length < 32) return "keys_not_configured";
      const row = { family_id: input.familyId, person_id: input.personId, source: input.source, account_id: accountId,
        external_id_hash: identityHash(input.source, accountId, input.phoneE164.slice(1), secret) };
      const ciphertext = encryptWebhook(Buffer.from(input.phoneE164, "utf8"), key, contactContext(row));
      return sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`contact:${row.family_id}:${row.person_id}:${row.source}`}, 0))`;
        const saved = await tx<{ id: string }[]>`
          insert into public.provider_identities (family_id, person_id, source, account_id, external_id_hash, binding_kind, contact_ciphertext, enabled, revoked_at)
          values (${row.family_id}, ${row.person_id}, ${row.source}, ${row.account_id}, ${row.external_id_hash}, 'contact', ${ciphertext}, ${primary}, null)
          on conflict (source, account_id, external_id_hash, binding_kind) do update
            set contact_ciphertext = excluded.contact_ciphertext, enabled = excluded.enabled, revoked_at = null
            where provider_identities.family_id = excluded.family_id and provider_identities.person_id = excluded.person_id
          returning id`;
        if (saved.length !== 1) return "conflict" as const;
        if (primary) {
          await tx`
            update public.provider_identities set enabled = false
            where family_id=${row.family_id} and person_id=${row.person_id} and source=${row.source}
              and account_id=${row.account_id} and binding_kind='contact' and enabled and id <> ${saved[0]!.id}`;
        }
        return "bound" as const;
      }) as Promise<BindContactResult>;
    },
  };
}

export function createContactsPort(sql: ISql, env: Readonly<Record<string, string | undefined>>): ShieldContacts {
  const account = (source: ContactSource) => contactAccount(env, source);
  function decrypt(row: Parameters<typeof contactContext>[0] & { contact_ciphertext: string | null }): string | null {
    if (!row.contact_ciphertext || !env.WEBHOOK_ENCRYPTION_KEY || !env.IDENTITY_HASH_SECRET) return null;
    try {
      const phone = decryptWebhook(row.contact_ciphertext, env.WEBHOOK_ENCRYPTION_KEY, contactContext(row)).toString("utf8");
      if (!E164.test(phone) || identityHash(row.source, row.account_id, phone.slice(1), env.IDENTITY_HASH_SECRET) !== row.external_id_hash) return null;
      return phone;
    } catch { return null; } // Never expose cipher errors, inputs or phones.
  }
  return {
    senderHash: (source, digits) => contactSenderHash(env, source, digits),
    async resolve({ familyId, personId, source }) {
      const id = account(source);
      if (!UUID.test(familyId) || !UUID.test(personId) || !id) return null;
      const rows = await sql<(Parameters<typeof contactContext>[0] & { contact_ciphertext: string | null })[]>`
        select family_id, person_id, source, account_id, external_id_hash, contact_ciphertext
        from public.provider_identities where family_id=${familyId} and person_id=${personId}
          and source=${source} and account_id=${id} and binding_kind='contact'
          and enabled and revoked_at is null order by id limit 2`;
      return rows.length === 1 ? decrypt(rows[0]!) : null;
    },
    async isFamilyNumber({ familyId, phoneHash }) {
      if (!UUID.test(familyId) || !/^[0-9a-f]{64}$/.test(phoneHash)) return false;
      const rows = await sql<(Parameters<typeof contactContext>[0] & { contact_ciphertext: string | null })[]>`
        select family_id, person_id, source, account_id, external_id_hash, contact_ciphertext
        from public.provider_identities where family_id=${familyId}
          and source in ('whatsapp','sarvam') and binding_kind='contact' and enabled and revoked_at is null`;
      for (const row of rows) {
        if (row.account_id !== account(row.source as ContactSource)) continue;
        const phone = decrypt(row);
        if (phone && await numberFingerprint(phone) === phoneHash) return true;
      }
      return false;
    },
  };
}
