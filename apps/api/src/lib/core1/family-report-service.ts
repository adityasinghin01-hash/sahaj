import {
  compileFamilyReport,
  redactSensitiveText,
} from '../../../../../packages/atlas/src/core1/family-reports';
import type { RawTimelineRecord } from '../../../../../packages/atlas/src/core1/types';
import { Core1CommandError } from './errors';
import { assertCommandCapability } from './capabilities';
import {
  extractIdempotencyKey,
  validateFamilyReportPayload,
  validateUuid,
} from './validation';
import {
  clockAt,
  createSupabaseCore1AuthPort,
  createSupabaseCore1TimelinePort,
  parseOptionalFamilyId,
  readCore1JsonRequest,
  toFamilyMembership,
  type Core1AuthPort,
  type Core1TimelinePort,
  type SupabaseClientLike,
} from './wiring-common';
import { toIstIso, verifyZapierReportSecret } from './zapier';
import { redactProseText } from '../core2-news/redaction';
import { serviceDatabase } from '../database';

export interface WeeklyReportDbFacts {
  calls: Array<{ id: string; status: string; createdAt: string }>;
  incidents: Array<{ id: string; state: string; severity: string; createdAt: string }>;
  refills: Array<{ id: string; status: string; createdAt: string }>;
  nudges: Array<{ id: string; kind: string; status: string; scheduledAt: string }>;
  shieldEventsCount: number;
  timelineRecords: RawTimelineRecord[];
}

export interface FamilyReportStore {
  familyExists(familyId: string): Promise<boolean>;
  loadWeeklyFacts(familyId: string, periodStart: string, periodEnd: string): Promise<WeeklyReportDbFacts>;
  /** Display name of the family's parent (Z2 `parent_name`). Optional; falls back to "Maa". */
  getParentDisplayName?(familyId: string): Promise<string | null>;
}

export interface FamilyReportServiceDeps {
  auth: Core1AuthPort;
  store: FamilyReportStore;
  timeline: Core1TimelinePort;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export function createSupabaseFamilyReportStore(db: SupabaseClientLike): FamilyReportStore {
  return {
    async familyExists(familyId) {
      const { data, error } = await db
        .from('families')
        .select('id')
        .eq('id', familyId)
        .maybeSingle();
      if (error) throw new Core1CommandError('family_lookup_failed', 503);
      return Boolean(data);
    },

    async getParentDisplayName(familyId) {
      const { data, error } = await db
        .from('people')
        .select('display_name')
        .eq('family_id', familyId)
        .eq('role', 'parent')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      const raw = (data as { display_name?: unknown }).display_name;
      return typeof raw === 'string' ? raw : null;
    },

    async loadWeeklyFacts(familyId, periodStart, periodEnd) {
      const [callsRes, incidentsRes, refillArRes, nudgesRes, shieldRes, timelineRes] = await Promise.all([
        db
          .from('calls')
          .select('id,status,created_at')
          .eq('family_id', familyId)
          .gte('created_at', periodStart)
          .lte('created_at', periodEnd),
        db
          .from('incidents')
          .select('id,state,severity,created_at')
          .eq('family_id', familyId)
          .gte('created_at', periodStart)
          .lte('created_at', periodEnd),
        db
          .from('action_requests')
          .select('id,status,created_at')
          .eq('family_id', familyId)
          .eq('action', 'medicine_refill')
          .gte('created_at', periodStart)
          .lte('created_at', periodEnd),
        db
          .from('nudges')
          .select('id,kind,status,scheduled_at')
          .eq('family_id', familyId)
          .gte('scheduled_at', periodStart)
          .lte('scheduled_at', periodEnd),
        db
          .from('shield_events')
          .select('id', { count: 'exact', head: true })
          .eq('family_id', familyId)
          .gte('created_at', periodStart)
          .lte('created_at', periodEnd),
        db
          .from('timeline_events')
          .select('id,family_id,event_type,human_line,created_at')
          .eq('family_id', familyId)
          .gte('created_at', periodStart)
          .lte('created_at', periodEnd)
          .order('created_at', { ascending: true }),
      ]);

      if (
        callsRes.error ||
        incidentsRes.error ||
        refillArRes.error ||
        nudgesRes.error ||
        shieldRes.error ||
        timelineRes.error
      ) {
        throw new Core1CommandError('report_query_failed', 503);
      }

      const calls = ((callsRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        status: String(r.status),
        createdAt: String(r.created_at),
      }));

      const incidents = ((incidentsRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        state: String(r.state),
        severity: String(r.severity),
        createdAt: String(r.created_at),
      }));

      const refills = ((refillArRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        status: String(r.status),
        createdAt: String(r.created_at),
      }));

