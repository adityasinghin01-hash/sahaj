/**
 * Strict request validation for Core 1 authenticated commands.
 *
 * Implements:
 * - Rejection of unknown fields (strict payload schemas)
 * - Strict mediaObjectPath verification: rejects URLs, path traversal (.., %2e), wrong buckets, other families
 * - Bounded string and integer limits
 * - Bounded request size checking (up to 64 KB)
 * - Strict UUID and Idempotency key checking
 */

import { Core1CommandError } from './errors';
import type {
  CheckInCommandPayload,
  UrgentHelpCommandPayload,
  VoiceMessageCommandPayload,
  RefillProposalCommandPayload,
  MissedCallNudgeCommandPayload,
  FamilyReportCommandPayload,
} from './types';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_REGEX = /^[a-zA-Z0-9_\-.:]{1,256}$/;

export function isValidUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

export function validateUuid(id: unknown, fieldName: string): string {
  if (!isValidUuid(id)) {
    throw new Core1CommandError(`invalid_${fieldName}_uuid`, 400);
  }
  return id;
}

export function validateIdempotencyKey(key: unknown): string {
  if (typeof key !== 'string' || !IDEMPOTENCY_KEY_REGEX.test(key)) {
    throw new Core1CommandError('invalid_idempotency_key', 400);
  }
  return key;
}

/**
 * Asserts that the object contains NO keys outside of the allowed set.
 * Fixes Blocker 7 from ANTIGRAVITY-B-REVIEW.
 */
export function assertStrictKeys(obj: Record<string, unknown>, allowedKeys: Set<string>, context: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new Core1CommandError(`unknown_field_${key}_in_${context}`, 400);
    }
  }
}

/**
 * Reads and bounds request body bytes.
 */
