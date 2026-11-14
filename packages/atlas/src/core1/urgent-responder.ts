/**
 * Urgent responder offer, decline, timeout, and escalation state machine.
 *
 * Implements:
 * - Ranked circle member dispatching
 * - Offer timeouts with automatic progression to next rank
 * - Explicit declines with automatic progression
 * - Authoritative acceptance proof binding: binds exact offered responder + incident + assignment + call + account
 * - Strict rejection of wrong responders, cross-family events, and unverified callbacks
 * - Absolute prohibition on fabricating acceptance from call connected/completed events
 * - Promise timelines and overdue re-escalation
 * - Deterministic identifier derivation for replay stability
 */

import { deriveDeterministicId } from './types';
import type {
  UrgentIncident,
  IncidentAssignment,
  CircleMember,
  IncidentTransitionResult,
  IncidentSeverity,
  ResponderAcceptanceProof,
  Clock,
} from './types';

export function getEligibleResponders(
  circle: CircleMember[],
  excludedPersonIds: Set<string>
): CircleMember[] {
  return circle
    .filter(m => m.active && m.consentAt && !m.revokedAt && !excludedPersonIds.has(m.personId))
    .sort((a, b) => a.rank - b.rank);
}

export interface InitiateIncidentParams {
  incidentId?: string;
  familyId: string;
  personId: string;
  severity: IncidentSeverity;
  circle: CircleMember[];
  offerTimeoutMinutes?: number;
  clock: Clock;
}

/**
 * Initiates an urgent incident and dispatches the first offer to the top-ranked eligible responder.
 */
export function initiateIncident(params: InitiateIncidentParams): IncidentTransitionResult {
  const { familyId, personId, severity, circle, clock } = params;
  const incidentId = params.incidentId ?? deriveDeterministicId(`incident:${familyId}:${personId}`, clock.nowIso());
  const offerTimeoutMinutes = params.offerTimeoutMinutes ?? 3;
  const now = clock.now();
  const nowIso = clock.nowIso();

  const incident: UrgentIncident = {
    id: incidentId,
    familyId,
    personId,
    state: 'open',
    severity,
    createdAt: nowIso,
  };

  // Exclude the subject themselves - a person cannot be their own emergency responder
  const eligible = getEligibleResponders(circle, new Set([personId]));

  if (!eligible.length) {
    const escalatedIncident: UrgentIncident = {
      ...incident,
      state: 'escalated',
    };
    return {
      incident: escalatedIncident,
      intents: [
        {
          type: 'incident_escalated',
          reason: 'no_available_circle_members',
        },
      ],
      transitionStatus: 'success',
    };
  }

  const primary = eligible[0];
  const expiresAt = new Date(now.getTime() + offerTimeoutMinutes * 60 * 1000).toISOString();
  const assignmentId = deriveDeterministicId(`asgn:${incidentId}`, 1);

  const assignment: IncidentAssignment = {
    id: assignmentId,
    familyId,
    incidentId,
    personId: primary.personId,
    status: 'offered',
    offeredAt: nowIso,
    expiresAt,
  };

  const offeredIncident: UrgentIncident = {
    ...incident,
    state: 'offered',
  };

  return {
    incident: offeredIncident,
    assignment,
    intents: [
      {
        type: 'offer_dispatched',
        intent: {
          incidentId,
          familyId,
          assignmentId,
          responderPersonId: primary.personId,
          rank: primary.rank,
          offeredAt: nowIso,
          expiresAt,
          severity,
        },
      },
    ],
    transitionStatus: 'success',
  };
}

export interface HandleResponderResponseParams {
  incident: UrgentIncident;
  currentAssignment: IncidentAssignment;
  circle: CircleMember[];
  previousAssignments?: IncidentAssignment[];
  response: {
    responderPersonId: string;
    responseType: 'accept' | 'decline';
    /** Authoritative provider acceptance proof required for 'accept' */
    acceptanceProof?: ResponderAcceptanceProof;
    promiseMinutes?: number;
  };
  offerTimeoutMinutes?: number;
  clock: Clock;
}

/**
 * Handles responder accept or decline with strict verification.
 */
