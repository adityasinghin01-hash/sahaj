import { compileFamilyReport } from '../../../../../packages/atlas/src/core1/family-reports';
import type { RawTimelineRecord } from '../../../../../packages/atlas/src/core1/types';
import { bearerToken, safeTokenEquals } from '../secrets';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface WeeklyScope { familyId: string; parentId: string; requesterId: string }
export interface WeeklyStore {
  scopeIsLive(scope: WeeklyScope): Promise<boolean>;
  timeline(scope: WeeklyScope, start: string, end: string): Promise<RawTimelineRecord[]>;
}
export interface WeeklyConfig extends WeeklyScope { bearer: string }
export const WEEKLY_FIELDS = ['week_start','week_end','parent_name','checkin_summary','mood_summary','medicine_summary','errand_summary','alert_summary','weekly_summary'] as const;

/** Last completed Sunday 20:00 IST cutoff, with an explicitly half-open seven-day window. */
export function weeklyWindow(now: Date) {
  if (!Number.isFinite(now.getTime())) throw new Error('invalid_clock');
  const offset = 330 * 60_000, day = 86_400_000;
  const local = new Date(now.getTime() + offset);
  let end = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 20) - offset - local.getUTCDay() * day;
  if (end > now.getTime()) end -= 7 * day;
  return { start: new Date(end - 7 * day).toISOString(), end: new Date(end).toISOString() };
}

export async function handleWeekly(request: Request, config: WeeklyConfig | undefined, store: () => WeeklyStore, now = new Date()): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control':'no-store', 'Vary':'Authorization' } });
  if (!config || config.bearer.length < 32 || ![config.familyId,config.parentId,config.requesterId].every(id => UUID.test(id))) return json({error:'not_configured'},503);
  if (!safeTokenEquals(bearerToken(request),config.bearer)) return json({error:'unauthorized'},401);
  if (new URL(request.url).search) return json({error:'query_parameters_not_allowed'},400);
  try {
    const db = store();
    if (!await db.scopeIsLive(config)) return json({error:'scope_unavailable'},403);
    const period = weeklyWindow(now), records = await db.timeline(config,period.start,period.end);
    if (records.length > 1000) return json({error:'report_limit_exceeded'},503);
    // Reject repository scope/window violations instead of silently returning a partial report.
    if (records.some(r => r.familyId !== config.familyId || !Number.isFinite(Date.parse(r.createdAt)) || Date.parse(r.createdAt) < Date.parse(period.start) || Date.parse(r.createdAt) >= Date.parse(period.end))) return json({error:'report_scope_invalid'},503);
    // Reuse Phase 4's compiler, but never export its free-text/general timeline or metadata.
    const report = compileFamilyReport({familyId:config.familyId,requesterRole:'child',requesterPersonId:config.requesterId,
      periodStart:period.start,periodEnd:period.end,timelineRecords:records,clock:{now:()=>new Date(now),nowIso:()=>now.toISOString()}});
    const stats = report.stats;
    const errands = records.filter(r => ['errand.approved','errand.denied','errand.completed'].includes(r.eventType)).length;
    return json({week_start:period.start,week_end:period.end,parent_name:'Parent',
      checkin_summary:`Completed check-ins: ${stats.checkInsCompleted}.`,
      mood_summary:'Mood trend not available from verified aggregate events.',
      medicine_summary:`Refill-related records: ${stats.refillProposalsGenerated}. No adherence inference.`,
      errand_summary:`Signed errand decision/completion records: ${errands}.`,
      alert_summary:`Urgent incidents raised: ${stats.urgentIncidentsRaised}; resolved: ${stats.urgentIncidentsResolved}.`,
      weekly_summary:records.length ? `Recorded activities: ${records.length}; shared voice records: ${stats.voiceMessagesShared}.` : 'No recorded activities in this reporting period.'});
  } catch { return json({error:'report_unavailable'},503); }
}
