import { serviceDatabase } from "./database";
import { encryptWebhook, identityHash, payloadHash, WebhookError } from "./webhook-security";

/** Metadata the store will persist besides person_id. Everything else is dropped: no content, numbers or free text. */
const METADATA_KEYS: Record<string, RegExp> = {
  status: /^(sent|delivered|read|failed|unsupported)$/,
  provider_ref: /^[A-Za-z0-9_.:=+/-]{1,256}$/,
  binding: /^unverified$/,
};
export function narrowMetadata(input: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, re] of Object.entries(METADATA_KEYS)) {
    const v = input?.[k];
    if (typeof v === "string" && re.test(v)) out[k] = v;
  }
  return out;
}

type Db = Pick<ReturnType<typeof serviceDatabase>, "from" | "rpc">;

export function eventStore(injected?: Db) {
  const { WEBHOOK_ENCRYPTION_KEY: encryptionKey, IDENTITY_HASH_SECRET: identitySecret } = process.env;
  if (!encryptionKey || !identitySecret) throw new WebhookError("event_storage_not_configured", 503);
  const db = injected ?? serviceDatabase();
  return {
    async resolve(source: string, account: string, externalId: string) {
      const hash = identityHash(source, account, externalId, identitySecret);
      const { data, error } = await db.from("provider_identities").select("family_id,person_id")
        .eq("source", source).eq("account_id", account).eq("external_id_hash", hash)
        .eq("binding_kind", "contact").eq("enabled", true).is("revoked_at", null).maybeSingle();
      if (error) throw new WebhookError("identity_lookup_failed", 503);
      if (!data) throw new WebhookError("unregistered_sender", 403);
      return { familyId: String(data.family_id), personId: String(data.person_id) };
    },
    async findMessageBinding(account: string, messageId: string) {
      // Written by complete_dispatch: source whatsapp, configured phone_number_id, binding_kind 'message', attempt_id = message id.
      const { data, error } = await db.from("provider_identities").select("family_id,person_id")
        .eq("source", "whatsapp").eq("account_id", account).eq("binding_kind", "message").eq("attempt_id", messageId)
        .eq("enabled", true).is("revoked_at", null).limit(2);
      if (error || !Array.isArray(data)) throw new WebhookError("identity_lookup_failed", 503);
      if (data.length !== 1) return null;
      return { familyId: String(data[0]!.family_id), personId: String(data[0]!.person_id) };
    },
    async ingest(event: StoredInput) {
      // Bind the resolved identity (and any verified status metadata) inside the stored hash as well as metadata.
      // A retry after reassignment within one family, or with different status facts, must conflict.
      const extra = narrowMetadata(event.metadata);
      const envelope: Record<string, unknown> = { ...event.payload, person_id: event.personId };
      if (Object.keys(extra).length) envelope.metadata = extra; // absent for messages: their hash is unchanged
      const body = Buffer.from(JSON.stringify(envelope));
      const { error } = await db.rpc("ingest_raw_event", {
        p_source: event.source, p_provider_event_id: event.id, p_event_type: event.type,
        p_family_id: event.familyId, p_metadata: { ...extra, person_id: event.personId },
        p_payload_hash: payloadHash(body),
        p_payload_ciphertext: encryptWebhook(body, encryptionKey, `${event.source}:${event.id}`),
      });
      if (error) throw new WebhookError(error.code === "23505" ? "event_id_conflict" : "event_persistence_failed", error.code === "23505" ? 409 : 503);
    },
  };
}

export interface StoredInput {
  source: string; id: string; type: string; familyId: string; personId: string;
  payload: Record<string, unknown>;
  /** Only keys allowed by narrowMetadata are persisted. */
  metadata?: Record<string, string>;
}
