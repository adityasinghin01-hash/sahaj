import { z } from 'zod';
import { ApiError } from './api';
import type { Session } from './session';
import type { RecordedVoiceClip } from './voice-recorder';

export const ProofChallengeSchema = z.object({
  id: z.string(),
  family_id: z.string(),
  requester_person_id: z.string(),
  subject_person_id: z.string(),
  word_token: z.string(),
  prompt_hi: z.string(),
  prompt_en: z.string(),
  status: z.enum(['pending', 'verified', 'word_mismatch', 'expired', 'escalated']),
  ttl_seconds: z.number(),
  expires_at: z.string(),
  answered_at: z.string().nullable(),
  verified_at: z.string().nullable(),
  escalated_at: z.string().nullable(),
  voice_media_id: z.string().nullable(),
  voice_post_id: z.string().nullable(),
  stt_matched: z.boolean(),
  incident_id: z.string().nullable(),
  offered_contact_name: z.string().nullable(),
  freshness_seconds: z.number().nullable(),
  freshness_stamp_hi: z.string().nullable(),
  freshness_stamp_en: z.string().nullable(),
  escalation_message_hi: z.string().nullable(),
  escalation_message_en: z.string().nullable(),
  media_url: z.string().nullable(),
  media_expires_in: z.number().nullable(),
  attempts: z.number(),
  created_at: z.string(),
});

export type ProofChallenge = z.infer<typeof ProofChallengeSchema>;

export const ProofChallengeGetResponseSchema = z.object({
  ok: z.literal(true),
  challenge: ProofChallengeSchema.nullable(),
});

export const ProofChallengeCreateResponseSchema = z.object({
  ok: z.literal(true),
  challenge: ProofChallengeSchema,
});

export const ProofChallengeAnswerResponseSchema = z.object({
  ok: z.literal(true),
  verified: z.boolean(),
  retry_allowed: z.boolean(),
  challenge: ProofChallengeSchema,
});

const VoiceUploadSchema = z.object({
  ok: z.literal(true),
  media_id: z.string(),
  media_object_path: z.string(),
  consent_id: z.string(),
});

export const DEMO_PROOF_WORDS = ['gulab', 'kamal', 'suraj', 'champa', 'koyal', 'tara'] as const;

export function createProofApi(session: Session) {
  const baseHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${session.token}`,
    };
    if (session.familyId) {
      headers['x-sahaj-family-id'] = session.familyId;
    }
    return headers;
  };

  async function requestJson<T>(
    path: string,
    schema: z.ZodType<T>,
    init?: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal },
  ): Promise<T> {
    const headers = baseHeaders();
    if (init?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${session.url}${path}`, {
      method: init?.method ?? 'GET',
      headers,
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: init?.signal ?? AbortSignal.timeout(15_000),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      const msg =
        json && typeof json === 'object' && 'message' in json && typeof json.message === 'string'
          ? json.message
          : 'Request failed.';
      throw new ApiError(response.status, msg);
    }
    return schema.parse(json);
  }

  return {
    getLatestChallenge: (signal?: AbortSignal) =>
      requestJson('/api/core2/proof', ProofChallengeGetResponseSchema, { method: 'GET', signal }),

    getChallengeById: (challengeId: string, signal?: AbortSignal) =>
      requestJson(
        `/api/core2/proof/${encodeURIComponent(challengeId)}`,
        ProofChallengeCreateResponseSchema,
        { method: 'GET', signal },
      ),

    createDemoChallenge: (signal?: AbortSignal) =>
      requestJson('/api/core2/proof', ProofChallengeCreateResponseSchema, {
        method: 'POST',
        body: {},
        signal,
      }),

    uploadAndAnswer: async (
      challenge: ProofChallenge,
      clip: RecordedVoiceClip,
      signal?: AbortSignal,
    ) => {
      const form = new FormData();
      form.append('recipient_person_id', challenge.requester_person_id);
      form.append('duration_s', String(Math.min(30, Math.max(1, clip.durationS))));
      form.append('consent_granted', 'true');

      if (clip.blob) {
        form.append('file', clip.blob, clip.filename);
      } else if (clip.fileUri) {
        if (clip.fileUri.startsWith('blob:') || clip.fileUri.startsWith('data:')) {
          const blob = await (await fetch(clip.fileUri)).blob();
          form.append('file', blob, clip.filename);
        } else {
          form.append(
            'file',
            {
              uri: clip.fileUri,
              name: clip.filename,
              type: clip.contentType,
            } as unknown as Blob,
          );
        }
      } else {
        throw new ApiError(400, 'No recorded audio clip available.');
      }

      const uploadRes = await fetch(`${session.url}/api/core1/voice-messages/upload`, {
        method: 'POST',
        headers: baseHeaders(),
        body: form,
        signal: signal ?? AbortSignal.timeout(20_000),
      });
      const uploadJson = await uploadRes.json().catch(() => null);
      if (!uploadRes.ok) {
        const msg =
          uploadJson &&
          typeof uploadJson === 'object' &&
          'message' in uploadJson &&
          typeof uploadJson.message === 'string'
            ? uploadJson.message
            : 'Voice upload failed.';
        throw new ApiError(uploadRes.status, msg);
      }
      const uploaded = VoiceUploadSchema.parse(uploadJson);

      return requestJson(
        `/api/core2/proof/${encodeURIComponent(challenge.id)}/answer`,
        ProofChallengeAnswerResponseSchema,
        {
          method: 'POST',
          body: {
            voice_media_id: uploaded.media_id,
            media_object_path: uploaded.media_object_path,
            duration_s: Math.min(30, Math.max(1, clip.durationS)),
          },
          signal,
        },
      );
    },
  };
}
