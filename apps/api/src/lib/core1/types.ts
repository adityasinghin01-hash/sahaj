/**
 * Type definitions for Core 1 authenticated commands, repository ports, and domain contracts.
 */

import type { User } from '@supabase/supabase-js';

export type CommandType =
  | 'check_in'
  | 'urgent_help'
  | 'voice_message'
  | 'refill_proposal'
  | 'missed_call_nudge'
  | 'family_report';

export type FamilyRole = 'child' | 'parent' | 'circle';

export interface FamilyMembership {
  familyId: string;
  userId: string;
  personId: string;
  role: FamilyRole;
}

export interface CircleRecord {
  familyId: string;
  personId: string;
  rank: number;
  active: boolean;
  approvedAt: string | null;
  consentAt: string | null;
  revokedAt: string | null;
}

export interface CommandContext {
  user: User;
  membership: FamilyMembership;
  clientIp?: string;
  idempotencyKey: string;
  scopedIdempotencyKey: string;
}

export interface PersistedCommandResult {
  eventId: string;
  commandType: CommandType;
  status: 'queued' | 'requested';
  deduped: boolean;
  data?: Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// Command Payloads
// ----------------------------------------------------------------------------

export interface CheckInCommandPayload {
  scheduleId?: string;
  personId: string;
  preferredTime?: string;
  timezone?: string;
  wakeToken?: string;
  cancel?: boolean;
  cancellationReason?: string;
}

export interface UrgentHelpCommandPayload {
  incidentId?: string;
  subjectPersonId: string;
  severity: 'routine' | 'urgent' | 'critical';
  action?: 'initiate' | 'accept' | 'decline' | 'complete';
  assignmentId?: string;
  promiseMinutes?: number;
  rawEventId?: string;
}

export interface VoiceMessageCommandPayload {
  recipientPersonId: string;
  mediaObjectPath: string;
  consentId: string;
  replyToId?: string;
}

export interface RefillProposalCommandPayload {
  medicineId: string;
  personId: string;
  vendorId: string;
  reorderPacks?: number;
  doseAction?: 'confirmed_dose' | 'missed_dose' | 'double_dose_reported' | 'count_reconciliation';
  doseCount?: number;
}

export interface MissedCallNudgeCommandPayload {
  callerPersonId: string;
  recipientPersonId: string;
  providerCallId: string;
  providerAccountId?: string;
  timestamp?: string;
}

export interface FamilyReportCommandPayload {
  periodStart: string;
  periodEnd: string;
}

export interface BaseCommandEnvelope<T = Record<string, unknown>> {
  command: CommandType;
  familyId?: string;
  payload: T;
  idempotencyKey?: string;
}

// ----------------------------------------------------------------------------
// Injected Port Interfaces
// ----------------------------------------------------------------------------

export interface AuthPort {
  getUser(token: string): Promise<User>;
}

export interface StoredRawEvent {
  id: string;
  familyId: string;
  source: string;
  providerEventId: string;
  payloadHash: string;
  payloadCiphertext: string;
  status: string;
}

export interface Core1RepositoryPort {
  getMembership(userId: string, requestedFamilyId?: string): Promise<FamilyMembership>;
  getCircleRecord(familyId: string, personId: string): Promise<CircleRecord | null>;
  validateEntityOwnership(entityType: string, familyId: string, entityId: string): Promise<boolean>;
  findEventByIdempotency(scopedKey: string): Promise<StoredRawEvent | null>;
  persistCommandEvent(params: {
    eventId: string;
    familyId: string;
    scopedIdempotencyKey: string;
    payloadHash: string;
    payloadCiphertext: string;
    commandType: CommandType;
    actorPersonId: string;
  }): Promise<void>;
  createUrgentIncidentOffer?(params: {
    familyId: string;
    subjectPersonId: string;
    severity: string;
    offerTimeoutMinutes?: number;
  }): Promise<{ incidentId: string; assignmentId?: string; state: string }>;
  recordMedicineDose?(params: {
    familyId: string;
    medicineId: string;
    personId: string;
    actionType: string;
    count?: number;
  }): Promise<{ remainingCount: number; isLowStock: boolean }>;
}

export interface Core1ServicePorts {
  auth: AuthPort;
  repo: Core1RepositoryPort;
  encryptionKeyHex?: string;
}
