export class MaaRouteError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = 'MaaRouteError';
  }
}

export const MAA_SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Type': 'application/json',
};

export interface VerifiedMaaDevice {
  deviceId: string;
  familyId: string;
  personId: string;
  displayName: string;
}

export interface MaaVoiceItem {
  id: string;
  from_person_id: string;
  from_display_name: string;
  to_person_id: string;
  to_display_name: string;
  state: 'queued' | 'sent' | 'delivered' | 'heard' | 'failed';
  created_at: string;
  duration_s: number | null;
  played_at: string | null;
  reply_to: string | null;
  media_url: string | null;
  media_expires_in: number | null;
}

export interface MaaVoiceListResponse {
  family_id: string;
  person_id: string;
  items: MaaVoiceItem[];
}

export interface MaaVoicePlayedResponse {
  ok: true;
  id: string;
  state: 'heard';
  played_at: string;
}

export interface MaaVoiceReplyResponse {
  ok: true;
  id: string;
  family_id: string;
  sender_id: string;
  recipient_id: string;
  reply_to: string | null;
  state: 'queued' | 'sent' | 'delivered' | 'heard' | 'failed';
  created_at: string;
  deduped: boolean;
}

export interface MaaUrgentResponder {
  person_id: string;
  display_name: string;
  promised_at: string | null;
}

export interface MaaUrgentAssignment {
  id: string;
  assignee_person_id: string;
  assignee_display_name: string;
  state: 'offered' | 'accepted' | 'declined' | 'expired' | 'completed';
  offered_at: string;
  responded_at: string | null;
  promised_at: string | null;
}

export interface MaaUrgentStatusResponse {
  ok: true;
  id: string;
  family_id: string;
  subject_person_id: string;
  subject_display_name: string;
  state: 'open' | 'offered' | 'accepted' | 'escalated' | 'resolved' | 'cancelled';
  severity: 'routine' | 'urgent' | 'critical';
  responder: MaaUrgentResponder | null;
  assignments: MaaUrgentAssignment[];
  promised_at: string | null;
  created_at: string;
  eta_minutes: number | null;
  status_line_hi: string;
  status_line_en: string;
  deduped?: boolean;
}
