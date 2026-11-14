import { decryptWebhook, encryptWebhook, identityHash } from "../webhook-security";

/** Providers whose destination numbers can be resolved for outbound dispatch. */
export type ContactProvider = "sarvam" | "twilio" | "whatsapp";
/** Sources a contact can be registered for (TeleCMI is inbound-only: missed-call caller lookup). */
export type ContactSource = ContactProvider | "telecmi";

export interface ContactCrypto { encryptionKeyHex: string; identitySecret: string }
export interface ContactResolverConfig extends ContactCrypto {
  /** The server-configured provider account each contact is bound to: Sarvam app id, Twilio AccountSid, WhatsApp phone_number_id. */
  accounts: Partial<Record<ContactProvider, string>>;
}

/** The slice of supabase-js used here (tests script it). */
export interface ContactDb {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACCOUNT = /^[A-Za-z0-9_.-]{1,128}$/;
const SOURCES: readonly ContactSource[] = ["sarvam", "twilio", "whatsapp", "telecmi"];

/**
 * Canonical identity digits: the E.164 number without '+'. This is exactly what the inbound parsers hash
 * (WhatsApp `from`/`recipient_id` digits, Sarvam/TeleCMI `phoneDigits`), so a registered contact matches inbound traffic.
 */
export const contactDigits = (e164: string): string => e164.slice(1);

/** Versioned AAD: the ciphertext only decrypts for this exact family, person, provider, account and identity hash. */
export const contactAad = (familyId: string, personId: string, source: ContactSource, accountId: string, hash: string) =>
  `sahaj:contact:v1:${familyId}:${personId}:${source}:${accountId}:${hash}`;

/** Error codes only: never the number, the hash input or a database message. */
export class ContactError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ContactError"; }
}

/**
 * Destination resolver for the dispatcher (`DispatchDeps.resolveDestination`). Returns the person's E.164 number or null.
 * Null when: provider account not configured; no row; more than one active row (ambiguous); the row is not exactly this
 * family/person/source/account/contact, enabled and unrevoked; the ciphertext does not decrypt under its AAD (tampered,
 * moved or copied from another row); the plaintext is not E.164; or its identity hash does not match the row.
 * Infrastructure errors throw `ContactError('contact_lookup_failed')` so the dispatcher fails before any claim.
 */
export function createContactResolver(db: ContactDb, cfg: ContactResolverConfig) {
  return async (familyId: string, personId: string, provider: ContactProvider): Promise<string | null> => {
    const account = cfg.accounts[provider];
    if (!account || !ACCOUNT.test(account) || !UUID.test(familyId) || !UUID.test(personId) || !SOURCES.includes(provider)) return null;
    const { data, error } = await db.from("provider_identities").select("family_id,person_id,source,account_id,external_id_hash,binding_kind,contact_ciphertext,enabled,revoked_at")
      .eq("family_id", familyId).eq("person_id", personId).eq("source", provider).eq("account_id", account)
      .eq("binding_kind", "contact").eq("enabled", true).is("revoked_at", null).limit(2);
    if (error || !Array.isArray(data)) throw new ContactError("contact_lookup_failed");
    if (data.length !== 1) return null;
    const row = data[0] as Record<string, unknown>;
    // Defence in depth: the filters above are the contract; re-check them on the returned row.
    if (row.family_id !== familyId || row.person_id !== personId || row.source !== provider || row.account_id !== account
      || row.binding_kind !== "contact" || row.enabled !== true || row.revoked_at !== null) return null;
    const hash = row.external_id_hash, ct = row.contact_ciphertext;
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash) || typeof ct !== "string") return null;
    let e164: string;
    try { e164 = decryptWebhook(ct, cfg.encryptionKeyHex, contactAad(familyId, personId, provider, account, hash)).toString("utf8"); }
    catch { return null; }
    if (!E164.test(e164)) return null;
    if (identityHash(provider, account, contactDigits(e164), cfg.identitySecret) !== hash) return null;
    return e164;
  };
}

export type RegisterResult = "registered" | "already_registered";
export interface RegisterContactInput { familyId: string; personId: string; source: ContactSource; accountId: string; e164: string }

/**
 * TRUSTED SERVER-ONLY onboarding helper. The caller (Phase 4 setup) must already have authenticated and authorized the adult
 * adding this number for this person; there is deliberately no HTTP route for it. Encrypts the number under its AAD and calls
 * the service-only `register_contact_identity` RPC, which validates the person is in the family, refuses to move a number that
 * belongs to another family or person, refuses to revive a revoked row, and allows one active contact per person and account.
 */
export async function registerContactIdentity(db: ContactDb, crypto: ContactCrypto, input: RegisterContactInput): Promise<RegisterResult> {
  const { familyId, personId, source, accountId, e164 } = input;
  if (!UUID.test(familyId) || !UUID.test(personId) || !SOURCES.includes(source) || !ACCOUNT.test(accountId) || typeof e164 !== "string" || !E164.test(e164)) {
    throw new ContactError("invalid_contact");
  }
  const hash = identityHash(source, accountId, contactDigits(e164), crypto.identitySecret);
  const ciphertext = encryptWebhook(Buffer.from(e164, "utf8"), crypto.encryptionKeyHex, contactAad(familyId, personId, source, accountId, hash));
  const { data, error } = await db.rpc("register_contact_identity", {
    p_family_id: familyId, p_person_id: personId, p_source: source, p_account_id: accountId, p_identity_hash: hash, p_contact_ciphertext: ciphertext,
  });
  if (error) {
    const known = ["person_not_in_family", "identity_owned_elsewhere", "identity_revoked", "contact_already_registered", "invalid_contact"];
    throw new ContactError(known.includes(error.message ?? "") ? error.message! : "contact_registration_failed");
  }
  if (data !== "registered" && data !== "already_registered") throw new ContactError("contact_registration_failed");
  return data;
}

/** Revoke a person's active contact for one provider account. Trusted server-only, like registration. Returns rows revoked. */
export async function revokeContactIdentity(db: ContactDb, input: { familyId: string; personId: string; source: ContactSource; accountId: string }): Promise<number> {
  if (!UUID.test(input.familyId) || !UUID.test(input.personId) || !SOURCES.includes(input.source) || !ACCOUNT.test(input.accountId)) throw new ContactError("invalid_contact");
  const { data, error } = await db.rpc("revoke_contact_identity", { p_family_id: input.familyId, p_person_id: input.personId, p_source: input.source, p_account_id: input.accountId });
  if (error || typeof data !== "number") throw new ContactError(error?.message === "person_not_in_family" ? "person_not_in_family" : "contact_revocation_failed");
  return data;
}