export async function readCommandBody(request: Request, maxBytes = 65536): Promise<Buffer> {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new Core1CommandError('payload_too_large', 413);
  }

  if (!request.body) {
    return Buffer.alloc(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Core1CommandError('payload_too_large', 413);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

export function parseCommandJson(body: Buffer): Record<string, unknown> {
  if (body.length === 0) {
    throw new Core1CommandError('empty_request_body', 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Core1CommandError('malformed_json_body', 400);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Core1CommandError('invalid_json_object', 400);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Validates mediaObjectPath according to private storage conventions.
 * Fixes Blocker 2 from ANTIGRAVITY-B-REVIEW.
 */
export function validateMediaObjectPath(familyId: string, objectPath: string): void {
  if (typeof objectPath !== 'string' || !objectPath.trim()) {
    throw new Core1CommandError('invalid_media_object_path', 400);
  }

  // Reject URL schemes
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(objectPath)) {
    throw new Core1CommandError('media_path_url_prohibited', 400);
  }

  // Reject directory traversal and encoded dots
  if (objectPath.includes('..') || objectPath.toLowerCase().includes('%2e') || objectPath.includes('\\')) {
    throw new Core1CommandError('media_path_traversal_prohibited', 400);
  }

  // Expected format: <familyId>/voice/<filename> or <familyId>/calls/<filename>
  const parts = objectPath.split('/');
  if (parts.length < 3) {
    throw new Core1CommandError('invalid_media_path_structure', 400);
  }

  if (parts[0] !== familyId) {
    throw new Core1CommandError('media_path_cross_family_mismatch', 403);
  }

  const category = parts[1];
  if (category !== 'voice' && category !== 'calls') {
    throw new Core1CommandError('invalid_media_bucket_category', 400);
  }

  const filename = parts.slice(2).join('/');
  if (!/^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9]+)?$/.test(filename) || filename.length > 128) {
    throw new Core1CommandError('invalid_media_filename', 400);
  }
}

// ----------------------------------------------------------------------------
// Payload Validators with Strict Key Enforcement
// ----------------------------------------------------------------------------

export function validateCheckInPayload(input: Record<string, unknown>): CheckInCommandPayload {
  const allowed = new Set([
    'scheduleId', 'schedule_id',
    'personId', 'person_id',
    'preferredTime', 'preferred_time',
    'timezone',
    'wakeToken', 'wake_token',
    'cancel',
    'cancellationReason', 'cancellation_reason'
  ]);
  assertStrictKeys(input, allowed, 'check_in');

  const personIdRaw = input.personId ?? input.person_id;
  const personId = validateUuid(personIdRaw, 'person_id');

  let scheduleId: string | undefined;
  const sIdRaw = input.scheduleId ?? input.schedule_id;
  if (sIdRaw !== undefined) scheduleId = validateUuid(sIdRaw, 'schedule_id');

  let preferredTime: string | undefined;
  const ptRaw = input.preferredTime ?? input.preferred_time;
  if (ptRaw !== undefined) {
    if (typeof ptRaw !== 'string' || !/^\d{2}:\d{2}$/.test(ptRaw)) {
      throw new Core1CommandError('invalid_preferred_time_format', 400);
    }
    preferredTime = ptRaw;
  }

  let timezone: string | undefined;
  if (input.timezone !== undefined) {
    if (typeof input.timezone !== 'string' || input.timezone.length > 50) {
      throw new Core1CommandError('invalid_timezone', 400);
    }
    timezone = input.timezone;
  }

  let wakeToken: string | undefined;
  const wtRaw = input.wakeToken ?? input.wake_token;
  if (wtRaw !== undefined) {
    if (typeof wtRaw !== 'string' || wtRaw.length > 128) {
      throw new Core1CommandError('invalid_wake_token', 400);
    }
    wakeToken = wtRaw;
  }

  const cancel = input.cancel === true;
  let cancellationReason: string | undefined;
  const crRaw = input.cancellationReason ?? input.cancellation_reason;
  if (crRaw !== undefined) {
    if (typeof crRaw !== 'string' || crRaw.length > 256) {
      throw new Core1CommandError('invalid_cancellation_reason', 400);
    }
    cancellationReason = crRaw;
  }

  return {
    scheduleId,
    personId,
    preferredTime,
    timezone,
    wakeToken,
    cancel,
    cancellationReason,
  };
}

export function validateUrgentHelpPayload(input: Record<string, unknown>): UrgentHelpCommandPayload {
  const allowed = new Set([
    'incidentId', 'incident_id',
    'subjectPersonId', 'subject_person_id', 'personId', 'person_id',
    'severity',
    'action',
    'assignmentId', 'assignment_id',
    'promiseMinutes', 'promise_minutes',
    'rawEventId', 'raw_event_id'
  ]);
  assertStrictKeys(input, allowed, 'urgent_help');

  const subjectRaw = input.subjectPersonId ?? input.subject_person_id ?? input.personId ?? input.person_id;
  const subjectPersonId = validateUuid(subjectRaw, 'subject_person_id');

  let severity: 'routine' | 'urgent' | 'critical' = 'urgent';
  if (input.severity !== undefined) {
    if (input.severity !== 'routine' && input.severity !== 'urgent' && input.severity !== 'critical') {
      throw new Core1CommandError('invalid_severity', 400);
    }
    severity = input.severity;
  }

  let incidentId: string | undefined;
  const incRaw = input.incidentId ?? input.incident_id;
  if (incRaw !== undefined) incidentId = validateUuid(incRaw, 'incident_id');

  let action: UrgentHelpCommandPayload['action'] = 'initiate';
  if (input.action !== undefined) {
    if (input.action !== 'initiate' && input.action !== 'accept' && input.action !== 'decline' && input.action !== 'complete') {
      throw new Core1CommandError('invalid_urgent_action', 400);
    }
    action = input.action;
  }

  let assignmentId: string | undefined;
  const asgnRaw = input.assignmentId ?? input.assignment_id;
  if (asgnRaw !== undefined) assignmentId = validateUuid(asgnRaw, 'assignment_id');

  let rawEventId: string | undefined;
  const evtRaw = input.rawEventId ?? input.raw_event_id;
  if (evtRaw !== undefined) rawEventId = validateUuid(evtRaw, 'raw_event_id');

  let promiseMinutes: number | undefined;
  const pmRaw = input.promiseMinutes ?? input.promise_minutes;
  if (pmRaw !== undefined) {
    if (typeof pmRaw !== 'number' || !Number.isInteger(pmRaw) || pmRaw <= 0 || pmRaw > 1440) {
      throw new Core1CommandError('invalid_promise_minutes', 400);
    }
    promiseMinutes = pmRaw;
  }

  return {
    incidentId,
    subjectPersonId,
    severity,
    action,
    assignmentId,
    promiseMinutes,
    rawEventId,
  };
}

export function validateVoiceMessagePayload(input: Record<string, unknown>, familyId: string): VoiceMessageCommandPayload {
  const allowed = new Set([
    'recipientPersonId', 'recipient_person_id',
    'mediaObjectPath', 'media_object_path',
    'consentId', 'consent_id',
    'replyToId', 'reply_to_id', 'replyToVoicePostId', 'reply_to_voice_post_id'
  ]);
  assertStrictKeys(input, allowed, 'voice_message');

  const recRaw = input.recipientPersonId ?? input.recipient_person_id;
  const recipientPersonId = validateUuid(recRaw, 'recipient_person_id');

  const mopRaw = input.mediaObjectPath ?? input.media_object_path;
  if (typeof mopRaw !== 'string') {
    throw new Core1CommandError('missing_media_object_path', 400);
  }
  validateMediaObjectPath(familyId, mopRaw);

  const cidRaw = input.consentId ?? input.consent_id;
  const consentId = validateUuid(cidRaw, 'consent_id');

  let replyToId: string | undefined;
  const repRaw = input.replyToId ?? input.reply_to_id ?? input.replyToVoicePostId ?? input.reply_to_voice_post_id;
  if (repRaw !== undefined) replyToId = validateUuid(repRaw, 'reply_to_id');

  return {
    recipientPersonId,
    mediaObjectPath: mopRaw,
    consentId,
    replyToId,
  };
}

export function validateRefillProposalPayload(input: Record<string, unknown>): RefillProposalCommandPayload {
  const allowed = new Set([
    'medicineId', 'medicine_id',
    'personId', 'person_id',
    'vendorId', 'vendor_id',
    'reorderPacks', 'reorder_packs',
    'doseAction', 'dose_action',
    'doseCount', 'dose_count'
  ]);
  assertStrictKeys(input, allowed, 'refill_proposal');

  const medRaw = input.medicineId ?? input.medicine_id;
  const medicineId = validateUuid(medRaw, 'medicine_id');

  const personRaw = input.personId ?? input.person_id;
  const personId = validateUuid(personRaw, 'person_id');

  const venRaw = input.vendorId ?? input.vendor_id;
  const vendorId = validateUuid(venRaw, 'vendor_id');

  let reorderPacks: number | undefined;
  const rpRaw = input.reorderPacks ?? input.reorder_packs;
  if (rpRaw !== undefined) {
    if (typeof rpRaw !== 'number' || !Number.isInteger(rpRaw) || rpRaw <= 0 || rpRaw > 100) {
      throw new Core1CommandError('invalid_reorder_packs', 400);
    }
    reorderPacks = rpRaw;
  }

  let doseAction: RefillProposalCommandPayload['doseAction'];
  const daRaw = input.doseAction ?? input.dose_action;
  if (daRaw !== undefined) {
    if (daRaw !== 'confirmed_dose' && daRaw !== 'missed_dose' && daRaw !== 'double_dose_reported' && daRaw !== 'count_reconciliation') {
      throw new Core1CommandError('invalid_dose_action', 400);
    }
    doseAction = daRaw;
  }

  let doseCount: number | undefined;
  const dcRaw = input.doseCount ?? input.dose_count;
  if (dcRaw !== undefined) {
    if (typeof dcRaw !== 'number' || !Number.isInteger(dcRaw) || dcRaw < 0) {
      throw new Core1CommandError('invalid_dose_count', 400);
    }
    doseCount = dcRaw;
  }

  return {
    medicineId,
    personId,
    vendorId,
    reorderPacks,
    doseAction,
    doseCount,
  };
}

export function validateMissedCallNudgePayload(input: Record<string, unknown>): MissedCallNudgeCommandPayload {
  const allowed = new Set([
    'callerPersonId', 'caller_person_id',
    'recipientPersonId', 'recipient_person_id',
    'providerCallId', 'provider_call_id',
    'providerAccountId', 'provider_account_id',
    'timestamp'
  ]);
  assertStrictKeys(input, allowed, 'missed_call_nudge');

  const callerRaw = input.callerPersonId ?? input.caller_person_id;
  const callerPersonId = validateUuid(callerRaw, 'caller_person_id');

  const recRaw = input.recipientPersonId ?? input.recipient_person_id;
  const recipientPersonId = validateUuid(recRaw, 'recipient_person_id');

  const pcRaw = input.providerCallId ?? input.provider_call_id;
  if (typeof pcRaw !== 'string' || !pcRaw.trim() || pcRaw.length > 128) {
    throw new Core1CommandError('invalid_provider_call_id', 400);
  }

  let providerAccountId: string | undefined;
  const paRaw = input.providerAccountId ?? input.provider_account_id;
  if (paRaw !== undefined) {
    if (typeof paRaw !== 'string' || paRaw.length > 128) {
      throw new Core1CommandError('invalid_provider_account_id', 400);
    }
    providerAccountId = paRaw;
  }

  let timestamp: string | undefined;
  if (input.timestamp !== undefined) {
    if (typeof input.timestamp !== 'string' || isNaN(new Date(input.timestamp).getTime())) {
      throw new Core1CommandError('invalid_timestamp', 400);
    }
    timestamp = input.timestamp;
  }

  return {
    callerPersonId,
    recipientPersonId,
    providerCallId: pcRaw,
    providerAccountId,
    timestamp,
  };
}

export function validateFamilyReportPayload(input: Record<string, unknown>): FamilyReportCommandPayload {
  const allowed = new Set(['periodStart', 'period_start', 'periodEnd', 'period_end']);
  assertStrictKeys(input, allowed, 'family_report');

  const psRaw = input.periodStart ?? input.period_start;
  const peRaw = input.periodEnd ?? input.period_end;

  if (typeof psRaw !== 'string' || isNaN(new Date(psRaw).getTime())) {
    throw new Core1CommandError('invalid_period_start', 400);
  }
  if (typeof peRaw !== 'string' || isNaN(new Date(peRaw).getTime())) {
    throw new Core1CommandError('invalid_period_end', 400);
  }

  if (new Date(psRaw).getTime() > new Date(peRaw).getTime()) {
    throw new Core1CommandError('invalid_period_range', 400);
  }

  return {
    periodStart: psRaw,
    periodEnd: peRaw,
  };
}

export function extractIdempotencyKey(request: Request, bodyObject: Record<string, unknown>): string {
  const headerKey = request.headers.get('idempotency-key') ?? request.headers.get('x-idempotency-key');
  const bodyKey = bodyObject.idempotencyKey ?? bodyObject.idempotency_key;

  const rawKey = headerKey ?? bodyKey;
  if (!rawKey) {
    throw new Core1CommandError('missing_idempotency_key', 400);
  }
  return validateIdempotencyKey(rawKey);
}
