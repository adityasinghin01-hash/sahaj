import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AI_DISCLOSURE } from '@sahaj/adapters';
import { verifyTimelineEvent, type SignedTimelineEvent } from '../../src/lib/timeline';
import { verifyResponderRenderer } from '../../src/lib/atlas-runtime/bridge';
import { dispatchOutbound, type DispatchStore, type DispatchDeps } from '../../src/lib/provider-dispatch';
import type { Core1Actor, Core1AuthPort, Core1TimelinePort } from '../../src/lib/core1/wiring-common';
import {
  buildUrgentResponderRenderer,
  executeUrgentHelpCommand,
  formatUrgentAcceptedCalmLine,
  processUrgentEscalationTick,
  dispatchUrgentCallAndPushForIncident,
  type UrgentAssignmentRow,
  type UrgentCircleMemberRow,
  type UrgentHelpServiceDeps,
  type UrgentHelpStore,
  type UrgentIncidentRow,
} from '../../src/lib/core1/urgent-help-service';
import type { ResponderAcceptanceProof } from '../../../../packages/atlas/src/core1/types';

const FAM_A = '11111111-1111-4111-8111-111111111111';
const FAM_B = '22222222-2222-4222-8222-222222222222';
const MAA_ID = 'c1000000-0000-4000-8000-000000000001';
const RIYA_ID = 'c1000000-0000-4000-8000-000000000002';
const SHARMA_ID = 'c1000000-0000-4000-8000-000000000003';
const VERMA_ID = 'c1000000-0000-4000-8000-000000000004';
const UNCONSENTED_ID = 'c1000000-0000-4000-8000-000000000005';
const REVOKED_ID = 'c1000000-0000-4000-8000-000000000006';
const FOREIGN_PERSON_ID = 'c9000000-0000-4000-8000-000000000099';

const PHONE_SHARMA = '+919000000011';
const PHONE_VERMA = '+919000000012';
const PHONE_TWILIO_FROM = '+15550009999';

