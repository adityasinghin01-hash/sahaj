import type {
  AuthPort,
  CircleRecord,
  FamilyMembership,
  FamilyRole,
} from '@/lib/core1';

export type VoiceState = 'queued' | 'sent' | 'delivered' | 'heard' | 'failed';

export interface VoiceFeedItem {
  id: string;
  direction: 'inbound' | 'outbound';
  from_person_id: string;
  from_display_name: string;
  to_person_id: string;
  to_display_name: string;
  state: VoiceState;
  created_at: string;
  duration_s: number | null;
  played_at: string | null;
  reply_to: string | null;
}

export interface VoiceFeedResponse {
  family_id: string;
  caller_person_id: string;
  items: VoiceFeedItem[];
}

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

export type AssignmentState =
  | 'offered'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'completed';

export interface IncidentAssignmentItem {
  assignment_id: string;
  person_id: string;
  display_name: string;
  state: AssignmentState;
  offered_at: string;
  expires_at: string;
  accepted_at: string | null;
}

export interface IncidentFeedItem {
  id: string;
  subject_person_id: string;
  subject_display_name: string;
  state: IncidentState;
  severity: IncidentSeverity;
  responder: IncidentAssignmentItem | null;
  assignments: IncidentAssignmentItem[];
  promised_at: string | null;
  created_at: string;
}

export interface IncidentsFeedResponse {
  family_id: string;
  items: IncidentFeedItem[];
}

export type RefillState =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'executed'
  | 'failed';

export interface RefillApprovalItem {
  person_id: string;
  display_name: string;
  answer: boolean;
  answered_at: string;
}

export interface RefillFeedItem {
  id: string;
  person_id: string;
  person_display_name: string;
  medicine_id: string | null;
  medicine: string;
  amount_minor: number;
  currency: 'INR';
  vendor_id: string | null;
  vendor: string;
  state: RefillState;
  two_person_required: boolean;
  who_approved: string[];
  approvals: RefillApprovalItem[];
  created_at: string;
  expires_at: string;
}

export interface RefillsFeedResponse {
  family_id: string;
  items: RefillFeedItem[];
}

export type CheckInCallState =
  | 'scheduled'
  | 'ringing'
  | 'connected'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CheckInScheduleSummary {
  schedule_id: string;
  person_id: string;
  person_display_name: string;
  scheduled_for: string;
  timezone: string;
  enabled: boolean;
}

export interface CheckInFeedItem {
  id: string;
  person_id: string;
  person_display_name: string;
  scheduled_for: string;
  started_at: string | null;
  ended_at: string | null;
  state: CheckInCallState;
  short_summary: string;
  ai_disclosed: boolean;
}

export interface MissedCallNudgeItem {
  id: string;
  person_id: string;
  person_display_name: string;
  kind: string;
  status: 'pending' | 'sent' | 'cancelled' | 'failed';
  scheduled_at: string;
}

export interface CheckInsFeedResponse {
  family_id: string;
  next_checkin: CheckInScheduleSummary | null;
  items: CheckInFeedItem[];
  missed_call_nudges: MissedCallNudgeItem[];
}

export interface Core1FeedAuthRepo {
  getMembership(userId: string, requestedFamilyId?: string): Promise<FamilyMembership>;
  getCircleRecord(familyId: string, personId: string): Promise<CircleRecord | null>;
}

export interface Core1FeedReadRepository {
  listVoicePosts(familyId: string, callerPersonId: string, limit: number): Promise<VoiceFeedItem[]>;
  listIncidents(familyId: string, limit: number): Promise<IncidentFeedItem[]>;
  listRefills(familyId: string, limit: number): Promise<RefillFeedItem[]>;
  listCheckIns(
    familyId: string,
    restrictToPersonId: string | undefined,
    limit: number
  ): Promise<{
    next_checkin: CheckInScheduleSummary | null;
    items: CheckInFeedItem[];
    missed_call_nudges: MissedCallNudgeItem[];
  }>;
}

export interface Core1FeedPorts {
  auth: AuthPort;
  membershipRepo: Core1FeedAuthRepo;
  feedRepo: Core1FeedReadRepository;
}

export interface AuthenticatedFeedActor {
  userId: string;
  membership: FamilyMembership;
  role: FamilyRole;
}
