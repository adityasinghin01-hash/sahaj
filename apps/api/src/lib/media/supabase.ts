import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  AuthPort, CallContentRow, CallRow, ConsentRow, MediaBucket, MediaDeps, MediaRepository, Membership,
  ObjectInfo, StorageSigner, VoiceContentRow, VoicePostRow,
} from "./contracts";
import { denyAllAuthorizer } from "./authorization";
import { isBucket, isUuid } from "./paths";
/** Page size for consent history queries. A full page is treated as possibly truncated and denies. */
export const CONSENT_HISTORY_LIMIT = 200;
type Row = Record<string, unknown>;
const str = (v: unknown): string => { if (typeof v !== "string") throw new Error("bad_row"); return v; };
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));

/** Server-only adapters over a service-role client. Not exercised against a live project in this milestone. */
export function supabaseRepository(db: SupabaseClient): MediaRepository {
  const one = async (query: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row | null> => {
    const { data, error } = await query;
    if (error) throw new Error("db_error");
    return (data as Row | null) ?? null;
  };
  const consent = (r: Row): ConsentRow => ({
    id: str(r.id), familyId: str(r.family_id), personId: str(r.person_id), callId: strOrNull(r.call_id),
    purpose: str(r.purpose), answer: r.answer === true, version: str(r.version), createdAt: str(r.created_at),
  });
  const rpcObject = async (query: PromiseLike<{ data: unknown; error: unknown }>): Promise<Row | null> => {
    const { data, error } = await query;
    if (error) throw new Error("db_error");
    if (data === null || data === undefined) return null;
    if (typeof data !== "object" || Array.isArray(data)) throw new Error("bad_row");
    return data as Row;
  };
  const COLS = "id,family_id,person_id,call_id,purpose,answer,version,created_at";
  return {
    async getMembership(userId, familyId): Promise<Membership | null> {
      const r = await one(db.from("family_memberships").select("family_id,user_id,person_id,role,revoked_at")
        .eq("user_id", userId).eq("family_id", familyId).is("revoked_at", null).maybeSingle());
      return r && { familyId: str(r.family_id), userId: str(r.user_id), personId: str(r.person_id), role: str(r.role) as Membership["role"], revokedAt: strOrNull(r.revoked_at) };
    },
    async getVoicePost(postId): Promise<VoicePostRow | null> {
      const r = await one(db.from("voice_posts").select("id,family_id,sender_id,recipient_id,consent_id").eq("id", postId).maybeSingle());
      return r && { id: str(r.id), familyId: str(r.family_id), senderId: str(r.sender_id), recipientId: str(r.recipient_id), consentId: str(r.consent_id) };
    },
    async getVoiceContent(familyId, postId): Promise<VoiceContentRow | null> {
      // Service-only public RPC; sahaj_private is never exposed. Missing function => db_error => fail closed.
      const r = await rpcObject(db.rpc("get_voice_media_metadata", { p_family_id: familyId, p_post_id: postId }));
      if (!r) return null;
      const row = { familyId: str(r.family_id), voicePostId: str(r.voice_post_id), objectPath: str(r.object_path), expiresAt: str(r.expires_at) };
      if (row.familyId !== familyId || row.voicePostId !== postId) throw new Error("bad_row");
      return row;
    },
    async getCall(callId): Promise<CallRow | null> {
      const r = await one(db.from("calls").select("id,family_id,person_id").eq("id", callId).maybeSingle());
      return r && { id: str(r.id), familyId: str(r.family_id), personId: str(r.person_id) };
    },
    async getCallContent(familyId, callId): Promise<CallContentRow | null> {
      const r = await rpcObject(db.rpc("get_call_media_metadata", { p_family_id: familyId, p_call_id: callId }));
      if (!r) return null;
      const row = { familyId: str(r.family_id), callId: str(r.call_id), consentId: str(r.consent_id), recordingObjectPath: strOrNull(r.recording_object_path), expiresAt: str(r.expires_at) };
      if (row.familyId !== familyId || row.callId !== callId) throw new Error("bad_row");
      return row;
    },
    async getConsent(familyId, consentId) {
      const r = await one(db.from("consents").select(COLS).eq("family_id", familyId).eq("id", consentId).maybeSingle());
      return r && consent(r);
    },
    async listConsentHistory(familyId, personId, purpose, callId) {
      if (!isUuid(familyId) || !isUuid(personId) || (callId !== undefined && !isUuid(callId))) throw new Error("bad_filter");
      if (typeof purpose !== "string" || purpose.length === 0 || purpose.length > 200) throw new Error("bad_filter");
      const base = () => db.from("consents").select(COLS).eq("family_id", familyId).eq("person_id", personId).eq("purpose", purpose);
      const run = async (query: PromiseLike<{ data: unknown; error: unknown }>): Promise<ConsentRow[]> => {
        const { data, error } = await query;
        if (error || !Array.isArray(data)) throw new Error("db_error");
        // A full page may hide rows we cannot see: refuse to decide rather than guess.
        if (data.length >= CONSENT_HISTORY_LIMIT) throw new Error("history_truncated");
        return (data as Row[]).map(consent);
      };
      const newest = { ascending: false };
      if (callId === undefined) return run(base().order("created_at", newest).limit(CONSENT_HISTORY_LIMIT));
      // Call-scoped: exact call rows, plus explicit global refusals only. Other calls and global grants never load.
      const [forCall, globalRefusals] = await Promise.all([
        run(base().eq("call_id", callId).order("created_at", newest).limit(CONSENT_HISTORY_LIMIT)),
        run(base().is("call_id", null).eq("answer", false).order("created_at", newest).limit(CONSENT_HISTORY_LIMIT)),
      ]);
      return [...forCall, ...globalRefusals];
    },  };
}

export function supabaseAuth(db: SupabaseClient): AuthPort {
  return {
    async verifyBearer(token) {
      const { data, error } = await db.auth.getUser(token); // verifies with the auth server, not just JWT decoding
      return error || !data.user?.id ? null : { userId: data.user.id };
    },
  };
}

export function supabaseStorage(db: SupabaseClient): StorageSigner {
  return {
    async stat(bucket: MediaBucket, path: string): Promise<ObjectInfo | null> {
      if (!isBucket(bucket)) return null;
      const { data, error } = await db.storage.from(bucket).info(path);
      if (error || !data || typeof data.size !== "number" || typeof data.contentType !== "string") return null;
      return { size: data.size, contentType: data.contentType };
    },
    async createSignedUrl(bucket, path, expiresInSeconds) {
      if (!isBucket(bucket)) return null;
      const { data, error } = await db.storage.from(bucket).createSignedUrl(path, expiresInSeconds);
      return error || !data?.signedUrl ? null : data.signedUrl;
    },
  };
}

/** Production wiring; throws when server configuration is missing so handlers answer 503. */
export function defaultMediaDeps(): MediaDeps {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("database_not_configured");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return { auth: supabaseAuth(db), repo: supabaseRepository(db), storage: supabaseStorage(db), authorizeMedia: denyAllAuthorizer, now: () => new Date() };
}
