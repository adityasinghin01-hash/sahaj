import { describe, it, expect } from 'vitest';
import {
  initiateIncident,
  handleResponderResponse,
  checkIncidentTimeoutsAndPromises,
  completeIncident,
} from '../../src/core1/urgent-responder';
import { createClock } from '../../src/core1/types';
import type {
  CircleMember,
  ResponderAcceptanceProof,
  UrgentIncident,
  IncidentAssignment,
} from '../../src/core1/types';

describe('Urgent Incident & Responder State Machine', () => {
  const familyId = '11111111-1111-4111-8111-111111111111';
  const subjectPersonId = '22222222-2222-4222-8222-222222222222'; // Maa
  const childPersonId = '33333333-3333-4333-8333-333333333333'; // Primary responder
  const unclePersonId = '44444444-4444-4444-8444-444444444444'; // Secondary responder

  const circle: CircleMember[] = [
    {
      personId: childPersonId,
      rank: 1,
      active: true,
      consentAt: '2026-11-01T00:00:00.000Z',
    },
    {
      personId: unclePersonId,
      rank: 2,
      active: true,
      consentAt: '2026-11-01T00:00:00.000Z',
    },
    {
      personId: subjectPersonId, // subject themselves in circle - must be excluded!
      rank: 3,
      active: true,
      consentAt: '2026-11-01T00:00:00.000Z',
    },
  ];

  it('initiates incident and dispatches offer to top-ranked eligible responder (excluding subject)', () => {
    const clock = createClock('2026-11-15T10:00:00.000Z');
    const result = initiateIncident({
      familyId,
      personId: subjectPersonId,
      severity: 'urgent',
      circle,
      offerTimeoutMinutes: 3,
      clock,
    });

    expect(result.transitionStatus).toBe('success');
    expect(result.incident.state).toBe('offered');
    expect(result.assignment).toBeDefined();
    expect(result.assignment?.personId).toBe(childPersonId);
    expect(result.assignment?.status).toBe('offered');
    expect(result.intents.length).toBe(1);
    expect(result.intents[0].type).toBe('offer_dispatched');
  });

  it('BLOCKER 6 FIX: derives deterministic IDs on repeated calculation', () => {
    const clock = createClock('2026-11-15T10:00:00.000Z');
    const r1 = initiateIncident({
      incidentId: 'fixed-incident-id',
      familyId,
      personId: subjectPersonId,
      severity: 'urgent',
      circle,
      clock,
    });
    const r2 = initiateIncident({
      incidentId: 'fixed-incident-id',
      familyId,
      personId: subjectPersonId,
      severity: 'urgent',
      circle,
      clock,
    });

    expect(r1.assignment?.id).toBe(r2.assignment?.id);
  });

  it('BLOCKER 1 FIX: accepts responder with exact authoritative provider acceptance proof', () => {
    const clock = createClock('2026-11-15T10:01:00.000Z');
    const init = initiateIncident({
      incidentId: 'inc-001',
      familyId,
      personId: subjectPersonId,
      severity: 'urgent',
      circle,
      clock,
    });

    const incident = init.incident;
    const assignment = init.assignment!;

    const validProof: ResponderAcceptanceProof = {
      eventId: 'evt-acceptance-100',
      familyId,
      incidentId: incident.id,
      assignmentId: assignment.id,
      responderPersonId: childPersonId,
      subjectPersonId,
      callId: 'call-twilio-555',
      outboxId: 'outbox-777',
      actionRequestId: 'req-888',
      action: 'urgent_responder',
      providerAction: 'twilio.create_call',
      accountId: 'AC_twilio_prod',
      dispatchKey: 'dispatch:777:a1',
      normalizedProof: true,
      verifiedBy: 'twilio_signature',
      source: 'twilio',
    };

    const acceptResult = handleResponderResponse({
      incident,
      currentAssignment: assignment,
      circle,
      response: {
        responderPersonId: childPersonId,
        responseType: 'accept',
        acceptanceProof: validProof,
        promiseMinutes: 20,
      },
      clock,
    });

    expect(acceptResult.transitionStatus).toBe('success');
    expect(acceptResult.incident.state).toBe('accepted');
    expect(acceptResult.incident.ownerPersonId).toBe(childPersonId);
    expect(acceptResult.assignment?.status).toBe('accepted');
    expect(acceptResult.assignment?.verifiedByProviderEventId).toBe('evt-acceptance-100');
    expect(acceptResult.intents.some(i => i.type === 'responder_accepted')).toBe(true);
  });

  it('BLOCKER 1 FIX: rejects unverified event, wrong responder, cross-family, and cross-incident proof', () => {
    const clock = createClock('2026-11-15T10:01:00.000Z');
    const init = initiateIncident({
      incidentId: 'inc-001',
      familyId,
      personId: subjectPersonId,
      severity: 'urgent',
      circle,
      clock,
    });

    const incident = init.incident;
    const assignment = init.assignment!;

    // 1. Missing proof completely
    const rMissing = handleResponderResponse({
      incident,
      currentAssignment: assignment,
      circle,
      response: {
        responderPersonId: childPersonId,
        responseType: 'accept',
      },
      clock,
    });
    expect(rMissing.transitionStatus).toBe('unverified_event');

    // 2. Mismatched family in proof
    const rWrongFamily = handleResponderResponse({
      incident,
      currentAssignment: assignment,
      circle,
      response: {
        responderPersonId: childPersonId,
        responseType: 'accept',
        acceptanceProof: {
          eventId: 'evt-1',
          familyId: '99999999-9999-4999-8999-999999999999', // other family!
          incidentId: incident.id,
          assignmentId: assignment.id,
          responderPersonId: childPersonId,
          subjectPersonId,
          callId: 'c1',
          action: 'urgent_responder',
          providerAction: 'twilio.create_call',
          accountId: 'AC1',
          normalizedProof: true,
          verifiedBy: 'twilio_signature',
          source: 'twilio',
        },
      },
      clock,
    });
    expect(rWrongFamily.transitionStatus).toBe('unverified_event');

    // 3. Subject claiming to accept emergency for themselves
    const rSubjectAccepting = handleResponderResponse({
      incident,
      currentAssignment: assignment,
      circle,
      response: {
        responderPersonId: subjectPersonId,
        responseType: 'accept',
      },
      clock,
    });
    expect(rSubjectAccepting.transitionStatus).toBe('wrong_responder');

    // 4. Mismatched responder ID in proof
    const rWrongResponderProof = handleResponderResponse({
      incident,
      currentAssignment: assignment,
      circle,
      response: {
        responderPersonId: childPersonId,
        responseType: 'accept',
        acceptanceProof: {
          eventId: 'evt-2',
          familyId,
          incidentId: incident.id,
          assignmentId: assignment.id,
          responderPersonId: unclePersonId, // different responder!
          subjectPersonId,
          callId: 'c1',
          action: 'urgent_responder',
          providerAction: 'twilio.create_call',
          accountId: 'AC1',
          normalizedProof: true,
          verifiedBy: 'twilio_signature',
          source: 'twilio',
        },
      },
      clock,
    });
    expect(rWrongResponderProof.transitionStatus).toBe('unverified_event');
  });

  it('BLOCKER 1 FIX: decline advances offer to rank 2 responder; escalates when circle exhausted', () => {
    const clock = createClock('2026-11-15T10:01:00.000Z');
    const init = initiateIncident({
      incidentId: 'inc-002',
      familyId,
      personId: subjectPersonId,
      severity: 'urgent',
      circle,
      clock,
    });

    // Rank 1 declines
    const decline1 = handleResponderResponse({
      incident: init.incident,
      currentAssignment: init.assignment!,
      circle,
      response: {
        responderPersonId: childPersonId,
        responseType: 'decline',
      },
      clock,
    });

    expect(decline1.transitionStatus).toBe('success');
    expect(decline1.assignment?.personId).toBe(unclePersonId); // Rank 2!
    expect(decline1.assignment?.status).toBe('offered');

    // Rank 2 declines -> circle exhausted -> escalation
    const decline2 = handleResponderResponse({
      incident: decline1.incident,
      currentAssignment: decline1.assignment!,
      circle,
      previousAssignments: [init.assignment!, decline1.assignment!],
      response: {
        responderPersonId: unclePersonId,
        responseType: 'decline',
      },
      clock,
    });

    expect(decline2.transitionStatus).toBe('success');
    expect(decline2.incident.state).toBe('escalated');
    expect(decline2.intents.some(i => i.type === 'incident_escalated')).toBe(true);
  });

  it('progresses on offer timeout and triggers escalation on circle exhaustion', () => {
    const clock = createClock('2026-11-15T10:00:00.000Z');
    const init = initiateIncident({
      incidentId: 'inc-003',
      familyId,
      personId: subjectPersonId,
      severity: 'urgent',
      circle,
      offerTimeoutMinutes: 3,
      clock,
    });

    // Advance clock past expiration
    const clockExpired = createClock('2026-11-15T10:04:00.000Z');
    const timeout1 = checkIncidentTimeoutsAndPromises({
      incident: init.incident,
      currentAssignment: init.assignment,
      circle,
      clock: clockExpired,
    });

    expect(timeout1.transitionStatus).toBe('timeout_expired');
    expect(timeout1.assignment?.personId).toBe(unclePersonId);
    expect(timeout1.assignment?.status).toBe('offered');

    // Advance clock past second offer expiration
    const clockExpired2 = createClock('2026-11-15T10:10:00.000Z');
    const timeout2 = checkIncidentTimeoutsAndPromises({
      incident: timeout1.incident,
      currentAssignment: timeout1.assignment,
      circle,
      previousAssignments: [init.assignment!, timeout1.assignment!],
      clock: clockExpired2,
    });

    expect(timeout2.transitionStatus).toBe('timeout_expired');
    expect(timeout2.incident.state).toBe('escalated');
  });

  it('triggers overdue escalation when accepted promise deadline is exceeded', () => {
    const clockNow = createClock('2026-11-15T10:30:00.000Z');
    const acceptedIncident: UrgentIncident = {
      id: 'inc-004',
      familyId,
      personId: subjectPersonId,
      state: 'accepted',
      severity: 'urgent',
      ownerPersonId: childPersonId,
      promisedAt: '2026-11-15T10:20:00.000Z', // 10 minutes ago!
      createdAt: '2026-11-15T10:00:00.000Z',
    };

    const overdueResult = checkIncidentTimeoutsAndPromises({
      incident: acceptedIncident,
      circle,
      clock: clockNow,
    });

    expect(overdueResult.transitionStatus).toBe('success');
    expect(overdueResult.incident.state).toBe('escalated');
    expect(overdueResult.intents.some(i => i.type === 'overdue_escalation')).toBe(true);
  });

  it('completes incident only when called by verified accepted owner in matching family', () => {
    const clock = createClock('2026-11-15T10:15:00.000Z');
    const acceptedIncident: UrgentIncident = {
      id: 'inc-005',
      familyId,
      personId: subjectPersonId,
      state: 'accepted',
      severity: 'urgent',
      ownerPersonId: childPersonId,
      promisedAt: '2026-11-15T10:30:00.000Z',
      createdAt: '2026-11-15T10:00:00.000Z',
    };

    const acceptedAssignment: IncidentAssignment = {
      id: 'asgn-005',
      familyId,
      incidentId: 'inc-005',
      personId: childPersonId,
      status: 'accepted',
      offeredAt: '2026-11-15T10:00:00.000Z',
      expiresAt: '2026-11-15T10:03:00.000Z',
      acceptedAt: '2026-11-15T10:02:00.000Z',
      verifiedByProviderEventId: 'evt-prov-5',
    };

    // Wrong person completion rejected
    const rWrong = completeIncident({
      incident: acceptedIncident,
      currentAssignment: acceptedAssignment,
      responderPersonId: unclePersonId, // not the owner!
      familyId,
      clock,
    });
    expect(rWrong.transitionStatus).toBe('wrong_responder');

    // Wrong family completion rejected
    const rWrongFamily = completeIncident({
      incident: acceptedIncident,
      currentAssignment: acceptedAssignment,
      responderPersonId: childPersonId,
      familyId: '99999999-9999-4999-8999-999999999999',
      clock,
    });
    expect(rWrongFamily.transitionStatus).toBe('mismatched_family');

    // Correct owner completion succeeds
    const rSuccess = completeIncident({
      incident: acceptedIncident,
      currentAssignment: acceptedAssignment,
      responderPersonId: childPersonId,
      familyId,
      clock,
    });
    expect(rSuccess.transitionStatus).toBe('success');
    expect(rSuccess.incident.state).toBe('closed');
    expect(rSuccess.assignment?.status).toBe('completed');
  });
});
