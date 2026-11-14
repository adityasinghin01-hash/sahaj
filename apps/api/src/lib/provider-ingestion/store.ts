import { serviceDatabase } from "../database";
import { encryptWebhook, identityHash, payloadHash, WebhookError } from "../webhook-security";
import type { ConsentRow, Identity, ProviderEvent, ProviderStore } from "./gateway";

/** Supabase-backed store. Service role stays server-side; nothing here logs payloads or phone numbers. */
export function providerStore(): ProviderStore {
  const { WEBHOOK_ENCRYPTION_KEY: encryptionKey, IDENTITY_HASH_SECRET: identitySecret } = process.env;
  if (!encryptionKey || !identitySecret) throw new WebhookError("event_storage_not_configured", 503);
  const db = serviceDatabase();
  const lookupFailed = () => new WebhookError("identity_lookup_failed", 503);
  const identity = (row: { family_id: unknown; person_id: unknown } | null): Identity | null =>
    row ? { familyId: String(row.family_id), personId: String(row.person_id) } : null;
  const CONSENT_COLUMNS = "id,family_id,person_id,call_id,purpose,answer,version,created_at";
  const consentRow = (r: Record<string, unknown>): ConsentRow => ({
    id: String(r.id), familyId: String(r.family_id), personId: String(r.person_id), callId: r.call_id == null ? null : String(r.call_id),
    purpose: String(r.purpose), answer: r.answer === true, version: String(r.version), createdAt: String(r.created_at),
  });

  return {
    async findSarvamAttempt(appId, attemptId) {
      const { data, error } = await db.from("provider_identities").select("family_id,person_id")
        .eq("source", "sarvam").eq("account_id", appId).eq("binding_kind", "attempt")
        .eq("external_id_hash", identityHash("sarvam", appId, attemptId, identitySecret))
        .eq("attempt_id", attemptId).eq("agent_id", appId).eq("enabled", true).is("revoked_at", null).maybeSingle();
      if (error) throw lookupFailed();
      return identity(data);
    },
    async resolveContact(source, account, externalId) {
      const { data, error } = await db.from("provider_identities").select("family_id,person_id")
        .eq("source", source).eq("account_id", account).eq("binding_kind", "contact")
        .eq("external_id_hash", identityHash(source, account, externalId, identitySecret))
        .eq("enabled", true).is("revoked_at", null).maybeSingle();
      if (error) throw lookupFailed();
      return identity(data);
    },
    async findCall(provider, externalId) {
      const { data, error } = await db.from("calls").select("id,family_id,person_id,ai_disclosed_at")
        .eq("provider", provider).eq("external_id", externalId).maybeSingle();
      if (error) throw lookupFailed();
      const who = identity(data);
      return who && data ? { ...who, callId: String(data.id), aiDisclosed: !!data.ai_disclosed_at } : null;
    },
    async findConsents(familyId, personId, callId, purpose) {
      // Two bounded queries. The global one selects refusals only, so newer global affirmations cannot crowd a refusal out of the limit.
      const base = () => db.from("consents").select(CONSENT_COLUMNS).eq("family_id", familyId).eq("person_id", personId)
        .eq("purpose", purpose).order("created_at", { ascending: false }).limit(20);
      const [specific, global] = await Promise.all([base().eq("call_id", callId), base().is("call_id", null).eq("answer", false)]);
      if (specific.error || global.error) throw new WebhookError("consent_lookup_failed", 503);
      return [...(specific.data ?? []), ...(global.data ?? [])].map(consentRow);
    },
    async ingest(event: ProviderEvent) {
      // person_id and consent/call IDs live inside the hashed, encrypted envelope as well as metadata, so a replay
      // after identity reassignment or consent change within one family conflicts instead of being accepted.
      const envelope: Record<string, unknown> = { ...event.payload, person_id: event.personId };
      if (event.callId) envelope.call_id = event.callId;
      if (event.consentId) envelope.consent_id = event.consentId;
      const body = Buffer.from(JSON.stringify(envelope));
      const metadata: Record<string, string> = { person_id: event.personId, status: event.status };
      if (event.callId) metadata.call_id = event.callId;
      if (event.consentId) metadata.consent_id = event.consentId;
      if (event.review) metadata.review = event.review;
      const { error } = await db.rpc("ingest_raw_event", {
        p_source: event.source, p_provider_event_id: event.id, p_event_type: event.type, p_family_id: event.familyId,
        p_metadata: metadata,
        p_payload_hash: payloadHash(body),
        p_payload_ciphertext: encryptWebhook(body, encryptionKey, `${event.source}:${event.id}`),
      });
      if (error) {
        const conflict = error.code === "23505";
        throw new WebhookError(conflict ? "event_id_conflict" : "event_persistence_failed", conflict ? 409 : 503);
      }
    },
  };
}
