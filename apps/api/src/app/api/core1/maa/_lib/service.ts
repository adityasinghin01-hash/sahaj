import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { computePayloadHash, deriveScopedIdempotencyKey } from '@/lib/core1/idempotency';
import { isValidUuid, readCommandBody, validateIdempotencyKey, validateMediaObjectPath } from '@/lib/core1/validation';
import { consentIsCurrent, latestConsent } from '@/lib/media/consent';
import {
  MAX_SIGNED_URL_SECONDS,
  MEDIA_BUCKETS,
  voiceShareConsentPurpose,
  type ConsentRow,
  type MediaAuthorizationContext,
} from '@/lib/media/contracts';
import { objectFitsBucket, validateObjectPath } from '@/lib/media/paths';
import { encryptWebhook } from '@/lib/webhook-security';
import { verifyMaaDeviceRequest, type ReplayGuard } from './device-auth';
import type {
  MaaIncidentAssignmentRecord,
  MaaPersonRecord,
  MaaRepo,
  MaaUrgentIncidentRecord,
  MaaUrgentState,
  MaaVoicePostRecord,
} from './repo';
import {
  MAA_SECURITY_HEADERS,
  MaaRouteError,
  type MaaUrgentStatusResponse,
  type MaaVoiceItem,
  type MaaVoiceListResponse,
  type MaaVoicePlayedResponse,
  type MaaVoiceReplyResponse,
  type VerifiedMaaDevice,
} from './types';

const VOICE_REPLY_MAX_REQUEST_BYTES = 22 * 1024 * 1024;
const MIME_TO_AUDIO: Record<string, { normalizedMime: 'audio/mpeg' | 'audio/wav' | 'audio/ogg' | 'audio/mp4'; ext: string }> = {
  'audio/mpeg': { normalizedMime: 'audio/mpeg', ext: 'mp3' },
  'audio/mp3': { normalizedMime: 'audio/mpeg', ext: 'mp3' },
  'audio/wav': { normalizedMime: 'audio/wav', ext: 'wav' },
  'audio/x-wav': { normalizedMime: 'audio/wav', ext: 'wav' },
  'audio/ogg': { normalizedMime: 'audio/ogg', ext: 'ogg' },
  'audio/mp4': { normalizedMime: 'audio/mp4', ext: 'm4a' },
  'audio/m4a': { normalizedMime: 'audio/mp4', ext: 'm4a' },
  'audio/x-m4a': { normalizedMime: 'audio/mp4', ext: 'm4a' },
  'audio/aac': { normalizedMime: 'audio/mp4', ext: 'm4a' },
};

export interface MaaServiceDeps {
  repo: MaaRepo;
  pairingSecret?: string;
  encryptionKeyHex?: string;
  now?: () => Date;
  replayGuard?: ReplayGuard;
  signedUrlSeconds?: number;
  onUrgentIncidentCreated?: (event: {
    familyId: string;
    incidentId: string;
    subjectPersonId: string;
    severity: 'routine' | 'urgent' | 'critical';
    assignments: MaaIncidentAssignmentRecord[];
    state: MaaUrgentState;
  }) => Promise<void>;
}

function nowOf(deps: MaaServiceDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function jsonResponse(body: unknown, status = 200): Response {
  return NextResponse.json(body, {
    status,
    headers: MAA_SECURITY_HEADERS,
  });
}

export function errorJsonResponse(error: unknown): Response {
  if (error instanceof MaaRouteError) {
    return jsonResponse({ error: error.code }, error.status);
  }
  if (error instanceof Error && 'status' in error && 'code' in error) {
    const status = Number((error as { status: unknown }).status);
    const code = String((error as { code: unknown }).code);
    if (Number.isInteger(status) && status >= 400 && status <= 599) {
      return jsonResponse({ error: code }, status);
    }
  }
  return jsonResponse({ error: 'internal_error' }, 500);
}

function parseJsonObject(raw: Buffer): Record<string, unknown> {
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new MaaRouteError('malformed_json_body', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MaaRouteError('invalid_json_object', 400);
  }
  return parsed as Record<string, unknown>;
}

function assertActorScopeMatch(
  device: VerifiedMaaDevice,
  input: Record<string, unknown>,
  url?: URL,
): void {
  const familyCandidate =
    input.family_id ?? input.familyId ?? url?.searchParams.get('family_id') ?? url?.searchParams.get('familyId');
  if (typeof familyCandidate === 'string' && familyCandidate.length > 0 && familyCandidate !== device.familyId) {
    throw new MaaRouteError('cross_family_mismatch', 403);
  }

  const personCandidate =
    input.person_id ??
    input.personId ??
    input.sender_id ??
    input.senderId ??
    input.subject_person_id ??
    input.subjectPersonId ??
    url?.searchParams.get('person_id') ??
    url?.searchParams.get('personId');
  if (typeof personCandidate === 'string' && personCandidate.length > 0 && personCandidate !== device.personId) {
    throw new MaaRouteError('actor_person_mismatch', 403);
  }
}

function assertAllowedKeys(input: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new MaaRouteError(`unknown_field_${key}`, 400);
    }
  }
}

