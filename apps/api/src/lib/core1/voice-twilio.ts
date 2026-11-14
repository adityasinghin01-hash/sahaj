/**
 * Twilio keypad voice message relay, DTMF menu/consent gather, and reply
 * recording callback handlers for Core 1 two-way voice.
 *
 * Rules upheld:
 * - Signature verification via @sahaj/adapters `verifyTwilioFormSignature`.
 * - AI narration explicitly disclosed (`AI_DISCLOSURE.Hindi` in adapters).
 * - Never synthesises or clones any family voice; plays real signed URL (<= 60 s).
 * - Recording happens only after explicit consent (`voice_share:<sender>`).
 * - Reply audio is fetched via @sahaj/adapters `fetchTwilioRecording` and
 *   stored privately in `sahaj-voice` (`<familyId>/voice/<id>.wav`).
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildRecordedVoiceRelayTwiml,
  buildRecordingConsentTwiml,
  buildReplyRecordingTwiml,
  fetchTwilioRecording,
  parseGatherReply,
  verifyTwilioFormSignature,
  type FetchTransport,
  type RecordingConsent,
} from '@sahaj/adapters';
import { MAX_SIGNED_URL_SECONDS } from '@/lib/media/contracts';
import { voiceShareConsentPurpose } from './voice-upload';
import { VoiceApiError, createSupabaseVoiceTimelinePort, type VoiceTimelinePort } from './voice-auth';
import {
  createSupabaseVoiceNotifyDeps,
  notifyVoicePost,
  type VoiceNotifyDeps,
} from './voice-notify';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_SID_RE = /^AC[a-f0-9]{32}$/i;
const CALL_SID_RE = /^CA[a-f0-9]{32}$/i;
const RECORDING_SID_RE = /^RE[a-f0-9]{32}$/i;

export interface VoicePostMetadata {
  id: string;
  familyId: string;
  senderId: string;
  recipientId: string;
  consentId: string;
  objectPath: string;
  consentGrantedAt: string;
  consentVersion: string;
}

export interface VoiceTwilioRepo {
  getVoicePostMeta: (postId: string) => Promise<VoicePostMetadata | null>;
  createSignedVoiceUrl: (objectPath: string, expiresInSeconds: number) => Promise<string | null>;
  markVoicePostHeard: (familyId: string, postId: string) => Promise<void>;
  findCallIdByExternalSid: (familyId: string, callSid: string) => Promise<string | null>;
  recordReplyConsent: (input: {
    familyId: string;
    personId: string;
    callId: string | null;
    purpose: string;
  }) => Promise<{ id: string; grantedAt: string; version: string }>;
  verifyReplyConsent: (
    familyId: string,
    consentId: string,
    personId: string,
    purpose: string,
  ) => Promise<boolean>;
  uploadReplyAudio: (
    objectPath: string,
    bytes: Uint8Array,
    contentType: 'audio/wav',
  ) => Promise<void>;
  createReplyVoicePost: (input: {
    familyId: string;
    senderId: string;
    recipientId: string;
    objectPath: string;
    consentId: string;
    replyToId: string;
  }) => Promise<{ voicePostId: string }>;
}

export interface VoiceTwilioDeps {
  accountSid: string;
  authToken: string;
  publicBaseUrl: string;
  allowedRecordingHosts: readonly string[];
  transport: FetchTransport;
  repo: VoiceTwilioRepo;
  timeline?: VoiceTimelinePort;
  notifyDeps?: VoiceNotifyDeps;
  notifyOnReply?: (deps: VoiceNotifyDeps, input: {
    familyId: string;
    voicePostId: string;
    senderId: string;
    recipientId: string;
    replyToId: string;
  }) => Promise<unknown>;
  now?: () => Date;
  newId?: () => string;
}

export function createSupabaseVoiceTwilioDeps(db: SupabaseClient): VoiceTwilioDeps {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? '';
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() ?? '';
  const publicBaseUrl = (process.env.TWILIO_VOICE_BASE_URL?.trim() ?? '').replace(/\/+$/, '');
  const supabaseHost = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : '';
  const allowedRecordingHosts = (
    process.env.TWILIO_ALLOWED_RECORDING_HOSTS
      ? process.env.TWILIO_ALLOWED_RECORDING_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)
      : supabaseHost
        ? [supabaseHost]
        : []
  );

  const repo: VoiceTwilioRepo = {
    async getVoicePostMeta(postId) {
      const { data: post, error: pErr } = await db
        .from('voice_posts')
        .select('id,family_id,sender_id,recipient_id,consent_id')
        .eq('id', postId)
        .maybeSingle();
      if (pErr || !post) return null;
      const p = post as Record<string, unknown>;
      const familyId = String(p.family_id);
      const consentId = String(p.consent_id);

      const [{ data: media }, { data: consent }] = await Promise.all([
        db.rpc('get_voice_media_metadata', { p_family_id: familyId, p_post_id: postId }),
        db
          .from('consents')
          .select('id,created_at,version,answer')
          .eq('family_id', familyId)
          .eq('id', consentId)
          .maybeSingle(),
      ]);

      const mediaRow = media as { object_path?: string } | null;
      const consentRow = consent as { created_at?: string; version?: string; answer?: boolean } | null;
      if (!mediaRow?.object_path || !consentRow || consentRow.answer !== true) {
        return null;
      }

      return {
        id: String(p.id),
        familyId,
        senderId: String(p.sender_id),
        recipientId: String(p.recipient_id),
        consentId,
        objectPath: mediaRow.object_path,
        consentGrantedAt: String(consentRow.created_at ?? new Date().toISOString()),
        consentVersion: String(consentRow.version ?? 'voice-v1'),
      };
    },
    async createSignedVoiceUrl(objectPath, expiresInSeconds) {
      const ttl = Math.min(Math.max(1, Math.trunc(expiresInSeconds)), MAX_SIGNED_URL_SECONDS);
      const { data, error } = await db.storage
        .from('sahaj-voice')
        .createSignedUrl(objectPath, ttl);
      if (error || !data?.signedUrl) return null;
      return data.signedUrl;
    },
    async markVoicePostHeard(familyId, postId) {
      await db
        .from('voice_posts')
        .update({ state: 'heard' })
        .eq('family_id', familyId)
        .eq('id', postId);
    },
    async findCallIdByExternalSid(familyId, callSid) {
      const { data } = await db
        .from('calls')
        .select('id')
        .eq('family_id', familyId)
        .eq('external_id', callSid)
        .maybeSingle();
      return data ? String((data as { id: string }).id) : null;
    },
    async recordReplyConsent({ familyId, personId, callId, purpose }) {
      const { data, error } = await db
        .from('consents')
        .insert({
          family_id: familyId,
          person_id: personId,
          call_id: callId,
          purpose,
          question: 'Kya aap apna jawab record karne ki anumati dete hain?',
          answer: true,
          version: 'twilio-voice-v1',
        })
        .select('id,created_at,version')
        .single();
      if (error || !data) throw new VoiceApiError('consent_insert_failed', 503);
      const row = data as Record<string, unknown>;
      return {
        id: String(row.id),
        grantedAt: String(row.created_at),
        version: String(row.version),
      };
    },
    async verifyReplyConsent(familyId, consentId, personId, purpose) {
      const { data, error } = await db
        .from('consents')
        .select('id,family_id,person_id,purpose,answer')
        .eq('family_id', familyId)
        .eq('id', consentId)
        .maybeSingle();
      if (error || !data) return false;
      const row = data as Record<string, unknown>;
      return (
        row.person_id === personId &&
        row.purpose === purpose &&
        row.answer === true
      );
    },
    async uploadReplyAudio(objectPath, bytes, contentType) {
      const { error } = await db.storage.from('sahaj-voice').upload(objectPath, bytes, {
        contentType,
        upsert: false,
      });
      if (error) throw new VoiceApiError('reply_upload_failed', 503);
    },
    async createReplyVoicePost(input) {
      const { data, error } = await db.rpc('create_family_voice_post', {
        p_family_id: input.familyId,
        p_sender_id: input.senderId,
        p_recipient_id: input.recipientId,
        p_object_path: input.objectPath,
        p_consent_id: input.consentId,
        p_reply_to: input.replyToId,
      });
      if (error || !data || typeof (data as { voice_post_id?: string }).voice_post_id !== 'string') {
        throw new VoiceApiError('create_reply_post_failed', 503);
      }
      return { voicePostId: (data as { voice_post_id: string }).voice_post_id };
    },
  };

  return {
    accountSid,
    authToken,
    publicBaseUrl,
    allowedRecordingHosts,
    transport: (url, init) => fetch(url, init),
    repo,
    timeline: createSupabaseVoiceTimelinePort(db),
    notifyDeps: createSupabaseVoiceNotifyDeps(db),
  };
}

function buildPublicWebhookUrl(request: Request, configuredBaseUrl: string): string {
  const reqUrl = new URL(request.url);
  if (configuredBaseUrl) {
    return `${configuredBaseUrl.replace(/\/+$/, '')}${reqUrl.pathname}${reqUrl.search}`;
  }
  return request.url;
}

async function readVerifiedFormParams(
  request: Request,
  deps: VoiceTwilioDeps,
): Promise<{ params: URLSearchParams; reqUrl: URL }> {
  if (!deps.authToken || !ACCOUNT_SID_RE.test(deps.accountSid)) {
    throw new VoiceApiError('twilio_not_configured', 503);
  }
  const reqUrl = new URL(request.url);
  const signature = request.headers.get('x-twilio-signature');
  const publicUrl = buildPublicWebhookUrl(request, deps.publicBaseUrl);
  const rawBody = request.method === 'GET' ? '' : await request.text();
  const params = new URLSearchParams(rawBody);
  const valid = verifyTwilioFormSignature(publicUrl, params, signature, deps.authToken);
  if (!valid) {
    throw new VoiceApiError('invalid_twilio_signature', 401);
  }
  return { params, reqUrl };
}

function buildRelayForPost(
  meta: VoicePostMetadata,
  signedUrl: string,
  deps: VoiceTwilioDeps,
): string {
  const base = deps.publicBaseUrl.replace(/\/+$/, '');
  const gatherAction = `${base}/api/core1/voice-messages/twilio/gather?postId=${encodeURIComponent(meta.id)}&step=menu`;
  const consent: RecordingConsent = {
    granted: true,
    personId: meta.senderId,
    recordingId: meta.id,
  };
  return buildRecordedVoiceRelayTwiml({
    recordingUrl: signedUrl,
    allowedRecordingHosts: deps.allowedRecordingHosts,
    consent,
    personId: meta.senderId,
    recordingId: meta.id,
    actionUrl: gatherAction,
    promptHindi: 'सुनने के लिए 1 दबाएँ, जवाब देने के लिए 2 दबाएँ।',
  });
}

export async function handleTwilioVoiceTwiml(
  request: Request,
  deps: VoiceTwilioDeps,
): Promise<{ status: number; xml: string }> {
  const { reqUrl } = await readVerifiedFormParams(request, deps);
  const postId = reqUrl.searchParams.get('postId') ?? '';
  if (!UUID_RE.test(postId)) {
    throw new VoiceApiError('invalid_post_id', 400);
  }
  const meta = await deps.repo.getVoicePostMeta(postId);
  if (!meta) {
    throw new VoiceApiError('voice_post_not_found', 404);
  }
  const signedUrl = await deps.repo.createSignedVoiceUrl(meta.objectPath, MAX_SIGNED_URL_SECONDS);
  if (!signedUrl) {
    throw new VoiceApiError('signed_url_failed', 503);
  }
  const xml = buildRelayForPost(meta, signedUrl, deps);
  return { status: 200, xml };
}

export async function handleTwilioVoiceGather(
  request: Request,
  deps: VoiceTwilioDeps,
): Promise<{ status: number; xml: string }> {
  const { params, reqUrl } = await readVerifiedFormParams(request, deps);
  const postId = reqUrl.searchParams.get('postId') ?? '';
  const step = reqUrl.searchParams.get('step') ?? 'menu';
  if (!UUID_RE.test(postId)) {
    throw new VoiceApiError('invalid_post_id', 400);
  }
  const meta = await deps.repo.getVoicePostMeta(postId);
  if (!meta) {
    throw new VoiceApiError('voice_post_not_found', 404);
  }

  const base = deps.publicBaseUrl.replace(/\/+$/, '');
  const callSid = params.get('CallSid');

  if (step === 'consent') {
    const reply = parseGatherReply(params);
    if (reply.choice !== 'yes') {
      const declineUrl = `${base}/api/core1/voice-messages/twilio/recording?postId=${encodeURIComponent(postId)}`;
      return { status: 200, xml: buildReplyRecordingTwiml(reply, declineUrl) };
    }
    const callId =
      callSid && CALL_SID_RE.test(callSid)
        ? await deps.repo.findCallIdByExternalSid(meta.familyId, callSid)
        : null;
    const consent = await deps.repo.recordReplyConsent({
      familyId: meta.familyId,
      personId: meta.recipientId,
      callId,
      purpose: voiceShareConsentPurpose(meta.senderId),
    });
    const recordingCallback = `${base}/api/core1/voice-messages/twilio/recording?postId=${encodeURIComponent(postId)}&consentId=${encodeURIComponent(consent.id)}`;
    return { status: 200, xml: buildReplyRecordingTwiml(reply, recordingCallback) };
  }

  // Menu step: Digit 1 replays message; Digit 2 starts consent-gated reply recording.
  const digit = params.get('Digits')?.trim();
  const parsed = parseGatherReply(params);
  if (digit === '1' || parsed.choice === 'yes') {
    await deps.repo.markVoicePostHeard(meta.familyId, meta.id);
    if (deps.timeline) {
      await deps.timeline.append({
        familyId: meta.familyId,
        eventId: (deps.newId ?? randomUUID)(),
        dedupeKey: `voice_heard_keypad:${meta.id}`,
        eventType: 'voice_post.heard',
        entityId: meta.id,
        humanLine: 'Recipient replayed voice message on keypad phone.',
        payload: { channel: 'keypad_call' },
      });
    }
    const signedUrl = await deps.repo.createSignedVoiceUrl(
      meta.objectPath,
      MAX_SIGNED_URL_SECONDS,
    );
    if (!signedUrl) {
      throw new VoiceApiError('signed_url_failed', 503);
    }
    return { status: 200, xml: buildRelayForPost(meta, signedUrl, deps) };
  }

  if (digit === '2' || parsed.choice === 'no') {
    const consentActionUrl = `${base}/api/core1/voice-messages/twilio/gather?postId=${encodeURIComponent(postId)}&step=consent`;
    return { status: 200, xml: buildRecordingConsentTwiml(consentActionUrl) };
  }

  return {
    status: 200,
    xml: '<?xml version="1.0" encoding="UTF-8"?><Response><Say language="hi-IN">ठीक है, धन्यवाद।</Say><Hangup/></Response>',
  };
}

export async function handleTwilioVoiceRecording(
  request: Request,
  deps: VoiceTwilioDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { params, reqUrl } = await readVerifiedFormParams(request, deps);
  const postId = reqUrl.searchParams.get('postId') ?? '';
  const consentId = reqUrl.searchParams.get('consentId') ?? '';
  if (!UUID_RE.test(postId) || !UUID_RE.test(consentId)) {
    throw new VoiceApiError('invalid_recording_callback_params', 400);
  }

  const accountSid = params.get('AccountSid');
  if (accountSid && accountSid !== deps.accountSid) {
    throw new VoiceApiError('unknown_twilio_account', 403);
  }
  const recordingStatus = params.get('RecordingStatus');
  if (recordingStatus && recordingStatus !== 'completed') {
    return { status: 200, body: { ok: true, ignored: recordingStatus } };
  }
  const recordingSid = params.get('RecordingSid') ?? '';
  if (!RECORDING_SID_RE.test(recordingSid)) {
    throw new VoiceApiError('invalid_recording_sid', 400);
  }

  const meta = await deps.repo.getVoicePostMeta(postId);
  if (!meta) {
    throw new VoiceApiError('voice_post_not_found', 404);
  }

  // Maa (meta.recipientId) replies to Riya (meta.senderId); verify consent for voice_share:<senderId>.
  const consentValid = await deps.repo.verifyReplyConsent(
    meta.familyId,
    consentId,
    meta.recipientId,
    voiceShareConsentPurpose(meta.senderId),
  );
  if (!consentValid) {
    throw new VoiceApiError('reply_consent_required', 403);
  }

  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const idempotencyKey = `twilio-voice-rec:${recordingSid}`;
  const rec = await fetchTwilioRecording(
    {
      transport: deps.transport,
      accountSid: deps.accountSid,
      authToken: deps.authToken,
    },
    {
      personId: meta.recipientId,
      idempotencyKey,
      authorization: {
        decision: 'allow',
        consent: true,
        personId: meta.recipientId,
        action: 'twilio.recording.read',
        idempotencyKey,
        expiresAt: nowMs + 60_000,
      },
      payload: { recordingSid },
    },
  );

  const newId = deps.newId ?? randomUUID;
  const replyObjectPath = `${meta.familyId}/voice/${newId()}.wav`;
  await deps.repo.uploadReplyAudio(replyObjectPath, rec.data.audio, rec.data.contentType);

  const created = await deps.repo.createReplyVoicePost({
    familyId: meta.familyId,
    senderId: meta.recipientId,
    recipientId: meta.senderId,
    objectPath: replyObjectPath,
    consentId,
    replyToId: meta.id,
  });

  if (deps.timeline) {
    await deps.timeline.append({
      familyId: meta.familyId,
      eventId: newId(),
      dedupeKey: `voice_reply_recorded:${recordingSid}`,
      eventType: 'voice_post.reply_recorded',
      entityId: created.voicePostId,
      humanLine: 'Recorded keypad voice reply from family member.',
      payload: { replyToId: meta.id },
    });
  }

  if (deps.notifyDeps) {
    const notifier = deps.notifyOnReply ?? notifyVoicePost;
    await notifier(deps.notifyDeps, {
      familyId: meta.familyId,
      voicePostId: created.voicePostId,
      senderId: meta.recipientId,
      recipientId: meta.senderId,
      replyToId: meta.id,
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      reply_voice_post_id: created.voicePostId,
      reply_to: meta.id,
    },
  };
}
