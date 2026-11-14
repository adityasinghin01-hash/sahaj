import type { SupabaseClient } from '@supabase/supabase-js';
import { Core1CommandError, isValidUuid } from '@/lib/core1';
import { sanitizeSummaryText } from './service';
import type {
  AssignmentState,
  CheckInCallState,
  CheckInFeedItem,
  CheckInScheduleSummary,
  Core1FeedReadRepository,
  IncidentAssignmentItem,
  IncidentFeedItem,
  IncidentSeverity,
  IncidentState,
  MissedCallNudgeItem,
  RefillApprovalItem,
  RefillFeedItem,
  RefillState,
  VoiceFeedItem,
  VoiceState,
} from './types';

function throwDbError(): never {
  throw new Core1CommandError('database_query_error', 500);
}

async function loadDisplayNameMap(
  client: SupabaseClient,
  familyId: string,
  personIds: Iterable<string>
): Promise<Map<string, string>> {
  const unique = [...new Set([...personIds].filter((id) => isValidUuid(id)))];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;

  const { data, error } = await client
    .from('people')
    .select('id, display_name')
    .eq('family_id', familyId)
    .in('id', unique);

  if (error) throwDbError();
  for (const row of (data ?? []) as Array<{ id: string; display_name: string }>) {
    map.set(row.id, sanitizeSummaryText(row.display_name || 'Family member'));
  }
  return map;
}

function defaultCallSummary(status: CheckInCallState): string {
  switch (status) {
    case 'completed':
      return 'Check-in call completed';
    case 'connected':
      return 'Check-in call in progress';
    case 'ringing':
      return 'Calling now';
    case 'scheduled':
      return 'Check-in scheduled';
    case 'failed':
      return 'Check-in missed or unanswered';
    case 'cancelled':
      return 'Check-in cancelled';
  }
}

