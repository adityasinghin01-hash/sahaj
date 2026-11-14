/**
 * Pure domain types for Sahaj Core 1 workflow operations.
 * Privacy rule: Synthetic identifiers and metadata enums only. No PII, plaintext phones, or unmasked medical records.
 */

import { createHash } from 'node:crypto';
import type { GateRequest } from '@sahaj/gate';

export interface Clock {
  now(): Date;
  nowIso(): string;
}

export function createClock(dateOrIso?: Date | string): Clock {
  const d = dateOrIso ? new Date(dateOrIso) : new Date();
  return {
    now: () => new Date(d.getTime()),
    nowIso: () => d.toISOString(),
  };
}

/**
 * Deterministically derives an identifier from domain scope and nonce/counter,
 * preventing random UUID churn on replay/re-evaluation.
 */
export function deriveDeterministicId(scope: string, nonce: string | number): string {
  const hash = createHash('sha256').update(`${scope}:${nonce}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// ----------------------------------------------------------------------------
// 1. Daily Check-in Types
// ----------------------------------------------------------------------------

export interface TimeWindow {
  /** HH:mm in local time, e.g. "21:00" */
  start: string;
  /** HH:mm in local time, e.g. "07:00" */
  end: string;
}

export interface CheckInRetryPolicy {
  maxAttempts: number;
  retryIntervalMinutes: number;
}

export interface CheckInScheduleConfig {
  id: string;
  familyId: string;
  personId: string;
  enabled: boolean;
  /** IANA timezone, e.g. "Asia/Kolkata" or "America/New_York" */
  timezone: string;
  /** Preferred local time for check-in, e.g. "09:00" */
  preferredTime: string;
  /** Local quiet windows where calls must not be initiated */
  quietWindows: TimeWindow[];
  retryPolicy: CheckInRetryPolicy;
}

export type CheckInAttemptStatus =
  | 'scheduled'
  | 'ringing'
  | 'connected'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CheckInAttempt {
  attemptNumber: number;
  scheduledAt: string;
  status: CheckInAttemptStatus;
  completedAt?: string;
  callId?: string;
}

export interface CheckInConsent {
  hasConsent: boolean;
  expiresAt?: string;
  revokedAt?: string;
}

export interface CheckInState {
  scheduleId: string;
  familyId: string;
  personId: string;
  localDate: string; // YYYY-MM-DD
  attempts: CheckInAttempt[];
  lastWakeToken?: string;
  cancelledAt?: string;
  cancellationReason?: string;
}

export interface CheckInCallIntent {
  familyId: string;
  personId: string;
  scheduleId: string;
  targetTime: string; // ISO 8601
  attemptNumber: number;
  /** AI disclosure is mandatory under Sahaj guidelines */
  aiDisclose: true;
  recordingConsentRequired: boolean;
  wakeToken: string;
}

export interface CheckInEscalationAlert {
  familyId: string;
  personId: string;
  scheduleId: string;
  attemptsCount: number;
  reason: 'retry_exhausted';
  severity: 'urgent';
  occurredAt: string;
}

export type CheckInScheduleDecision =
  | {
      action: 'schedule_call';
      intent: CheckInCallIntent;
      nextState: CheckInState;
    }
  | {
      action: 'defer_quiet_hours';
      deferredUntil: string; // ISO 8601
      nextState: CheckInState;
    }
  | {
      action: 'exhausted';
      alert: CheckInEscalationAlert;
      nextState: CheckInState;
    }
  | {
      action: 'blocked_missing_consent';
      reason: string;
      nextState: CheckInState;
    }
  | {
      action: 'duplicate_wake_ignored';
      wakeToken: string;
      nextState: CheckInState;
    }
  | {
      action: 'already_completed';
      completedAt: string;
      nextState: CheckInState;
    }
  | {
      action: 'in_progress';
      attemptNumber: number;
      nextState: CheckInState;
    }
  | {
      action: 'cancelled';
      reason: string;
      nextState: CheckInState;
    };

// ----------------------------------------------------------------------------
// 2. Urgent Responder Types & Exact Acceptance Proof Binding
// ----------------------------------------------------------------------------

export type IncidentState =
  | 'open'
  | 'offered'
  | 'accepted'
  | 'heard'
  | 'done'
  | 'reopened'
  | 'escalated'
  | 'closed';

export type IncidentSeverity = 'routine' | 'urgent' | 'critical';

export type AssignmentStatus =
  | 'offered'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'completed';

export interface CircleMember {
  personId: string;
  rank: number; // 1 = primary, 2 = secondary...
  active: boolean;
  approvedAt?: string;
  consentAt?: string;
  revokedAt?: string;
}

export interface IncidentAssignment {
  id: string;
  familyId: string;
  incidentId: string;
  personId: string;
  status: AssignmentStatus;
  offeredAt: string;
  expiresAt: string;
  acceptedAt?: string;
  verifiedByProviderEventId?: string;
}

export interface UrgentIncident {
  id: string;
  familyId: string;
  personId: string; // The subject who needs assistance
  requestId?: string;
  ownerPersonId?: string; // The responder who accepted
  state: IncidentState;
  severity: IncidentSeverity;
  promisedAt?: string;
  createdAt: string;
}

/**
 * Authoritative provider acceptance proof bound to family, incident, assignment, and provider identity.
 * Conforms to sibling Kiro Phase2/Phase3 responder.accepted normalized contract.
 */
export interface ResponderAcceptanceProof {
  eventId: string;
  familyId: string;
  incidentId: string;
  assignmentId: string;
  responderPersonId: string;
  subjectPersonId: string;
  callId: string;
  outboxId?: string;
  actionRequestId?: string;
  action: 'urgent_responder';
  providerAction: string;
  accountId: string;
  dispatchKey?: string;
  normalizedProof: true;
  /** Twilio: signed Gather press. Sarvam (K-SARVAMCALL): tool decision bound in SQL to a call we dispatched for this assignment. */
  verifiedBy: 'twilio_signature' | 'sarvam_call_binding';
  source: 'twilio' | 'sarvam';
}

export interface ResponderOfferIntent {
  incidentId: string;
  familyId: string;
  assignmentId: string;
  responderPersonId: string;
  rank: number;
  offeredAt: string;
  expiresAt: string;
  severity: IncidentSeverity;
}

export interface OverdueEscalationIntent {
  incidentId: string;
  familyId: string;
  subjectPersonId: string;
  assignedResponderId: string;
  promisedAt: string;
  escalatedAt: string;
  reason: 'promise_overdue';
}

export interface IncidentTransitionResult {
  incident: UrgentIncident;
  assignment?: IncidentAssignment;
  intents: (
    | { type: 'offer_dispatched'; intent: ResponderOfferIntent }
    | { type: 'overdue_escalation'; intent: OverdueEscalationIntent }
    | { type: 'incident_escalated'; reason: string }
    | { type: 'responder_accepted'; responderPersonId: string; promisedAt: string }
    | { type: 'incident_closed' }
  )[];
  transitionStatus:
    | 'success'
    | 'wrong_responder'
    | 'stale_assignment'
    | 'unverified_event'
    | 'timeout_expired'
    | 'already_terminal'
    | 'mismatched_family'
    | 'invalid_assignment_state';
  reason?: string;
}

// ----------------------------------------------------------------------------
// 3. Two-Way Family Voice Orchestration Types
// ----------------------------------------------------------------------------

export type VoicePostState = 'queued' | 'sent' | 'delivered' | 'heard' | 'failed';

export interface VoicePost {
  id: string;
  familyId: string;
  senderId: string;
  recipientId: string;
  replyToId?: string;
  state: VoicePostState;
  consentId: string;
  createdAt: string;
}

export interface VoiceContentMetadata {
  familyId: string;
  voicePostId: string;
  objectPath: string;
  expiresAt: string;
}

export interface VoiceShareConsent {
  id: string;
  familyId: string;
  personId: string;
  purpose: string; // must start with voice_share:
  answer: boolean;
  expiresAt?: string;
  revokedAt?: string;
}

export interface VoiceDispatchIntent {
  familyId: string;
  voicePostId: string;
  senderId: string;
  recipientId: string;
  objectPath: string;
  consentId: string;
  expiresAt: string;
  replyToId?: string;
  /** Guard: Explicitly verify that no AI synthetic voice cloning is ever invoked */
  syntheticCloningProhibited: true;
}

export interface VoicePostTransitionResult {
  voicePost: VoicePost;
  content: VoiceContentMetadata;
  intent?: VoiceDispatchIntent;
  status: 'enqueued' | 'blocked_missing_consent' | 'expired' | 'invalid_path';
  reason?: string;
}

// ----------------------------------------------------------------------------
// 4. Medicine Inventory & Refill Mathematics Types
// ----------------------------------------------------------------------------

export interface MedicineRecord {
  id: string;
  familyId: string;
  personId: string;
  label: string;
  remainingCount: number;
  refillThreshold: number;
  instructionsConfirmedByPerson: boolean;
  unitDose: number;
  packSize: number;
  preferredVendorId?: string;
  /** Estimated unit price per dose/item in integer minor units (e.g. paise/cents) */
  estimatedUnitPriceMinor?: number;
}

export interface VendorRecord {
  id: string;
  familyId: string;
  approved: boolean;
  revokedAt?: string | null;
}

export type DoseActionType =
  | 'confirmed_dose'
  | 'missed_dose'
  | 'double_dose_reported'
  | 'count_reconciliation';

export interface DoseInput {
  actionType: DoseActionType;
  /** Actual count taken or counted (must be positive integer if specified) */
  count?: number;
  timestamp: string;
}

export interface RefillProposalIntent {
  familyId: string;
  medicineId: string;
  personId: string;
  vendorId: string;
  itemIds: string[];
  reorderQuantity: number;
  amountMinor: number;
  proposedAt: string;
  requiresFamilyApproval: true;
  gateRequest: GateRequest;
}

export interface MedicineOperationResult {
  medicine: MedicineRecord;
  actionTaken: DoseActionType;
  isLowStock: boolean;
  refillProposal?: RefillProposalIntent;
  safetyAlert?: {
    severity: 'routine' | 'urgent';
    message: string;
    notifyFamily: boolean;
    medicalDiagnosisOrPrescriptionGiven: false;
  };
}

// ----------------------------------------------------------------------------
// 5. Missed Call Types & Deduplication
// ----------------------------------------------------------------------------

export interface MissedCallEvent {
  providerCallId: string;
  providerAccountId?: string;
  familyId: string;
  callerPersonId: string;
  recipientPersonId: string;
  timestamp: string;
}

export type MissedCallTier = 'single' | 'repeated' | 'urgent';

export interface MissedCallNudgeIntent {
  familyId: string;
  callerPersonId: string;
  recipientPersonId: string;
  tier: MissedCallTier;
  callCount: number;
  windowStart: string;
  windowEnd: string;
  callIds: string[];
  proposedNudge: {
    kind: 'missed_call_single' | 'missed_call_repeated' | 'missed_call_urgent';
    urgency: 'routine' | 'elevated' | 'urgent';
    scheduledAt: string;
  };
}

export interface MissedCallGroupingResult {
  clusters: MissedCallNudgeIntent[];
  dedupedCount: number;
  rawEventCount: number;
}

// ----------------------------------------------------------------------------
// 6. Access-Controlled Family Reports & Redacted Timeline
// ----------------------------------------------------------------------------

export interface RawTimelineRecord {
  id: string;
  familyId: string;
  source: string;
  eventType: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  contentPreview?: string;
}

export interface RedactedTimelineRecord {
  id: string;
  eventType: string;
  timestamp: string;
  summary: string;
  category: 'check_in' | 'urgent' | 'voice' | 'medicine' | 'missed_call' | 'general';
}

export interface FamilyReport {
  familyId: string;
  requestedByPersonId: string;
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  stats: {
    checkInsCompleted: number;
    urgentIncidentsRaised: number;
    urgentIncidentsResolved: number;
    voiceMessagesShared: number;
    refillProposalsGenerated: number;
    missedCallsDetected: number;
  };
  timeline: RedactedTimelineRecord[];
}
