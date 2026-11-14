/**
 * Core 1 Authenticated Command Service.
 *
 * Implements:
 * - Supabase bearer token verification via getUser
 * - Explicit server-side family membership resolution (Blocker 4 fix)
 * - Live circle permission checking failing closed (Blocker 5 fix)
 * - Strict bounded body and unknown-field payload validation (Blocker 7 fix)
 * - Comprehensive cross-family entity reference validation (Blocker 1 fix)
 * - Scoped idempotency with body conflict detection (Blocker 3 fix)
 * - Safe encryption error mapping to 503 without leaking secrets (Blocker 8 fix)
 * - Durable encrypted ingestion before returning 202 (queued/requested only)
 */

import { randomUUID } from 'node:crypto';
import { Core1CommandError, mapToCommandError } from './errors';
import { bearerToken } from '../secrets';
import { encryptWebhook, WebhookError } from '../webhook-security';
import { assertCommandCapability } from './capabilities';
import {
  deriveScopedIdempotencyKey,
  computePayloadHash,
} from './idempotency';
import {
  readCommandBody,
  parseCommandJson,
  extractIdempotencyKey,
  validateCheckInPayload,
  validateUrgentHelpPayload,
  validateVoiceMessagePayload,
  validateRefillProposalPayload,
  validateMissedCallNudgePayload,
  validateFamilyReportPayload,
} from './validation';
import type {
  CommandType,
  Core1ServicePorts,
  PersistedCommandResult,
} from './types';

export function normalizeCommandType(raw: unknown): CommandType {
  if (typeof raw !== 'string') {
    throw new Core1CommandError('missing_command_type', 400);
  }
  const normalized = raw.trim().toLowerCase().replace(/-/g, '_');
  const validCommands: Record<string, CommandType> = {
    check_in: 'check_in',
    urgent_help: 'urgent_help',
    voice_message: 'voice_message',
    refill_proposal: 'refill_proposal',
    refill: 'refill_proposal',
    missed_call_nudge: 'missed_call_nudge',
    family_report: 'family_report',
  };

  const command = validCommands[normalized];
  if (!command) {
    throw new Core1CommandError(`unsupported_command_type_${raw}`, 400);
  }
  return command;
}