function readIdempotencyKey(request: Request, body: Record<string, unknown>): string | null {
  const raw = request.headers.get('idempotency-key') ?? body.idempotency_key ?? body.idempotencyKey;
  if (raw === undefined || raw === null || raw === '') return null;
  return validateIdempotencyKey(raw);
}

async function maybePersistEncryptedCommand(
  deps: MaaServiceDeps,
  params: {
    familyId: string;
    actorPersonId: string;
    commandType: 'voice_message' | 'urgent_help';
    scopedKey: string;
    bodyHash: string;
    entityId: string;
    safePayload: Record<string, unknown>;
  },
): Promise<void> {
  const keyHex = deps.encryptionKeyHex ?? process.env.WEBHOOK_ENCRYPTION_KEY ?? '';
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) {
    return;
  }

  const plaintext = Buffer.from(JSON.stringify(params.safePayload), 'utf8');
  const ciphertext = encryptWebhook(plaintext, keyHex, `core1:${params.familyId}:${params.scopedKey}`);
  await deps.repo.persistCommandEvent({
    eventId: randomUUID(),
    familyId: params.familyId,
    scopedIdempotencyKey: params.scopedKey,
    payloadHash: params.bodyHash,
    payloadCiphertext: ciphertext,
    commandType: params.commandType,
    actorPersonId: params.actorPersonId,
    entityId: params.entityId,
  });
}

async function signVoiceUrlIfAllowed(
  deps: MaaServiceDeps,
  device: VerifiedMaaDevice,
  post: MaaVoicePostRecord,
  ttlSeconds: number,
  now: Date,
): Promise<{ url: string | null; expiresIn: number | null }> {
  try {
    const purpose = voiceShareConsentPurpose(post.recipientId);
    const [linked, history] = await Promise.all([
      deps.repo.getConsent(post.familyId, post.consentId),
      deps.repo.listConsentHistory(post.familyId, post.senderId, purpose),
    ]);

    if (
      !consentIsCurrent({
        linked,
        history,
        familyId: post.familyId,
        personId: post.senderId,
        purpose,
        now,
      })
    ) {
      return { url: null, expiresIn: null };
    }

    const content = await deps.repo.getVoiceContent(post.familyId, post.id);
    if (!content || content.familyId !== post.familyId || content.voicePostId !== post.id) {
      return { url: null, expiresIn: null };
    }

    const safePath = validateObjectPath(content.objectPath, post.familyId);
    if (!safePath) return { url: null, expiresIn: null };

    const expiryMs = Date.parse(content.expiresAt);
    if (!Number.isFinite(expiryMs) || expiryMs <= now.getTime()) {
      return { url: null, expiresIn: null };
    }

    const authCtx: MediaAuthorizationContext = {
      action: 'read_voice_media',
      familyId: post.familyId,
      actor: {
        userId: device.deviceId,
        personId: device.personId,
        role: 'parent',
      },
      subject: {
        kind: 'voice_post',
        id: post.id,
        senderId: post.senderId,
        recipientId: post.recipientId,
      },
      consent: {
        id: linked!.id,
        purpose: linked!.purpose,
        personId: linked!.personId,
        callId: linked!.callId,
        grantedAt: linked!.createdAt,
      },
      object: {
        bucket: 'sahaj-voice',
        path: safePath,
        expiresAt: content.expiresAt,
      },
      now: now.toISOString(),
    };

    if ((await deps.repo.authorizeMedia(authCtx)) !== 'allow') {
      return { url: null, expiresIn: null };
    }

    const info = await deps.repo.storage.stat('sahaj-voice', safePath);
    if (!info || !objectFitsBucket('sahaj-voice', info)) {
      return { url: null, expiresIn: null };
    }

    if ((await deps.repo.authorizeMedia(authCtx)) !== 'allow') {
      return { url: null, expiresIn: null };
    }

    const remainingSeconds = Math.floor((expiryMs - now.getTime()) / 1000);
    const boundedTtl = Math.min(ttlSeconds, MAX_SIGNED_URL_SECONDS, remainingSeconds);
    if (boundedTtl < 1) {
      return { url: null, expiresIn: null };
    }

    const signedUrl = await deps.repo.storage.createSignedUrl('sahaj-voice', safePath, boundedTtl);
    if (typeof signedUrl !== 'string' || !/^https?:\/\//i.test(signedUrl)) {
      return { url: null, expiresIn: null };
    }

    return { url: signedUrl, expiresIn: boundedTtl };
  } catch {
    return { url: null, expiresIn: null };
  }
}

