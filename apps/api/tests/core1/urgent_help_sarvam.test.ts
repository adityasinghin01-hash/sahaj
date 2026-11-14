import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DispatchDeps, DispatchStore } from '../../src/lib/provider-dispatch';
import {
  applySarvamResponderDecision,
  dispatchUrgentCallAndPushForIncident,
  type UrgentAssignmentRow,
  type UrgentHelpServiceDeps,
  type UrgentHelpStore,
  type UrgentIncidentRow,
} from '../../src/lib/core1/urgent-help-service';
import type { ResponderAcceptanceProof } from '../../../../packages/atlas/src/core1/types';

const FAM = '11111111-1111-4111-8111-111111111111';
const MAA = '22222222-2222-4222-8222-222222222221';
const RIYA = '22222222-2222-4222-8222-222222222222';
const ROHIT = '22222222-2222-4222-8222-222222222223';
const SHARMA = '22222222-2222-4222-8222-222222222224';
const NOW = new Date('2026-11-15T06:00:00.000Z');

/**
 * In-memory stand-in for the K-SARVAMCALL SQL: prepare binds a calls row to {incident, assignment, responder};
 * the Sarvam HTTP response gives the attempt id; record_sarvam_responder_decision only accepts that call id for that exact
 * assignment + responder while it is still offered, once per call.
 */