export async function executeCore1Command(
  request: Request,
  ports: Core1ServicePorts,
  commandOverride?: CommandType
): Promise<PersistedCommandResult> {
  try {
    // 1. Verify Supabase bearer token via getUser
    const token = bearerToken(request);
    if (!token) {
      throw new Core1CommandError('unauthorized_missing_bearer_token', 401);
    }

    let user;
    try {
      user = await ports.auth.getUser(token);
    } catch {
      throw new Core1CommandError('unauthorized_invalid_bearer_token', 401);
    }

    if (!user || !user.id) {
      throw new Core1CommandError('unauthorized_invalid_bearer_token', 401);
    }

    // 2. Read bounded body bytes (max 64KB)
    const rawBody = await readCommandBody(request);
    const bodyHash = computePayloadHash(rawBody);

    // 3. Parse JSON
    const parsed = parseCommandJson(rawBody);

    // 4. Determine command type and requested family
    const commandRaw = commandOverride ?? parsed.command ?? parsed.command_type ?? parsed.action;
    const commandType = normalizeCommandType(commandRaw);

    const requestedFamilyIdRaw = parsed.familyId ?? parsed.family_id;
    const requestedFamilyId = typeof requestedFamilyIdRaw === 'string' ? requestedFamilyIdRaw.trim() : undefined;

    // 5. Extract and validate idempotency key
    const rawIdempotencyKey = extractIdempotencyKey(request, parsed);

    // 6. Load current membership server-side (resolving explicit family, Blocker 4 fix)
    const membership = await ports.repo.getMembership(user.id, requestedFamilyId);

    // 7. Load live circle record if role is circle (Blocker 5 fix)
    const circleRecord = membership.role === 'circle'
      ? await ports.repo.getCircleRecord(membership.familyId, membership.personId)
      : null;

    // 8. Derive scoped idempotency key binding family, authenticated actor, and client key (Blocker 3 fix)
    const scopedIdempotencyKey = deriveScopedIdempotencyKey(
      membership.familyId,
      membership.personId,
      rawIdempotencyKey
    );

    // 9. Check for duplicate replay or body conflict (Blocker 3 fix)
    const existingEvent = await ports.repo.findEventByIdempotency(scopedIdempotencyKey);
    if (existingEvent) {
      if (existingEvent.payloadHash === bodyHash) {
        // Idempotent replay: return existing accepted representation
        return {
          eventId: existingEvent.id,
          commandType,
          status: 'queued',
          deduped: true,
        };
      }
      // Same idempotency key with modified payload body -> 409 Conflict
      throw new Core1CommandError('idempotency_conflict_body_mismatch', 409);
    }

    // 10. Extract payload object (support both envelope { command, payload } and flat request)
    const payloadInput =
      parsed.payload && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload)
        ? (parsed.payload as Record<string, unknown>)
        : parsed;

    // Strip out envelope metadata keys from payload input if present
    const cleanedPayload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payloadInput)) {
      if (!['command', 'command_type', 'familyId', 'family_id', 'idempotencyKey', 'idempotency_key'].includes(k)) {
        cleanedPayload[k] = v;
      }
    }

    // 11. Validate command-specific payload and referenced entity ownership (Blocker 1 fix)
    let targetPersonId: string | undefined;

    switch (commandType) {
      case 'check_in': {
        const payload = validateCheckInPayload(cleanedPayload);
        targetPersonId = payload.personId;

        // Prove person belongs to this family
        const personOk = await ports.repo.validateEntityOwnership('person', membership.familyId, payload.personId);
        if (!personOk) throw new Core1CommandError('foreign_person_reference', 403);

        if (payload.scheduleId) {
          const scheduleOk = await ports.repo.validateEntityOwnership('schedule', membership.familyId, payload.scheduleId);
          if (!scheduleOk) throw new Core1CommandError('foreign_schedule_reference', 403);
        }
        break;
      }

      case 'urgent_help': {
        const payload = validateUrgentHelpPayload(cleanedPayload);
        targetPersonId = payload.subjectPersonId;

        // Prove subject belongs to this family
        const subjectOk = await ports.repo.validateEntityOwnership('person', membership.familyId, payload.subjectPersonId);
        if (!subjectOk) throw new Core1CommandError('foreign_subject_reference', 403);

        // Crucial Blocker 1 fix: Prove incident belongs to this family if supplied
        if (payload.incidentId) {
          const incidentOk = await ports.repo.validateEntityOwnership('incident', membership.familyId, payload.incidentId);
          if (!incidentOk) throw new Core1CommandError('foreign_incident_reference', 403);
        }

        if (payload.assignmentId) {
          const assignmentOk = await ports.repo.validateEntityOwnership('assignment', membership.familyId, payload.assignmentId);
          if (!assignmentOk) throw new Core1CommandError('foreign_assignment_reference', 403);
        }
        break;
      }

      case 'voice_message': {
        const payload = validateVoiceMessagePayload(cleanedPayload, membership.familyId);
        targetPersonId = payload.recipientPersonId;

        // Prove recipient belongs to family
        const recOk = await ports.repo.validateEntityOwnership('person', membership.familyId, payload.recipientPersonId);
        if (!recOk) throw new Core1CommandError('foreign_recipient_reference', 403);

        // Prove consent belongs to family
        const consentOk = await ports.repo.validateEntityOwnership('consent', membership.familyId, payload.consentId);
        if (!consentOk) throw new Core1CommandError('foreign_consent_reference', 403);
        break;
      }

      case 'refill_proposal': {
        const payload = validateRefillProposalPayload(cleanedPayload);
        targetPersonId = payload.personId;

        const personOk = await ports.repo.validateEntityOwnership('person', membership.familyId, payload.personId);
        if (!personOk) throw new Core1CommandError('foreign_person_reference', 403);

        const medOk = await ports.repo.validateEntityOwnership('medicine', membership.familyId, payload.medicineId);
        if (!medOk) throw new Core1CommandError('foreign_medicine_reference', 403);

        const venOk = await ports.repo.validateEntityOwnership('vendor', membership.familyId, payload.vendorId);
        if (!venOk) throw new Core1CommandError('foreign_vendor_reference', 403);
        break;
      }

      case 'missed_call_nudge': {
        const payload = validateMissedCallNudgePayload(cleanedPayload);
        targetPersonId = payload.recipientPersonId;

        const callerOk = await ports.repo.validateEntityOwnership('person', membership.familyId, payload.callerPersonId);
        if (!callerOk) throw new Core1CommandError('foreign_caller_reference', 403);

        const recOk = await ports.repo.validateEntityOwnership('person', membership.familyId, payload.recipientPersonId);
        if (!recOk) throw new Core1CommandError('foreign_recipient_reference', 403);
        break;
      }

      case 'family_report': {
        validateFamilyReportPayload(cleanedPayload);
        break;
      }
    }

    // 12. Enforce role and circle capability checks
    assertCommandCapability(commandType, membership, circleRecord, targetPersonId);

    // 13. Encrypt payload before durable ingestion (Blocker 8 fix: map encryption failure to 503)
    const keyHex = ports.encryptionKeyHex ?? process.env.WEBHOOK_ENCRYPTION_KEY ?? '';
    let ciphertext: string;
    try {
      if (!/^[a-f0-9]{64}$/i.test(keyHex)) {
        throw new Core1CommandError('service_unavailable_encryption', 503);
      }
      ciphertext = encryptWebhook(
        rawBody,
        keyHex,
        `core1:${membership.familyId}:${scopedIdempotencyKey}`
      );
    } catch (encErr) {
      if (encErr instanceof WebhookError && encErr.code === 'invalid_encryption_configuration') {
        throw new Core1CommandError('service_unavailable_encryption', 503);
      }
      if (encErr instanceof Core1CommandError) {
        throw encErr;
      }
      throw new Core1CommandError('service_unavailable_encryption', 503);
    }

    // 14. Persist encrypted raw_event before returning 202
    const eventId = randomUUID();
    await ports.repo.persistCommandEvent({
      eventId,
      familyId: membership.familyId,
      scopedIdempotencyKey,
      payloadHash: bodyHash,
      payloadCiphertext: ciphertext,
      commandType,
      actorPersonId: membership.personId,
    });

    // 15. Return 202 Accepted status representation (queued/requested only)
    return {
      eventId,
      commandType,
      status: 'queued',
      deduped: false,
    };
  } catch (err) {
    throw mapToCommandError(err);
  }
}