function buildCalmStatus(
  incident: MaaUrgentIncidentRecord,
  assignments: MaaIncidentAssignmentRecord[],
  peopleMap: Map<string, MaaPersonRecord>,
  now: Date,
): MaaUrgentStatusResponse {
  const subjectName = peopleMap.get(incident.subjectPersonId)?.displayName ?? 'Maa';
  const acceptedAssignment = assignments.find((a) => a.state === 'accepted') ?? null;
  const responderId = incident.responderId ?? acceptedAssignment?.assigneePersonId ?? null;
  const responderName = responderId ? peopleMap.get(responderId)?.displayName ?? 'Family' : null;
  const promisedAt = incident.promisedAt ?? acceptedAssignment?.promisedAt ?? null;

  let etaMinutes: number | null = null;
  if (promisedAt) {
    const diffMs = Date.parse(promisedAt) - now.getTime();
    if (Number.isFinite(diffMs)) {
      etaMinutes = Math.max(1, Math.ceil(diffMs / 60_000));
    }
  } else if (incident.state === 'accepted' || acceptedAssignment) {
    etaMinutes = 4;
  }

  let statusLineHi = 'मदद के लिए परिवार को खबर दे दी है';
  let statusLineEn = 'Family has been alerted for help';

  if ((incident.state === 'accepted' || acceptedAssignment) && responderName) {
    const mins = etaMinutes ?? 4;
    statusLineHi = `${responderName} aa rahe hain · ${mins} minute`;
    statusLineEn = `${responderName} is coming · ${mins} min`;
  } else if (incident.state === 'resolved') {
    statusLineHi = 'मदद पहुँच गई है · सब ठीक है';
    statusLineEn = 'Help arrived · everything is settled';
  } else if (incident.state === 'cancelled') {
    statusLineHi = 'मदद अनुरोध बंद किया गया';
    statusLineEn = 'Help request closed';
  } else if (incident.state === 'escalated') {
    statusLineHi = 'सभी को खबर भेज दी है · कोई न कोई अभी आ रहा है';
    statusLineEn = 'Circle alerted · someone from family is on the way';
  }

  return {
    ok: true,
    id: incident.id,
    family_id: incident.familyId,
    subject_person_id: incident.subjectPersonId,
    subject_display_name: subjectName,
    state: incident.state,
    severity: incident.severity,
    responder:
      responderId && responderName
        ? {
            person_id: responderId,
            display_name: responderName,
            promised_at: promisedAt,
          }
        : null,
    assignments: assignments.map((a) => ({
      id: a.id,
      assignee_person_id: a.assigneePersonId,
      assignee_display_name: peopleMap.get(a.assigneePersonId)?.displayName ?? 'Family',
      state: a.state,
      offered_at: a.offeredAt,
      responded_at: a.respondedAt,
      promised_at: a.promisedAt,
    })),
    promised_at: promisedAt,
    created_at: incident.createdAt,
    eta_minutes: etaMinutes,
    status_line_hi: statusLineHi,
    status_line_en: statusLineEn,
  };
}

