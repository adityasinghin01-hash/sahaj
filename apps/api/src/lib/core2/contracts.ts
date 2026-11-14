import type { GateDecision, GateInput } from "@sahaj/gate";

export type Core2ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "family_selection_required"
  | "invalid_request"
  | "idempotency_key_required"
  | "idempotency_conflict"
  | "not_found"
  | "conflict"
  | "stale_version"
  | "watch_cancelled"
  | "incident_closed"
  | "incident_already_accepted"
  | "assignment_expired"
  | "consent_required"
  | "approval_required"
  | "storage_unavailable"
  | "unavailable";

export class Core2Error extends Error {
  constructor(
    public readonly code: Core2ErrorCode,
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 503,
    message: string,
  ) {
    super(message);
    this.name = "Core2Error";
  }
}

export type MemberRole = "parent" | "child" | "circle";
export type TrustedContactScope = "sos" | "watch_escalation" | "reassurance";
export type TrustedContactState = "invited" | "approved" | "active" | "revoked";
export type WatchState = "active" | "checking_in" | "escalated" | "safe" | "cancelled";
export type SosStatus =
  | "countdown"
  | "queued"
  | "pending_contacts"
  | "awaiting_approval"
  | "denied"
  | "verified_accepted"
  | "safe"
  | "cancelled";
export type DeliveryStatus = "none" | "queued" | "delivery_unknown" | "delivered" | "failed" | "denied";
export type ReassuranceKind = "im_safe" | "reached_home" | "truth_line";

export interface Core2Actor {
  userId: string;
  familyId: string;
  personId: string;
  role: MemberRole;
}

export interface Core2Membership {
  familyId: string;
  userId: string;
  personId: string;
  role: MemberRole;
  revokedAt: string | null;
}

export interface Core2Person {
  id: string;
  familyId: string;
  displayName: string;
  role: "parent" | "child" | "circle" | "vendor";
  timezone: string;
}

