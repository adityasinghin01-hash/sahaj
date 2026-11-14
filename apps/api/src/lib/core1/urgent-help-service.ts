/**
 * Core 1 Urgent Help Escalation Chain (J3)
 *
 * Flow:
 * 1. POST /api/core1/urgent-help or POST /api/core1/maa/urgent creates an incident and offers
 *    it to the top-ranked eligible circle member (consent_at != null, revoked_at == null, never subject).
 * 2. Places an outbound Twilio call through Phase 2 dispatchOutbound + createContactResolver
 *    pointing to GET/POST /api/core1/urgent-help/twilio/twiml (AI disclosure + DTMF Gather:
 *    "1 dabaiye — main ja raha hoon, 2 — nahi ja sakta").
 * 3. Press 1 -> Phase 2 /api/twilio/gather -> record_responder_acceptance + accept_assignment_verified ->
 *    trigger updates incidents.state = 'accepted', owner_person_id, promised_at (~4 min default).
 * 4. Press 2 / decline / call no-answer/busy / offer timeout (scaled by DEMO_TIMER_SCALE) ->
 *    advance_urgent_incident_offer marks declined/expired and offers next eligible ranked circle member,
 *    or escalates the incident when the circle is exhausted.
 * 5. Riya receives an Expo app push (app_push_tokens, never WhatsApp) at each step.
 * 6. Status is readable via GET /api/core1/feed/incidents and GET /api/core1/maa/urgent/[id]
 *    with calm wording (e.g. "Sharma uncle aa rahe hain · 4 minute").
 */

import { randomUUID } from 'node:crypto';
import {
  AI_DISCLOSURE,
  assertSafeUrl,
  type FetchTransport,
} from '@sahaj/adapters';
import { handleResponderResponse } from '../../../../../packages/atlas/src/core1/urgent-responder';
import type {
  IncidentAssignment,
  ResponderAcceptanceProof,
  UrgentIncident,
} from '../../../../../packages/atlas/src/core1/types';
import {
  dispatchOutbound,
  type ContactResolver,
  type DispatchDeps,
  type DispatchOutcome,
} from '../provider-dispatch';
import { createContactResolver } from '../provider-dispatch/contacts';
import { dispatchStore } from '../provider-dispatch/supabase-store';
import { encryptWebhook } from '../webhook-security';
import { canonicalJson } from '../timeline';
import { serviceDatabase } from '../database';
import { Core1CommandError } from './errors';
import { assertCommandCapability } from './capabilities';
import {
  extractIdempotencyKey,
  isValidUuid,
  validateUrgentHelpPayload,
  validateUuid,
} from './validation';
import {
  clockAt,
  createSupabaseCore1AuthPort,
  createSupabaseCore1TimelinePort,
  parseOptionalFamilyId,
  readCore1JsonRequest,
  sha256Hex,
  stableCore1Uuid,
  toFamilyMembership,
  type Core1Actor,
  type Core1AuthPort,
  type Core1TimelinePort,
  type SupabaseClientLike,
} from './wiring-common';
import {
  claimOutboxRowForDirectDispatch,
  createSupabaseDispatchAuthorizer,
  listFamilyChildPushTokens,
  parseDemoTimerScale,
  sanitizeNoDigitsRun,
  scaleDurationSeconds,
  sendAppPushTokens,
  type PushFetch,
} from './push-notify';

export const DEFAULT_OFFER_TIMEOUT_MINUTES = 3;
export const URGENT_RESPONDER_TWIML_PROVENANCE = 'api.core1.urgent_help.twilio.twiml:v1';

const xmlEscape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export interface UrgentResponderTwimlOptions {
  gatherActionUrl: string;
}