function harness(opts: { runtime?: boolean } = {}) {
  let now = new Date(NOW);
  const names: Record<string, string> = { [MAA]: 'Meena Maa', [RIYA]: 'Riya', [ROHIT]: 'Rohit', [SHARMA]: 'Sharma uncle' };
  const incidents = new Map<string, UrgentIncidentRow>();
  const assignments = new Map<string, UrgentAssignmentRow>();
  const calls = new Map<string, { incidentId: string; assignmentId: string; responder: string; externalId: string | null }>();
  const decisions = new Map<string, { decision: string; eventId: string; proofId?: string }>();
  const proofs = new Map<string, ResponderAcceptanceProof>();
  const prepared: Array<{ provider?: string; responder: string }> = [];
  const sarvamBodies: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const pushes: Array<{ title: string }> = [];
  const timeline: string[] = [];
  const circle = [ROHIT, SHARMA];

  const offer = (incidentId: string, personId: string) => {
    const id = randomUUID();
    assignments.set(id, { id, familyId: FAM, incidentId, personId, status: 'offered', offeredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 180_000).toISOString(), acceptedAt: null, verifiedByProviderEvent: null });
    return id;
  };
  const store = {
    verifyFamilyPerson: async () => true,
    getPersonDisplayName: async (_f: string, p: string) => names[p] ?? 'Family member',
    getCircleMember: async () => null,
    listCircleMembers: async () => circle.map((personId, i) => ({ id: personId, familyId: FAM, personId, rank: i + 1, active: true, consentAt: '2026-11-01T00:00:00Z', revokedAt: null })),
    listChildPushTokens: async () => ['ExponentPushToken[riya-synth]'],
    getIncident: async (_f: string, id: string) => (incidents.has(id) ? { ...incidents.get(id)! } : null),
    getAssignment: async (_f: string, _i: string, id: string) => (assignments.has(id) ? { ...assignments.get(id)! } : null),
    prepareUrgentResponderDispatch: async (p: { incidentId: string; assignmentId: string; responderPersonId: string; provider?: string }) => {
      prepared.push({ provider: p.provider, responder: p.responderPersonId });
      const callId = randomUUID();
      calls.set(callId, { incidentId: p.incidentId, assignmentId: p.assignmentId, responder: p.responderPersonId, externalId: null });
      return { status: 'ready' as const, outboxId: randomUUID(), callId, actionRequestId: randomUUID() };
    },
    claimOutboxForDirectDispatch: async () => ({ leaseToken: randomUUID(), attempt: 1 }),
    finishOutboxDispatch: async () => {},
    advanceUrgentOffer: async (p: { incidentId: string; assignmentId: string; reason: 'declined' | 'expired' }) => {
      const a = assignments.get(p.assignmentId)!;
      if (a.status !== 'offered') return { status: 'assignment_not_offered' as const };
      a.status = p.reason === 'declined' ? 'declined' : 'expired';
      const tried = new Set([...assignments.values()].filter((x) => x.incidentId === p.incidentId).map((x) => x.personId));
      const next = circle.find((c) => !tried.has(c));
      if (!next) { incidents.get(p.incidentId)!.state = 'escalated'; return { status: 'escalated' as const, previousResponderId: a.personId }; }
      const id = offer(p.incidentId, next);
      return { status: 'offered' as const, incidentId: p.incidentId, previousAssignmentId: a.id, previousResponderId: a.personId, assignmentId: id, responderPersonId: next };
    },
    async recordSarvamResponderDecision(p: { callId: string; incidentId: string; assignmentId: string; responderPersonId: string; decision: 'accept' | 'decline' }) {
      const c = calls.get(p.callId);
      if (!c || !c.externalId) throw new Error('call_not_ours');
      if (c.assignmentId !== p.assignmentId || c.incidentId !== p.incidentId || c.responder !== p.responderPersonId) throw new Error('call_assignment_mismatch');
      const prior = decisions.get(p.callId);
      if (prior) {
        if (prior.decision !== p.decision) throw new Error('decision_already_recorded');
        return { eventId: prior.eventId, proofEventId: prior.proofId, assignmentId: p.assignmentId, replayed: true };
      }
      const a = assignments.get(p.assignmentId)!;
      if (a.status !== 'offered' || Date.parse(a.expiresAt) <= now.getTime()) throw new Error('assignment_not_offered');
      const eventId = randomUUID();
      let proofId: string | undefined;
      if (p.decision === 'accept') {
        proofId = randomUUID();
        proofs.set(proofId, { eventId: proofId, familyId: FAM, incidentId: p.incidentId, assignmentId: p.assignmentId, responderPersonId: p.responderPersonId,
          subjectPersonId: MAA, callId: p.callId, action: 'urgent_responder', providerAction: 'sarvam.outbound_call', accountId: 'agent-checkin',
          normalizedProof: true, verifiedBy: 'sarvam_call_binding', source: 'sarvam' });
      }
      decisions.set(p.callId, { decision: p.decision, eventId, proofId });
      return { eventId, proofEventId: proofId, assignmentId: p.assignmentId, replayed: false };
    },
    loadAcceptanceProof: async (_f: string, id: string) => proofs.get(id) ?? null,
    acceptAssignmentVerified: async (p: { incidentId: string; assignmentId: string; responderPersonId: string; promiseMinutes: number }) => {
      const a = assignments.get(p.assignmentId)!, i = incidents.get(p.incidentId)!;
      if (a.status !== 'offered') return null;
      a.status = 'accepted'; a.verifiedByProviderEvent = [...proofs.values()].find((x) => x.assignmentId === a.id)!.eventId;
      i.state = 'accepted'; i.ownerPersonId = p.responderPersonId; i.promisedAt = new Date(now.getTime() + p.promiseMinutes * 60_000).toISOString();
      return { ...i };
    },
    recordChildAlert: async () => {},
  } as unknown as UrgentHelpStore;

  const dispatchStoreFake: DispatchStore = {
    claimOutbox: async () => [], getBinding: async () => null, bindOutbox: async () => true, claim: async () => 'claimed',
    complete: async () => {}, bindIdentity: async () => true, fail: async () => true, unknown: async () => true,
    sweepStale: async () => 0, reconcile: async () => true, recordDeliveryProof: async () => null,
    reconcileOutbox: async () => true, acceptAssignment: async () => true, finishOutbox: async () => true,
  };
  const deps: DispatchDeps = {
    store: dispatchStoreFake,
    authorize: async (cmd, key) => ({ decision: 'allow', consent: true, personId: cmd.personId, action: cmd.payload.action, idempotencyKey: key, expiresAt: Date.now() + 60_000 }),
    resolveDestination: Object.assign(async () => '+919000000003', {
      resolveIdentity: async () => ({ e164: '+919000000003', identityId: randomUUID(), accountId: 'agent-checkin', identityHash: 'a'.repeat(64) }),
    }),
    identitySecret: 's'.repeat(40),
    transport: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      sarvamBodies.push(body);
      const attempt = `att-${sarvamBodies.length}`;
      // What complete_dispatch does: bind the provider ref to OUR call.
      const callId = body.app_config.agent_variables.call_id as string;
      calls.get(callId)!.externalId = attempt;
      return new Response(JSON.stringify({ attempt_id: attempt }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    providers: { sarvam: { apiKey: 'k', orgId: 'o', workspaceId: 'w', appId: 'agent-checkin', appVersion: 1, connectionId: 'conn',
      agentPhoneNumber: '+918000000000', webhookUrl: 'https://api.sahaj.example/api/sarvam/post-call/s' } },
  };
  const service: UrgentHelpServiceDeps = {
    auth: { authenticate: async () => { throw new Error('unused'); } },
    store,
    timeline: { append: async (e) => { timeline.push(e.eventType); return { deduped: false, sequence: timeline.length, chainHash: 'h' }; } },
    dispatch: opts.runtime === false ? null : { provider: 'sarvam', deps, sarvamAgentId: 'agent-responder', bridgeLabel: 'riya-transfer', twimlUrl: '', gatherCallbackUrl: '' },
    callProvider: 'sarvam',
    encryptionKeyHex: '19'.repeat(32),
    pushFetch: async (_url, init) => { for (const m of JSON.parse(String(init.body))) pushes.push(m); return new Response('{}', { status: 200 }); },
    now: () => now,
    env: { DEMO_TIMER_SCALE: '1' },
  };
  const startIncident = async (responder = ROHIT) => {
    const incidentId = randomUUID();
    incidents.set(incidentId, { id: incidentId, familyId: FAM, subjectPersonId: MAA, state: 'offered', severity: 'critical', ownerPersonId: null, promisedAt: null, createdAt: now.toISOString() });
    const assignmentId = offer(incidentId, responder);
    const res = await dispatchUrgentCallAndPushForIncident(service, { familyId: FAM, incidentId, subjectPersonId: MAA, severity: 'critical', assignmentId, responderPersonId: responder, state: 'offered' });
    const callId = [...calls.entries()].find(([, c]) => c.assignmentId === assignmentId)![0];
    return { incidentId, assignmentId, callId, res };
  };
  return { service, startIncident, prepared, sarvamBodies, pushes, timeline, calls, assignments, incidents, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe('urgent help over Sarvam (K-SARVAMCALL)', () => {
  it('places the RESPONDER agent call for Rohit with the documented agent variables', async () => {
    const h = harness();
    const { incidentId, assignmentId, callId, res } = await h.startIncident();
    expect(res.callOutcome?.status).toBe('dispatched');
    expect(h.prepared).toEqual([{ provider: 'sarvam', responder: ROHIT }]);
    const app = h.sarvamBodies[0].app_config;
    expect(app.app_id).toBe('agent-responder');
    expect(app.agent_variables).toMatchObject({
      purpose: 'urgent_help', introduction: 'Main Sahaj ki AI sahayak hoon.', responder_name: 'Rohit', subject_name: 'Meena ji',
      incident_id: incidentId, assignment_id: assignmentId, responder_person_id: ROHIT, family_id: FAM, parent_id: MAA,
      call_id: callId, bridge_to: 'riya-transfer', is_danger: 'yes',
    });
    for (const k of ['responder_name', 'subject_name', 'incident_summary', 'introduction']) expect(app.agent_variables[k]).not.toMatch(/\d{4,}|\+91/);
    expect(app.agent_variables.incident_summary).toBe('Meena ji ne Sahaj se turant madad maangi hai.');
    expect(h.timeline).toContain('urgent.responder_called');
  });

  it('binds the offer to Sarvam even when the runtime is not configured (providers off)', async () => {
    const h = harness({ runtime: false });
    const { res } = await h.startIncident();
    expect(res.callSkippedReason).toBe('sarvam_not_configured');
    expect(h.prepared).toEqual([{ provider: 'sarvam', responder: ROHIT }]);
    expect(h.sarvamBodies).toHaveLength(0);
  });

  it('accept_incident with OUR call id accepts, writes the timeline and pushes Riya; a replay sends nothing twice', async () => {
    const h = harness();
    const { incidentId, assignmentId, callId } = await h.startIncident();
    const pushesBefore = h.pushes.length;
    const input = { familyId: FAM, parentId: MAA, callId, incidentId, assignmentId, responderPersonId: ROHIT, decision: 'accept' as const, promiseMinutes: 7 };
    expect(await applySarvamResponderDecision(h.service, input)).toEqual({ status: 'accepted', replayed: false });
    expect(h.incidents.get(incidentId)).toMatchObject({ state: 'accepted', ownerPersonId: ROHIT });
    expect(h.timeline).toContain('urgent.accepted');
    expect(h.pushes.slice(pushesBefore).map((p) => p.title)).toEqual(['Rohit accepted urgent help']);
    expect(await applySarvamResponderDecision(h.service, input)).toEqual({ status: 'accepted', replayed: true });
    expect(h.pushes.length).toBe(pushesBefore + 1);
  });

  it('refuses a foreign call id, a call for another assignment, and an expired assignment', async () => {
    const h = harness();
    const a = await h.startIncident();
    const b = await h.startIncident(SHARMA);
    const base = { familyId: FAM, parentId: MAA, incidentId: a.incidentId, assignmentId: a.assignmentId, responderPersonId: ROHIT, decision: 'accept' as const };
    await expect(applySarvamResponderDecision(h.service, { ...base, callId: randomUUID() })).rejects.toThrow('call_not_ours');
    await expect(applySarvamResponderDecision(h.service, { ...base, callId: b.callId })).rejects.toThrow('call_assignment_mismatch');
    await expect(applySarvamResponderDecision(h.service, { ...base, callId: a.callId, parentId: RIYA })).rejects.toThrow('incident_not_found');
    h.advance(181_000);
    await expect(applySarvamResponderDecision(h.service, { ...base, callId: a.callId })).rejects.toThrow('assignment_not_offered');
    expect(h.incidents.get(a.incidentId)?.state).toBe('offered');
  });

  it('decline_incident offers the next circle member with a new Sarvam call; a different second decision is refused', async () => {
    const h = harness();
    const { incidentId, assignmentId, callId } = await h.startIncident();
    const input = { familyId: FAM, parentId: MAA, callId, incidentId, assignmentId, responderPersonId: ROHIT, decision: 'decline' as const };
    const r = await applySarvamResponderDecision(h.service, input);
    expect(r).toMatchObject({ status: 'offered', nextResponderPersonId: SHARMA, replayed: false });
    expect(h.sarvamBodies).toHaveLength(2);
    expect(h.sarvamBodies[1].app_config.agent_variables.responder_person_id).toBe(SHARMA);
    expect(await applySarvamResponderDecision(h.service, input)).toEqual({ status: 'declined', replayed: true });
    await expect(applySarvamResponderDecision(h.service, { ...input, decision: 'accept' })).rejects.toThrow('decision_already_recorded');
  });
});