export interface TrustedContactRow {
  id: string;
  familyId: string;
  subjectPersonId: string;
  contactPersonId: string;
  contactDisplayName?: string;
  rank: number;
  scopes: TrustedContactScope[];
  state: TrustedContactState;
  approvedAt: string | null;
  consentId: string | null;
  consentAt: string | null;
  effectiveFrom: string;
  effectiveUntil: string | null;
  revokedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WatchRow {
  id: string;
  familyId: string;
  subjectPersonId: string;
  incidentId: string | null;
  requestId: string | null;
  rawEventId: string;
  timezone: string;
  state: WatchState;
  version: number;
  graceMinutes: number;
  deadlineAt: string;
  graceUntil: string;
  nextTickAt: string | null;
  checkedInAt: string | null;
  escalatedAt: string | null;
  safeAt: string | null;
  cancelledAt: string | null;
  safeIdempotencyKeyHash: string | null;
  safeVoicePostId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SosRow {
  id: string;
  familyId: string;
  subjectPersonId: string;
  incidentId: string;
  requestId: string;
  rawEventId: string;
  status: SosStatus;
  deliveryStatus: Exclude<DeliveryStatus, "denied">;
  responderAccepted: boolean;
  acceptedAssignmentId: string | null;
  acceptedRawEventId: string | null;
  version: number;
  countdownUntil: string | null;
  cancelledAt: string | null;
  safeAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SharingPreferencesRow {
  familyId: string;
  subjectPersonId: string;
  shareStatusWithParent: boolean;
  allowLocationShare: boolean;
  allowHealthShare: boolean;
  allowNarrativeShare: boolean;
  version: number;
  updatedAt: string;
}

export interface ReassuranceRow {
  id: string;
  familyId: string;
  subjectPersonId: string;
  recipientPersonId: string;
  kind: ReassuranceKind;
  watchId: string | null;
  sosId: string | null;
  voicePostId: string | null;
  outboxId: string | null;
  statusLabel: string;
  deliveryStatus: Exclude<DeliveryStatus, "none">;
  deliveryVerified: boolean;
  heardVerified: boolean;
  verifiedRawEventId: string | null;
  locationShared: boolean;
  healthShared: boolean;
  narrativeShared: boolean;
  createdAt: string;
}

export interface Core2IdempotencyRecord {
  familyId: string;
  actorPersonId: string;
  action: string;
  keyHash: string;
  requestHash: string;
  responseStatus: number;
  responseBody: unknown;
}

export interface Core2ConsentRecord {
  id: string;
  familyId: string;
  personId: string;
  callId: string | null;
  purpose: string;
  answer: boolean;
  version: string;
  createdAt: string;
}

export interface Core2VoicePostRecord {
  id: string;
  familyId: string;
  senderId: string;
  recipientId: string;
  consentId: string;
}

export interface DispatchFenceInput {
  familyId: string;
  outboxId: string;
  trustedContactId?: string | null;
  watchId?: string | null;
  sosId?: string | null;
}

export interface Core2AuthPort {
  verifyBearer(token: string): Promise<{ userId: string } | null>;
}

export interface Core2CryptoPort {
  encryptPayload(familyId: string, eventId: string, source: string, payload: Record<string, unknown>): {
    payloadHash: string;
    payloadCiphertext: string;
  };
  encryptSecretNote(aad: string, note: Record<string, unknown>): string;
}

export interface Core2TimelineAppendInput {
  familyId: string;
  eventId: string;
  dedupeKey: string;
  eventType: string;
  entityId: string | null;
  humanLine: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface Core2TimelinePort {
  append(input: Core2TimelineAppendInput): Promise<void>;
}

export interface Core2GatePort {
  evaluate(input: GateInput): GateDecision | Promise<GateDecision>;
}

export interface EnqueueOutboxRequest {
  familyId: string;
  actionRequestId: string | null;
  kind: string;
  dedupeKey: string;
  payloadCiphertext: string;
  trustedContactId?: string | null;
  watchId?: string | null;
  sosId?: string | null;
}

export interface EnqueueOutboxResult {
  outboxId: string;
  status: "pending";
}

/**
 * Typed dispatch seam for Kiro Phase 2/3 authorized outbox & dispatch fencing.
 * Zero direct SMS/WhatsApp/Sarvam provider HTTP calls happen in Core 2 routes.
 */
export interface Core2DispatchPort {
  enqueueAuthorized(request: EnqueueOutboxRequest): Promise<EnqueueOutboxResult>;
}

export interface Core2Repository {
  listActiveMemberships(userId: string): Promise<Core2Membership[]>;
  getPerson(familyId: string, personId: string): Promise<Core2Person | null>;
  listPeopleByRole(familyId: string, role: "parent" | "child" | "circle" | "vendor"): Promise<Core2Person[]>;

  getIdempotency(
    familyId: string,
    actorPersonId: string,
    action: string,
    keyHash: string,
  ): Promise<Core2IdempotencyRecord | null>;
  saveIdempotency(record: Core2IdempotencyRecord): Promise<void>;

  ingestRawEvent(input: {
    source: string;
    providerEventId: string;
    eventType: string;
    familyId: string;
    metadata: Record<string, unknown>;
    payloadHash: string;
    payloadCiphertext: string;
  }): Promise<{ rawEventId: string }>;

  loadGateInput(input: {
    familyId: string;
    actorPersonId: string;
    requestId: string;
    action: GateInput["request"]["action"];
    targetId: string;
    consentSubjectId?: string;
    now: string;
  }): Promise<GateInput>;

  createRequestAndIncident(input: {
    familyId: string;
    personId: string;
    requestKind: string;
    severity: "routine" | "urgent" | "critical";
    incidentState: "open" | "offered";
  }): Promise<{ requestId: string; incidentId: string }>;

  createAssignment(input: {
    familyId: string;
    incidentId: string;
    personId: string;
    expiresAt: string;
  }): Promise<{ assignmentId: string }>;

  listActiveTrustedContacts(
    familyId: string,
    subjectPersonId: string,
    scope: TrustedContactScope,
    nowIso: string,
  ): Promise<TrustedContactRow[]>;

  listTrustedContacts(
    familyId: string,
    subjectPersonId: string,
    includeRevoked: boolean,
    limit: number,
  ): Promise<TrustedContactRow[]>;

  getTrustedContact(familyId: string, contactId: string): Promise<TrustedContactRow | null>;

  createTrustedContact(input: {
    familyId: string;
    subjectPersonId: string;
    contactPersonId: string;
    rank: number;
    scopes: TrustedContactScope[];
    effectiveFrom: string;
    effectiveUntil: string | null;
  }): Promise<TrustedContactRow>;

  approveTrustedContact(input: {
    familyId: string;
    contactId: string;
    consentPersonId: string;
    consentVersion: string;
    nowIso: string;
  }): Promise<TrustedContactRow>;

  updateTrustedContact(input: {
    familyId: string;
    contactId: string;
    expectedVersion: number;
    rank?: number;
    scopes?: TrustedContactScope[];
    effectiveUntil?: string | null;
  }): Promise<TrustedContactRow>;

  revokeTrustedContact(
    familyId: string,
    contactId: string,
    expectedVersion?: number,
  ): Promise<TrustedContactRow>;

  createSosEvent(input: {
    familyId: string;
    subjectPersonId: string;
    incidentId: string;
    requestId: string;
    rawEventId: string;
    status: SosStatus;
    deliveryStatus: Exclude<DeliveryStatus, "denied">;
    countdownUntil: string | null;
  }): Promise<SosRow>;

  updateSosStatus(input: {
    familyId: string;
    sosId: string;
    expectedVersion?: number;
    status: SosStatus;
    deliveryStatus?: Exclude<DeliveryStatus, "denied">;
    cancelledAt?: string | null;
    safeAt?: string | null;
  }): Promise<SosRow>;

  getSosEvent(familyId: string, sosId: string): Promise<SosRow | null>;
  listSosEvents(familyId: string, subjectPersonId: string | null, limit: number): Promise<SosRow[]>;

  createWatch(input: {
    familyId: string;
    subjectPersonId: string;
    rawEventId: string;
    requestId: string;
    timezone: string;
    graceMinutes: number;
    deadlineAt: string;
    graceUntil: string;
    nextTickAt: string;
    routeCiphertext: string;
  }): Promise<WatchRow>;

  extendWatch(input: {
    familyId: string;
    watchId: string;
    subjectPersonId: string;
    expectedVersion: number;
    addMinutes: number;
    addMs?: number;
    graceMs?: number;
    nowIso: string;
  }): Promise<WatchRow>;

  cancelWatch(input: {
    familyId: string;
    watchId: string;
    subjectPersonId: string;
    expectedVersion?: number;
    nowIso: string;
  }): Promise<WatchRow>;

  resolveWatchSafe(input: {
    familyId: string;
    watchId: string;
    subjectPersonId: string;
    expectedVersion?: number;
    idempotencyKeyHash: string;
    voicePostId?: string | null;
  }): Promise<WatchRow>;

  tickDueWatches(nowIso: string, limit: number): Promise<WatchRow[]>;

  getWatch(familyId: string, watchId: string): Promise<WatchRow | null>;
  listWatches(familyId: string, subjectPersonId: string | null, limit: number): Promise<WatchRow[]>;

  getVoicePost(familyId: string, postId: string): Promise<Core2VoicePostRecord | null>;
  getConsent(familyId: string, consentId: string): Promise<Core2ConsentRecord | null>;
  listConsentHistory(familyId: string, personId: string, purpose: string): Promise<Core2ConsentRecord[]>;

  getSharingPreferences(familyId: string, subjectPersonId: string): Promise<SharingPreferencesRow>;
  upsertSharingPreferences(input: {
    familyId: string;
    subjectPersonId: string;
    shareStatusWithParent: boolean;
    allowLocationShare: boolean;
    allowHealthShare: boolean;
    allowNarrativeShare: boolean;
  }): Promise<SharingPreferencesRow>;

  createReassuranceUpdate(input: {
    familyId: string;
    subjectPersonId: string;
    recipientPersonId: string;
    kind: ReassuranceKind;
    watchId: string | null;
    sosId: string | null;
    voicePostId: string | null;
    outboxId: string | null;
    statusLabel: string;
    deliveryStatus: Exclude<DeliveryStatus, "none">;
    locationShared: boolean;
    healthShared: boolean;
    narrativeShared: boolean;
  }): Promise<ReassuranceRow>;

  listReassuranceUpdates(
    familyId: string,
    recipientOrSubjectPersonId: string | null,
    limit: number,
  ): Promise<ReassuranceRow[]>;

  fencePendingSosDispatches(familyId: string, sosId: string, reason: string): Promise<void>;

  listDueEscalations(nowIso: string, limit: number): Promise<DueIncidentEscalation[]>;

  offerNextTrustedContact(input: {
    familyId: string;
    incidentId: string;
    scope: "sos" | "watch_escalation";
    offerExpiresAt: string;
    nowIso: string;
  }): Promise<OfferNextContactResult>;

  acceptIncidentAssignment(input: {
    familyId: string;
    incidentId: string;
    actorPersonId: string;
    rawEventId: string;
    nowIso: string;
  }): Promise<AcceptIncidentResult>;

  declineIncidentAssignment(input: {
    familyId: string;
    incidentId: string;
    actorPersonId: string;
    nowIso: string;
  }): Promise<DeclineIncidentResult>;

  loadTruthLineSnapshot(input: {
    familyId: string;
    parentPersonId: string;
    subjectPersonId?: string;
  }): Promise<TruthLineStateSnapshot>;
}

export interface DueIncidentEscalation {
  incidentId: string;
  familyId: string;
  subjectPersonId: string;
  watchId: string | null;
  sosId: string | null;
  offerExpiresAt: string;
}

export interface OfferNextContactResult {
  assignmentId: string | null;
  trustedContactId: string | null;
  contactPersonId: string | null;
  rank: number | null;
  offeredAt: string | null;
  expiresAt: string | null;
  newlyCreated: boolean;
  exhausted: boolean;
}

export interface AcceptIncidentResult {
  assignmentId: string;
  incidentId: string;
  subjectPersonId: string;
  responderPersonId: string;
  offeredAt: string;
  acceptedAt: string;
  alreadyAccepted: boolean;
}

export interface DeclineIncidentResult {
  assignmentId: string;
  incidentId: string;
  subjectPersonId: string;
  alreadyDeclined: boolean;
}

export interface TruthLineStateSnapshot {
  child: Core2Person;
  preferences: SharingPreferencesRow;
  latestWatch: WatchRow | null;
  activeIncidentOwnerName: string | null;
  latestSos: SosRow | null;
  latestReassurance: ReassuranceRow | null;
}

export interface Core2Deps {
  auth: Core2AuthPort;
  repo: Core2Repository;
  dispatch: Core2DispatchPort;
  gate: Core2GatePort;
  timeline: Core2TimelinePort;
  crypto: Core2CryptoPort;
  now?: () => Date;
  uuid?: () => string;
  env?: Record<string, string | undefined>;
}

// Public safe API DTOs (snake_case matching docs/phase5/CORE2-API.md)
export interface PublicWatchDto {
  id: string;
  family_id: string;
  subject_person_id: string;
  incident_id: string | null;
  request_id: string | null;
  timezone: string;
  state: WatchState;
  version: number;
  grace_minutes: number;
  deadline_at: string;
  grace_until: string;
  checked_in_at: string | null;
  escalated_at: string | null;
  safe_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicSosDto {
  id: string;
  family_id: string;
  subject_person_id: string;
  incident_id: string;
  request_id: string;
  status: SosStatus;
  delivery_status: Exclude<DeliveryStatus, "denied">;
  responder_accepted: boolean;
  version: number;
  countdown_until: string | null;
  cancelled_at: string | null;
  safe_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublicTrustedContactDto {
  id: string;
  family_id: string;
  subject_person_id: string;
  contact_person_id: string;
  display_name: string | null;
  rank: number;
  scopes: TrustedContactScope[];
  state: TrustedContactState;
  effective_from: string;
  effective_until: string | null;
  revoked_at: string | null;
  version: number;
  created_at: string;
}

export interface PublicReassuranceDto {
  id: string;
  family_id: string;
  subject_person_id: string;
  recipient_person_id: string;
  kind: ReassuranceKind;
  watch_id: string | null;
  sos_id: string | null;
  status: Exclude<DeliveryStatus, "none">;
  delivery_verified: boolean;
  heard_verified: boolean;
  facts_exposed: {
    status_label: string;
    location_included: boolean;
    health_included: boolean;
    narrative_included: boolean;
  };
  created_at: string;
}

export interface PublicSharingPreferencesDto {
  family_id: string;
  subject_person_id: string;
  share_status_with_parent: boolean;
  allow_location_share: boolean;
  allow_health_share: boolean;
  allow_narrative_share: boolean;
  version: number;
  updated_at: string;
}