export function buildUrgentResponderTwiml(options: UrgentResponderTwimlOptions): string {
  const gatherAction = options.gatherActionUrl.trim();
  if (!/^https:\/\//i.test(gatherAction)) {
    throw new Core1CommandError('invalid_twilio_gather_url', 503);
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say language="hi-IN">${xmlEscape(AI_DISCLOSURE.Hindi)} ${xmlEscape('परिवार में एक ज़रूरी मदद चाहिए।')}</Say>` +
    `<Gather input="dtmf" numDigits="1" timeout="10" action="${xmlEscape(gatherAction)}" method="POST">` +
    `<Say language="hi-IN">${xmlEscape('1 dabaiye — main ja raha hoon, 2 — nahi ja sakta')}</Say>` +
    `</Gather>` +
    `<Say language="hi-IN">${xmlEscape('कोई उत्तर नहीं मिला। धन्यवाद।')}</Say>` +
    `<Hangup/>` +
    `</Response>`
  );
}

export interface UrgentResponderRenderer {
  provenance: string;
  url: string;
  gatherActionUrl: string;
  render(): string;
}

export function buildUrgentResponderRenderer(params: {
  baseUrl: string;
  gatherActionUrl: string;
}): UrgentResponderRenderer {
  const cleanBase = params.baseUrl.replace(/\/+$/, '');
  const url = `${cleanBase}/api/core1/urgent-help/twilio/twiml`;
  return {
    provenance: URGENT_RESPONDER_TWIML_PROVENANCE,
    url,
    gatherActionUrl: params.gatherActionUrl,
    render: () => buildUrgentResponderTwiml({ gatherActionUrl: params.gatherActionUrl }),
  };
}

export interface UrgentIncidentRow {
  id: string;
  familyId: string;
  subjectPersonId: string;
  state: UrgentIncident['state'];
  severity: 'routine' | 'urgent' | 'critical';
  ownerPersonId: string | null;
  promisedAt: string | null;
  createdAt: string;
}

export interface UrgentAssignmentRow {
  id: string;
  familyId: string;
  incidentId: string;
  personId: string;
  status: 'offered' | 'accepted' | 'declined' | 'expired' | 'completed';
  offeredAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  verifiedByProviderEvent: string | null;
}

export interface PrepareUrgentDispatchResult {
  status: 'ready' | 'existing' | 'denied';
  outboxId?: string;
  callId?: string;
  actionRequestId?: string;
  reason?: string;
}

export interface AdvanceUrgentOfferResult {
  status: 'offered' | 'escalated' | 'not_yet_expired' | 'already_terminal' | 'assignment_not_offered' | 'incident_not_found';
  incidentId?: string;
  previousAssignmentId?: string;
  previousResponderId?: string;
  assignmentId?: string;
  responderPersonId?: string;
  expiresAt?: string;
}

export interface UrgentCircleMemberRow {
  id: string;
  familyId: string;
  personId: string;
  rank: number;
  active: boolean;
  consentAt: string | null;
  revokedAt: string | null;
}

export interface UrgentHelpStore {
  verifyFamilyPerson(familyId: string, personId: string): Promise<boolean>;
  getPersonDisplayName(familyId: string, personId: string): Promise<string>;
  getCircleMember(familyId: string, personId: string): Promise<UrgentCircleMemberRow | null>;
  listCircleMembers(familyId: string): Promise<UrgentCircleMemberRow[]>;
  listChildPushTokens(familyId: string): Promise<string[]>;
  createUrgentIncidentOfferScaled(params: {
    familyId: string;
    subjectPersonId: string;
    severity: 'routine' | 'urgent' | 'critical';
    offerTimeoutSeconds: number;
  }): Promise<{
    incidentId: string;
    assignmentId: string | null;
    responderPersonId: string | null;
    state: string;
    expiresAt: string | null;
    reason?: string;
  }>;
  getIncident(familyId: string, incidentId: string): Promise<UrgentIncidentRow | null>;
  getAssignment(familyId: string, incidentId: string, assignmentId: string): Promise<UrgentAssignmentRow | null>;
  listIncidentAssignments(familyId: string, incidentId: string): Promise<UrgentAssignmentRow[]>;
  prepareUrgentResponderDispatch(params: {
    familyId: string;
    incidentId: string;
    assignmentId: string;
    subjectPersonId: string;
    responderPersonId: string;
    dedupeKey: string;
    payloadCiphertext: string;
    payloadHash: string;
  }): Promise<PrepareUrgentDispatchResult>;
  claimOutboxForDirectDispatch(outboxId: string, workerId: string): Promise<{ leaseToken: string; attempt: number } | null>;
  finishOutboxDispatch(outboxId: string, leaseToken: string, success: boolean, errorCode?: string | null): Promise<void>;
  advanceUrgentOffer(params: {
    familyId: string;
    incidentId: string;
    assignmentId: string;
    reason: 'declined' | 'expired';
    offerTimeoutSeconds: number;
  }): Promise<AdvanceUrgentOfferResult>;
  acceptAssignmentVerified(params: {
    familyId: string;
    incidentId: string;
    assignmentId: string;
    responderPersonId: string;
    rawEventId: string;
    promiseMinutes: number;
  }): Promise<UrgentIncidentRow | null>;
  loadAcceptanceProof(familyId: string, rawEventId: string): Promise<ResponderAcceptanceProof | null>;
  completeIncident(familyId: string, incidentId: string): Promise<UrgentIncidentRow | null>;
  recordChildAlert(params: {
    id: string;
    familyId: string;
    personId: string;
    incidentId: string;
    kind: string;
  }): Promise<void>;
  findCommandDedupe(familyId: string, dedupeKey: string): Promise<{ entityId: string; payloadHash: string } | null>;
  saveCommandDedupe(params: {
    eventId: string;
    familyId: string;
    dedupeKey: string;
    payloadHash: string;
    entityId: string;
  }): Promise<void>;
  listExpiredOfferedAssignments(nowIso: string, limit?: number): Promise<
    Array<{
      familyId: string;
      incidentId: string;
      assignmentId: string;
      subjectPersonId: string;
      responderPersonId: string;
      severity: 'routine' | 'urgent' | 'critical';
    }>
  >;
  listUnnotifiedAcceptedAssignments(limit?: number): Promise<
    Array<{
      familyId: string;
      incidentId: string;
      assignmentId: string;
      subjectPersonId: string;
      responderPersonId: string;
      promisedAt: string | null;
    }>
  >;
  listFailedResponderCalls(limit?: number): Promise<
    Array<{
      familyId: string;
      incidentId: string;
      assignmentId: string;
      subjectPersonId: string;
      responderPersonId: string;
      severity: 'routine' | 'urgent' | 'critical';
      failureStatus: string;
    }>
  >;
  hasTimelineDedupe(familyId: string, dedupeKey: string): Promise<boolean>;
}

export interface UrgentDispatchRuntime {
  deps: DispatchDeps;
  twimlUrl: string;
  gatherCallbackUrl: string;
  dispatchFn?: typeof dispatchOutbound;
}

export interface UrgentHelpServiceDeps {
  auth: Core1AuthPort;
  store: UrgentHelpStore;
  timeline: Core1TimelinePort;
  dispatch?: UrgentDispatchRuntime | null;
  pushFetch?: PushFetch;
  encryptionKeyHex?: string;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

function getNow(deps: UrgentHelpServiceDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function computeEtaMinutes(promisedAt: string | null, now: Date): number {
  if (!promisedAt) return 4;
  const diffMs = Date.parse(promisedAt) - now.getTime();
  if (!Number.isFinite(diffMs)) return 4;
  return Math.max(1, Math.ceil(diffMs / 60_000));
}

export function formatUrgentAcceptedCalmLine(responderName: string, etaMinutes: number): string {
  const safeName = sanitizeNoDigitsRun(responderName, 60);
  const mins = Math.max(1, Math.round(etaMinutes));
  return `${safeName} aa rahe hain · ${mins} minute`;
}

async function notifyRiyaPush(
  deps: UrgentHelpServiceDeps,
  params: {
    familyId: string;
    title: string;
    body: string;
    incidentId: string;
    stage: string;
    assignmentId?: string;
  },
): Promise<{ sent: boolean; tokenCount: number; reason?: string }> {
  const tokens = await deps.store.listChildPushTokens(params.familyId);
  return sendAppPushTokens({
    tokens,
    fetchImpl: deps.pushFetch,
    message: {
      familyId: params.familyId,
      title: params.title,
      body: params.body,
      data: {
        kind: 'urgent_help',
        stage: params.stage,
        incidentId: params.incidentId,
        ...(params.assignmentId ? { assignmentId: params.assignmentId } : {}),
      },
    },
  });
}

async function dispatchTwilioForOffer(
  deps: UrgentHelpServiceDeps,
  params: {
    familyId: string;
    incidentId: string;
    assignmentId: string;
    subjectPersonId: string;
    responderPersonId: string;
    severity: 'routine' | 'urgent' | 'critical';
  },
): Promise<{
  prepared: PrepareUrgentDispatchResult;
  outcome?: DispatchOutcome;
  callSkippedReason?: string;
}> {
  const encKey = deps.encryptionKeyHex ?? deps.env?.WEBHOOK_ENCRYPTION_KEY ?? process.env.WEBHOOK_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
    throw new Core1CommandError('encryption_not_configured', 503);
  }

  const dedupeKey = `urgent_responder:${params.incidentId}:${params.assignmentId}`;
  const outboxPayload = {
    v: 1,
    action: 'urgent_responder',
    incidentId: params.incidentId,
    assignmentId: params.assignmentId,
    subjectPersonId: params.subjectPersonId,
    severity: params.severity,
  };
  const canonical = canonicalJson(outboxPayload);
  const payloadHash = sha256Hex(canonical);
  const payloadCiphertext = encryptWebhook(
    Buffer.from(canonical, 'utf8'),
    encKey,
    `outbox:${params.familyId}:${dedupeKey}`,
  );

  const prepared = await deps.store.prepareUrgentResponderDispatch({
    familyId: params.familyId,
    incidentId: params.incidentId,
    assignmentId: params.assignmentId,
    subjectPersonId: params.subjectPersonId,
    responderPersonId: params.responderPersonId,
    dedupeKey,
    payloadCiphertext,
    payloadHash,
  });

  if (prepared.status === 'denied' || !prepared.outboxId) {
    return { prepared, callSkippedReason: prepared.reason ?? 'prepare_denied' };
  }

  if (!deps.dispatch || !deps.dispatch.deps.providers.twilio) {
    return { prepared, callSkippedReason: 'twilio_not_configured' };
  }

  const workerId = `urgent-worker-${randomUUID().slice(0, 8)}`;
  const claimed = await deps.store.claimOutboxForDirectDispatch(prepared.outboxId, workerId);
  if (!claimed) {
    return { prepared, callSkippedReason: 'outbox_not_claimable' };
  }

  const dispatchFn = deps.dispatch.dispatchFn ?? dispatchOutbound;
  const outcome = await dispatchFn(deps.dispatch.deps, {
    familyId: params.familyId,
    personId: params.responderPersonId,
    outboxId: prepared.outboxId,
    outboxLease: claimed.leaseToken,
    attempt: claimed.attempt,
    callId: prepared.callId,
    aiDisclosureAttested: true,
    payload: {
      action: 'twilio.create_call',
      twimlUrl: deps.dispatch.twimlUrl,
    },
  });

  if (outcome.status === 'dispatched') {
    await deps.store.finishOutboxDispatch(prepared.outboxId, claimed.leaseToken, true, null);
  } else if (outcome.status === 'failed' || outcome.status === 'denied') {
    await deps.store.finishOutboxDispatch(prepared.outboxId, claimed.leaseToken, false, outcome.code);
  } else if (outcome.status === 'delivery_unknown') {
    await deps.store.finishOutboxDispatch(prepared.outboxId, claimed.leaseToken, false, outcome.code);
  }

  return { prepared, outcome };
}

/**
 * Triggers Phase 2 Twilio dispatch + Riya push for an already-created incident (used by both
 * /api/core1/urgent-help and /api/core1/maa/urgent).
 */
export async function dispatchUrgentCallAndPushForIncident(
  deps: UrgentHelpServiceDeps,
  params: {
    familyId: string;
    incidentId: string;
    subjectPersonId: string;
    severity: 'routine' | 'urgent' | 'critical';
    assignmentId: string | null;
    responderPersonId: string | null;
    state: string;
  },
): Promise<{
  callOutcome?: DispatchOutcome;
  callSkippedReason?: string;
  outboxId?: string;
  pushResult: { sent: boolean; tokenCount: number; reason?: string };
}> {
  const now = getNow(deps);
  const subjectName = await deps.store.getPersonDisplayName(params.familyId, params.subjectPersonId);

  if (params.state === 'escalated' || !params.assignmentId || !params.responderPersonId) {
    await deps.store.recordChildAlert({
      id: stableCore1Uuid(['child_alert', params.familyId, params.incidentId, 'escalated']),
      familyId: params.familyId,
      personId: params.subjectPersonId,
      incidentId: params.incidentId,
      kind: 'urgent_escalated',
    });

    await deps.timeline.append({
      familyId: params.familyId,
      eventType: 'urgent.escalated',
      entityId: params.incidentId,
      dedupeKey: `urgent_escalated:${params.incidentId}`,
      humanLine: sanitizeNoDigitsRun(`No eligible circle responder available for ${subjectName}; family alerted.`),
      payload: {
        incidentId: params.incidentId,
        subjectPersonId: params.subjectPersonId,
        severity: params.severity,
        reason: 'no_available_circle_members',
      },
      occurredAt: now.toISOString(),
    });

    const pushResult = await notifyRiyaPush(deps, {
      familyId: params.familyId,
      title: `Urgent help needed for ${subjectName}`,
      body: 'No circle responder answered automatically — please check now',
      incidentId: params.incidentId,
      stage: 'escalated',
    });

    return { callSkippedReason: 'no_available_circle_members', pushResult };
  }

  const responderName = await deps.store.getPersonDisplayName(params.familyId, params.responderPersonId);

  await deps.timeline.append({
    familyId: params.familyId,
    eventType: 'urgent.offered',
    entityId: params.incidentId,
    dedupeKey: `urgent_offer:${params.incidentId}:${params.assignmentId}`,
    humanLine: sanitizeNoDigitsRun(`Urgent help requested for ${subjectName}; calling ${responderName}.`),
    payload: {
      incidentId: params.incidentId,
      assignmentId: params.assignmentId,
      subjectPersonId: params.subjectPersonId,
      responderPersonId: params.responderPersonId,
      severity: params.severity,
    },
    occurredAt: now.toISOString(),
  });

  const dispatchRes = await dispatchTwilioForOffer(deps, {
    familyId: params.familyId,
    incidentId: params.incidentId,
    assignmentId: params.assignmentId,
    subjectPersonId: params.subjectPersonId,
    responderPersonId: params.responderPersonId,
    severity: params.severity,
  });

  if (dispatchRes.outcome?.status === 'dispatched') {
    await deps.timeline.append({
      familyId: params.familyId,
      eventType: 'urgent.responder_called',
      entityId: params.incidentId,
      dedupeKey: `urgent_call:${params.incidentId}:${params.assignmentId}`,
      humanLine: sanitizeNoDigitsRun(`Placed Twilio urgent responder call to ${responderName}.`),
      payload: {
        incidentId: params.incidentId,
        assignmentId: params.assignmentId,
        responderPersonId: params.responderPersonId,
        outboxId: dispatchRes.prepared.outboxId,
        providerRef: dispatchRes.outcome.providerRef,
      },
      occurredAt: getNow(deps).toISOString(),
    });
  }

  const pushResult = await notifyRiyaPush(deps, {
    familyId: params.familyId,
    title: `Urgent help requested by ${subjectName}`,
    body: `Calling ${responderName} now for help`,
    incidentId: params.incidentId,
    assignmentId: params.assignmentId,
    stage: 'offered',
  });

  return {
    outboxId: dispatchRes.prepared.outboxId,
    callOutcome: dispatchRes.outcome,
    callSkippedReason: dispatchRes.callSkippedReason,
    pushResult,
  };
}

export async function advanceAndDispatchNextResponder(
  deps: UrgentHelpServiceDeps,
  params: {
    familyId: string;
    incidentId: string;
    assignmentId: string;
    subjectPersonId: string;
    severity: 'routine' | 'urgent' | 'critical';
    reason: 'declined' | 'expired';
  },
): Promise<{
  status: AdvanceUrgentOfferResult['status'];
  nextAssignmentId?: string;
  nextResponderPersonId?: string;
  callOutcome?: DispatchOutcome;
  pushResult?: { sent: boolean; tokenCount: number; reason?: string };
}> {
  const scale = parseDemoTimerScale(deps.env ?? process.env);
  const timeoutSeconds = scaleDurationSeconds(DEFAULT_OFFER_TIMEOUT_MINUTES, scale);
  const advanced = await deps.store.advanceUrgentOffer({
    familyId: params.familyId,
    incidentId: params.incidentId,
    assignmentId: params.assignmentId,
    reason: params.reason,
    offerTimeoutSeconds: timeoutSeconds,
  });

  if (advanced.status !== 'offered' && advanced.status !== 'escalated') {
    return { status: advanced.status };
  }

  const subjectName = await deps.store.getPersonDisplayName(params.familyId, params.subjectPersonId);
  const prevResponderName = advanced.previousResponderId
    ? await deps.store.getPersonDisplayName(params.familyId, advanced.previousResponderId)
    : 'Previous responder';

  await deps.timeline.append({
    familyId: params.familyId,
    eventType: params.reason === 'declined' ? 'urgent.declined' : 'urgent.offer_timed_out',
    entityId: params.incidentId,
    dedupeKey: `urgent_${params.reason}:${params.incidentId}:${params.assignmentId}`,
    humanLine: sanitizeNoDigitsRun(
      params.reason === 'declined'
        ? `${prevResponderName} declined urgent offer for ${subjectName}.`
        : `${prevResponderName} did not answer in time for ${subjectName}.`,
    ),
    payload: {
      incidentId: params.incidentId,
      assignmentId: params.assignmentId,
      previousResponderId: advanced.previousResponderId ?? null,
      reason: params.reason,
    },
    occurredAt: getNow(deps).toISOString(),
  });

  if (advanced.status === 'escalated' || !advanced.assignmentId || !advanced.responderPersonId) {
    await deps.store.recordChildAlert({
      id: stableCore1Uuid(['child_alert', params.familyId, params.incidentId, 'escalated']),
      familyId: params.familyId,
      personId: params.subjectPersonId,
      incidentId: params.incidentId,
      kind: 'urgent_escalated',
    });

    await deps.timeline.append({
      familyId: params.familyId,
      eventType: 'urgent.escalated',
      entityId: params.incidentId,
      dedupeKey: `urgent_escalated:${params.incidentId}`,
      humanLine: sanitizeNoDigitsRun(`Circle exhausted for ${subjectName}; escalating to family.`),
      payload: {
        incidentId: params.incidentId,
        subjectPersonId: params.subjectPersonId,
        reason: params.reason === 'declined' ? 'circle_exhausted_declined' : 'circle_exhausted_timeout',
      },
      occurredAt: getNow(deps).toISOString(),
    });

    const pushResult = await notifyRiyaPush(deps, {
      familyId: params.familyId,
      title: `Urgent escalation: ${subjectName}`,
      body: 'No circle member could confirm — please step in immediately',
      incidentId: params.incidentId,
      stage: 'escalated',
    });

    return { status: 'escalated', pushResult };
  }

  const nextDispatch = await dispatchUrgentCallAndPushForIncident(deps, {
    familyId: params.familyId,
    incidentId: params.incidentId,
    subjectPersonId: params.subjectPersonId,
    severity: params.severity,
    assignmentId: advanced.assignmentId,
    responderPersonId: advanced.responderPersonId,
    state: 'offered',
  });

  return {
    status: 'offered',
    nextAssignmentId: advanced.assignmentId,
    nextResponderPersonId: advanced.responderPersonId,
    callOutcome: nextDispatch.callOutcome,
    pushResult: nextDispatch.pushResult,
  };
}

/**
 * Executes POST /api/core1/urgent-help synchronously through real urgent-responder
 * creation/decline/accept/complete, Phase 2 Twilio dispatch, Riya Expo push, and signed timeline.
 */
export async function executeUrgentHelpCommand(
  request: Request,
  deps: UrgentHelpServiceDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const bodyObj = await readCore1JsonRequest(request);
  const requestedFamilyId = parseOptionalFamilyId(request, bodyObj);
  const actor: Core1Actor = await deps.auth.authenticate(request, requestedFamilyId);
  const idempotencyKey = extractIdempotencyKey(request, bodyObj);

  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bodyObj)) {
    if (!['command', 'command_type', 'familyId', 'family_id', 'idempotencyKey', 'idempotency_key'].includes(k)) {
      cleaned[k] = v;
    }
  }

  const payload = validateUrgentHelpPayload(cleaned);
  const subjectOk = await deps.store.verifyFamilyPerson(actor.familyId, payload.subjectPersonId);
  if (!subjectOk) {
    throw new Core1CommandError('foreign_subject_reference', 403);
  }

  const circleRecord =
    actor.role === 'circle' ? await deps.store.getCircleMember(actor.familyId, actor.personId) : null;
  assertCommandCapability(
    'urgent_help',
    toFamilyMembership(actor),
    circleRecord
      ? {
          familyId: circleRecord.familyId,
          personId: circleRecord.personId,
          rank: circleRecord.rank,
          active: circleRecord.active,
          approvedAt: null,
          consentAt: circleRecord.consentAt,
          revokedAt: circleRecord.revokedAt,
        }
      : null,
    payload.subjectPersonId,
  );

  const canonicalReqHash = sha256Hex(canonicalJson(JSON.parse(JSON.stringify(payload))));
  const scopedKey = sha256Hex(`${actor.familyId}:${actor.personId}:urgent_help:${idempotencyKey}`);

  const dedupe = await deps.store.findCommandDedupe(actor.familyId, scopedKey);
  if (dedupe) {
    if (dedupe.payloadHash !== canonicalReqHash) {
      throw new Core1CommandError('idempotency_conflict_payload_mismatch', 409);
    }
    const existingInc = await deps.store.getIncident(actor.familyId, dedupe.entityId);
    return {
      status: 200,
      body: {
        ok: true,
        deduped: true,
        commandType: 'urgent_help',
        incidentId: dedupe.entityId,
        state: existingInc?.state ?? 'offered',
        responderPersonId: existingInc?.ownerPersonId ?? null,
        promisedAt: existingInc?.promisedAt ?? null,
      },
    };
  }

  const now = getNow(deps);

  if (payload.action === 'initiate') {
    const scale = parseDemoTimerScale(deps.env ?? process.env);
    const timeoutSeconds = scaleDurationSeconds(DEFAULT_OFFER_TIMEOUT_MINUTES, scale);
    const created = await deps.store.createUrgentIncidentOfferScaled({
      familyId: actor.familyId,
      subjectPersonId: payload.subjectPersonId,
      severity: payload.severity,
      offerTimeoutSeconds: timeoutSeconds,
    });

    await deps.store.saveCommandDedupe({
      eventId: randomUUID(),
      familyId: actor.familyId,
      dedupeKey: scopedKey,
      payloadHash: canonicalReqHash,
      entityId: created.incidentId,
    });

    const dispatched = await dispatchUrgentCallAndPushForIncident(deps, {
      familyId: actor.familyId,
      incidentId: created.incidentId,
      subjectPersonId: payload.subjectPersonId,
      severity: payload.severity,
      assignmentId: created.assignmentId,
      responderPersonId: created.responderPersonId,
      state: created.state,
    });

    return {
      status: 201,
      body: {
        ok: true,
        deduped: false,
        commandType: 'urgent_help',
        action: 'initiate',
        incidentId: created.incidentId,
        assignmentId: created.assignmentId,
        responderPersonId: created.responderPersonId,
        state: created.state,
        expiresAt: created.expiresAt,
        outboxId: dispatched.outboxId ?? null,
        callStatus: dispatched.callOutcome?.status ?? dispatched.callSkippedReason ?? 'pending',
        pushSent: dispatched.pushResult.sent,
      },
    };
  }

  if (!payload.incidentId || !payload.assignmentId) {
    if (payload.action === 'complete' && payload.incidentId) {
      const done = await deps.store.completeIncident(actor.familyId, payload.incidentId);
      if (!done) throw new Core1CommandError('incident_not_found', 404);
      const subjectName = await deps.store.getPersonDisplayName(actor.familyId, done.subjectPersonId);
      await deps.timeline.append({
        familyId: actor.familyId,
        eventType: 'urgent.completed',
        entityId: done.id,
        dedupeKey: `urgent_completed:${done.id}`,
        humanLine: sanitizeNoDigitsRun(`Urgent help resolved for ${subjectName}.`),
        payload: { incidentId: done.id },
        occurredAt: now.toISOString(),
      });
      await notifyRiyaPush(deps, {
        familyId: actor.familyId,
        title: 'All clear',
        body: `Help resolved for ${subjectName}`,
        incidentId: done.id,
        stage: 'done',
      });
      await deps.store.saveCommandDedupe({
        eventId: randomUUID(),
        familyId: actor.familyId,
        dedupeKey: scopedKey,
        payloadHash: canonicalReqHash,
        entityId: done.id,
      });
      return {
        status: 200,
        body: { ok: true, deduped: false, commandType: 'urgent_help', action: 'complete', incidentId: done.id, state: done.state },
      };
    }
    throw new Core1CommandError('missing_incident_or_assignment_id', 400);
  }

  const incident = await deps.store.getIncident(actor.familyId, payload.incidentId);
  if (!incident) throw new Core1CommandError('incident_not_found', 404);
  const assignment = await deps.store.getAssignment(actor.familyId, incident.id, payload.assignmentId);
  if (!assignment) throw new Core1CommandError('assignment_not_found', 404);

  if (payload.action === 'accept') {
    if (!payload.rawEventId || !isValidUuid(payload.rawEventId)) {
      throw new Core1CommandError('missing_acceptance_proof_event', 400);
    }
    const proof = await deps.store.loadAcceptanceProof(actor.familyId, payload.rawEventId);
    if (!proof) {
      throw new Core1CommandError('invalid_acceptance_proof', 403);
    }

    const circle = await deps.store.listCircleMembers(actor.familyId);
    const domainRes = handleResponderResponse({
      incident: {
        id: incident.id,
        familyId: incident.familyId,
        personId: incident.subjectPersonId,
        state: incident.state,
        severity: incident.severity,
        ownerPersonId: incident.ownerPersonId ?? undefined,
        promisedAt: incident.promisedAt ?? undefined,
        createdAt: incident.createdAt,
      },
      currentAssignment: {
        id: assignment.id,
        familyId: assignment.familyId,
        incidentId: assignment.incidentId,
        personId: assignment.personId,
        status: assignment.status,
        offeredAt: assignment.offeredAt,
        expiresAt: assignment.expiresAt,
      },
      circle: circle.map((c) => ({
        personId: c.personId,
        rank: c.rank,
        active: c.active,
        consentAt: c.consentAt ?? undefined,
        revokedAt: c.revokedAt ?? undefined,
      })),
      response: {
        responderPersonId: assignment.personId,
        responseType: 'accept',
        acceptanceProof: proof,
        promiseMinutes: payload.promiseMinutes ?? 4,
      },
      clock: clockAt(now),
    });

    if (domainRes.transitionStatus !== 'success') {
      throw new Core1CommandError(domainRes.transitionStatus, 409);
    }

    const updated = await deps.store.acceptAssignmentVerified({
      familyId: actor.familyId,
      incidentId: incident.id,
      assignmentId: assignment.id,
      responderPersonId: assignment.personId,
      rawEventId: payload.rawEventId,
      promiseMinutes: payload.promiseMinutes ?? 4,
    });
    if (!updated) throw new Core1CommandError('acceptance_persistence_failed', 409);

    const responderName = await deps.store.getPersonDisplayName(actor.familyId, assignment.personId);
    const etaMinutes = computeEtaMinutes(updated.promisedAt, now);
    const calmLine = formatUrgentAcceptedCalmLine(responderName, etaMinutes);

    await deps.timeline.append({
      familyId: actor.familyId,
      eventType: 'urgent.accepted',
      entityId: incident.id,
      dedupeKey: `urgent_accepted:${incident.id}:${assignment.id}`,
      humanLine: calmLine,
      payload: {
        incidentId: incident.id,
        assignmentId: assignment.id,
        responderPersonId: assignment.personId,
        proofEventId: payload.rawEventId,
        etaMinutes,
      },
      occurredAt: now.toISOString(),
    });

    const pushResult = await notifyRiyaPush(deps, {
      familyId: actor.familyId,
      title: `${responderName} accepted urgent help`,
      body: calmLine,
      incidentId: incident.id,
      assignmentId: assignment.id,
      stage: 'accepted',
    });

    await deps.store.saveCommandDedupe({
      eventId: randomUUID(),
      familyId: actor.familyId,
      dedupeKey: scopedKey,
      payloadHash: canonicalReqHash,
      entityId: incident.id,
    });

    return {
      status: 200,
      body: {
        ok: true,
        deduped: false,
        commandType: 'urgent_help',
        action: 'accept',
        incidentId: incident.id,
        assignmentId: assignment.id,
        responderPersonId: assignment.personId,
        state: 'accepted',
        promisedAt: updated.promisedAt,
        statusLine: calmLine,
        pushSent: pushResult.sent,
      },
    };
  }

  // action === 'decline'
  if (assignment.status !== 'offered') {
    throw new Core1CommandError('assignment_not_offered', 409);
  }
  const advanced = await advanceAndDispatchNextResponder(deps, {
    familyId: actor.familyId,
    incidentId: incident.id,
    assignmentId: assignment.id,
    subjectPersonId: incident.subjectPersonId,
    severity: incident.severity,
    reason: 'declined',
  });

  await deps.store.saveCommandDedupe({
    eventId: randomUUID(),
    familyId: actor.familyId,
    dedupeKey: scopedKey,
    payloadHash: canonicalReqHash,
    entityId: incident.id,
  });

  return {
    status: 200,
    body: {
      ok: true,
      deduped: false,
      commandType: 'urgent_help',
      action: 'decline',
      incidentId: incident.id,
      state: advanced.status === 'escalated' ? 'escalated' : 'offered',
      nextAssignmentId: advanced.nextAssignmentId ?? null,
      nextResponderPersonId: advanced.nextResponderPersonId ?? null,
      pushSent: advanced.pushResult?.sent ?? false,
    },
  };
}

/**
 * Periodic cron tick handler for urgent incidents:
 * 1. Sends Riya Expo push + timeline for any assignment recently accepted via /api/twilio/gather.
 * 2. Advances offers whose responder Twilio call failed (no-answer/busy/failed) or whose offer timer expired.
 */
export async function processUrgentEscalationTick(deps: UrgentHelpServiceDeps): Promise<{
  acceptedNotified: number;
  failedCallsAdvanced: number;
  timeoutsAdvanced: number;
}> {
  const now = getNow(deps);
  let acceptedNotified = 0;
  let failedCallsAdvanced = 0;
  let timeoutsAdvanced = 0;

  const accepted = await deps.store.listUnnotifiedAcceptedAssignments(20);
  for (const row of accepted) {
    const dedupeKey = `urgent_accepted:${row.incidentId}:${row.assignmentId}`;
    const already = await deps.store.hasTimelineDedupe(row.familyId, dedupeKey);
    if (already) continue;

    const responderName = await deps.store.getPersonDisplayName(row.familyId, row.responderPersonId);
    const etaMinutes = computeEtaMinutes(row.promisedAt, now);
    const calmLine = formatUrgentAcceptedCalmLine(responderName, etaMinutes);

    await deps.timeline.append({
      familyId: row.familyId,
      eventType: 'urgent.accepted',
      entityId: row.incidentId,
      dedupeKey,
      humanLine: calmLine,
      payload: {
        incidentId: row.incidentId,
        assignmentId: row.assignmentId,
        responderPersonId: row.responderPersonId,
        etaMinutes,
      },
      occurredAt: now.toISOString(),
    });

    await notifyRiyaPush(deps, {
      familyId: row.familyId,
      title: `${responderName} accepted urgent help`,
      body: calmLine,
      incidentId: row.incidentId,
      assignmentId: row.assignmentId,
      stage: 'accepted',
    });
    acceptedNotified++;
  }

  const failedCalls = await deps.store.listFailedResponderCalls(20);
  for (const row of failedCalls) {
    const res = await advanceAndDispatchNextResponder(deps, {
      familyId: row.familyId,
      incidentId: row.incidentId,
      assignmentId: row.assignmentId,
      subjectPersonId: row.subjectPersonId,
      severity: row.severity,
      reason: 'expired',
    });
    if (res.status === 'offered' || res.status === 'escalated') {
      failedCallsAdvanced++;
    }
  }

  const expiredOffers = await deps.store.listExpiredOfferedAssignments(now.toISOString(), 20);
  for (const row of expiredOffers) {
    const res = await advanceAndDispatchNextResponder(deps, {
      familyId: row.familyId,
      incidentId: row.incidentId,
      assignmentId: row.assignmentId,
      subjectPersonId: row.subjectPersonId,
      severity: row.severity,
      reason: 'expired',
    });
    if (res.status === 'offered' || res.status === 'escalated') {
      timeoutsAdvanced++;
    }
  }

  return { acceptedNotified, failedCallsAdvanced, timeoutsAdvanced };
}

export function createSupabaseUrgentHelpStore(db: SupabaseClientLike): UrgentHelpStore {
  return {
    async verifyFamilyPerson(familyId, personId) {
      const { data } = await db
        .from('people')
        .select('id')
        .eq('family_id', familyId)
        .eq('id', personId)
        .eq('active', true)
        .maybeSingle();
      return Boolean(data);
    },

    async getPersonDisplayName(familyId, personId) {
      const { data } = await db
        .from('people')
        .select('display_name')
        .eq('family_id', familyId)
        .eq('id', personId)
        .maybeSingle();
      const raw = data && typeof (data as { display_name?: unknown }).display_name === 'string'
        ? (data as { display_name: string }).display_name
        : 'Family member';
      return sanitizeNoDigitsRun(raw, 60);
    },

    async getCircleMember(familyId, personId) {
      const { data } = await db
        .from('circle')
        .select('id,family_id,person_id,rank,consent_at,revoked_at')
        .eq('family_id', familyId)
        .eq('person_id', personId)
        .maybeSingle();
      if (!data) return null;
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id),
        familyId: String(r.family_id),
        personId: String(r.person_id),
        rank: Number(r.rank),
        active: r.consent_at != null && r.revoked_at == null,
        consentAt: r.consent_at ? String(r.consent_at) : null,
        revokedAt: r.revoked_at ? String(r.revoked_at) : null,
      };
    },

    async listCircleMembers(familyId) {
      const { data } = await db
        .from('circle')
        .select('id,family_id,person_id,rank,consent_at,revoked_at')
        .eq('family_id', familyId)
        .order('rank', { ascending: true });
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        familyId: String(r.family_id),
        personId: String(r.person_id),
        rank: Number(r.rank),
        active: r.consent_at != null && r.revoked_at == null,
        consentAt: r.consent_at ? String(r.consent_at) : null,
        revokedAt: r.revoked_at ? String(r.revoked_at) : null,
      }));
    },

    async listChildPushTokens(familyId) {
      return listFamilyChildPushTokens(db, familyId);
    },

    async createUrgentIncidentOfferScaled(params) {
      const { data, error } = await db.rpc('create_urgent_incident_offer_scaled', {
        p_family_id: params.familyId,
        p_subject_person_id: params.subjectPersonId,
        p_severity: params.severity,
        p_offer_timeout_seconds: params.offerTimeoutSeconds,
      });
      if (error || !data) {
        throw new Core1CommandError('urgent_offer_creation_failed', 503);
      }
      const d = data as Record<string, unknown>;
      return {
        incidentId: String(d.incident_id),
        assignmentId: typeof d.assignment_id === 'string' ? d.assignment_id : null,
        responderPersonId: typeof d.responder_person_id === 'string' ? d.responder_person_id : null,
        state: String(d.state ?? 'offered'),
        expiresAt: typeof d.expires_at === 'string' ? d.expires_at : null,
        reason: typeof d.reason === 'string' ? d.reason : undefined,
      };
    },

    async getIncident(familyId, incidentId) {
      const { data } = await db
        .from('incidents')
        .select('id,family_id,person_id,state,severity,owner_person_id,promised_at,created_at')
        .eq('family_id', familyId)
        .eq('id', incidentId)
        .maybeSingle();
      if (!data) return null;
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id),
        familyId: String(r.family_id),
        subjectPersonId: String(r.person_id),
        state: r.state as UrgentIncident['state'],
        severity: r.severity as 'routine' | 'urgent' | 'critical',
        ownerPersonId: typeof r.owner_person_id === 'string' ? r.owner_person_id : null,
        promisedAt: typeof r.promised_at === 'string' ? r.promised_at : null,
        createdAt: String(r.created_at),
      };
    },

    async getAssignment(familyId, incidentId, assignmentId) {
      const { data } = await db
        .from('assignments')
        .select('id,family_id,incident_id,person_id,status,offered_at,expires_at,accepted_at,verified_by_provider_event')
        .eq('family_id', familyId)
        .eq('incident_id', incidentId)
        .eq('id', assignmentId)
        .maybeSingle();
      if (!data) return null;
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id),
        familyId: String(r.family_id),
        incidentId: String(r.incident_id),
        personId: String(r.person_id),
        status: r.status as UrgentAssignmentRow['status'],
        offeredAt: String(r.offered_at),
        expiresAt: String(r.expires_at),
        acceptedAt: typeof r.accepted_at === 'string' ? r.accepted_at : null,
        verifiedByProviderEvent:
          typeof r.verified_by_provider_event === 'string' ? r.verified_by_provider_event : null,
      };
    },

    async listIncidentAssignments(familyId, incidentId) {
      const { data } = await db
        .from('assignments')
        .select('id,family_id,incident_id,person_id,status,offered_at,expires_at,accepted_at,verified_by_provider_event')
        .eq('family_id', familyId)
        .eq('incident_id', incidentId)
        .order('offered_at', { ascending: true });
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        familyId: String(r.family_id),
        incidentId: String(r.incident_id),
        personId: String(r.person_id),
        status: r.status as UrgentAssignmentRow['status'],
        offeredAt: String(r.offered_at),
        expiresAt: String(r.expires_at),
        acceptedAt: typeof r.accepted_at === 'string' ? r.accepted_at : null,
        verifiedByProviderEvent:
          typeof r.verified_by_provider_event === 'string' ? r.verified_by_provider_event : null,
      }));
    },

    async prepareUrgentResponderDispatch(params) {
      const { data, error } = await db.rpc('prepare_urgent_responder_dispatch', {
        p_family_id: params.familyId,
        p_incident_id: params.incidentId,
        p_assignment_id: params.assignmentId,
        p_subject_person_id: params.subjectPersonId,
        p_responder_person_id: params.responderPersonId,
        p_dedupe_key: params.dedupeKey,
        p_payload_ciphertext: params.payloadCiphertext,
        p_payload_hash: params.payloadHash,
      });
      if (error || !data) {
        return { status: 'denied', reason: 'prepare_dispatch_failed' };
      }
      const d = data as Record<string, unknown>;
      return {
        status: (d.status as 'ready' | 'existing' | 'denied') ?? 'denied',
        outboxId: typeof d.outbox_id === 'string' ? d.outbox_id : undefined,
        callId: typeof d.call_id === 'string' ? d.call_id : undefined,
        actionRequestId: typeof d.action_request_id === 'string' ? d.action_request_id : undefined,
        reason: typeof d.reason === 'string' ? d.reason : undefined,
      };
    },

    async claimOutboxForDirectDispatch(outboxId, workerId) {
      return claimOutboxRowForDirectDispatch(db, outboxId, workerId);
    },

    async finishOutboxDispatch(outboxId, leaseToken, success, errorCode) {
      await db.rpc('finish_outbox', {
        p_outbox_id: outboxId,
        p_lease_token: leaseToken,
        p_success: success,
        p_error_code: errorCode ?? null,
      });
    },

    async advanceUrgentOffer(params) {
      const { data, error } = await db.rpc('advance_urgent_incident_offer', {
        p_family_id: params.familyId,
        p_incident_id: params.incidentId,
        p_assignment_id: params.assignmentId,
        p_reason: params.reason,
        p_offer_timeout_seconds: params.offerTimeoutSeconds,
      });
      if (error || !data) {
        throw new Core1CommandError('advance_urgent_offer_failed', 503);
      }
      const d = data as Record<string, unknown>;
      return {
        status: d.status as AdvanceUrgentOfferResult['status'],
        incidentId: typeof d.incident_id === 'string' ? d.incident_id : undefined,
        previousAssignmentId: typeof d.previous_assignment_id === 'string' ? d.previous_assignment_id : undefined,
        previousResponderId: typeof d.previous_responder_id === 'string' ? d.previous_responder_id : undefined,
        assignmentId: typeof d.assignment_id === 'string' ? d.assignment_id : undefined,
        responderPersonId: typeof d.responder_person_id === 'string' ? d.responder_person_id : undefined,
        expiresAt: typeof d.expires_at === 'string' ? d.expires_at : undefined,
      };
    },

    async acceptAssignmentVerified(params) {
      const { data, error } = await db.rpc('accept_responder_assignment_verified', {
        p_family_id: params.familyId,
        p_incident_id: params.incidentId,
        p_assignment_id: params.assignmentId,
        p_responder_person_id: params.responderPersonId,
        p_raw_event_id: params.rawEventId,
        p_promise_minutes: params.promiseMinutes,
      });
      if (error || !data) return null;
      return this.getIncident(params.familyId, params.incidentId);
    },

    async loadAcceptanceProof(familyId, rawEventId) {
      const { data } = await db
        .from('raw_events')
        .select('id,family_id,source,event_type,status,normalized_proof,verified_by,metadata,received_at')
        .eq('id', rawEventId)
        .eq('family_id', familyId)
        .maybeSingle();
      if (!data) return null;
      const r = data as Record<string, unknown>;
      if (
        r.status !== 'processed' ||
        r.normalized_proof !== true ||
        r.source !== 'twilio' ||
        r.event_type !== 'responder.accepted'
      ) {
        return null;
      }
      const meta = (r.metadata ?? {}) as Record<string, unknown>;
      if (
        meta.verified_by !== 'twilio_signature' ||
        meta.action !== 'urgent_responder' ||
        typeof meta.incident_id !== 'string' ||
        typeof meta.assignment_id !== 'string' ||
        typeof meta.responder_person_id !== 'string' ||
        typeof meta.subject_person_id !== 'string' ||
        typeof meta.call_id !== 'string' ||
        typeof meta.account_id !== 'string'
      ) {
        return null;
      }
      return {
        eventId: String(r.id),
        familyId,
        incidentId: meta.incident_id,
        assignmentId: meta.assignment_id,
        responderPersonId: meta.responder_person_id,
        subjectPersonId: meta.subject_person_id,
        callId: meta.call_id,
        outboxId: typeof meta.outbox_id === 'string' ? meta.outbox_id : undefined,
        actionRequestId: typeof meta.action_request_id === 'string' ? meta.action_request_id : undefined,
        action: 'urgent_responder',
        providerAction: typeof meta.provider_action === 'string' ? meta.provider_action : 'twilio.outbound_call',
        accountId: meta.account_id,
        dispatchKey: typeof meta.dispatch_key === 'string' ? meta.dispatch_key : undefined,
        normalizedProof: true,
        verifiedBy: 'twilio_signature',
        source: 'twilio',
      };
    },

    async completeIncident(familyId, incidentId) {
      const { data } = await db
        .from('incidents')
        .update({ state: 'done' })
        .eq('family_id', familyId)
        .eq('id', incidentId)
        .select('id')
        .maybeSingle();
      if (!data) return null;
      return this.getIncident(familyId, incidentId);
    },

    async recordChildAlert(params) {
      await db.from('child_alerts').upsert(
        {
          id: params.id,
          family_id: params.familyId,
          person_id: params.personId,
          incident_id: params.incidentId,
          kind: params.kind,
        },
        { onConflict: 'id' },
      );
    },

    async findCommandDedupe(familyId, dedupeKey) {
      const { data } = await db
        .from('raw_events')
        .select('metadata')
        .eq('family_id', familyId)
        .eq('source', 'core1_api')
        .eq('provider_event_id', dedupeKey)
        .maybeSingle();
      if (!data) return null;
      const meta = (data as { metadata?: Record<string, unknown> }).metadata;
      if (!meta || typeof meta.entity_id !== 'string' || typeof meta.payload_hash !== 'string') {
        return null;
      }
      return { entityId: meta.entity_id, payloadHash: meta.payload_hash };
    },

    async saveCommandDedupe(params) {
      await db.from('raw_events').insert({
        id: params.eventId,
        family_id: params.familyId,
        source: 'core1_api',
        provider_event_id: params.dedupeKey,
        event_type: 'urgent_help',
        status: 'processed',
        processed_at: new Date().toISOString(),
        metadata: {
          entity_id: params.entityId,
          payload_hash: params.payloadHash,
        },
      });
    },

    async listExpiredOfferedAssignments(nowIso, limit = 20) {
      const { data } = await db
        .from('assignments')
        .select('id,family_id,incident_id,person_id,expires_at,incidents!inner(person_id,severity,state)')
        .eq('status', 'offered')
        .lte('expires_at', nowIso)
        .eq('incidents.state', 'offered')
        .order('expires_at', { ascending: true })
        .limit(limit);

      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
        const inc = Array.isArray(r.incidents) ? r.incidents[0] : (r.incidents as Record<string, unknown>);
        return {
          familyId: String(r.family_id),
          incidentId: String(r.incident_id),
          assignmentId: String(r.id),
          subjectPersonId: String(inc.person_id),
          responderPersonId: String(r.person_id),
          severity: (inc.severity as 'routine' | 'urgent' | 'critical') ?? 'urgent',
        };
      });
    },

    async listUnnotifiedAcceptedAssignments(limit = 20) {
      const { data } = await db
        .from('assignments')
        .select('id,family_id,incident_id,person_id,verified_by_provider_event,incidents!inner(person_id,promised_at,state)')
        .eq('status', 'accepted')
        .not('verified_by_provider_event', 'is', null)
        .eq('incidents.state', 'accepted')
        .order('accepted_at', { ascending: false })
        .limit(limit);

      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
        const inc = Array.isArray(r.incidents) ? r.incidents[0] : (r.incidents as Record<string, unknown>);
        return {
          familyId: String(r.family_id),
          incidentId: String(r.incident_id),
          assignmentId: String(r.id),
          subjectPersonId: String(inc.person_id),
          responderPersonId: String(r.person_id),
          promisedAt: typeof inc.promised_at === 'string' ? inc.promised_at : null,
        };
      });
    },

    async listFailedResponderCalls(limit = 20) {
      const { data } = await db
        .from('assignments')
        .select('id,family_id,incident_id,person_id,incidents!inner(person_id,severity,state),dispatch_bindings!inner(outbox_id,outbox!inner(status,last_error_code))')
        .eq('status', 'offered')
        .eq('incidents.state', 'offered')
        .limit(limit);

      const results: Array<{
        familyId: string;
        incidentId: string;
        assignmentId: string;
        subjectPersonId: string;
        responderPersonId: string;
        severity: 'routine' | 'urgent' | 'critical';
        failureStatus: string;
      }> = [];

      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const inc = Array.isArray(r.incidents) ? r.incidents[0] : (r.incidents as Record<string, unknown>);
        const bindings = Array.isArray(r.dispatch_bindings) ? r.dispatch_bindings : [r.dispatch_bindings];
        const binding = bindings[0] as Record<string, unknown> | undefined;
        const outbox = binding
          ? (Array.isArray(binding.outbox) ? binding.outbox[0] : (binding.outbox as Record<string, unknown>))
          : undefined;
        const outboxStatus = outbox ? String(outbox.status ?? '') : '';
        if (outboxStatus === 'failed' || outboxStatus === 'dead') {
          results.push({
            familyId: String(r.family_id),
            incidentId: String(r.incident_id),
            assignmentId: String(r.id),
            subjectPersonId: String(inc.person_id),
            responderPersonId: String(r.person_id),
            severity: (inc.severity as 'routine' | 'urgent' | 'critical') ?? 'urgent',
            failureStatus: String(outbox?.last_error_code ?? outboxStatus),
          });
        }
      }
      return results;
    },

    async hasTimelineDedupe(familyId, dedupeKey) {
      const { data } = await db
        .from('timeline_events')
        .select('sequence')
        .eq('family_id', familyId)
        .eq('dedupe_key', dedupeKey)
        .maybeSingle();
      return Boolean(data);
    },
  };
}

export function createSupabaseUrgentDispatchRuntime(
  db: SupabaseClientLike,
  env: Record<string, string | undefined> = process.env,
  transport: FetchTransport = globalThis.fetch as FetchTransport,
): UrgentDispatchRuntime | null {
  const {
    TWILIO_ACCOUNT_SID: accountSid,
    TWILIO_AUTH_TOKEN: authToken,
    TWILIO_FROM_NUMBER: fromNumber,
    TWILIO_STATUS_CALLBACK_URL: statusCallbackUrl,
    TWILIO_GATHER_CALLBACK_URL: gatherCallbackUrl,
    PROVIDER_WEBHOOK_HOSTS: rawHosts,
    PUBLIC_API_BASE_URL: publicBaseUrl,
    NEXT_PUBLIC_API_BASE_URL: nextPublicBaseUrl,
    CONTACT_ENCRYPTION_KEY: contactKey,
    IDENTITY_HASH_SECRET: identitySecret,
  } = env;

  if (!accountSid || !authToken || !fromNumber || !statusCallbackUrl || !contactKey || !identitySecret) {
    return null;
  }

  const allowedWebhookHosts = (rawHosts ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  let derivedBase = publicBaseUrl ?? nextPublicBaseUrl;
  if (!derivedBase) {
    try {
      derivedBase = new URL(statusCallbackUrl).origin;
    } catch {
      return null;
    }
  }
  const gatherUrl = gatherCallbackUrl || `${derivedBase.replace(/\/+$/, '')}/api/twilio/gather`;
  const renderer = buildUrgentResponderRenderer({ baseUrl: derivedBase, gatherActionUrl: gatherUrl });

  try {
    if (allowedWebhookHosts.length === 0) return null;
    assertSafeUrl(renderer.url, allowedWebhookHosts, 'twilio');
    assertSafeUrl(statusCallbackUrl, allowedWebhookHosts, 'twilio');
    assertSafeUrl(gatherUrl, allowedWebhookHosts, 'twilio');
  } catch {
    return null;
  }

  const store = dispatchStore(db as unknown as Parameters<typeof dispatchStore>[0]);
  const resolveDestination = createContactResolver(
    db as unknown as Parameters<typeof createContactResolver>[0],
    {
      encryptionKeyHex: contactKey,
      identitySecret,
      accounts: { twilio: accountSid },
    },
  );

  const authorize = createSupabaseDispatchAuthorizer(db);

  return {
    twimlUrl: renderer.url,
    gatherCallbackUrl: gatherUrl,
    deps: {
      store,
      authorize,
      transport,
      identitySecret,
      resolveDestination,
      providers: {
        twilio: {
          accountSid,
          authToken,
          fromNumber,
          statusCallbackUrl,
          allowedWebhookHosts,
        },
      },
    },
  };
}

export function createProductionUrgentHelpDeps(
  env: Record<string, string | undefined> = process.env,
): UrgentHelpServiceDeps {
  const db = serviceDatabase();
  const encryptionKeyHex = env.WEBHOOK_ENCRYPTION_KEY;
  return {
    auth: createSupabaseCore1AuthPort(db),
    store: createSupabaseUrgentHelpStore(db),
    timeline: createSupabaseCore1TimelinePort(
      db,
      env.TIMELINE_SIGNING_PRIVATE_KEY ?? env.SIGNING_PRIVATE_KEY,
      env.TIMELINE_SIGNING_KEY_ID ?? env.SIGNING_KEY_ID ?? 'core1-default',
    ),
    dispatch: createSupabaseUrgentDispatchRuntime(db, env),
    encryptionKeyHex,
    env,
  };
}

export { validateUuid };
