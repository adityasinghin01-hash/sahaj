import type { MaaRepo } from "@/app/api/core1/maa/_lib/repo";
import type { ReplayGuard } from "@/app/api/core1/maa/_lib/device-auth";
import type {
  Core2Actor,
  Core2Deps,
  Core2DispatchPort,
  Core2GatePort,
  Core2Person,
  Core2Repository,
  Core2TimelinePort,
} from "@/lib/core2/contracts";
import type { TimelineKey } from "@/lib/timeline";

export type GentleNewsStatus =
  | "circle_offered"
  | "companion_with_maa"
  | "maa_call_queued"
  | "maa_called"
  | "closed";

export type CircleOfferStatus =
  | "none"
  | "offered"
  | "accepted"
  | "declined"
  | "timed_out"
  | "with_maa";

export type HeardMessageKind =
  | "core2_reassurance"
  | "core1_voice_post"
  | "gentle_news_voice";

export type HeardChannel = "smartphone_app" | "keypad_twilio";

export type HeardEvidenceType =
  | "device_signed_playback_end"
  | "twilio_gather_after_playback"
  | "twilio_status_duration_gte_clip";

export type ZapierZ3Status = "skipped" | "sent" | "failed";

export interface MaaQuestionEntry {
  id: string;
  question: string;
  recorded_at: string;
  source: "sarvam_tool" | "system";
}