export function handleResponderResponse(params: HandleResponderResponseParams): IncidentTransitionResult {
  const { incident, currentAssignment, circle, response, clock } = params;
  const previousAssignments = params.previousAssignments ?? [currentAssignment];
  const offerTimeoutMinutes = params.offerTimeoutMinutes ?? 3;
  const now = clock.now();
  const nowIso = clock.nowIso();

  // 1. Guard against non-actionable incident states
  if (['escalated', 'closed', 'done'].includes(incident.state)) {
    return {
      incident,
      assignment: currentAssignment,
      intents: [],
      transitionStatus: 'already_terminal',
      reason: `Incident is already in terminal state: ${incident.state}`,
    };
  }

  // 2. Guard against assignment and family mismatch
  if (currentAssignment.incidentId !== incident.id) {
    return {
      incident,
      assignment: currentAssignment,
      intents: [],
      transitionStatus: 'stale_assignment',
      reason: 'Assignment does not belong to this incident',
    };
  }

  if (currentAssignment.familyId !== incident.familyId) {
    return {
      incident,
      assignment: currentAssignment,
      intents: [],
      transitionStatus: 'mismatched_family',
      reason: 'Assignment family does not match incident family',
    };
  }

  // 3. Guard against wrong responder
  if (response.responderPersonId !== currentAssignment.personId) {
    return {
      incident,
      assignment: currentAssignment,
      intents: [],
      transitionStatus: 'wrong_responder',
      reason: `Response from ${response.responderPersonId} does not match currently offered responder ${currentAssignment.personId}`,
    };
  }

  // 4. Guard against already processed assignment
  if (currentAssignment.status !== 'offered') {
    return {
      incident,
      assignment: currentAssignment,
      intents: [],
      transitionStatus: 'invalid_assignment_state',
      reason: `Assignment status is already ${currentAssignment.status}`,
    };
  }

  // 5. Handle ACCEPTANCE with AUTHORITATIVE EVIDENCE BINDING
  if (response.responseType === 'accept') {
    const proof = response.acceptanceProof;

    if (!proof) {
      return {
        incident,
        assignment: currentAssignment,
        intents: [],
        transitionStatus: 'unverified_event',
        reason: 'Responder acceptance requires authoritative provider acceptance proof',
      };
    }

    // Verify all binding attributes strictly
    const isBound =
      proof.normalizedProof === true &&
      ((proof.verifiedBy === 'twilio_signature' && proof.source === 'twilio') ||
        (proof.verifiedBy === 'sarvam_call_binding' && proof.source === 'sarvam' && proof.providerAction === 'sarvam.outbound_call')) &&
      proof.action === 'urgent_responder' &&
      proof.familyId === incident.familyId &&
      proof.familyId === currentAssignment.familyId &&
      proof.incidentId === incident.id &&
      proof.incidentId === currentAssignment.incidentId &&
      proof.assignmentId === currentAssignment.id &&
      proof.responderPersonId === currentAssignment.personId &&
      proof.responderPersonId === response.responderPersonId &&
      proof.subjectPersonId === incident.personId &&
      proof.responderPersonId !== incident.personId &&
      typeof proof.callId === 'string' &&
      proof.callId.length > 0 &&
      typeof proof.accountId === 'string' &&
      proof.accountId.length > 0;

    if (!isBound) {
      return {
        incident,
        assignment: currentAssignment,
        intents: [],
        transitionStatus: 'unverified_event',
        reason: 'Authoritative proof binding failed: mismatched family, incident, assignment, call, or account',
      };
    }

    // Acceptance verified
    const promiseMinutes = response.promiseMinutes && response.promiseMinutes > 0 ? response.promiseMinutes : 15;
    const promisedAt = new Date(now.getTime() + promiseMinutes * 60 * 1000).toISOString();

    const acceptedAssignment: IncidentAssignment = {
      ...currentAssignment,
      status: 'accepted',
      acceptedAt: nowIso,
      verifiedByProviderEventId: proof.eventId,
    };

    const acceptedIncident: UrgentIncident = {
      ...incident,
      state: 'accepted',
      ownerPersonId: response.responderPersonId,
      promisedAt,
    };

    return {
      incident: acceptedIncident,
      assignment: acceptedAssignment,
      intents: [
        {
          type: 'responder_accepted',
          responderPersonId: response.responderPersonId,
          promisedAt,
        },
      ],
      transitionStatus: 'success',
    };
  }

  // 6. Handle DECLINE: advance to next eligible responder
  const declinedAssignment: IncidentAssignment = {
    ...currentAssignment,
    status: 'declined',
  };

  const excludedIds = new Set(previousAssignments.map(a => a.personId));
  excludedIds.add(currentAssignment.personId);
  excludedIds.add(incident.personId); // subject excluded
  const eligible = getEligibleResponders(circle, excludedIds);

  if (!eligible.length) {
    // Circle exhausted: escalate incident
    const escalatedIncident: UrgentIncident = {
      ...incident,
      state: 'escalated',
    };

    return {
      incident: escalatedIncident,
      assignment: declinedAssignment,
      intents: [
        {
          type: 'incident_escalated',
          reason: 'responder_declined_circle_exhausted',
        },
      ],
      transitionStatus: 'success',
    };
  }

  // Dispatch offer to next eligible responder
  const nextResponder = eligible[0];
  const newExpiresAt = new Date(now.getTime() + offerTimeoutMinutes * 60 * 1000).toISOString();
  const nextAssignmentId = deriveDeterministicId(`asgn:${incident.id}`, previousAssignments.length + 1);

  const nextAssignment: IncidentAssignment = {
    id: nextAssignmentId,
    familyId: incident.familyId,
    incidentId: incident.id,
    personId: nextResponder.personId,
    status: 'offered',
    offeredAt: nowIso,
    expiresAt: newExpiresAt,
  };

  return {
    incident: { ...incident, state: 'offered' },
    assignment: nextAssignment,
    intents: [
      {
        type: 'offer_dispatched',
        intent: {
          incidentId: incident.id,
          familyId: incident.familyId,
          assignmentId: nextAssignment.id,
          responderPersonId: nextResponder.personId,
          rank: nextResponder.rank,
          offeredAt: nowIso,
          expiresAt: newExpiresAt,
          severity: incident.severity,
        },
      },
    ],
    transitionStatus: 'success',
  };
}