      const nudges = ((nudgesRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        status: String(r.status),
        scheduledAt: String(r.scheduled_at),
      }));

      const timelineRecords: RawTimelineRecord[] = (
        (timelineRes.data ?? []) as Array<Record<string, unknown>>
      ).map((r) => ({
        id: String(r.id),
        familyId: String(r.family_id),
        source: 'timeline',
        eventType: String(r.event_type),
        createdAt: String(r.created_at),
        contentPreview: typeof r.human_line === 'string' ? r.human_line : undefined,
      }));

      return {
        calls,
        incidents,
        refills,
        nudges,
        shieldEventsCount: typeof shieldRes.count === 'number' ? shieldRes.count : 0,
        timelineRecords,
      };
    },
  };
}

function buildWeeklyReportJson(params: {
  familyId: string;
  requesterRole: 'child' | 'parent' | 'circle';
  requesterPersonId: string;
  periodStart: string;
  periodEnd: string;
  facts: WeeklyReportDbFacts;
  nowDate: Date;
}) {
  const clock = clockAt(params.nowDate);
  const domainReport = compileFamilyReport({
    familyId: params.familyId,
    requesterRole: params.requesterRole,
    requesterPersonId: params.requesterPersonId,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    timelineRecords: params.facts.timelineRecords,
    clock,
  });

  const redactedTimeline = domainReport.timeline.map((item) => ({
    ...item,
    summary: redactSensitiveText(item.summary),
  }));

  const checkInsCompleted = params.facts.calls.filter((c) => c.status === 'completed').length;
  const incidentsResolved = params.facts.incidents.filter(
    (i) => i.state === 'closed' || i.state === 'done',
  ).length;

  const summaryLines = redactedTimeline.map((item) => item.summary);
  if (summaryLines.length === 0) {
    summaryLines.push(
      redactSensitiveText(
        `Weekly summary: ${params.facts.calls.length} check-ins (${checkInsCompleted} completed), ${params.facts.incidents.length} incidents, ${params.facts.refills.length} refills, ${params.facts.nudges.length} nudges, ${params.facts.shieldEventsCount} Shield events.`,
      ),
    );
  }

  return {
    schema: 'sahaj.zapier.z2.v1' as const,
    familyId: params.familyId,
    requestedByPersonId: params.requesterPersonId,
    periodStart: params.periodStart,
    periodEnd: params.periodEnd,
    generatedAt: domainReport.generatedAt,
    totalEvents: redactedTimeline.length,
    counts: {
      checkIns: params.facts.calls.length,
      checkInsCompleted,
      incidents: params.facts.incidents.length,
      incidentsResolved,
      refills: params.facts.refills.length,
      nudges: params.facts.nudges.length,
      shieldEvents: params.facts.shieldEventsCount,
    },
    summaryLines,
    timeline: redactedTimeline,
    redacted: true as const,
  };
}

