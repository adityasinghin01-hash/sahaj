import type { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchTwilioRecording,
  getSarvamRecording,
  verifyTwilioFormSignature,
} from "@sahaj/adapters";
import { createSupabaseVoiceNotifyDeps, defaultSendExpoPush } from "@/lib/core1/voice-notify";
import { createProductionCore2Deps } from "@/lib/core2/supabase";
import { serviceDatabase } from "@/lib/database";
import { cedarMediaAuthorizer } from "@/lib/media/cedar-authorizer";
import { MAX_SIGNED_URL_SECONDS, voiceShareConsentPurpose } from "@/lib/media/contracts";
import { validateObjectPath } from "@/lib/media/paths";
import { normalizeCodeWord } from "./code-word";
import {
  Core2ProofError,
  type AnyPhoneAttemptOutcome,
  type AnyPhoneSessionRow,
  type Core2ProofDeps,
  type ProofAnyPhoneRepo,
  type ProofChallengeRow,
  type ProofChallengeStatus,
  type ProofPersonCandidate,
  type ProofStoragePort,
  type VoiceAudioLookup,
} from "./contracts";
import { createSaarasSttFromEnv } from "./saaras-stt";
import { createCore2ProofService } from "./service";

type Row = Record<string, unknown>;

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function optStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strArr(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function mapChallenge(r: Row): ProofChallengeRow {
  return {
    id: str(r.id),
    familyId: str(r.family_id),
    requesterPersonId: str(r.requester_person_id),
    subjectPersonId: str(r.subject_person_id),
    wordToken: str(r.word_token),
    wordAliases: strArr(r.word_aliases),
    status: str(r.status) as ProofChallengeStatus,
    ttlSeconds: num(r.ttl_seconds, 60),
    expiresAt: str(r.expires_at),
    answeredAt: optStr(r.answered_at),
    verifiedAt: optStr(r.verified_at),
    escalatedAt: optStr(r.escalated_at),
    voiceMediaId: optStr(r.voice_media_id),
    voicePostId: optStr(r.voice_post_id),
    voiceObjectPath: optStr(r.voice_object_path),
    sttTranscript: optStr(r.stt_transcript),
    sttMatched: r.stt_matched === true,
    incidentId: optStr(r.incident_id),
    requestId: optStr(r.request_id),
    offeredContactPersonId: optStr(r.offered_contact_person_id),
    offeredContactName: optStr(r.offered_contact_name),
    attempts: num(r.attempts, 0),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function mapAnyPhoneSession(r: Row): AnyPhoneSessionRow {
  return {
    id: str(r.id),
    familyId: str(r.family_id),
    subjectPersonId: str(r.subject_person_id),
    incidentId: str(r.incident_id),
    requestId: str(r.request_id),
    callRefHash: optStr(r.call_ref_hash),
    callerChannel: str(r.caller_channel, "any_phone"),
    grantedPowers: strArr(r.granted_powers),
    deniedPowers: strArr(r.denied_powers),
    codeWordRotated: r.code_word_rotated === true,
    voicePostId: optStr(r.voice_post_id),
    voiceObjectPath: optStr(r.voice_object_path),
    statusMessageHi: str(r.status_message_hi),
    statusMessageEn: str(r.status_message_en),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function contentTypeFromPath(objectPath: string): string {
  const lower = objectPath.toLowerCase();
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  return "audio/mp4";
}

export function createSupabaseProofRepo(db: SupabaseClient): ProofAnyPhoneRepo {
  return {
    async findPersonByNameOrAlias(familyId, saidName, role): Promise<ProofPersonCandidate | null> {
      const target = normalizeCodeWord(saidName);
      if (!target) return null;

      let q = db
        .from("people")
        .select("id,family_id,display_name,role,timezone,aliases")
        .eq("family_id", familyId);
      if (role) {
        q = q.eq("role", role);
      }
      const { data, error } = await q;
      if (error || !Array.isArray(data)) {
        throw new Core2ProofError("unavailable", 503, "Family member lookup failed.");
      }

      const rows = (data as Row[]).map((r) => ({
        id: str(r.id),
        familyId: str(r.family_id),
        displayName: str(r.display_name),
        role: str(r.role) as ProofPersonCandidate["role"],
        timezone: str(r.timezone, "Asia/Kolkata"),
        aliases: strArr(r.aliases),
      }));

      // Exact display_name match first, then first-word / alias match, deterministic by id.
      rows.sort((a, b) => a.id.localeCompare(b.id));
      for (const p of rows) {
        if (normalizeCodeWord(p.displayName) === target) return p;
      }
      for (const p of rows) {
        const firstToken = normalizeCodeWord(p.displayName).split(" ")[0] ?? "";
        if (firstToken === target) return p;
        if (p.aliases.some((alias) => normalizeCodeWord(alias) === target)) return p;
      }
      return null;
    },

    async listPushTokensForPerson(familyId, personId) {
      const { data: members, error: mErr } = await db
        .from("family_memberships")
        .select("user_id")
        .eq("family_id", familyId)
        .eq("person_id", personId)
        .is("revoked_at", null);
      if (mErr || !members || members.length === 0) return [];
      const userIds = (members as Array<{ user_id: string }>).map((m) => m.user_id);
      const { data: tokens, error: tErr } = await db
        .from("app_push_tokens")
        .select("expo_push_token")
        .in("user_id", userIds);
      if (tErr || !tokens) return [];
      return (tokens as Array<{ expo_push_token: string }>)
        .map((t) => t.expo_push_token)
        .filter((t) => typeof t === "string" && t.length > 0);
    },

    async createProofChallenge(input) {
      const { data, error } = await db
        .from("core2_proof_challenges")
        .insert({
          family_id: input.familyId,
          requester_person_id: input.requesterPersonId,
          subject_person_id: input.subjectPersonId,
          word_token: input.wordToken,
          word_aliases: [...input.wordAliases],
          status: "pending",
          ttl_seconds: input.ttlSeconds,
          expires_at: input.expiresAt,
        })
        .select("*")
        .single();
      if (error || !data) {
        throw new Core2ProofError("unavailable", 503, "Failed to create proof challenge.");
      }
      return mapChallenge(data as Row);
    },

    async getProofChallenge(familyId, challengeId) {
      const { data, error } = await db
        .from("core2_proof_challenges")
        .select("*")
        .eq("family_id", familyId)
        .eq("id", challengeId)
        .maybeSingle();
      if (error) throw new Core2ProofError("unavailable", 503, "Proof challenge lookup failed.");
      return data ? mapChallenge(data as Row) : null;
    },

    async getLatestProofChallenge(familyId, subjectPersonId) {
      let q = db
        .from("core2_proof_challenges")
        .select("*")
        .eq("family_id", familyId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (subjectPersonId) {
        q = q.eq("subject_person_id", subjectPersonId);
      }
      const { data, error } = await q.maybeSingle();
      if (error) throw new Core2ProofError("unavailable", 503, "Proof challenge lookup failed.");
      return data ? mapChallenge(data as Row) : null;
    },

    async updateProofChallengeAnswer(input) {
      const { data, error } = await db
        .from("core2_proof_challenges")
        .update({
          status: input.status,
          answered_at: input.answeredAt,
          verified_at: input.verifiedAt,
          voice_media_id: input.voiceMediaId,
          voice_post_id: input.voicePostId,
          voice_object_path: input.voiceObjectPath,
          stt_transcript: input.sttTranscript,
          stt_matched: input.sttMatched,
          attempts: input.attempts,
          updated_at: input.answeredAt,
        })
        .eq("family_id", input.familyId)
        .eq("id", input.challengeId)
        .select("*")
        .single();
      if (error || !data) {
        throw new Core2ProofError("unavailable", 503, "Failed to update proof challenge answer.");
      }
      return mapChallenge(data as Row);
    },

    async markProofChallengeEscalated(input) {
      const { data, error } = await db
        .from("core2_proof_challenges")
        .update({
          status: "escalated",
          escalated_at: input.escalatedAt,
          incident_id: input.incidentId,
          request_id: input.requestId,
          offered_contact_person_id: input.offeredContactPersonId,
          offered_contact_name: input.offeredContactName,
          updated_at: input.escalatedAt,
        })
        .eq("family_id", input.familyId)
        .eq("id", input.challengeId)
        .select("*")
        .single();
      if (error || !data) {
        throw new Core2ProofError("unavailable", 503, "Failed to mark proof challenge escalated.");
      }
      return mapChallenge(data as Row);
    },

    async claimDueProofChallenges(nowIso, limit) {
      const { data, error } = await db.rpc("core2_claim_due_proof_challenges", {
        p_now: nowIso,
        p_limit: limit,
      });
      if (error || !Array.isArray(data)) {
        throw new Core2ProofError("unavailable", 503, "Failed to claim due proof challenges.");
      }
      return (data as Row[]).map(mapChallenge);
    },

    async getCodeWordHash(familyId) {
      const { data, error } = await db
        .from("shield_family_security")
        .select("code_word_hash")
        .eq("family_id", familyId)
        .maybeSingle();
      if (error) {
        throw new Core2ProofError("unavailable", 503, "Code word store unavailable.");
      }
      return optStr((data as Row | null)?.code_word_hash);
    },

    async rotateCodeWordHash(familyId, newHashHex) {
      const { error } = await db.rpc("core2_rotate_shield_code_word", {
        p_family_id: familyId,
        p_new_hash: newHashHex,
      });
      if (error) {
        throw new Core2ProofError("unavailable", 503, "Code word rotation failed.");
      }
    },

    async recordAnyPhoneAttempt(input): Promise<AnyPhoneAttemptOutcome> {
      const { data, error } = await db.rpc("core2_record_any_phone_attempt", {
        p_family_id: input.familyId,
        p_ok: input.ok,
        p_max_attempts: input.maxAttempts,
        p_lock_seconds: input.lockSeconds,
        p_now: input.nowIso,
      });
      const row = Array.isArray(data) ? (data[0] as Row | undefined) : (data as Row | undefined);
      if (error || !row) {
        throw new Core2ProofError("unavailable", 503, "Any-phone attempt check failed.");
      }
      return {
        locked: row.locked === true,
        lockedUntil: optStr(row.locked_until),
        failedAttempts: num(row.failed_attempts, 0),
        remainingAttempts: num(row.remaining_attempts, 0),
      };
    },

    async createAnyPhoneSession(input) {
      const { data, error } = await db
        .from("core2_any_phone_sessions")
        .insert({
          family_id: input.familyId,
          subject_person_id: input.subjectPersonId,
          incident_id: input.incidentId,
          request_id: input.requestId,
          call_ref_hash: input.callRefHash,
          granted_powers: [...input.grantedPowers],
          denied_powers: [...input.deniedPowers],
          code_word_rotated: input.codeWordRotated,
          status_message_hi: input.statusMessageHi,
          status_message_en: input.statusMessageEn,
        })
        .select("*")
        .single();
      if (error || !data) {
        throw new Core2ProofError("unavailable", 503, "Failed to persist any-phone session.");
      }
      return mapAnyPhoneSession(data as Row);
    },

    async getAnyPhoneSession(familyId, sessionId) {
      const { data, error } = await db
        .from("core2_any_phone_sessions")
        .select("*")
        .eq("family_id", familyId)
        .eq("id", sessionId)
        .maybeSingle();
      if (error) throw new Core2ProofError("unavailable", 503, "Any-phone session lookup failed.");
      return data ? mapAnyPhoneSession(data as Row) : null;
    },

    async getLatestAnyPhoneSession(familyId) {
      const { data, error } = await db
        .from("core2_any_phone_sessions")
        .select("*")
        .eq("family_id", familyId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Core2ProofError("unavailable", 503, "Any-phone session lookup failed.");
      return data ? mapAnyPhoneSession(data as Row) : null;
    },

    async attachVoiceToAnyPhoneSession(input) {
      const { data, error } = await db
        .from("core2_any_phone_sessions")
        .update({
          voice_post_id: input.voicePostId,
          voice_object_path: input.voiceObjectPath,
          updated_at: new Date().toISOString(),
        })
        .eq("family_id", input.familyId)
        .eq("id", input.sessionId)
        .select("*")
        .single();
      if (error || !data) {
        throw new Core2ProofError("unavailable", 503, "Failed to attach voice post to session.");
      }
      return mapAnyPhoneSession(data as Row);
    },

    async recordVoiceShareConsent(input) {
      const { data, error } = await db
        .from("consents")
        .insert({
          family_id: input.familyId,
          person_id: input.personId,
          purpose: voiceShareConsentPurpose(input.recipientId),
          question: "Consent to share recorded voice update with family.",
          answer: true,
          version: input.version,
        })
        .select("id")
        .single();
      if (error || !data) {
        throw new Core2ProofError("unavailable", 503, "Voice share consent insert failed.");
      }
      return { consentId: str((data as Row).id) };
    },

    async createVoicePostWithMedia(input) {
      const { data, error } = await db.rpc("create_family_voice_post", {
        p_family_id: input.familyId,
        p_sender_id: input.senderId,
        p_recipient_id: input.recipientId,
        p_object_path: input.objectPath,
        p_consent_id: input.consentId,
        p_reply_to: null,
      });
      const postId = (data as { voice_post_id?: unknown } | null)?.voice_post_id;
      if (error || typeof postId !== "string") {
        throw new Core2ProofError("unavailable", 503, "Voice post creation failed.");
      }
      return { voicePostId: postId };
    },
  };
}

export function createSupabaseProofStorage(db: SupabaseClient): ProofStoragePort {
  return {
    async readVoiceMediaForAnswer(input): Promise<VoiceAudioLookup | null> {
      let resolvedPath = input.mediaObjectPath ?? null;
      let voicePostId = input.voicePostId ?? null;
      let senderId = input.subjectPersonId;
      let recipientId = input.subjectPersonId;

      if (voicePostId) {
        const [{ data: post }, { data: media }] = await Promise.all([
          db
            .from("voice_posts")
            .select("id,family_id,sender_id,recipient_id")
            .eq("family_id", input.familyId)
            .eq("id", voicePostId)
            .maybeSingle(),
          db.rpc("get_voice_media_metadata", {
            p_family_id: input.familyId,
            p_post_id: voicePostId,
          }),
        ]);
        const postRow = post as Row | null;
        const mediaRow = media as Row | null;
        if (!postRow || !mediaRow || typeof mediaRow.object_path !== "string") {
          return null;
        }
        senderId = str(postRow.sender_id);
        recipientId = str(postRow.recipient_id);
        resolvedPath = str(mediaRow.object_path);
      }

      const candidatePaths: string[] = [];
      if (resolvedPath) {
        if (!validateObjectPath(resolvedPath, input.familyId)) {
          throw new Core2ProofError("forbidden", 403, "Voice media path outside caller family.");
        }
        candidatePaths.push(resolvedPath);
      } else if (input.voiceMediaId) {
        for (const ext of ["m4a", "ogg", "wav"] as const) {
          candidatePaths.push(`${input.familyId}/voice/${input.voiceMediaId}.${ext}`);
        }
      }

      for (const path of candidatePaths) {
        const { data, error } = await db.storage.from("sahaj-voice").download(path);
        if (!error && data) {
          const bytes = new Uint8Array(await data.arrayBuffer());
          return {
            voiceMediaId: input.voiceMediaId ?? null,
            voicePostId,
            senderId,
            recipientId,
            objectPath: path,
            contentType: data.type || contentTypeFromPath(path),
            durationS: null,
            bytes,
          };
        }
      }

      return null;
    },

    async uploadVoiceBytes(objectPath, bytes, contentType) {
      const { error } = await db.storage.from("sahaj-voice").upload(objectPath, bytes, {
        contentType,
        upsert: false,
      });
      if (error) {
        throw new Core2ProofError("storage_unavailable", 503, "Voice upload failed.");
      }
    },

    async createSignedVoiceUrl(input) {
      if (!validateObjectPath(input.objectPath, input.familyId)) {
        return null;
      }

      if (input.voicePostId) {
        const { data: post } = await db
          .from("voice_posts")
          .select("id,family_id,sender_id,recipient_id,consent_id")
          .eq("family_id", input.familyId)
          .eq("id", input.voicePostId)
          .maybeSingle();

        const p = post as Row | null;
        if (p) {
          const { data: consent } = await db
            .from("consents")
            .select("id,purpose,person_id,call_id,created_at,answer")
            .eq("family_id", input.familyId)
            .eq("id", str(p.consent_id))
            .maybeSingle();
          const c = consent as Row | null;
          if (!c || c.answer !== true) {
            return null;
          }
          const decision = await cedarMediaAuthorizer({
            action: "read_voice_media",
            familyId: input.familyId,
            actor: {
              userId: input.actorUserId,
              personId: input.actorPersonId,
              role: input.actorRole,
            },
            subject: {
              kind: "voice_post",
              id: str(p.id),
              senderId: str(p.sender_id),
              recipientId: str(p.recipient_id),
            },
            consent: {
              id: str(c.id),
              purpose: str(c.purpose),
              personId: str(c.person_id),
              callId: optStr(c.call_id),
              grantedAt: str(c.created_at),
            },
            object: {
              bucket: "sahaj-voice",
              path: input.objectPath,
              expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
            },
            now: new Date().toISOString(),
          });
          if (decision !== "allow") {
            return null;
          }
        }
      }

      const ttl = Math.min(Math.max(1, input.expiresInSeconds ?? MAX_SIGNED_URL_SECONDS), MAX_SIGNED_URL_SECONDS);
      const { data, error } = await db.storage.from("sahaj-voice").createSignedUrl(input.objectPath, ttl);
      if (error || !data?.signedUrl) return null;
      return { url: data.signedUrl, expiresInSeconds: ttl };
    },
  };
}

export function createProductionCore2ProofDeps(): Core2ProofDeps {
  const core2 = createProductionCore2Deps();
  const db = serviceDatabase();
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const publicBaseUrl = (process.env.TWILIO_VOICE_BASE_URL?.trim() ?? "").replace(/\/+$/, "");

  const sarvamApiKey = process.env.SARVAM_API_KEY?.trim() ?? "";
  const sarvamOrgId = process.env.SARVAM_ORG_ID?.trim() ?? "";
  const sarvamWorkspaceId = process.env.SARVAM_WORKSPACE_ID?.trim() ?? "";

  return {
    auth: core2.auth,
    core2Repo: core2.repo,
    proofRepo: createSupabaseProofRepo(db),
    storage: createSupabaseProofStorage(db),
    stt: createSaarasSttFromEnv(process.env),
    dispatch: core2.dispatch,
    gate: core2.gate,
    timeline: core2.timeline,
    crypto: core2.crypto,
    voiceNotifyDeps: createSupabaseVoiceNotifyDeps(db),
    sendPush: defaultSendExpoPush,
    verifyTwilioSignature(request, rawBody) {
      if (!authToken || !accountSid) return false;
      const reqUrl = new URL(request.url);
      const publicUrl = publicBaseUrl
        ? `${publicBaseUrl}${reqUrl.pathname}${reqUrl.search}`
        : request.url;
      return verifyTwilioFormSignature(
        publicUrl,
        new URLSearchParams(rawBody),
        request.headers.get("x-twilio-signature"),
        authToken,
      );
    },
    async fetchTwilioRecordingAudio({ recordingSid }) {
      const key = `any-phone-twilio:${recordingSid}`;
      const res = await fetchTwilioRecording(
        {
          transport: (url, init) => fetch(url, init),
          accountSid,
          authToken,
        },
        {
          personId: "any-phone",
          idempotencyKey: key,
          authorization: {
            decision: "allow",
            consent: true,
            personId: "any-phone",
            action: "twilio.recording.read",
            idempotencyKey: key,
            expiresAt: Date.now() + 60_000,
          },
          payload: { recordingSid },
        },
      );
      return {
        audio: res.data.audio,
        contentType: "audio/wav",
      };
    },
    async fetchSarvamRecordingAudio({ appId, interactionId }) {
      const key = `any-phone-sarvam:${interactionId}`;
      const res = await getSarvamRecording(
        {
          transport: (url, init) => fetch(url, init),
          apiKey: sarvamApiKey,
          orgId: sarvamOrgId,
          workspaceId: sarvamWorkspaceId,
        },
        {
          personId: "any-phone",
          idempotencyKey: key,
          authorization: {
            decision: "allow",
            consent: true,
            personId: "any-phone",
            action: "sarvam.recording.read",
            idempotencyKey: key,
            expiresAt: Date.now() + 60_000,
          },
          payload: { appId, interactionId },
        },
      );
      return {
        audio: res.data.audio,
        contentType: "audio/wav",
      };
    },
  };
}

export function getCore2ProofService() {
  return createCore2ProofService(createProductionCore2ProofDeps());
}
