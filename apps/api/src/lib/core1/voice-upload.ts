/**
 * Private voice clip upload for Core 1 two-way voice (Riya -> Maa, or replies).
 * Validates format (m4a/aac/ogg), size (<= 5 MB), duration (<= 60 s),
 * recipient membership, and active voice_share:<recipient> consent before
 * uploading privately to the `sahaj-voice` bucket. Never emits public URLs.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConsentRow } from '@/lib/media/contracts';
import { consentIsCurrent } from '@/lib/media/consent';

export const voiceShareConsentPurpose = (recipientPersonId: string): string =>
  `voice_share:${recipientPersonId}`;
import { objectFitsBucket, validateObjectPath } from '@/lib/media/paths';
import { CONSENT_HISTORY_LIMIT } from '@/lib/media/supabase';
import {
  createSupabaseVoiceAuthPorts,
  resolveVoiceActor,
  type VoiceActor,
  VoiceApiError,
  type VoiceAuthPorts,
} from './voice-auth';

export const VOICE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const VOICE_UPLOAD_MAX_DURATION_S = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ResolvedAudioFormat {
  ext: 'm4a' | 'ogg';
  storedContentType: 'audio/mp4' | 'audio/ogg';
}

const MIME_MAP: Record<string, ResolvedAudioFormat> = {
  'audio/mp4': { ext: 'm4a', storedContentType: 'audio/mp4' },
  'audio/m4a': { ext: 'm4a', storedContentType: 'audio/mp4' },
  'audio/x-m4a': { ext: 'm4a', storedContentType: 'audio/mp4' },
  'audio/aac': { ext: 'm4a', storedContentType: 'audio/mp4' },
  'audio/x-aac': { ext: 'm4a', storedContentType: 'audio/mp4' },
  'audio/ogg': { ext: 'ogg', storedContentType: 'audio/ogg' },
};

export function resolveVoiceUploadFormat(
  rawContentType: string | null | undefined,
  filename?: string | null,
): ResolvedAudioFormat {
  const baseMime = (rawContentType ?? '').split(';')[0].trim().toLowerCase();
  if (baseMime && baseMime !== 'application/octet-stream') {
    const mapped = MIME_MAP[baseMime];
    if (!mapped) {
      throw new VoiceApiError(
        'unsupported_media_type',
        415,
        'Only m4a, aac, or ogg voice recordings are allowed.',
      );
    }
    return mapped;
  }

  const extMatch = (filename ?? '').trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = extMatch?.[1];
  if (ext === 'm4a' || ext === 'aac' || ext === 'mp4') {
    return { ext: 'm4a', storedContentType: 'audio/mp4' };
  }
  if (ext === 'ogg') {
    return { ext: 'ogg', storedContentType: 'audio/ogg' };
  }

  throw new VoiceApiError(
    'unsupported_media_type',
    415,
    'Only m4a, aac, or ogg voice recordings are allowed.',
  );
}

export interface VoiceUploadInput {
  bytes: Uint8Array;
  contentType: string;
  filename?: string | null;
  recipientPersonId: string;
  durationS?: number | null;
  consentId?: string | null;
  consentGranted?: boolean;
}

export interface VoiceUploadRepo {
  personExistsInFamily: (familyId: string, personId: string) => Promise<boolean>;
  listConsents: (familyId: string, personId: string) => Promise<ConsentRow[]>;
  grantConsent: (input: {
    familyId: string;
    personId: string;
    purpose: string;
    question: string;
    version: string;
  }) => Promise<ConsentRow>;
  uploadVoiceObject: (
    objectPath: string,
    bytes: Uint8Array,
    contentType: string,
  ) => Promise<void>;
}

export interface VoiceUploadDeps {
  auth: VoiceAuthPorts;
  repo: VoiceUploadRepo;
  now?: () => Date;
  newId?: () => string;
}

export interface VoiceUploadResult {
  ok: true;
  media_id: string;
  media_object_path: string;
  mediaObjectPath: string;
  consent_id: string;
  consentId: string;
  content_type: 'audio/mp4' | 'audio/ogg';
  size_bytes: number;
  duration_s: number | null;
}

export function createSupabaseVoiceUploadDeps(db: SupabaseClient): VoiceUploadDeps {
  return {
    auth: createSupabaseVoiceAuthPorts(db),
    repo: {
      async personExistsInFamily(familyId, personId) {
        const { data, error } = await db
          .from('people')
          .select('id')
          .eq('family_id', familyId)
          .eq('id', personId)
          .maybeSingle();
        if (error) throw new VoiceApiError('recipient_lookup_failed', 503);
        return Boolean(data);
      },
      async listConsents(familyId, personId) {
        const { data, error } = await db
          .from('consents')
          .select('id,family_id,person_id,call_id,purpose,answer,version,created_at')
          .eq('family_id', familyId)
          .eq('person_id', personId)
          .order('created_at', { ascending: false })
          .limit(CONSENT_HISTORY_LIMIT);
        if (error) throw new VoiceApiError('consent_lookup_failed', 503);
        return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
          id: String(row.id),
          familyId: String(row.family_id),
          personId: String(row.person_id),
          callId: row.call_id === null || row.call_id === undefined ? null : String(row.call_id),
          purpose: String(row.purpose),
          answer: row.answer === true,
          version: String(row.version),
          createdAt: String(row.created_at),
        }));
      },
      async grantConsent(input) {
        const { data, error } = await db
          .from('consents')
          .insert({
            family_id: input.familyId,
            person_id: input.personId,
            purpose: input.purpose,
            question: input.question,
            answer: true,
            version: input.version,
          })
          .select('id,family_id,person_id,call_id,purpose,answer,version,created_at')
          .single();
        if (error || !data) {
          throw new VoiceApiError('consent_record_failed', 503);
        }
        const row = data as Record<string, unknown>;
        return {
          id: String(row.id),
          familyId: String(row.family_id),
          personId: String(row.person_id),
          callId: row.call_id === null || row.call_id === undefined ? null : String(row.call_id),
          purpose: String(row.purpose),
          answer: row.answer === true,
          version: String(row.version),
          createdAt: String(row.created_at),
        };
      },
      async uploadVoiceObject(objectPath, bytes, contentType) {
        const { error } = await db.storage.from('sahaj-voice').upload(objectPath, bytes, {
          contentType,
          upsert: false,
        });
        if (error) {
          throw new VoiceApiError('storage_upload_failed', 503);
        }
      },
    },
  };
}

function parseOptionalDuration(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new VoiceApiError('invalid_audio_duration', 400, 'Duration must be greater than 0 s.');
  }
  if (parsed > VOICE_UPLOAD_MAX_DURATION_S) {
    throw new VoiceApiError(
      'audio_too_long',
      400,
      `Voice clip exceeds maximum ${VOICE_UPLOAD_MAX_DURATION_S} s duration.`,
    );
  }
  return parsed;
}

export async function parseVoiceUploadRequest(request: Request): Promise<VoiceUploadInput> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('multipart/form-data')) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new VoiceApiError('invalid_form_data', 400);
    }

    const fileEntry = form.get('file') ?? form.get('audio');
    if (!fileEntry || typeof fileEntry === 'string') {
      throw new VoiceApiError('missing_audio_file', 400);
    }

    const recipientRaw =
      form.get('recipient_person_id') ?? form.get('recipientPersonId') ?? '';
    const consentIdRaw = form.get('consent_id') ?? form.get('consentId') ?? '';
    const consentGrantedRaw =
      form.get('consent_granted') ?? form.get('consentGranted') ?? '';
    const durationRaw =
      form.get('duration_s') ?? form.get('durationS') ?? form.get('durationSeconds');
    const durationMsRaw = form.get('duration_ms') ?? form.get('durationMs');

    let durationS = parseOptionalDuration(durationRaw);
    if (durationS === null && durationMsRaw !== null && durationMsRaw !== '') {
      const ms = Number(String(durationMsRaw).trim());
      durationS = parseOptionalDuration(Number.isFinite(ms) ? ms / 1000 : ms);
    }

    const bytes = new Uint8Array(await fileEntry.arrayBuffer());
    return {
      bytes,
      contentType: fileEntry.type || 'application/octet-stream',
      filename: 'name' in fileEntry ? fileEntry.name : null,
      recipientPersonId: String(recipientRaw).trim(),
      durationS,
      consentId: consentIdRaw ? String(consentIdRaw).trim() : null,
      consentGranted:
        String(consentGrantedRaw).trim().toLowerCase() === 'true' ||
        String(consentGrantedRaw).trim() === '1',
    };
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new VoiceApiError('invalid_request_body', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new VoiceApiError('invalid_request_body', 400);
  }

  const audioBase64 = body.audio_base64 ?? body.audioBase64;
  if (typeof audioBase64 !== 'string' || !audioBase64.trim()) {
    throw new VoiceApiError('missing_audio_data', 400);
  }
  const cleanB64 = audioBase64.replace(/^data:[^;]+;base64,/, '').trim();
  const bytes = new Uint8Array(Buffer.from(cleanB64, 'base64'));

  const durationRaw = body.duration_s ?? body.durationS ?? body.durationSeconds;
  const durationMsRaw = body.duration_ms ?? body.durationMs;
  let durationS = parseOptionalDuration(durationRaw);
  if (durationS === null && durationMsRaw !== undefined && durationMsRaw !== null) {
    durationS = parseOptionalDuration(
      typeof durationMsRaw === 'number' ? durationMsRaw / 1000 : Number(durationMsRaw) / 1000,
    );
  }

  return {
    bytes,
    contentType: String(body.content_type ?? body.contentType ?? 'application/octet-stream'),
    filename: typeof body.filename === 'string' ? body.filename : null,
    recipientPersonId: String(body.recipient_person_id ?? body.recipientPersonId ?? '').trim(),
    durationS,
    consentId:
      typeof (body.consent_id ?? body.consentId) === 'string'
        ? String(body.consent_id ?? body.consentId).trim()
        : null,
    consentGranted: (body.consent_granted ?? body.consentGranted) === true,
  };
}

export async function handleVoiceUpload(
  request: Request,
  deps: VoiceUploadDeps,
): Promise<{ status: number; body: VoiceUploadResult; actor: VoiceActor }> {
  const actor = await resolveVoiceActor(request, deps.auth);
  const input = await parseVoiceUploadRequest(request);

  if (!UUID_RE.test(input.recipientPersonId)) {
    throw new VoiceApiError('invalid_recipient_person_id', 400);
  }
  if (input.consentId && !UUID_RE.test(input.consentId)) {
    throw new VoiceApiError('invalid_consent_id', 400);
  }

  if (input.bytes.byteLength === 0) {
    throw new VoiceApiError('empty_audio', 400, 'Audio clip must not be empty.');
  }
  if (input.bytes.byteLength > VOICE_UPLOAD_MAX_BYTES) {
    throw new VoiceApiError(
      'payload_too_large',
      413,
      `Voice clip exceeds maximum size of ${VOICE_UPLOAD_MAX_BYTES} bytes (5 MB).`,
    );
  }

  const format = resolveVoiceUploadFormat(input.contentType, input.filename);
  if (!objectFitsBucket('sahaj-voice', { size: input.bytes.byteLength, contentType: format.storedContentType })) {
    throw new VoiceApiError('unsupported_media_type', 415);
  }

  const recipientInFamily = await deps.repo.personExistsInFamily(
    actor.familyId,
    input.recipientPersonId,
  );
  if (!recipientInFamily) {
    throw new VoiceApiError('recipient_not_in_family', 403);
  }

  const purpose = voiceShareConsentPurpose(input.recipientPersonId);
  const now = (deps.now ?? (() => new Date()))();
  const history = await deps.repo.listConsents(actor.familyId, actor.personId);

  let activeConsent: ConsentRow | null = null;
  if (input.consentId) {
    const linked = history.find((c) => c.id === input.consentId) ?? null;
    if (
      consentIsCurrent({
        linked,
        history,
        familyId: actor.familyId,
        personId: actor.personId,
        purpose,
        now,
      })
    ) {
      activeConsent = linked;
    } else {
      throw new VoiceApiError(
        'consent_required',
        403,
        `Active recording consent (${purpose}) is required.`,
      );
    }
  } else {
    const candidate = history.find(
      (c) =>
        c.familyId === actor.familyId &&
        c.personId === actor.personId &&
        c.purpose === purpose &&
        c.answer === true,
    );
    if (
      candidate &&
      consentIsCurrent({
        linked: candidate,
        history,
        familyId: actor.familyId,
        personId: actor.personId,
        purpose,
        now,
      })
    ) {
      activeConsent = candidate;
    } else if (input.consentGranted === true) {
      activeConsent = await deps.repo.grantConsent({
        familyId: actor.familyId,
        personId: actor.personId,
        purpose,
        question: 'Consent to share recorded voice message with family recipient.',
        version: 'voice-v1',
      });
    } else {
      throw new VoiceApiError(
        'consent_required',
        403,
        `Active recording consent (${purpose}) is required.`,
      );
    }
  }

  const mediaId = (deps.newId ?? randomUUID)();
  const objectPath = `${actor.familyId}/voice/${mediaId}.${format.ext}`;
  const pathCheck = validateObjectPath(objectPath, actor.familyId);
  if (!pathCheck) {
    throw new VoiceApiError('invalid_object_path', 500);
  }

  await deps.repo.uploadVoiceObject(objectPath, input.bytes, format.storedContentType);

  return {
    status: 201,
    actor,
    body: {
      ok: true,
      media_id: mediaId,
      media_object_path: objectPath,
      mediaObjectPath: objectPath,
      consent_id: activeConsent!.id,
      consentId: activeConsent!.id,
      content_type: format.storedContentType,
      size_bytes: input.bytes.byteLength,
      duration_s: input.durationS ?? null,
    },
  };
}