export interface ZapierZ2ReportFields {
  week_start: string;
  week_end: string;
  parent_name: string;
  checkin_summary: string;
  mood_summary: string;
  medicine_summary: string;
  errand_summary: string;
  alert_summary: string;
  weekly_summary: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Short, redacted prose: no phone numbers, OTP-like digit runs, or line breaks. */
function shortSafe(text: string, max = 160): string {
  const cleaned = redactProseText(text.replace(/\s+/g, ' ').trim());
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

/** Collects `label: value` notes the check-in service writes into timeline human lines. */
function collectCheckInNotes(records: RawTimelineRecord[], label: 'mood' | 'medicines'): string[] {
  const re = new RegExp(`${label}:\\s*([A-Za-z][A-Za-z '-]{0,30})`, 'i');
  const out: string[] = [];
  for (const r of records) {
    const m = r.contentPreview ? re.exec(r.contentPreview) : null;
    if (m) out.push(m[1].trim().toLowerCase());
  }
  return out;
}

/**
 * Z2 template fields (Google Docs placeholders). Every value is a plain short string;
 * week bounds are full timestamps with the Asia/Kolkata offset.
 */
export function buildZapierZ2Fields(params: {
  periodStart: string;
  periodEnd: string;
  parentName: string | null;
  facts: WeeklyReportDbFacts;
}): ZapierZ2ReportFields {
  const { facts } = params;
  const parentName = shortSafe(params.parentName?.trim() || 'Maa', 60).replace(/<PHONE>|\*{6}/g, '').trim() || 'Maa';

  const totalCalls = facts.calls.length;
  const completedCalls = facts.calls.filter((c) => c.status === 'completed').length;
  const checkin = totalCalls === 0
    ? 'No check-in calls this week.'
    : `${completedCalls} of ${plural(totalCalls, 'check-in call')} completed.`;

  const moods = collectCheckInNotes(facts.timelineRecords, 'mood');
  const distinctMoods = [...new Set(moods)].slice(0, 3);
  const mood = moods.length === 0
    ? 'No mood noted this week.'
    : `Mood noted on ${plural(moods.length, 'check-in')}: ${distinctMoods.join(', ')}.`;

  const meds = collectCheckInNotes(facts.timelineRecords, 'medicines');
  const medicine = meds.length === 0
    ? 'No medicine updates noted on check-ins this week.'
    : `Medicines discussed on ${plural(meds.length, 'check-in')}: ${[...new Set(meds)].slice(0, 3).join(', ')}.`;

  const refillsDone = facts.refills.filter((r) => r.status === 'executed').length;
  const refillsPending = facts.refills.filter((r) => r.status === 'pending' || r.status === 'approved').length;
  const errand = facts.refills.length === 0
    ? 'No errands this week.'
    : `${plural(facts.refills.length, 'medicine refill')}: ${refillsDone} completed, ${refillsPending} in progress.`;

  const urgent = facts.incidents.length;
  const resolved = facts.incidents.filter((i) => i.state === 'closed' || i.state === 'done').length;
  const alertParts = [
    urgent === 0 ? 'No urgent alerts' : `${plural(urgent, 'urgent alert')} (${resolved} resolved)`,
    plural(facts.nudges.length, 'missed-call nudge'),
    plural(facts.shieldEventsCount, 'scam warning'),
  ];
  const alert = `${alertParts.join(', ')}.`;

  const weekly = urgent === 0
    ? `A calm week for ${parentName}: ${checkin.toLowerCase().replace(/\.$/, '')}.`
    : `${parentName} had ${plural(urgent, 'urgent alert')} this week; ${checkin.toLowerCase().replace(/\.$/, '')}.`;

  return {
    week_start: toIstIso(params.periodStart) ?? params.periodStart,
    week_end: toIstIso(params.periodEnd) ?? params.periodEnd,
    parent_name: parentName,
    checkin_summary: shortSafe(checkin),
    mood_summary: shortSafe(mood),
    medicine_summary: shortSafe(medicine),
    errand_summary: shortSafe(errand),
    alert_summary: shortSafe(alert),
    weekly_summary: shortSafe(weekly, 240),
  };
}

/**
 * POST /api/core1/family-report:
 * Compiles redacted weekly report from real database rows (`calls`, `incidents`, `action_requests`/refills,
 * `nudges`, `shield_events`, `timeline_events`) for adult child (`child` role, e.g., Riya).
 */
export async function executeFamilyReportCommand(
  request: Request,
  deps: FamilyReportServiceDeps,
): Promise<Response> {
  try {
    const body = await readCore1JsonRequest(request);
    const idempotencyKey = extractIdempotencyKey(request, body);
    const requestedFamilyId = parseOptionalFamilyId(request, body);

    const sanitized = { ...body };
    delete sanitized.familyId;
    delete sanitized.family_id;
    delete sanitized.idempotencyKey;
    delete sanitized.idempotency_key;

    const payload = validateFamilyReportPayload(sanitized);
    const actor = await deps.auth.authenticate(request, requestedFamilyId);
    assertCommandCapability('family_report', toFamilyMembership(actor), null);

    const nowDate = (deps.now ?? (() => new Date()))();
    const facts = await deps.store.loadWeeklyFacts(
      actor.familyId,
      payload.periodStart,
      payload.periodEnd,
    );

    const report = buildWeeklyReportJson({
      familyId: actor.familyId,
      requesterRole: actor.role,
      requesterPersonId: actor.personId,
      periodStart: payload.periodStart,
      periodEnd: payload.periodEnd,
      facts,
      nowDate,
    });

    const tl = await deps.timeline.append({
      familyId: actor.familyId,
      eventType: 'core1.family_report.generated',
      entityId: actor.personId,
      humanLine: `Weekly redacted family report generated (${report.counts.checkIns} check-ins, ${report.counts.refills} refills, ${report.counts.nudges} nudges)`,
      payload: {
        periodStart: payload.periodStart,
        periodEnd: payload.periodEnd,
        counts: report.counts,
      },
      dedupeKey: `family_report:${actor.familyId}:${idempotencyKey}`,
      occurredAt: nowDate.toISOString(),
    });

    return Response.json(
      {
        status: 'ready',
        commandType: 'family_report',
        timelineSequence: tl.sequence,
        idempotencyKey,
        report,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Core1CommandError) {
      return Response.json({ error: error.code }, { status: error.status });
    }
    return Response.json({ error: 'internal_command_error' }, { status: 500 });
  }
}

/**
 * GET /api/core1/family-report/weekly:
 * Zapier Z2 scheduled digest endpoint protected by `x-sahaj-zap-secret` === `ZAPIER_REPORT_SECRET`.
 */
export async function executeWeeklyFamilyReportZapierGet(
  request: Request,
  deps: Pick<FamilyReportServiceDeps, 'store' | 'env' | 'now'>,
): Promise<Response> {
  const authCheck = verifyZapierReportSecret(request, deps.env);
  if (!authCheck.ok) {
    return Response.json({ error: authCheck.code }, { status: authCheck.status });
  }

  try {
    const url = new URL(request.url);
    const familyId = validateUuid(url.searchParams.get('familyId'), 'familyId');

    const nowDate = (deps.now ?? (() => new Date()))();
    const rawEnd = url.searchParams.get('periodEnd');
    const rawStart = url.searchParams.get('periodStart');

    const endMs = rawEnd ? Date.parse(rawEnd) : nowDate.getTime();
    if (!Number.isFinite(endMs)) {
      throw new Core1CommandError('invalid_period_end', 400);
    }
    const startMs = rawStart ? Date.parse(rawStart) : endMs - 7 * 24 * 60 * 60 * 1000;
    if (!Number.isFinite(startMs) || startMs > endMs) {
      throw new Core1CommandError('invalid_period_start', 400);
    }

    const periodStart = new Date(startMs).toISOString();
    const periodEnd = new Date(endMs).toISOString();

    const exists = await deps.store.familyExists(familyId);
    if (!exists) {
      return Response.json({ error: 'family_not_found' }, { status: 404 });
    }

    const facts = await deps.store.loadWeeklyFacts(familyId, periodStart, periodEnd);
    const report = buildWeeklyReportJson({
      familyId,
      requesterRole: 'child',
      requesterPersonId: familyId,
      periodStart,
      periodEnd,
      facts,
      nowDate,
    });
    const parentName = deps.store.getParentDisplayName
      ? await deps.store.getParentDisplayName(familyId).catch(() => null)
      : null;
    const z2Fields = buildZapierZ2Fields({ periodStart, periodEnd, parentName, facts });

    // Nine top-level template fields for the Z2 Docs step, plus the earlier report keys.
    return Response.json({ ...z2Fields, ...report }, { status: 200 });
  } catch (error) {
    if (error instanceof Core1CommandError) {
      return Response.json({ error: error.code }, { status: error.status });
    }
    return Response.json({ error: 'internal_command_error' }, { status: 500 });
  }
}

export function createProductionFamilyReportDeps(
  env: Record<string, string | undefined> = process.env,
): FamilyReportServiceDeps {
  const db = serviceDatabase();
  return {
    auth: createSupabaseCore1AuthPort(db),
    store: createSupabaseFamilyReportStore(db),
    timeline: createSupabaseCore1TimelinePort(
      db,
      env.TIMELINE_SIGNING_PRIVATE_KEY ?? env.SIGNING_PRIVATE_KEY,
      env.TIMELINE_SIGNING_KEY_ID ?? env.SIGNING_KEY_ID ?? 'core1-default',
    ),
    env,
  };
}
