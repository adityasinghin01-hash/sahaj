import { serviceDatabase } from "../database";
import type { ConsentRow } from "../provider-ingestion/gateway";
import type { PurgeStore } from "./purge";
import { RecordingError, type RawEventRow, type RecordingStorage, type RecordingStore } from "./types";

type DbError = { code?: string; message?: string; statusCode?: string | number } | null;
/** The slice of supabase-js used here, so tests can script it. */
export interface RecordingDb {
  from(table: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: DbError }>;
  storage: { from(bucket: string): {
    upload(path: string, body: Uint8Array, options: { contentType: string; upsert: boolean }): PromiseLike<{ error: DbError }>;
    remove(paths: string[]): PromiseLike<{ error: DbError }>;
  } };
}

export const RECORDINGS_BUCKET = "sahaj-recordings";
const unavailable = () => new RecordingError("store_unavailable", true);
const CONSENT_COLUMNS = "id,family_id,person_id,call_id,purpose,answer,version,created_at";
const consentRow = (r: Record<string, unknown>): ConsentRow => ({
  id: String(r.id), familyId: String(r.family_id), personId: String(r.person_id), callId: r.call_id == null ? null : String(r.call_id),
  purpose: String(r.purpose), answer: r.answer === true, version: String(r.version), createdAt: String(r.created_at),
});

export function recordingStore(db: RecordingDb = serviceDatabase() as unknown as RecordingDb): RecordingStore {
  return {
    async getCall(familyId, callId) {
      const { data, error } = await db.from("calls").select("person_id,provider,external_id,ai_disclosed_at")
        .eq("family_id", familyId).eq("id", callId).maybeSingle();
      if (error) throw unavailable();
      return data ? { personId: String(data.person_id), provider: String(data.provider), externalId: data.external_id == null ? null : String(data.external_id), aiDisclosed: !!data.ai_disclosed_at } : null;
    },
    async findConsents(familyId, personId, callId) {
      // Exact-call rows and global REFUSALS only, each bounded, so newer rows for other calls or global yes rows cannot crowd out a refusal.
      const base = () => db.from("consents").select(CONSENT_COLUMNS).eq("family_id", familyId).eq("person_id", personId)
        .eq("purpose", "call_recording").order("created_at", { ascending: false }).limit(20);
      const [specific, global] = await Promise.all([base().eq("call_id", callId), base().is("call_id", null).eq("answer", false)]);
      if (specific.error || global.error) throw unavailable();
      return [...(specific.data ?? []), ...(global.data ?? [])].map(consentRow);
    },
    async slot(familyId, callId, refHash) {
      const { data, error } = await db.rpc("get_call_recording_slot", { p_family_id: familyId, p_call_id: callId, p_recording_ref_hash: refHash });
      if (error || (data !== "none" && data !== "same" && data !== "other" && data !== "purged")) throw unavailable();
      return data;
    },
    async put(i) {
      const { data, error } = await db.rpc("put_call_recording", {
        p_family_id: i.familyId, p_call_id: i.callId, p_consent_id: i.consentId, p_object_path: i.objectPath,
        p_expires_at: i.expiresAt.toISOString(), p_recording_ref_hash: i.refHash,
      });
      if (error) {
        // 42501: consent no longer effective or identity mismatch. 22023: refused metadata. Both are permanent.
        if (error.code === "42501") throw new RecordingError(error.message === "consent_not_effective" ? "consent_not_effective" : "identity_mismatch");
        if (error.code === "22023") throw new RecordingError("invalid_metadata");
        throw unavailable();
      }
      if (data !== "stored" && data !== "already_stored" && data !== "ignored_additional" && data !== "purged") throw unavailable();
      return data;
    },
  };
}

export function recordingStorage(db: RecordingDb = serviceDatabase() as unknown as RecordingDb): RecordingStorage {
  const bucket = () => db.storage.from(RECORDINGS_BUCKET);
  return {
    async put(path, bytes, contentType) {
      const { error } = await bucket().upload(path, bytes, { contentType, upsert: false });
      if (!error) return "created";
      if (String(error.statusCode) === "409" || /already exists|duplicate/i.test(error.message ?? "")) return "exists";
      throw new RecordingError("storage_unavailable", true);
    },
    async remove(path) {
      const { error } = await bucket().remove([path]);
      if (error) throw new RecordingError("storage_unavailable", true);
    },
  };
}

/** Read one raw event by id. The worker needs only this row; the decrypt context is `${source}:${provider_event_id}`. */
export async function readRawEvent(db: RecordingDb, id: string): Promise<RawEventRow | null> {
  const { data, error } = await db.from("raw_events").select("id,family_id,source,provider_event_id,event_type,metadata,payload_ciphertext").eq("id", id).maybeSingle();
  if (error) throw unavailable();
  return data ? {
    id: String(data.id), familyId: String(data.family_id), source: String(data.source), providerEventId: String(data.provider_event_id),
    eventType: String(data.event_type), metadata: (data.metadata ?? {}) as Record<string, unknown>, payloadCiphertext: data.payload_ciphertext ?? null,
  } : null;
}

export function purgeStore(db: RecordingDb = serviceDatabase() as unknown as RecordingDb): PurgeStore {
  return {
    async listCandidates(limit, asOf) {
      const { data, error } = await db.rpc("list_recording_purge_candidates", { p_limit: limit, p_as_of: asOf.toISOString() });
      if (error || !Array.isArray(data)) throw unavailable();
      return data.flatMap((r: Record<string, unknown>) => (typeof r.family_id === "string" && typeof r.call_id === "string" && typeof r.object_path === "string" && (r.reason === "retention" || r.reason === "consent")
        ? [{ familyId: r.family_id, callId: r.call_id, objectPath: r.object_path, reason: r.reason as "retention" | "consent" }] : []));
    },
    async finish(familyId, callId, objectPath, asOf) {
      const { data, error } = await db.rpc("finish_recording_purge", { p_family_id: familyId, p_call_id: callId, p_object_path: objectPath, p_as_of: asOf.toISOString() });
      if (error) throw unavailable();
      return data === true;
    },
  };
}