export interface CheckTimeoutsParams {
  incident: UrgentIncident;
  currentAssignment?: IncidentAssignment;
  circle: CircleMember[];
  previousAssignments?: IncidentAssignment[];
  offerTimeoutMinutes?: number;
  clock: Clock;
}

/**
 * Periodically invoked to check offer timeouts and promise overdue deadlines.
 */
export function checkIncidentTimeoutsAndPromises(params: CheckTimeoutsParams): IncidentTransitionResult {
  const { incident, currentAssignment, circle, clock } = params;
  const previousAssignments = params.previousAssignments ?? (currentAssignment ? [currentAssignment] : []);
  const offerTimeoutMinutes = params.offerTimeoutMinutes ?? 3;
  const now = clock.now();
  const nowIso = clock.nowIso();

  // Check offer timeout
  if (incident.state === 'offered' && currentAssignment && currentAssignment.status === 'offered') {
    if (now.getTime() >= new Date(currentAssignment.expiresAt).getTime()) {
      const expiredAssignment: IncidentAssignment = {
        ...currentAssignment,
        status: 'expired',
      };

      const excludedIds = new Set(previousAssignments.map(a => a.personId));
      excludedIds.add(currentAssignment.personId);
      excludedIds.add(incident.personId);
      const eligible = getEligibleResponders(circle, excludedIds);

      if (!eligible.length) {
        return {
          incident: { ...incident, state: 'escalated' },
          assignment: expiredAssignment,
          intents: [
            {
              type: 'incident_escalated',
              reason: 'offer_timeout_circle_exhausted',
            },
          ],
          transitionStatus: 'timeout_expired',
        };
      }

      const nextResponder = eligible[0];
      const newExpiresAt = new Date(now.getTime() + offerTimeoutMinutes * 60 * 1000).toISOString();
      const newAssignmentId = deriveDeterministicId(`asgn:${incident.id}`, previousAssignments.length + 1);
      const newAssignment: IncidentAssignment = {
        id: newAssignmentId,
        familyId: incident.familyId,
        incidentId: incident.id,
        personId: nextResponder.personId,
        status: 'offered',
        offeredAt: nowIso,
        expiresAt: newExpiresAt,
      };

      return {
        incident: { ...incident, state: 'offered' },
        assignment: newAssignment,
        intents: [
          {
            type: 'offer_dispatched',
            intent: {
              incidentId: incident.id,
              familyId: incident.familyId,
              assignmentId: newAssignment.id,
              responderPersonId: nextResponder.personId,
              rank: nextResponder.rank,
              offeredAt: nowIso,
              expiresAt: newExpiresAt,
              severity: incident.severity,
            },
          },
        ],
        transitionStatus: 'timeout_expired',
      };
    }
  }

  // Check promise overdue
  if (incident.state === 'accepted' && incident.promisedAt) {
    if (now.getTime() > new Date(incident.promisedAt).getTime()) {
      const escalatedIncident: UrgentIncident = {
        ...incident,
        state: 'escalated',
      };

      return {
        incident: escalatedIncident,
        assignment: currentAssignment,
        intents: [
          {
            type: 'overdue_escalation',
            intent: {
              incidentId: incident.id,
              familyId: incident.familyId,
              subjectPersonId: incident.personId,
              assignedResponderId: incident.ownerPersonId ?? '',
              promisedAt: incident.promisedAt,
              escalatedAt: nowIso,
              reason: 'promise_overdue',
            },
          },
          {
            type: 'incident_escalated',
            reason: 'responder_promise_overdue',
          },
        ],
        transitionStatus: 'success',
      };
    }
  }

  // No transition needed
  return {
    incident,
    assignment: currentAssignment,
    intents: [],
    transitionStatus: 'success',
  };
}