export async function handleMaaVoiceList(request: Request, deps: MaaServiceDeps): Promise<Response> {
  try {
    const url = new URL(request.url);
    const device = await verifyMaaDeviceRequest(request, new Uint8Array(0), {
      repo: deps.repo,
      pairingSecret: deps.pairingSecret,
      now: deps.now,
      replayGuard: deps.replayGuard,
    });
    assertActorScopeMatch(device, {}, url);

    const limitParam = Number(url.searchParams.get('limit') ?? '20');
    const limit = Number.isInteger(limitParam) && limitParam >= 1 ? Math.min(limitParam, 50) : 20;
    const ttl = Math.min(deps.signedUrlSeconds ?? MAX_SIGNED_URL_SECONDS, MAX_SIGNED_URL_SECONDS);
    const now = nowOf(deps);

    const [posts, people] = await Promise.all([
      deps.repo.listVoicePostsForRecipient(device.familyId, device.personId, limit),
      deps.repo.listPeopleInFamily(device.familyId),
    ]);
    const peopleMap = new Map(people.map((p) => [p.id, p]));

    const items: MaaVoiceItem[] = await Promise.all(
      posts.map(async (post) => {
        const signed = await signVoiceUrlIfAllowed(deps, device, post, ttl, now);
        return {
          id: post.id,
          from_person_id: post.senderId,
          from_display_name: peopleMap.get(post.senderId)?.displayName ?? 'Riya',
          to_person_id: post.recipientId,
          to_display_name: peopleMap.get(post.recipientId)?.displayName ?? device.displayName,
          state: post.state,
          created_at: post.createdAt,
          duration_s: post.durationS ?? null,
          played_at: post.playedAt ?? (post.state === 'heard' ? post.createdAt : null),
          reply_to: post.replyTo,
          media_url: signed.url,
          media_expires_in: signed.expiresIn,
        };
      }),
    );

    const body: MaaVoiceListResponse = {
      family_id: device.familyId,
      person_id: device.personId,
      items,
    };
    return jsonResponse(body, 200);
  } catch (err) {
    return errorJsonResponse(err);
  }
}

export async function handleMaaVoicePlayed(
  request: Request,
  postId: string,
  deps: MaaServiceDeps,
): Promise<Response> {
  try {
    const rawBody = await readCommandBody(request);
    const device = await verifyMaaDeviceRequest(
      request,
      new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength),
      {
        repo: deps.repo,
        pairingSecret: deps.pairingSecret,
        now: deps.now,
        replayGuard: deps.replayGuard,
      },
    );

    if (!isValidUuid(postId)) {
      throw new MaaRouteError('invalid_voice_post_id', 400);
    }

    const parsed = parseJsonObject(rawBody);
    assertActorScopeMatch(device, parsed);

    const post = await deps.repo.getVoicePostById(postId);
    if (!post) {
      throw new MaaRouteError('voice_post_not_found', 404);
    }
    if (post.familyId !== device.familyId || post.recipientId !== device.personId) {
      throw new MaaRouteError('forbidden_voice_post', 403);
    }

    const heardAt = nowOf(deps).toISOString();
    const { playedAt } = await deps.repo.markVoicePostHeard(
      device.familyId,
      post.id,
      device.personId,
      heardAt,
    );

    const body: MaaVoicePlayedResponse = {
      ok: true,
      id: post.id,
      state: 'heard',
      played_at: playedAt,
    };
    return jsonResponse(body, 200);
  } catch (err) {
    return errorJsonResponse(err);
  }
}

