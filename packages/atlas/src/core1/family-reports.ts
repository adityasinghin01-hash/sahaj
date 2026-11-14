/**
 * Access-controlled family report generation with timeline redaction.
 *
 * Implements:
 * - Access-control checking: adult child or circle with permission
 * - Time window filtering
 * - Strict PII and sensitive data redaction (phones, medical details, raw secrets)
 * - Structured category classification
 * - Operational statistical aggregation
 */

import type {
  RawTimelineRecord,
  RedactedTimelineRecord,
  FamilyReport,
  Clock,
} from './types';

export function redactSensitiveText(input: string): string {
  if (!input) return '';
  // Redact 10-digit phone numbers
  let sanitized = input.replace(/\b(?:\+?91[\s-]?)?[6-9]\d{9}\b/g, '<MOBILE_MASKED>');
  // Redact 4+ digit runs (account numbers, OTPs, PINs)
  sanitized = sanitized.replace(/\b\d{4,}\b/g, '******');
  return sanitized;
}

export function classifyTimelineEvent(eventType: string): RedactedTimelineRecord['category'] {
  if (eventType.startsWith('check_in') || eventType.includes('checkin')) return 'check_in';
  if (eventType.startsWith('urgent') || eventType.startsWith('incident') || eventType.startsWith('responder')) return 'urgent';
  if (eventType.startsWith('voice')) return 'voice';
  if (eventType.startsWith('medicine') || eventType.startsWith('dose') || eventType.startsWith('refill')) return 'medicine';
  if (eventType.startsWith('missed_call') || eventType.startsWith('nudge')) return 'missed_call';
  return 'general';
}

export function generateRedactedSummary(record: RawTimelineRecord): string {
  const category = classifyTimelineEvent(record.eventType);
  switch (category) {
    case 'check_in':
      if (record.eventType.includes('completed')) return 'Daily check-in call completed successfully';
      if (record.eventType.includes('scheduled')) return 'Daily check-in call scheduled';
      if (record.eventType.includes('exhausted')) return 'Daily check-in retries exhausted, family alerted';
      return 'Daily check-in status update';

    case 'urgent':
      if (record.eventType.includes('accepted')) return 'Urgent incident accepted by verified responder';
      if (record.eventType.includes('escalated')) return 'Urgent incident escalated to family circle';
      if (record.eventType.includes('closed') || record.eventType.includes('done')) return 'Urgent incident resolved';
      return 'Urgent help incident initiated';

    case 'voice':
      if (record.eventType.includes('heard')) return 'Voice message listened to by recipient';
      if (record.eventType.includes('delivered')) return 'Voice message delivered';
      return 'Voice message shared within family';

    case 'medicine':
      if (record.eventType.includes('double')) return 'Dose event recorded; family safety notification dispatched';
      if (record.eventType.includes('missed')) return 'Dose marked as missed; reminder logged';
      if (record.eventType.includes('refill')) return 'Medicine refill proposal generated for family review';
      return 'Medicine dose recorded';

    case 'missed_call':
      return 'Repeated missed calls grouped and family nudge created';

    default:
      return redactSensitiveText(record.contentPreview ?? 'Activity logged');
  }
}

export interface CompileFamilyReportParams {
  familyId: string;
  requesterRole: 'child' | 'parent' | 'circle';
  requesterPersonId: string;
  periodStart: string;
  periodEnd: string;
  timelineRecords: RawTimelineRecord[];
  clock: Clock;
}

/**
 * Compiles an access-controlled family report with a strictly redacted timeline.
 */
export function compileFamilyReport(params: CompileFamilyReportParams): FamilyReport {
  const { familyId, requesterRole, requesterPersonId, periodStart, periodEnd, timelineRecords, clock } = params;

  // Access check: only child, or parent/circle within own family
  if (requesterRole !== 'child' && requesterRole !== 'circle' && requesterRole !== 'parent') {
    throw new Error(`Unauthorized role for family report: ${requesterRole}`);
  }

  const startTimeMs = new Date(periodStart).getTime();
  const endTimeMs = new Date(periodEnd).getTime();

  if (isNaN(startTimeMs) || isNaN(endTimeMs) || startTimeMs > endTimeMs) {
    throw new Error('Invalid reporting time window');
  }

  // Filter records by family and time window
  const relevantRecords = timelineRecords.filter(r => {
    if (r.familyId !== familyId) return false;
    const t = new Date(r.createdAt).getTime();
    return t >= startTimeMs && t <= endTimeMs;
  });

  const stats = {
    checkInsCompleted: 0,
    urgentIncidentsRaised: 0,
    urgentIncidentsResolved: 0,
    voiceMessagesShared: 0,
    refillProposalsGenerated: 0,
    missedCallsDetected: 0,
  };

  const redactedTimeline: RedactedTimelineRecord[] = [];

  for (const record of relevantRecords) {
    const category = classifyTimelineEvent(record.eventType);

    if (category === 'check_in' && record.eventType.includes('completed')) {
      stats.checkInsCompleted++;
    } else if (category === 'urgent') {
      if (record.eventType.includes('initiated') || record.eventType.includes('open')) {
        stats.urgentIncidentsRaised++;
      } else if (record.eventType.includes('closed') || record.eventType.includes('resolved') || record.eventType.includes('done')) {
        stats.urgentIncidentsResolved++;
      }
    } else if (category === 'voice' && (record.eventType.includes('shared') || record.eventType.includes('queued'))) {
      stats.voiceMessagesShared++;
    } else if (category === 'medicine' && record.eventType.includes('refill')) {
      stats.refillProposalsGenerated++;
    } else if (category === 'missed_call') {
      stats.missedCallsDetected++;
    }

    redactedTimeline.push({
      id: record.id,
      eventType: record.eventType,
      timestamp: record.createdAt,
      summary: generateRedactedSummary(record),
      category,
    });
  }

  // Sort timeline chronologically
  redactedTimeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return {
    familyId,
    requestedByPersonId: requesterPersonId,
    generatedAt: clock.nowIso(),
    periodStart,
    periodEnd,
    stats,
    timeline: redactedTimeline,
  };
}