export interface CompleteIncidentParams {
  incident: UrgentIncident;
  currentAssignment: IncidentAssignment;
  responderPersonId: string;
  familyId: string;
  clock: Clock;
}

/**
 * Completes an accepted incident by the assigned owner.
 * Validates that current assignment belongs to family/incident/person and is in accepted state.
 */
export function completeIncident(params: CompleteIncidentParams): IncidentTransitionResult {
  const { incident, currentAssignment, responderPersonId, familyId } = params;

  // 1. Guard family correspondence
  if (incident.familyId !== familyId || currentAssignment.familyId !== familyId) {
    return {
      incident,
      assignment: currentAssignment,
      intents: [],
      transitionStatus: 'mismatched_family',
      reason: 'Completion family does not match incident family',
    };
  }

  // 2. Guard state
  if (incident.state !== 'accepted') {
    return {
      incident,
      assignment: currentAssignment,
      intents: [],
      transitionStatus: 'already_terminal',
      reason: `Cannot complete incident in state ${incident.state}`,
    };
  }

  if (currentAssignment.status !== 'accepted') {
    return {
      incident,
      assignment: currentAssignment,
      intents: [],
      transitionStatus: 'invalid_assignment_state',
      reason: `Cannot complete assignment with status ${currentAssignment.status}`,
    };
  }

  // 3. Guard assignment correspondence
  if (currentAssignment.incidentId !== incident.id) {
    return {
      incident,
      assignment: currentAssignment,
      intents: [],
      transitionStatus: 'stale_assignment',
      reason: 'Assignment does not belong to this incident',
    };
  }

  // 4. Guard owner
  if (responderPersonId !== incident.ownerPersonId || responderPersonId !== currentAssignment.personId) {
    return {
      incident,
      assignment: currentAssignment,
      intents: [],
      transitionStatus: 'wrong_responder',
      reason: 'Only the verified accepted owner can mark incident completed',
    };
  }

  const completedAssignment: IncidentAssignment = {
    ...currentAssignment,
    status: 'completed',
  };

  const closedIncident: UrgentIncident = {
    ...incident,
    state: 'closed',
  };

  return {
    incident: closedIncident,
    assignment: completedAssignment,
    intents: [{ type: 'incident_closed' }],
    transitionStatus: 'success',
  };
}