export async function handleMaaVoiceReply(request: Request, deps: MaaServiceDeps): Promise<Response> {
  try {
    const rawBody = await readCommandBody(request, VOICE_REPLY_MAX_REQUEST_BYTES);
    const device = await verifyMaaDeviceRequest(
      request,
      new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength),
      {
        repo: deps.repo,
        pairingSecret: deps.pairingSecret,
        now: deps.now,
        replayGuard: deps.replayGuard,
      },
    );

    const parsed = parseJsonObject(rawBody);
    assertAllowedKeys(
      parsed,
      new Set([
        'family_id',
        'familyId',
        'person_id',
        'personId',
        'sender_id',
        'senderId',
        'reply_to',
        'replyTo',
        'recipient_person_id',
        'recipientPersonId',
        'audio_base64',
        'audioBase64',
        'content_type',
        'contentType',
        'duration_s',
        'durationS',
        'consent_granted',
        'consentGranted',
        'consent_version',
        'consentVersion',
        'idempotency_key',
        'idempotencyKey',
      ]),
    );
    assertActorScopeMatch(device, parsed);

    const idempotencyKey = readIdempotencyKey(request, parsed);
    const bodyHash = computePayloadHash(rawBody);
    const scopedKey = idempotencyKey
      ? deriveScopedIdempotencyKey(device.familyId, device.personId, `voice-reply:${idempotencyKey}`)
      : null;

    if (scopedKey) {
      const existing = await deps.repo.findCommandIdempotency(scopedKey);
      if (existing) {
        if (existing.payloadHash !== bodyHash) {
          throw new MaaRouteError('idempotency_conflict_body_mismatch', 409);
        }
        if (existing.entityId) {
          const existingPost = await deps.repo.getVoicePostById(existing.entityId);
          if (existingPost && existingPost.familyId === device.familyId) {
            const dedupedBody: MaaVoiceReplyResponse = {
              ok: true,
              id: existingPost.id,
              family_id: existingPost.familyId,
              sender_id: existingPost.senderId,
              recipient_id: existingPost.recipientId,
              reply_to: existingPost.replyTo,
              state: existingPost.state,
              created_at: existingPost.createdAt,
              deduped: true,
            };
            return jsonResponse(dedupedBody, 200);
          }
        }
      }
    }

    const durationRaw = parsed.duration_s ?? parsed.durationS;
    if (durationRaw !== undefined) {
      if (typeof durationRaw !== 'number' || !Number.isFinite(durationRaw) || durationRaw <= 0 || durationRaw > 30) {
        throw new MaaRouteError('voice_reply_duration_exceeds_30s', 400);
      }
    }

    const rawMime = String(parsed.content_type ?? parsed.contentType ?? 'audio/mp4')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const audioMeta = MIME_TO_AUDIO[rawMime];
    if (!audioMeta) {
      throw new MaaRouteError('unsupported_audio_type', 400);
    }

    const audioBase64 = parsed.audio_base64 ?? parsed.audioBase64;
    if (typeof audioBase64 !== 'string' || audioBase64.trim().length === 0) {
      throw new MaaRouteError('missing_audio_payload', 400);
    }

    const normalizedBase64 = audioBase64.replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedBase64)) {
      throw new MaaRouteError('invalid_audio_base64', 400);
    }
    const audioBytes = Uint8Array.from(Buffer.from(normalizedBase64, 'base64'));
    if (audioBytes.byteLength === 0 || audioBytes.byteLength > MEDIA_BUCKETS['sahaj-voice'].maxBytes) {
      throw new MaaRouteError('invalid_audio_size', 400);
    }

    const replyToRaw = parsed.reply_to ?? parsed.replyTo;
    let replyTo: string | null = null;
    let derivedRecipientId: string | null = null;
    if (replyToRaw !== undefined && replyToRaw !== null) {
      if (typeof replyToRaw !== 'string' || !isValidUuid(replyToRaw)) {
        throw new MaaRouteError('invalid_reply_to_uuid', 400);
      }
      const parentPost = await deps.repo.getVoicePostById(replyToRaw);
      if (!parentPost) {
        throw new MaaRouteError('reply_target_not_found', 404);
      }
      if (parentPost.familyId !== device.familyId || parentPost.recipientId !== device.personId) {
        throw new MaaRouteError('forbidden_reply_target', 403);
      }
      replyTo = parentPost.id;
      derivedRecipientId = parentPost.senderId;
    }

    const explicitRecipient = parsed.recipient_person_id ?? parsed.recipientPersonId;
    let recipientId = derivedRecipientId;
    if (explicitRecipient !== undefined && explicitRecipient !== null) {
      if (typeof explicitRecipient !== 'string' || !isValidUuid(explicitRecipient)) {
        throw new MaaRouteError('invalid_recipient_person_id', 400);
      }
      const target = await deps.repo.getPersonInFamily(device.familyId, explicitRecipient);
      if (!target || target.familyId !== device.familyId) {
        throw new MaaRouteError('foreign_recipient_reference', 403);
      }
      recipientId = target.id;
    }

    if (!recipientId) {
      const people = await deps.repo.listPeopleInFamily(device.familyId);
      const child = people.find((p) => p.role === 'child' && p.id !== device.personId);
      if (!child) {
        throw new MaaRouteError('recipient_required', 400);
      }
      recipientId = child.id;
    }

    const now = nowOf(deps);
    const purpose = voiceShareConsentPurpose(recipientId);
    const history = await deps.repo.listConsentHistory(device.familyId, device.personId, purpose);
    const latest = latestConsent(history, device.familyId, device.personId, purpose);
    const consentGrantedFlag = parsed.consent_granted ?? parsed.consentGranted;

    if (consentGrantedFlag === false) {
      throw new MaaRouteError('consent_required', 403);
    }

    let consent: ConsentRow | null = latest;
    if (
      !consent ||
      !consentIsCurrent({
        linked: consent,
        history,
        familyId: device.familyId,
        personId: device.personId,
        purpose,
        now,
      })
    ) {
      // Only create a consent grant if history isn't empty-refusal without new explicit tap, or explicit consent_granted === true
      if (consentGrantedFlag !== true) {
        throw new MaaRouteError('consent_required', 403);
      }
      const consentVersion = String(parsed.consent_version ?? parsed.consentVersion ?? 'v1').slice(0, 32);
      consent = await deps.repo.createVoiceShareConsent(
        device.familyId,
        device.personId,
        recipientId,
        consentVersion,
        now.toISOString(),
      );
    }

    const objectPath = `${device.familyId}/voice/${randomUUID()}.${audioMeta.ext}`;
    validateMediaObjectPath(device.familyId, objectPath);
    if (!validateObjectPath(objectPath, device.familyId)) {
      throw new MaaRouteError('invalid_media_object_path', 400);
    }

    await deps.repo.uploadVoiceObject(objectPath, audioBytes, audioMeta.normalizedMime);
    const created = await deps.repo.createFamilyVoicePost({
      familyId: device.familyId,
      senderId: device.personId,
      recipientId,
      objectPath,
      consentId: consent.id,
      replyTo,
    });

    await maybePersistEncryptedCommand(deps, {
      familyId: device.familyId,
      actorPersonId: device.personId,
      commandType: 'voice_message',
      scopedKey: scopedKey ?? `maa-voice-${created.id}`,
      bodyHash,
      entityId: created.id,
      safePayload: {
        command_type: 'voice_message',
        family_id: device.familyId,
        sender_person_id: device.personId,
        recipient_person_id: recipientId,
        consent_id: consent.id,
        voice_post_id: created.id,
        reply_to: replyTo,
      },
    });

    const responseBody: MaaVoiceReplyResponse = {
      ok: true,
      id: created.id,
      family_id: created.familyId,
      sender_id: created.senderId,
      recipient_id: created.recipientId,
      reply_to: created.replyTo,
      state: created.state,
      created_at: created.createdAt,
      deduped: false,
    };
    return jsonResponse(responseBody, 201);
  } catch (err) {
    return errorJsonResponse(err);
  }
}