function createHarness(initialNow = new Date('2026-11-15T06:00:00.000Z'), envOverrides: Record<string, string> = {}) {
  let now = new Date(initialNow.getTime());
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = 'test-ed25519-k1';

  const people = new Map<string, { familyId: string; displayName: string; phone?: string }>([
    [MAA_ID, { familyId: FAM_A, displayName: 'Meena Maa', phone: '+919000000001' }],
    [RIYA_ID, { familyId: FAM_A, displayName: 'Riya' }],
    [UNCONSENTED_ID, { familyId: FAM_A, displayName: 'NoConsent Neighbour', phone: '+919000000015' }],
    [REVOKED_ID, { familyId: FAM_A, displayName: 'Revoked Neighbour', phone: '+919000000016' }],
    [SHARMA_ID, { familyId: FAM_A, displayName: 'Sharma uncle', phone: PHONE_SHARMA }],
    [VERMA_ID, { familyId: FAM_A, displayName: 'Verma aunty', phone: PHONE_VERMA }],
    [FOREIGN_PERSON_ID, { familyId: FAM_B, displayName: 'Other Family' }],
  ]);

  const circleMembers: UrgentCircleMemberRow[] = [
    { id: randomUUID(), familyId: FAM_A, personId: MAA_ID, rank: 1, active: true, consentAt: '2026-11-01T00:00:00Z', revokedAt: null },
    { id: randomUUID(), familyId: FAM_A, personId: UNCONSENTED_ID, rank: 2, active: false, consentAt: null, revokedAt: null },
    { id: randomUUID(), familyId: FAM_A, personId: REVOKED_ID, rank: 3, active: false, consentAt: '2026-11-01T00:00:00Z', revokedAt: '2026-11-10T00:00:00Z' },
    { id: randomUUID(), familyId: FAM_A, personId: SHARMA_ID, rank: 4, active: true, consentAt: '2026-11-01T00:00:00Z', revokedAt: null },
    { id: randomUUID(), familyId: FAM_A, personId: VERMA_ID, rank: 5, active: true, consentAt: '2026-11-01T00:00:00Z', revokedAt: null },
  ];

  const incidents = new Map<string, UrgentIncidentRow>();
  const assignments = new Map<string, UrgentAssignmentRow>();
  const outboxRows = new Map<string, { id: string; incidentId: string; assignmentId: string; responderId: string; callId: string; attempt: number; lease?: string; dedupeKey: string }>();
  const failedCalls: Array<{
    familyId: string; incidentId: string; assignmentId: string; subjectPersonId: string; responderPersonId: string; severity: 'routine' | 'urgent' | 'critical'; failureStatus: string;
  }> = [];
  const acceptanceProofs = new Map<string, ResponderAcceptanceProof>();
  const childAlerts: Array<{ id: string; familyId: string; personId: string; incidentId: string; kind: string }> = [];
  const commandDedupe = new Map<string, { entityId: string; payloadHash: string }>();
  const timelineEvents: Array<{ signed: SignedTimelineEvent; familyId: string; dedupeKey: string; humanLine: string; payload: unknown }> = [];
  let seq = 0;
  let prevHash: string | null = null;

  const pushCalls: Array<{ url: string; messages: Array<{ to: string; title: string; body: string; data: Record<string, string> }> }> = [];
  const twilioHttpCalls: Array<{ url: string; body: string }> = [];
  const childPushTokens = ['ExponentPushToken[riya-synth-device-1]'];

  const actors: Record<string, Core1Actor> = {
    'token-maa': { userId: 'u-maa', familyId: FAM_A, personId: MAA_ID, role: 'parent' },
    'token-riya': { userId: 'u-riya', familyId: FAM_A, personId: RIYA_ID, role: 'child' },
    'token-foreign': { userId: 'u-foreign', familyId: FAM_B, personId: FOREIGN_PERSON_ID, role: 'child' },
  };

  const auth: Core1AuthPort = {
    async authenticate(request) {
      const tok = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      return actors[tok] ?? actors['token-maa'];
    },
  };

  const timeline: Core1TimelinePort = {
    async append(input) {
      const existing = timelineEvents.find((t) => t.familyId === input.familyId && t.dedupeKey === input.dedupeKey);
      if (existing) {
        return { deduped: true, sequence: seq, chainHash: existing.signed.chainHash };
      }
      seq += 1;
      const occurredAt = new Date(Date.parse(input.occurredAt ?? now.toISOString())).toISOString();
      const signed = signLocalTimeline(
        {
          familyId: input.familyId,
          eventId: randomUUID(),
          sequence: seq,
          dedupeKey: input.dedupeKey,
          eventType: input.eventType,
          entityId: input.entityId,
          humanLine: input.humanLine,
          previousHash: prevHash,
          occurredAt,
          keyId,
          payload: input.payload,
        },
        privateKey,
      );
      prevHash = signed.chainHash;
      timelineEvents.push({
        signed,
        familyId: input.familyId,
        dedupeKey: input.dedupeKey,
        humanLine: input.humanLine,
        payload: input.payload,
      });
      return { deduped: false, sequence: seq, chainHash: signed.chainHash };
    },
  };

  function eligibleNextResponder(subjectId: string, alreadyTried: Set<string>): UrgentCircleMemberRow | null {
    const candidates = circleMembers
      .filter((c) => c.familyId === FAM_A && c.personId !== subjectId && c.consentAt != null && c.revokedAt == null && !alreadyTried.has(c.personId))
      .sort((a, b) => a.rank - b.rank);
    return candidates[0] ?? null;
  }

  const store: UrgentHelpStore = {
    async verifyFamilyPerson(familyId, personId) {
      return people.get(personId)?.familyId === familyId;
    },
    async getPersonDisplayName(familyId, personId) {
      const p = people.get(personId);
      return p && p.familyId === familyId ? p.displayName : 'Family member';
    },
    async getCircleMember(familyId, personId) {
      return circleMembers.find((c) => c.familyId === familyId && c.personId === personId) ?? null;
    },
    async listCircleMembers(familyId) {
      return circleMembers.filter((c) => c.familyId === familyId);
    },
    async listChildPushTokens() {
      return childPushTokens;
    },
    async createUrgentIncidentOfferScaled(params) {
      const incidentId = randomUUID();
      const first = eligibleNextResponder(params.subjectPersonId, new Set());
      if (!first) {
        incidents.set(incidentId, {
          id: incidentId,
          familyId: params.familyId,
          subjectPersonId: params.subjectPersonId,
          state: 'escalated',
          severity: params.severity,
          ownerPersonId: null,
          promisedAt: null,
          createdAt: now.toISOString(),
        });
        return { incidentId, assignmentId: null, responderPersonId: null, state: 'escalated', expiresAt: null };
      }
      const assignmentId = randomUUID();
      const expiresAt = new Date(now.getTime() + params.offerTimeoutSeconds * 1000).toISOString();
      incidents.set(incidentId, {
        id: incidentId,
        familyId: params.familyId,
        subjectPersonId: params.subjectPersonId,
        state: 'offered',
        severity: params.severity,
        ownerPersonId: null,
        promisedAt: null,
        createdAt: now.toISOString(),
      });
      assignments.set(assignmentId, {
        id: assignmentId,
        familyId: params.familyId,
        incidentId,
        personId: first.personId,
        status: 'offered',
        offeredAt: now.toISOString(),
        expiresAt,
        acceptedAt: null,
        verifiedByProviderEvent: null,
      });
      return { incidentId, assignmentId, responderPersonId: first.personId, state: 'offered', expiresAt };
    },
    async getIncident(familyId, incidentId) {
      const inc = incidents.get(incidentId);
      return inc && inc.familyId === familyId ? { ...inc } : null;
    },
    async getAssignment(familyId, incidentId, assignmentId) {
      const a = assignments.get(assignmentId);
      return a && a.familyId === familyId && a.incidentId === incidentId ? { ...a } : null;
    },
    async listIncidentAssignments(familyId, incidentId) {
      return [...assignments.values()].filter((a) => a.familyId === familyId && a.incidentId === incidentId);
    },
    async prepareUrgentResponderDispatch(params) {
      const existing = [...outboxRows.values()].find((o) => o.dedupeKey === params.dedupeKey);
      if (existing) {
        return { status: 'existing', outboxId: existing.id, callId: existing.callId, actionRequestId: randomUUID() };
      }
      const outboxId = randomUUID();
      const callId = randomUUID();
      outboxRows.set(outboxId, {
        id: outboxId,
        incidentId: params.incidentId,
        assignmentId: params.assignmentId,
        responderId: params.responderPersonId,
        callId,
        attempt: 0,
        dedupeKey: params.dedupeKey,
      });
      return { status: 'ready', outboxId, callId, actionRequestId: randomUUID() };
    },
    async claimOutboxForDirectDispatch(outboxId) {
      const row = outboxRows.get(outboxId);
      if (!row) return null;
      row.attempt += 1;
      row.lease = randomUUID();
      return { leaseToken: row.lease, attempt: row.attempt };
    },
    async finishOutboxDispatch() {},
    async advanceUrgentOffer(params) {
      const inc = incidents.get(params.incidentId);
      const asg = assignments.get(params.assignmentId);
      if (!inc) return { status: 'incident_not_found' };
      if (!asg || asg.status !== 'offered') return { status: 'assignment_not_offered' };
      if (params.reason === 'expired' && Date.parse(asg.expiresAt) > now.getTime()) {
        return { status: 'not_yet_expired' };
      }
      asg.status = params.reason === 'declined' ? 'declined' : 'expired';
      const tried = new Set([...assignments.values()].filter((a) => a.incidentId === inc.id).map((a) => a.personId));
      const next = eligibleNextResponder(inc.subjectPersonId, tried);
      if (!next) {
        inc.state = 'escalated';
        return {
          status: 'escalated',
          incidentId: inc.id,
          previousAssignmentId: asg.id,
          previousResponderId: asg.personId,
        };
      }
      const nextId = randomUUID();
      const expiresAt = new Date(now.getTime() + params.offerTimeoutSeconds * 1000).toISOString();
      assignments.set(nextId, {
        id: nextId,
        familyId: inc.familyId,
        incidentId: inc.id,
        personId: next.personId,
        status: 'offered',
        offeredAt: now.toISOString(),
        expiresAt,
        acceptedAt: null,
        verifiedByProviderEvent: null,
      });
      return {
        status: 'offered',
        incidentId: inc.id,
        previousAssignmentId: asg.id,
        previousResponderId: asg.personId,
        assignmentId: nextId,
        responderPersonId: next.personId,
        expiresAt,
      };
    },
    async acceptAssignmentVerified(params) {
      const inc = incidents.get(params.incidentId);
      const asg = assignments.get(params.assignmentId);
      if (!inc || !asg || asg.status !== 'offered') return null;
      asg.status = 'accepted';
      asg.acceptedAt = now.toISOString();
      asg.verifiedByProviderEvent = params.rawEventId;
      inc.state = 'accepted';
      inc.ownerPersonId = params.responderPersonId;
      inc.promisedAt = new Date(now.getTime() + params.promiseMinutes * 60_000).toISOString();
      return { ...inc };
    },
    async loadAcceptanceProof(_familyId, rawEventId) {
      return acceptanceProofs.get(rawEventId) ?? null;
    },
    async completeIncident(familyId, incidentId) {
      const inc = incidents.get(incidentId);
      if (!inc || inc.familyId !== familyId) return null;
      inc.state = 'done';
      return { ...inc };
    },
    async recordChildAlert(params) {
      childAlerts.push(params);
    },
    async findCommandDedupe(familyId, dedupeKey) {
      return commandDedupe.get(`${familyId}:${dedupeKey}`) ?? null;
    },
    async saveCommandDedupe(params) {
      commandDedupe.set(`${params.familyId}:${params.dedupeKey}`, {
        entityId: params.entityId,
        payloadHash: params.payloadHash,
      });
    },
    async listExpiredOfferedAssignments(nowIso) {
      const t = Date.parse(nowIso);
      const out: Array<{
        familyId: string; incidentId: string; assignmentId: string; subjectPersonId: string; responderPersonId: string; severity: 'routine' | 'urgent' | 'critical';
      }> = [];
      for (const a of assignments.values()) {
        const inc = incidents.get(a.incidentId);
        if (a.status === 'offered' && Date.parse(a.expiresAt) <= t && inc && inc.state === 'offered') {
          out.push({
            familyId: a.familyId,
            incidentId: inc.id,
            assignmentId: a.id,
            subjectPersonId: inc.subjectPersonId,
            responderPersonId: a.personId,
            severity: inc.severity,
          });
        }
      }
      return out;
    },
    async listUnnotifiedAcceptedAssignments() {
      const out: Array<{
        familyId: string; incidentId: string; assignmentId: string; subjectPersonId: string; responderPersonId: string; promisedAt: string | null;
      }> = [];
      for (const a of assignments.values()) {
        const inc = incidents.get(a.incidentId);
        if (a.status === 'accepted' && inc && inc.state === 'accepted') {
          out.push({
            familyId: inc.familyId,
            incidentId: inc.id,
            assignmentId: a.id,
            subjectPersonId: inc.subjectPersonId,
            responderPersonId: a.personId,
            promisedAt: inc.promisedAt,
          });
        }
      }
      return out;
    },
    async listFailedResponderCalls() {
      return failedCalls.splice(0, failedCalls.length);
    },
    async hasTimelineDedupe(familyId, dedupeKey) {
      return timelineEvents.some((t) => t.familyId === familyId && t.dedupeKey === dedupeKey);
    },
  };

  const dispatchStoreFake: DispatchStore = {
    async claimOutbox() { return []; },
    async getBinding() { return null; },
    async bindOutbox() { return true; },
    async claim() { return 'claimed'; },
    async complete() {},
    async bindIdentity() { return true; },
    async fail() { return true; },
    async unknown() { return true; },
    async sweepStale() { return 0; },
    async reconcile() { return true; },
    async recordDeliveryProof() { return null; },
    async reconcileOutbox() { return true; },
    async acceptAssignment() { return true; },
    async finishOutbox() { return true; },
  };

  const resolveDestination: DispatchDeps['resolveDestination'] = Object.assign(
    async (_familyId: string, personId: string) => people.get(personId)?.phone ?? null,
    {
      async resolveIdentity(_familyId: string, personId: string) {
        const e164 = people.get(personId)?.phone;
        if (!e164) return null;
        return {
          e164,
          identityId: randomUUID(),
          accountId: 'AC00000000000000000000000000000001',
          identityHash: createHash('sha256').update(e164).digest('hex'),
        };
      },
    },
  );

  const renderer = buildUrgentResponderRenderer({
    baseUrl: 'https://api.sahaj.example',
    gatherActionUrl: 'https://api.sahaj.example/api/twilio/gather',
  });

  const dispatchDeps: DispatchDeps = {
    store: dispatchStoreFake,
    authorize: async (cmd, key) => ({
      decision: 'allow',
      consent: true,
      personId: cmd.personId,
      action: cmd.payload.action,
      idempotencyKey: key,
      expiresAt: Date.now() + 60_000,
    }),
    resolveDestination,
    identitySecret: '0'.repeat(64),
    transport: async (url, init) => {
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      twilioHttpCalls.push({ url, body: bodyStr });
      return new Response(
        JSON.stringify({ sid: `CA${randomUUID().replace(/-/g, '')}` }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    },
    providers: {
      twilio: {
        accountSid: 'AC00000000000000000000000000000001',
        authToken: 'auth-token-synth',
        fromNumber: PHONE_TWILIO_FROM,
        statusCallbackUrl: 'https://api.sahaj.example/api/twilio/status',
        allowedWebhookHosts: ['api.sahaj.example'],
      },
    },
  };

  const pushFetch = async (url: string, init: RequestInit) => {
    const messages = JSON.parse(String(init.body)) as Array<{ to: string; title: string; body: string; data: Record<string, string> }>;
    pushCalls.push({ url, messages });
    return new Response(JSON.stringify({ data: messages.map(() => ({ status: 'ok' })) }), { status: 200 });
  };

  const deps: UrgentHelpServiceDeps = {
    auth,
    store,
    timeline,
    dispatch: {
      deps: dispatchDeps,
      twimlUrl: renderer.url,
      gatherCallbackUrl: renderer.gatherActionUrl,
      dispatchFn: dispatchOutbound,
    },
    pushFetch,
    encryptionKeyHex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    now: () => new Date(now.getTime()),
    env: {
      DEMO_TIMER_SCALE: '1',
      ...envOverrides,
    },
  };

  return {
    deps,
    renderer,
    incidents,
    assignments,
    outboxRows,
    acceptanceProofs,
    childAlerts,
    timelineEvents,
    pushCalls,
    twilioHttpCalls,
    failedCalls,
    publicKey,
    advanceClockMs: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

// Re-export wrapper to sign using src/lib/timeline without importing private symbols
import { signTimelineEvent } from '../../src/lib/timeline';
function signLocalTimeline(
  input: Parameters<typeof signTimelineEvent>[0],
  privateKey: Parameters<typeof signTimelineEvent>[1],
): SignedTimelineEvent {
  return signTimelineEvent(input, privateKey);
}

function makeReq(token: string, body: Record<string, unknown>, idempotencyKey: string): Request {
  return new Request('https://api.sahaj.example/api/core1/urgent-help', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

describe('Core 1 Urgent Help End-to-End Wiring', () => {
  it('renders Twilio Gather TwiML with Hindi AI disclosure & verification passing', () => {
    const h = createHarness();
    const twiml = h.renderer.render();
    expect(verifyResponderRenderer(h.renderer, ['api.sahaj.example'])).toBeNull();
    expect(twiml).toContain(AI_DISCLOSURE.Hindi);
    expect(twiml).toContain('1 dabaiye — main ja raha hoon, 2 — nahi ja sakta');
    expect(twiml).toContain('https://api.sahaj.example/api/twilio/gather');
    expect(twiml).not.toContain(PHONE_SHARMA);
  });

  it('initiates urgent help -> calls rank-1 Sharma uncle via Twilio -> pushes Riya via Expo -> decline advances to Verma aunty -> scaled timeout escalates', async () => {
    const h = createHarness(new Date('2026-11-15T06:00:00.000Z'), { DEMO_TIMER_SCALE: '60' });

    const initRes = await executeUrgentHelpCommand(
      makeReq('token-maa', { subjectPersonId: MAA_ID, severity: 'urgent' }, 'urg-init-1'),
      h.deps,
    );
    expect(initRes.status).toBe(201);
    expect(initRes.body.responderPersonId).toBe(SHARMA_ID);
    expect(initRes.body.callStatus).toBe('dispatched');
    expect(initRes.body.pushSent).toBe(true);

    // 3m / 60 = 3s scaled timeout!
    const offeredExpiry = Date.parse(String(initRes.body.expiresAt));
    expect(offeredExpiry - Date.parse('2026-11-15T06:00:00.000Z')).toBe(3000);

    // Verify Twilio outbound call used resolved phone number + TwiML URL, NEVER WhatsApp
    expect(h.twilioHttpCalls).toHaveLength(1);
    expect(decodeURIComponent(h.twilioHttpCalls[0].body)).toContain(`To=${PHONE_SHARMA}`);
    expect(decodeURIComponent(h.twilioHttpCalls[0].body)).toContain(
      'Url=https://api.sahaj.example/api/core1/urgent-help/twilio/twiml',
    );
    expect(h.pushCalls).toHaveLength(1);
    expect(h.pushCalls[0].messages[0].to).toBe('ExponentPushToken[riya-synth-device-1]');
    expect(h.pushCalls[0].messages[0].body).toContain('Sharma uncle');
    expect(h.pushCalls[0].messages[0].body).not.toContain('9000');

    // Decline by Sharma uncle -> advances to Verma aunty and places second Twilio call
    const incId = String(initRes.body.incidentId);
    const asg1Id = String(initRes.body.assignmentId);
    const decRes = await executeUrgentHelpCommand(
      makeReq(
        'token-riya',
        { action: 'decline', incidentId: incId, assignmentId: asg1Id, subjectPersonId: MAA_ID },
        'urg-dec-1',
      ),
      h.deps,
    );
    expect(decRes.status).toBe(200);
    expect(decRes.body.state).toBe('offered');
    expect(decRes.body.nextResponderPersonId).toBe(VERMA_ID);
    expect(h.twilioHttpCalls).toHaveLength(2);
    expect(decodeURIComponent(h.twilioHttpCalls[1].body)).toContain(`To=${PHONE_VERMA}`);

    // Advance clock past scaled 3s expiry -> cron tick escalates when circle is exhausted
    h.advanceClockMs(4000);
    const tick = await processUrgentEscalationTick(h.deps);
    expect(tick.timeoutsAdvanced).toBe(1);
    expect(h.incidents.get(incId)?.state).toBe('escalated');
    expect(h.pushCalls[h.pushCalls.length - 1].messages[0].data.stage).toBe('escalated');

    // All timeline events must be Ed25519 verified and free of phone numbers
    for (const ev of h.timelineEvents) {
      expect(verifyTimelineEvent(ev.signed, h.publicKey)).toBe(true);
      expect(ev.humanLine).not.toContain('9000');
    }
  });

  it('verifies acceptance proof -> updates incident -> emits signed timeline & calm status -> pushes Riya', async () => {
    const h = createHarness();
    const initRes = await executeUrgentHelpCommand(
      makeReq('token-maa', { subjectPersonId: MAA_ID, severity: 'critical' }, 'urg-acc-init'),
      h.deps,
    );
    const incId = String(initRes.body.incidentId);
    const asgId = String(initRes.body.assignmentId);
    const outboxRow = [...h.outboxRows.values()][0];
    const proofEventId = randomUUID();

    h.acceptanceProofs.set(proofEventId, {
      eventId: proofEventId,
      familyId: FAM_A,
      incidentId: incId,
      assignmentId: asgId,
      responderPersonId: SHARMA_ID,
      subjectPersonId: MAA_ID,
      callId: outboxRow.callId,
      outboxId: outboxRow.id,
      actionRequestId: randomUUID(),
      action: 'urgent_responder',
      providerAction: 'twilio.create_call',
      accountId: 'AC00000000000000000000000000000001',
      normalizedProof: true,
      verifiedBy: 'twilio_signature',
      source: 'twilio',
    });

    const accRes = await executeUrgentHelpCommand(
      makeReq(
        'token-riya',
        { action: 'accept', incidentId: incId, assignmentId: asgId, subjectPersonId: MAA_ID, rawEventId: proofEventId, promiseMinutes: 4 },
        'urg-acc-confirm',
      ),
      h.deps,
    );
    expect(accRes.status).toBe(200);
    expect(accRes.body.state).toBe('accepted');
    expect(accRes.body.statusLine).toBe('Sharma uncle aa rahe hain · 4 minute');
    expect(h.incidents.get(incId)?.ownerPersonId).toBe(SHARMA_ID);

    // Riya receives Expo push with calm eta wording
    const lastPush = h.pushCalls[h.pushCalls.length - 1];
    expect(lastPush.messages[0].body).toContain('Sharma uncle aa rahe hain · 4 minute');
    expect(formatUrgentAcceptedCalmLine('Sharma uncle', 4)).toBe('Sharma uncle aa rahe hain · 4 minute');

    // dispatchUrgentCallAndPushForIncident is idempotent when called directly from Maa SOS route
    const secondIncRes = await h.deps.store.createUrgentIncidentOfferScaled({
      familyId: FAM_A,
      subjectPersonId: MAA_ID,
      severity: 'urgent',
      offerTimeoutSeconds: 180,
    });
    const dispatched = await dispatchUrgentCallAndPushForIncident(h.deps, {
      familyId: FAM_A,
      incidentId: secondIncRes.incidentId,
      assignmentId: secondIncRes.assignmentId!,
      subjectPersonId: MAA_ID,
      responderPersonId: secondIncRes.responderPersonId!,
      severity: 'urgent',
      state: secondIncRes.state,
    });
    expect(dispatched.callOutcome?.status).toBe('dispatched');
    expect(dispatched.pushResult.sent).toBe(true);
  });

  it('rejects cross-family subject access', async () => {
    const h = createHarness();
    await expect(
      executeUrgentHelpCommand(
        makeReq('token-foreign', { subjectPersonId: MAA_ID, severity: 'urgent' }, 'urg-cross-fam'),
        h.deps,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