export interface GentleNewsRow {
  id: string;
  family_id: string;
  incident_id: string;
  subject_person_id: string;
  parent_person_id: string;
  marked_by_person_id: string;
  status: GentleNewsStatus;
  calm_summary: string;
  voice_post_id: string | null;
  circle_person_id: string | null;
  circle_offer_status: CircleOfferStatus;
  tried_circle_person_ids: string[];
  circle_offered_at: string | null;
  circle_accepted_at: string | null;
  circle_with_maa_at: string | null;
  maa_call_due_at: string;
  maa_call_outbox_id: string | null;
  maa_call_queued_at: string | null;
  maa_questions: MaaQuestionEntry[];
  raw_event_id: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface CircleCompanionCandidate {
  person_id: string;
  display_name: string;
  device: "keypad" | "smartphone" | null;
  rank: number;
}

export interface IncidentSummaryRow {
  id: string;
  family_id: string;
  person_id: string;
  owner_person_id: string | null;
  state: string;
  severity: "routine" | "urgent" | "critical";
  promised_at: string | null;
  created_at: string;
}

export interface AssignmentSummaryRow {
  id: string;
  family_id: string;
  incident_id: string;
  person_id: string;
  display_name: string | null;
  role: string | null;
  status: string;
  offered_at: string;
  expires_at: string;
  accepted_at: string | null;
}

export interface ReassuranceDeliveryRow {
  id: string;
  family_id: string;
  subject_person_id: string;
  recipient_person_id: string;
  kind: "im_safe" | "reached_home" | "truth_line";
  watch_id: string | null;
  sos_id: string | null;
  voice_post_id: string | null;
  outbox_id: string | null;
  status_label: string;
  delivery_status: string;
  delivery_verified: boolean;
  heard_verified: boolean;
  created_at: string;
}

export interface VoicePostDeliveryRow {
  id: string;
  family_id: string;
  sender_id: string;
  recipient_id: string;
  state: "queued" | "sent" | "delivered" | "heard" | "failed";
  consent_id: string;
  created_at: string;
}

export interface HeardReceiptRow {
  id: string;
  family_id: string;
  message_kind: HeardMessageKind;
  delivery_id: string;
  reassurance_id: string | null;
  voice_post_id: string | null;
  outbox_id: string | null;
  recipient_person_id: string;
  channel: HeardChannel;
  evidence_type: HeardEvidenceType;
  device_id: string | null;
  call_sid: string | null;
  clip_duration_s: number;
  played_duration_s: number | null;
  dtmf_digit: string | null;
  raw_event_id: string;
  heard_at: string;
  created_at: string;
}

export interface TimelineSummaryRow {
  id: string;
  family_id: string;
  event_type: string;
  entity_id: string | null;
  human_line: string;
  payload_hash: string;
  prev_chain_hash: string | null;
  chain_hash: string;
  signature: string;
  signing_key_id: string;
  created_at: string;
  sequence?: number | null;
  dedupe_key?: string | null;
  occurred_at_iso?: string | null;
  envelope_canonical?: string | null;
}

export interface AfterReportDeliveryItem {
  delivery_id: string;
  message_kind: HeardMessageKind;
  label: string;
  sent_at: string;
  delivery_status: string;
  delivered: boolean;
  heard: boolean;
  heard_at: string | null;
  heard_channel: HeardChannel | null;
  heard_evidence: HeardEvidenceType | null;
  badge_label: string;
}

export interface AfterReportDto {
  schema_version: "sahaj.after_report.v1";
  family_id: string;
  incident_id: string;
  closed_at: string;
  redaction: {
    phone_numbers_stripped: true;
    location_trail_stripped: true;
    ai_cloned_voice_used: false;
  };
  what_happened: {
    severity: string;
    final_state: string;
    subject_person_id: string;
    subject_name: string;
    gentle_news_triggered: boolean;
    calm_summary: string | null;
    maa_questions: MaaQuestionEntry[];
    timeline_chain_verified: boolean;
    timeline_entries: Array<{
      id: string;
      event_type: string;
      human_line: string;
      created_at: string;
    }>;
  };
  who_accepted: {
    owner_person_id: string | null;
    owner_name: string | null;
    assignments: Array<{
      assignment_id: string;
      person_id: string;
      display_name: string | null;
      role: string | null;
      status: string;
      offered_at: string;
      accepted_at: string | null;
    }>;
    gentle_news_companion: {
      person_id: string | null;
      display_name: string | null;
      offer_status: CircleOfferStatus | null;
      offered_at: string | null;
      accepted_at: string | null;
      with_maa_at: string | null;
    } | null;
  };
  deliveries: AfterReportDeliveryItem[];
  timings: {
    incident_created_at: string;
    first_offer_at: string | null;
    accepted_at: string | null;
    hurt_marked_at: string | null;
    circle_with_maa_at: string | null;
    maa_call_queued_at: string | null;
    first_heard_at: string | null;
    closed_at: string;
    accept_latency_s: number | null;
    resolution_duration_s: number | null;
  };
  zapier_z3: {
    status: ZapierZ3Status;
    attempted_at: string | null;
    http_status: number | null;
  };
}

export interface AfterReportRow {
  id: string;
  family_id: string;
  incident_id: string;
  closed_at: string;
  report_json: AfterReportDto;
  zapier_z3_status: ZapierZ3Status;
  zapier_z3_attempted_at: string | null;
  zapier_z3_http_status: number | null;
  created_at: string;
  updated_at: string;
}

export interface ZapierZ3Payload {
  schema: "sahaj.zapier.z3.v1";
  event: "core2.after_report.closed";
  family_id: string;
  incident_id: string;
  closed_at: string;
  summary_line: string;
  accepted_by_name: string | null;
  accepted_at: string | null;
  deliveries_count: number;
  heard_count: number;
  resolution_duration_s: number | null;
  report: AfterReportDto | null;
}

export interface PublicGentleNewsDto {
  id: string;
  family_id: string;
  incident_id: string;
  subject_person_id: string;
  parent_person_id: string;
  status: GentleNewsStatus;
  calm_summary: string;
  voice_post_id: string | null;
  circle_person_id: string | null;
  circle_display_name: string | null;
  circle_offer_status: CircleOfferStatus;
  circle_offered_at: string | null;
  circle_accepted_at: string | null;
  circle_with_maa_at: string | null;
  maa_call_due_at: string;
  remaining_ms: number;
  maa_call_queued_at: string | null;
  maa_questions: MaaQuestionEntry[];
  maa_notified_via_push: false;
  created_at: string;
  updated_at: string;
}

export interface HeardStatusDto {
  delivery_id: string;
  message_kind: HeardMessageKind;
  heard_verified: boolean;
  heard_at: string | null;
  channel: HeardChannel | null;
  evidence_type: HeardEvidenceType | null;
  badge_label: string;
}

export interface RecordHeardInput {
  familyId: string;
  messageKind: HeardMessageKind;
  deliveryId: string;
  reassuranceId: string | null;
  voicePostId: string | null;
  outboxId: string | null;
  recipientPersonId: string;
  channel: HeardChannel;
  evidenceType: HeardEvidenceType;
  deviceId: string | null;
  callSid: string | null;
  clipDurationS: number;
  playedDurationS: number | null;
  dtmfDigit: string | null;
  rawEventId: string;
  heardAt: string;
}

export interface TwilioOutboxLookup {
  family_id: string;
  outbox_id: string | null;
  message_kind: HeardMessageKind;
  delivery_id: string;
  reassurance_id: string | null;
  voice_post_id: string | null;
  recipient_person_id: string;
  clip_duration_s: number | null;
}

export interface Core2NewsRepository {
  getIncident(familyId: string, incidentId: string): Promise<IncidentSummaryRow | null>;
  closeIncident(familyId: string, incidentId: string): Promise<IncidentSummaryRow>;
  getPerson(familyId: string, personId: string): Promise<Core2Person | null>;
  listAssignmentsForIncident(familyId: string, incidentId: string): Promise<AssignmentSummaryRow[]>;
  listActiveCircleCompanions(
    familyId: string,
    excludedPersonIds: readonly string[],
  ): Promise<CircleCompanionCandidate[]>;
  getVoicePost(familyId: string, voicePostId: string): Promise<VoicePostDeliveryRow | null>;
  getGentleNewsByIncident(familyId: string, incidentId: string): Promise<GentleNewsRow | null>;
  findLatestOpenGentleNewsForParent(
    familyId: string,
    parentPersonId?: string,
  ): Promise<GentleNewsRow | null>;
  insertGentleNews(input: {
    familyId: string;
    incidentId: string;
    subjectPersonId: string;
    parentPersonId: string;
    markedByPersonId: string;
    calmSummary: string;
    voicePostId: string | null;
    circlePersonId: string | null;
    circleOfferStatus: CircleOfferStatus;
    circleOfferedAt: string | null;
    maaCallDueAt: string;
    rawEventId: string;
    nowIso: string;
  }): Promise<GentleNewsRow>;
  updateGentleNewsCas(
    familyId: string,
    incidentId: string,
    expectedVersion: number,
    patch: Partial<{
      status: GentleNewsStatus;
      circle_person_id: string | null;
      circle_offer_status: CircleOfferStatus;
      tried_circle_person_ids: string[];
      circle_offered_at: string | null;
      circle_accepted_at: string | null;
      circle_with_maa_at: string | null;
      maa_call_due_at: string;
      maa_call_outbox_id: string | null;
      maa_call_queued_at: string | null;
      maa_questions: MaaQuestionEntry[];
    }>,
    nowIso: string,
  ): Promise<GentleNewsRow | null>;
  listDueGentleNews(nowIso: string, limit: number): Promise<GentleNewsRow[]>;
  listFamilyTimelineForReport(familyId: string, incidentId: string): Promise<TimelineSummaryRow[]>;
  listDeliveriesForReport(
    familyId: string,
    incidentId: string,
    subjectPersonId: string,
    parentPersonId: string,
    sinceIso: string,
    untilIso: string,
  ): Promise<{
    reassurances: ReassuranceDeliveryRow[];
    voicePosts: VoicePostDeliveryRow[];
  }>;
  listHeardReceiptsByDeliveries(
    familyId: string,
    deliveryIds: readonly string[],
  ): Promise<HeardReceiptRow[]>;
  getHeardReceiptByDelivery(
    familyId: string,
    deliveryId: string,
    messageKind?: HeardMessageKind,
  ): Promise<HeardReceiptRow | null>;
  findReassurance(familyId: string, reassuranceId: string): Promise<ReassuranceDeliveryRow | null>;
  resolveTwilioCallContext(
    callSid: string,
    hintFamilyId?: string,
  ): Promise<TwilioOutboxLookup | null>;
  recordHeardReceipt(input: RecordHeardInput): Promise<{
    receipt: HeardReceiptRow;
    alreadyRecorded: boolean;
  }>;
  getAfterReport(familyId: string, incidentId: string): Promise<AfterReportRow | null>;
  saveAfterReport(input: {
    familyId: string;
    incidentId: string;
    closedAt: string;
    reportJson: AfterReportDto;
    zapierStatus: ZapierZ3Status;
    zapierAttemptedAt: string | null;
    zapierHttpStatus: number | null;
    nowIso: string;
  }): Promise<AfterReportRow>;
  updateAfterReportZapierStatus(
    familyId: string,
    incidentId: string,
    status: ZapierZ3Status,
    attemptedAt: string | null,
    httpStatus: number | null,
    nowIso: string,
  ): Promise<void>;
  getLatestRawEventId?(familyId: string): Promise<string | null>;
}

export interface ZapierDispatcher {
  postZ3(
    hookUrl: string,
    payload: ZapierZ3Payload,
    timeoutMs: number,
  ): Promise<{ ok: boolean; status: number | null }>;
}

export interface Core2NewsDeps {
  core2: Core2Deps;
  newsRepo: Core2NewsRepository;
  maaRepo: MaaRepo;
  replayGuard?: ReplayGuard;
  zapier?: ZapierDispatcher;
  timelinePublicKeys?: ReadonlyMap<string, TimelineKey>;
  twilioPublicBaseUrl?: string;
}

export const BADGE_UNCONFIRMED_HI = "Bheja gaya — sunna confirm nahi";

/** Format a verified heard timestamp into Maa ne suna ✓ HH:MM (or fallback when unverified). */
export function formatHeardBadge(
  heardAtIso: string | null | undefined,
  timezone = "Asia/Kolkata",
): string {
  if (!heardAtIso) return BADGE_UNCONFIRMED_HI;
  const parsed = new Date(heardAtIso);
  if (Number.isNaN(parsed.getTime())) return BADGE_UNCONFIRMED_HI;
  try {
    const formatted = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed);
    return `Maa ne suna ✓ ${formatted}`;
  } catch {
    const utc = parsed.toISOString().slice(11, 16);
    return `Maa ne suna ✓ ${utc}`;
  }
}

export type ActorLike = Core2Actor;
export type DispatchLike = Core2DispatchPort;
export type GateLike = Core2GatePort;
export type TimelineLike = Core2TimelinePort;
export type Core2RepoLike = Core2Repository;