export async function handleMaaUrgentCreate(request: Request, deps: MaaServiceDeps): Promise<Response> {
  try {
    const rawBody = await readCommandBody(request);
    const device = await verifyMaaDeviceRequest(
      request,
      new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength),
      {
        repo: deps.repo,
        pairingSecret: deps.pairingSecret,
        now: deps.now,
        replayGuard: deps.replayGuard,
      },
    );

    const parsed = parseJsonObject(rawBody);
    assertAllowedKeys(
      parsed,
      new Set([
        'family_id',
        'familyId',
        'person_id',
        'personId',
        'subject_person_id',
        'subjectPersonId',
        'severity',
        'offer_timeout_minutes',
        'offerTimeoutMinutes',
        'idempotency_key',
        'idempotencyKey',
      ]),
    );
    assertActorScopeMatch(device, parsed);

    const severityRaw = parsed.severity ?? 'urgent';
    if (severityRaw !== 'routine' && severityRaw !== 'urgent' && severityRaw !== 'critical') {
      throw new MaaRouteError('invalid_severity', 400);
    }

    const timeoutRaw = parsed.offer_timeout_minutes ?? parsed.offerTimeoutMinutes ?? 3;
    if (typeof timeoutRaw !== 'number' || !Number.isInteger(timeoutRaw) || timeoutRaw < 1 || timeoutRaw > 30) {
      throw new MaaRouteError('invalid_offer_timeout', 400);
    }

    const idempotencyKey = readIdempotencyKey(request, parsed);
    const bodyHash = computePayloadHash(rawBody);
    const scopedKey = idempotencyKey
      ? deriveScopedIdempotencyKey(device.familyId, device.personId, `urgent:${idempotencyKey}`)
      : null;

    if (scopedKey) {
      const existing = await deps.repo.findCommandIdempotency(scopedKey);
      if (existing) {
        if (existing.payloadHash !== bodyHash) {
          throw new MaaRouteError('idempotency_conflict_body_mismatch', 409);
        }
        if (existing.entityId) {
          const incident = await deps.repo.getUrgentIncidentById(existing.entityId);
          if (incident && incident.familyId === device.familyId) {
            const [assignments, people] = await Promise.all([
              deps.repo.listIncidentAssignments(device.familyId, incident.id),
              deps.repo.listPeopleInFamily(device.familyId),
            ]);
            const peopleMap = new Map(people.map((p) => [p.id, p]));
            return jsonResponse(
              {
                ...buildCalmStatus(incident, assignments, peopleMap, nowOf(deps)),
                deduped: true,
              },
              200,
            );
          }
        }
      }
    }

    const offer = await deps.repo.createUrgentIncidentOffer({
      familyId: device.familyId,
      subjectPersonId: device.personId,
      severity: severityRaw,
      offerTimeoutMinutes: timeoutRaw,
    });

    await maybePersistEncryptedCommand(deps, {
      familyId: device.familyId,
      actorPersonId: device.personId,
      commandType: 'urgent_help',
      scopedKey: scopedKey ?? `maa-urgent-${offer.incidentId}`,
      bodyHash,
      entityId: offer.incidentId,
      safePayload: {
        command_type: 'urgent_help',
        family_id: device.familyId,
        subject_person_id: device.personId,
        severity: severityRaw,
        incident_id: offer.incidentId,
        assignment_id: offer.assignmentId ?? null,
      },
    });

    const [incident, assignments, people] = await Promise.all([
      deps.repo.getUrgentIncidentById(offer.incidentId),
      deps.repo.listIncidentAssignments(device.familyId, offer.incidentId),
      deps.repo.listPeopleInFamily(device.familyId),
    ]);

    const peopleMap = new Map(people.map((p) => [p.id, p]));
    const resolvedIncident: MaaUrgentIncidentRecord = incident ?? {
      id: offer.incidentId,
      familyId: device.familyId,
      subjectPersonId: device.personId,
      state: offer.state,
      severity: severityRaw,
      responderId: null,
      promisedAt: null,
      createdAt: nowOf(deps).toISOString(),
    };

    if (deps.onUrgentIncidentCreated) {
      await deps.onUrgentIncidentCreated({
        familyId: device.familyId,
        incidentId: offer.incidentId,
        subjectPersonId: device.personId,
        severity: severityRaw,
        assignments,
        state: resolvedIncident.state,
      });
    }

    return jsonResponse(
      {
        ...buildCalmStatus(resolvedIncident, assignments, peopleMap, nowOf(deps)),
        deduped: false,
      },
      201,
    );
  } catch (err) {
    return errorJsonResponse(err);
  }
}

export async function handleMaaUrgentStatus(
  request: Request,
  incidentId: string,
  deps: MaaServiceDeps,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const device = await verifyMaaDeviceRequest(request, new Uint8Array(0), {
      repo: deps.repo,
      pairingSecret: deps.pairingSecret,
      now: deps.now,
      replayGuard: deps.replayGuard,
    });
    assertActorScopeMatch(device, {}, url);

    if (!isValidUuid(incidentId)) {
      throw new MaaRouteError('invalid_incident_id', 400);
    }

    const incident = await deps.repo.getUrgentIncidentById(incidentId);
    if (!incident) {
      throw new MaaRouteError('incident_not_found', 404);
    }
    if (incident.familyId !== device.familyId || incident.subjectPersonId !== device.personId) {
      throw new MaaRouteError('forbidden_incident', 403);
    }

    const [assignments, people] = await Promise.all([
      deps.repo.listIncidentAssignments(device.familyId, incident.id),
      deps.repo.listPeopleInFamily(device.familyId),
    ]);
    const peopleMap = new Map(people.map((p) => [p.id, p]));

    return jsonResponse(buildCalmStatus(incident, assignments, peopleMap, nowOf(deps)), 200);
  } catch (err) {
    return errorJsonResponse(err);
  }
}