export function createSupabaseCore1FeedRepository(
  client: SupabaseClient
): Core1FeedReadRepository {
  return {
    async listVoicePosts(familyId, callerPersonId, limit): Promise<VoiceFeedItem[]> {
      const { data, error } = await client
        .from('voice_posts')
        .select('id, family_id, sender_id, recipient_id, reply_to, state, created_at')
        .eq('family_id', familyId)
        .or(`sender_id.eq.${callerPersonId},recipient_id.eq.${callerPersonId}`)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throwDbError();
      const rows = (data ?? []) as Array<{
        id: string;
        family_id: string;
        sender_id: string;
        recipient_id: string;
        reply_to: string | null;
        state: VoiceState;
        created_at: string;
      }>;

      if (rows.length === 0) return [];

      const personIds: string[] = [];
      const postIds: string[] = [];
      for (const r of rows) {
        personIds.push(r.sender_id, r.recipient_id);
        postIds.push(r.id);
      }

      const [names, heardRes] = await Promise.all([
        loadDisplayNameMap(client, familyId, personIds),
        client
          .from('timeline_events')
          .select('entity_id, event_type, created_at')
          .eq('family_id', familyId)
          .in('entity_id', postIds),
      ]);

      if (heardRes.error) throwDbError();
      const heardAtMap = new Map<string, string>();
      for (const ev of (heardRes.data ?? []) as Array<{
        entity_id: string | null;
        event_type: string;
        created_at: string;
      }>) {
        if (
          ev.entity_id &&
          (ev.event_type.includes('heard') || ev.event_type.includes('played'))
        ) {
          heardAtMap.set(ev.entity_id, ev.created_at);
        }
      }

      return rows.map((r) => ({
        id: r.id,
        direction: r.recipient_id === callerPersonId ? 'inbound' : 'outbound',
        from_person_id: r.sender_id,
        from_display_name: names.get(r.sender_id) ?? 'Family member',
        to_person_id: r.recipient_id,
        to_display_name: names.get(r.recipient_id) ?? 'Family member',
        state: r.state,
        created_at: r.created_at,
        duration_s: null,
        played_at: r.state === 'heard' ? (heardAtMap.get(r.id) ?? null) : null,
        reply_to: r.reply_to,
      }));
    },

    async listIncidents(familyId, limit): Promise<IncidentFeedItem[]> {
      const { data: incidentData, error: incErr } = await client
        .from('incidents')
        .select('id, family_id, person_id, owner_person_id, state, severity, promised_at, created_at')
        .eq('family_id', familyId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (incErr) throwDbError();
      const incidents = (incidentData ?? []) as Array<{
        id: string;
        family_id: string;
        person_id: string;
        owner_person_id: string | null;
        state: IncidentState;
        severity: IncidentSeverity;
        promised_at: string | null;
        created_at: string;
      }>;

      if (incidents.length === 0) return [];

      const incidentIds = incidents.map((i) => i.id);
      const { data: assignData, error: assignErr } = await client
        .from('assignments')
        .select('id, family_id, incident_id, person_id, status, offered_at, expires_at, accepted_at')
        .eq('family_id', familyId)
        .in('incident_id', incidentIds)
        .order('offered_at', { ascending: true });

      if (assignErr) throwDbError();
      const assignments = (assignData ?? []) as Array<{
        id: string;
        family_id: string;
        incident_id: string;
        person_id: string;
        status: AssignmentState;
        offered_at: string;
        expires_at: string;
        accepted_at: string | null;
      }>;

      const personIds: string[] = [];
      for (const i of incidents) {
        personIds.push(i.person_id);
        if (i.owner_person_id) personIds.push(i.owner_person_id);
      }
      for (const a of assignments) {
        personIds.push(a.person_id);
      }
      const names = await loadDisplayNameMap(client, familyId, personIds);

      const byIncident = new Map<string, IncidentAssignmentItem[]>();
      for (const a of assignments) {
        const list = byIncident.get(a.incident_id) ?? [];
        list.push({
          assignment_id: a.id,
          person_id: a.person_id,
          display_name: names.get(a.person_id) ?? 'Responder',
          state: a.status,
          offered_at: a.offered_at,
          expires_at: a.expires_at,
          accepted_at: a.accepted_at,
        });
        byIncident.set(a.incident_id, list);
      }

      return incidents.map((inc) => {
        const list = byIncident.get(inc.id) ?? [];
        const activeResponder =
          list.find((a) => a.state === 'accepted' || a.state === 'completed') ??
          [...list].reverse().find((a) => a.state === 'offered') ??
          list[list.length - 1] ??
          null;

        return {
          id: inc.id,
          subject_person_id: inc.person_id,
          subject_display_name: names.get(inc.person_id) ?? 'Family member',
          state: inc.state,
          severity: inc.severity,
          responder: activeResponder,
          assignments: list,
          promised_at: inc.promised_at,
          created_at: inc.created_at,
        };
      });
    },

    async listRefills(familyId, limit): Promise<RefillFeedItem[]> {
      const { data: reqData, error: reqErr } = await client
        .from('action_requests')
        .select(
          'id, family_id, person_id, action, status, expires_at, two_person_required, created_at, target_id, amount_minor, vendor_id, item_ids'
        )
        .eq('family_id', familyId)
        .eq('action', 'medicine_refill')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (reqErr) throwDbError();
      const requests = (reqData ?? []) as Array<{
        id: string;
        family_id: string;
        person_id: string;
        action: string;
        status: RefillState;
        expires_at: string;
        two_person_required: boolean;
        created_at: string;
        target_id: string | null;
        amount_minor: number | null;
        vendor_id: string | null;
        item_ids: string[] | null;
      }>;

      if (requests.length === 0) return [];

      const requestIds = requests.map((r) => r.id);
      const [answersRes, medsRes, vendorsRes] = await Promise.all([
        client
          .from('action_answers')
          .select('family_id, action_request_id, approver_person_id, answer, answered_at')
          .eq('family_id', familyId)
          .in('action_request_id', requestIds)
          .order('answered_at', { ascending: true }),
        client.from('medicines').select('id, label').eq('family_id', familyId),
        client.from('vendors').select('id, person_id').eq('family_id', familyId),
      ]);

      if (answersRes.error || medsRes.error || vendorsRes.error) throwDbError();

      const answers = (answersRes.data ?? []) as Array<{
        action_request_id: string;
        approver_person_id: string;
        answer: boolean;
        answered_at: string;
      }>;
      const medsMap = new Map<string, string>();
      for (const m of (medsRes.data ?? []) as Array<{ id: string; label: string }>) {
        medsMap.set(m.id, sanitizeSummaryText(m.label));
      }
      const vendorPersonMap = new Map<string, string>();
      for (const v of (vendorsRes.data ?? []) as Array<{ id: string; person_id: string }>) {
        vendorPersonMap.set(v.id, v.person_id);
      }

      const personIds: string[] = [];
      for (const r of requests) {
        personIds.push(r.person_id);
        if (r.vendor_id && vendorPersonMap.has(r.vendor_id)) {
          personIds.push(vendorPersonMap.get(r.vendor_id)!);
        }
      }
      for (const a of answers) {
        personIds.push(a.approver_person_id);
      }
      const names = await loadDisplayNameMap(client, familyId, personIds);

      const answersByReq = new Map<string, RefillApprovalItem[]>();
      for (const a of answers) {
        const list = answersByReq.get(a.action_request_id) ?? [];
        list.push({
          person_id: a.approver_person_id,
          display_name: names.get(a.approver_person_id) ?? 'Family member',
          answer: a.answer,
          answered_at: a.answered_at,
        });
        answersByReq.set(a.action_request_id, list);
      }

      return requests.map((r) => {
        const medCandidate =
          r.item_ids && r.item_ids.length > 0
            ? r.item_ids[0]
            : r.target_id && isValidUuid(r.target_id)
              ? r.target_id
              : null;
        const medicineId = medCandidate && isValidUuid(medCandidate) ? medCandidate : null;
        const vendorId = r.vendor_id && isValidUuid(r.vendor_id) ? r.vendor_id : null;
        const vendorPersonId = vendorId ? vendorPersonMap.get(vendorId) : undefined;
        const approvals = answersByReq.get(r.id) ?? [];

        return {
          id: r.id,
          person_id: r.person_id,
          person_display_name: names.get(r.person_id) ?? 'Family member',
          medicine_id: medicineId,
          medicine: (medicineId && medsMap.get(medicineId)) || 'Medicine refill',
          amount_minor: typeof r.amount_minor === 'number' ? r.amount_minor : 0,
          currency: 'INR',
          vendor_id: vendorId,
          vendor:
            (vendorPersonId && names.get(vendorPersonId)) || 'Approved chemist',
          state: r.status,
          two_person_required: r.two_person_required,
          who_approved: approvals.filter((a) => a.answer).map((a) => a.display_name),
          approvals,
          created_at: r.created_at,
          expires_at: r.expires_at,
        };
      });
    },

    async listCheckIns(familyId, restrictToPersonId, limit) {
      let schedQuery = client
        .from('schedules')
        .select('id, family_id, person_id, kind, next_at, timezone, enabled')
        .eq('family_id', familyId)
        .in('kind', ['check_in', 'daily_checkin'])
        .eq('enabled', true)
        .order('next_at', { ascending: true })
        .limit(5);

      let callsQuery = client
        .from('calls')
        .select('id, family_id, person_id, status, ai_disclosed_at, started_at, ended_at, created_at')
        .eq('family_id', familyId)
        .order('created_at', { ascending: false })
        .limit(limit);

      let nudgesQuery = client
        .from('nudges')
        .select('id, family_id, person_id, kind, scheduled_at, status')
        .eq('family_id', familyId)
        .like('kind', 'missed_call%')
        .order('scheduled_at', { ascending: false })
        .limit(limit);

      if (restrictToPersonId) {
        schedQuery = schedQuery.eq('person_id', restrictToPersonId);
        callsQuery = callsQuery.eq('person_id', restrictToPersonId);
        nudgesQuery = nudgesQuery.eq('person_id', restrictToPersonId);
      }

      const [schedRes, callsRes, nudgesRes] = await Promise.all([
        schedQuery,
        callsQuery,
        nudgesQuery,
      ]);

      if (schedRes.error || callsRes.error || nudgesRes.error) throwDbError();

      const schedules = (schedRes.data ?? []) as Array<{
        id: string;
        person_id: string;
        next_at: string;
        timezone: string;
        enabled: boolean;
      }>;
      const calls = (callsRes.data ?? []) as Array<{
        id: string;
        person_id: string;
        status: CheckInCallState;
        ai_disclosed_at: string | null;
        started_at: string | null;
        ended_at: string | null;
        created_at: string;
      }>;
      const nudges = (nudgesRes.data ?? []) as Array<{
        id: string;
        person_id: string;
        kind: string;
        scheduled_at: string;
        status: 'pending' | 'sent' | 'cancelled' | 'failed';
      }>;

      const personIds: string[] = [];
      for (const s of schedules) personIds.push(s.person_id);
      for (const c of calls) personIds.push(c.person_id);
      for (const n of nudges) personIds.push(n.person_id);

      const callIds = calls.map((c) => c.id);
      const [names, timelineRes] = await Promise.all([
        loadDisplayNameMap(client, familyId, personIds),
        callIds.length > 0
          ? client
              .from('timeline_events')
              .select('entity_id, human_line')
              .eq('family_id', familyId)
              .in('entity_id', callIds)
          : Promise.resolve({ data: [], error: null }),
      ]);

      if (timelineRes.error) throwDbError();
      const summaryByCall = new Map<string, string>();
      for (const t of (timelineRes.data ?? []) as Array<{
        entity_id: string | null;
        human_line: string;
      }>) {
        if (t.entity_id && t.human_line) {
          summaryByCall.set(t.entity_id, sanitizeSummaryText(t.human_line));
        }
      }

      const firstSchedule = schedules[0];
      const next_checkin: CheckInScheduleSummary | null = firstSchedule
        ? {
            schedule_id: firstSchedule.id,
            person_id: firstSchedule.person_id,
            person_display_name: names.get(firstSchedule.person_id) ?? 'Family member',
            scheduled_for: firstSchedule.next_at,
            timezone: firstSchedule.timezone,
            enabled: firstSchedule.enabled,
          }
        : null;

      const items: CheckInFeedItem[] = calls.map((c) => ({
        id: c.id,
        person_id: c.person_id,
        person_display_name: names.get(c.person_id) ?? 'Family member',
        scheduled_for: c.started_at ?? c.created_at,
        started_at: c.started_at,
        ended_at: c.ended_at,
        state: c.status,
        short_summary: summaryByCall.get(c.id) ?? defaultCallSummary(c.status),
        ai_disclosed: Boolean(c.ai_disclosed_at),
      }));

      const missed_call_nudges: MissedCallNudgeItem[] = nudges.map((n) => ({
        id: n.id,
        person_id: n.person_id,
        person_display_name: names.get(n.person_id) ?? 'Family member',
        kind: n.kind,
        status: n.status,
        scheduled_at: n.scheduled_at,
      }));

      return { next_checkin, items, missed_call_nudges };
    },
  };
}
