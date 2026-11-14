import { serviceDatabase } from "./database";
import { encryptWebhook, identityHash, payloadHash, WebhookError } from "./webhook-security";

export function eventStore() {
  const { WEBHOOK_ENCRYPTION_KEY: encryptionKey, IDENTITY_HASH_SECRET: identitySecret } = process.env;
  if (!encryptionKey || !identitySecret) throw new WebhookError("event_storage_not_configured", 503);
  const db = serviceDatabase();
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
    async ingest(event: StoredInput) {
      // Bind the resolved identity inside the stored hash as well as metadata.
      // A retry after reassignment within one family must conflict.
      const body = Buffer.from(JSON.stringify({ ...event.payload, person_id: event.personId }));
      const { error } = await db.rpc("ingest_raw_event", {
        p_source: event.source, p_provider_event_id: event.id, p_event_type: event.type,
        p_family_id: event.familyId, p_metadata: { person_id: event.personId },
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
}
