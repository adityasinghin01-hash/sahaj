import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { redactSensitiveText } from '../../../../../packages/atlas/src/core1/family-reports';
import { Core1CommandError } from '@/lib/core1/errors';
import { readCore1JsonRequest, stableCore1Uuid } from '@/lib/core1/wiring-common';
import { isValidUuid, validateUuid } from '@/lib/core1/validation';
import { bearerToken, safeTokenEquals } from '@/lib/secrets';
import { getDemoTimerScale, scaleDurationMs } from '@/lib/core2/security';
import { defaultSendExpoPush } from '@/lib/core1/voice-notify';
import {
  BOTH_FREE_NUDGE_BODY,
  BOTH_FREE_NUDGE_TITLE,
  MATCHER_TICK_INTERVAL_MS,
  evaluateFamilyPairMatch,
  getLocalDayBoundsUtc,
  isFreeWindowActiveAt,
  isQuietHoursAt,
  isValidIanaTimeZone,
  resolveSafeTimeZone,
} from './matcher';
import {
  formatHindiWindowLabel,
  formatMinutesToHHMM,
  parseHindiFreeTime,
} from './parser';
import { getLocalTimeParts } from '../../../../../packages/atlas/src/core1/check-in';
import type {
  Core1MatcherDeps,
  FreeWindowRecord,
  PersonScheduleContext,
} from './types';

const RESPONSE_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
} as const;

function jsonResp(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

function handleError(error: unknown): Response {
  if (error instanceof Core1CommandError) {
    return jsonResp({ error: error.code, message: error.message }, error.status);
  }
  return jsonResp({ error: 'internal_matcher_error' }, 500);
}

function extractRequestedFamilyId(
  request: Request,
  body?: Record<string, unknown>,
): string | undefined {
  const url = new URL(request.url);
  const queryFam =
    url.searchParams.get('familyId')?.trim() ||
    url.searchParams.get('family_id')?.trim() ||
    undefined;
  const headerFam =
    request.headers.get('x-sahaj-family-id')?.trim() ||
    request.headers.get('x-family-id')?.trim() ||
    undefined;
  const bodyFamRaw = body?.familyId ?? body?.family_id;
  const bodyFam =
    typeof bodyFamRaw === 'string' && bodyFamRaw.trim() ? bodyFamRaw.trim() : undefined;

  const candidates = [queryFam, headerFam, bodyFam].filter((v): v is string => Boolean(v));
  if (candidates.length === 0) return undefined;
  if (new Set(candidates).size > 1) {
    throw new Core1CommandError('conflicting_family_id', 400);
  }
  return validateUuid(candidates[0], 'family_id');
}

function parseHHMMToMinute(raw: unknown, field: string, allow2400 = false): number {
  if (typeof raw !== 'string') {
    throw new Core1CommandError(`invalid_${field}`, 400);
  }
  const clean = raw.trim();
  const match = clean.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Core1CommandError(`invalid_${field}`, 400);
  }
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (allow2400 && h === 24 && m === 0) {
    return 1440;
  }
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Core1CommandError(`invalid_${field}`, 400);
  }
  return h * 60 + m;
}

function serializeWindow(
  w: FreeWindowRecord,
  person: PersonScheduleContext | undefined,
  now: Date,
) {
  return {
    id: w.id,
    person_id: w.personId,
    person_display_name: redactSensitiveText(person?.displayName ?? 'Family member'),
    person_role: person?.role ?? 'child',
    timezone: w.timezone,
    start_time: formatMinutesToHHMM(w.startMinute),
    end_time: formatMinutesToHHMM(w.endMinute),
    start_minute: w.startMinute,
    end_minute: w.endMinute,
    kind: w.kind,
    days_of_week: w.daysOfWeek,
    expires_at: w.expiresAt,
    source: w.source,
    label: redactSensitiveText(w.label || formatHindiWindowLabel(w.startMinute, w.endMinute)),
    active_now: isFreeWindowActiveAt(w, now),
    created_at: w.createdAt,
  };
}

const POST_ALLOWED_KEYS = new Set([
  'familyId',
  'family_id',
  'mode',
  'duration_minutes',
  'durationMinutes',
  'start_time',
  'startTime',
  'end_time',
  'endTime',
  'timezone',
  'days_of_week',
  'daysOfWeek',
  'label',
  'said',
]);

export async function handleFreeTimesGet(
  request: Request,
  deps: Core1MatcherDeps,
): Promise<Response> {
  try {
    const requestedFamilyId = extractRequestedFamilyId(request);
    const actor = await deps.auth.authenticate(request, requestedFamilyId);
    if (actor.role !== 'child' && actor.role !== 'parent') {
      throw new Core1CommandError('forbidden_role_for_free_times', 403);
    }

    const now = (deps.now ?? (() => new Date()))();
    const [people, allWindows] = await Promise.all([
      deps.store.listFamilyPeople(actor.familyId),
      actor.role === 'child'
        ? deps.store.listActiveWindowsForFamily(actor.familyId)
        : deps.store.listActiveWindowsForPerson(actor.familyId, actor.personId),
    ]);

    const peopleMap = new Map(people.map((p) => [p.id, p]));
    const activeNonExpired = allWindows.filter(
      (w) => w.kind === 'recurring' || (w.expiresAt !== null && Date.parse(w.expiresAt) > now.getTime()),
    );
    const actorPerson = peopleMap.get(actor.personId);
    const ownWindows = activeNonExpired
      .filter((w) => w.personId === actor.personId)
      .map((w) => serializeWindow(w, peopleMap.get(w.personId), now));

    if (actor.role === 'parent') {
      return jsonResp({
        family_id: actor.familyId,
        person_id: actor.personId,
        timezone: actorPerson?.timezone ?? 'Asia/Kolkata',
        windows: ownWindows,
        family_windows: [],
        both_free_now: false,
        maa_free_now: activeNonExpired.some((w) => isFreeWindowActiveAt(w, now)),
        riya_free_now: false,
        maa_quiet_now: actorPerson
          ? isQuietHoursAt(actorPerson.quietWindows, actorPerson.timezone, now)
          : false,
        talked_today: false,
        nudged_today: false,
        nudge_message: BOTH_FREE_NUDGE_BODY,
        last_nudge: null,
      });
    }

    const parents = people.filter((p) => p.role === 'parent');
    const primaryParent = parents[0];
    const parentWindows = primaryParent
      ? activeNonExpired.filter((w) => w.personId === primaryParent.id)
      : [];
    const childWindows = activeNonExpired.filter((w) => w.personId === actor.personId);

    let bothFreeNow = false;
    let maaFreeNow = false;
    let riyaFreeNow = childWindows.some((w) => isFreeWindowActiveAt(w, now));
    let maaQuietNow = false;
    let talkedToday = false;
    let nudgedToday = false;
    let lastNudge: { id: string; matched_at: string; local_date: string } | null = null;

    if (primaryParent && actorPerson) {
      const bounds = getLocalDayBoundsUtc(now, primaryParent.timezone);
      const [nudgeRow, talked] = await Promise.all([
        deps.store.getMatcherNudgeForDay(actor.familyId, primaryParent.id, bounds.localDate),
        deps.store.hasTalkedToday({
          familyId: actor.familyId,
          parentPersonId: primaryParent.id,
          childPersonId: actorPerson.id,
          dayStartUtcIso: bounds.dayStartUtcIso,
          dayEndUtcIso: bounds.dayEndUtcIso,
        }),
      ]);
      const evaluation = evaluateFamilyPairMatch({
        familyId: actor.familyId,
        parent: primaryParent,
        child: actorPerson,
        parentWindows,
        childWindows,
        localDate: bounds.localDate,
        nudgedToday: Boolean(nudgeRow && nudgeRow.status === 'sent'),
        talkedToday: talked,
        now,
      });
      bothFreeNow = evaluation.bothFreeNow;
      maaFreeNow = evaluation.maaFreeNow;
      riyaFreeNow = evaluation.riyaFreeNow;
      maaQuietNow = evaluation.maaQuietNow;
      talkedToday = evaluation.talkedToday;
      nudgedToday = evaluation.nudgedToday;
      if (nudgeRow) {
        lastNudge = {
          id: nudgeRow.id,
          matched_at: nudgeRow.matchedAt,
          local_date: nudgeRow.localDate,
        };
      }
    }

    return jsonResp({
      family_id: actor.familyId,
      person_id: actor.personId,
      timezone: actorPerson?.timezone ?? 'Asia/Kolkata',
      windows: ownWindows,
      family_windows: activeNonExpired.map((w) =>
        serializeWindow(w, peopleMap.get(w.personId), now),
      ),
      both_free_now: bothFreeNow,
      maa_free_now: maaFreeNow,
      riya_free_now: riyaFreeNow,
      maa_quiet_now: maaQuietNow,
      talked_today: talkedToday,
      nudged_today: nudgedToday,
      nudge_message: BOTH_FREE_NUDGE_BODY,
      last_nudge: lastNudge,
    });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleFreeTimesPost(
  request: Request,
  deps: Core1MatcherDeps,
): Promise<Response> {
  try {
    const body = await readCore1JsonRequest(request);
    for (const key of Object.keys(body)) {
      if (!POST_ALLOWED_KEYS.has(key)) {
        throw new Core1CommandError(`unknown_field_${key}`, 400);
      }
    }

    const requestedFamilyId = extractRequestedFamilyId(request, body);
    const actor = await deps.auth.authenticate(request, requestedFamilyId);
    if (actor.role !== 'child' && actor.role !== 'parent') {
      throw new Core1CommandError('forbidden_role_for_free_times', 403);
    }

    const person = await deps.store.getPerson(actor.familyId, actor.personId);
    if (!person) {
      throw new Core1CommandError('person_not_found', 404);
    }

    const rawTz = body.timezone;
    if (rawTz !== undefined) {
      if (typeof rawTz !== 'string' || !isValidIanaTimeZone(rawTz.trim())) {
        throw new Core1CommandError('invalid_timezone', 400);
      }
    }
    const timezone = typeof rawTz === 'string' ? rawTz.trim() : resolveSafeTimeZone(person.timezone);
    const now = (deps.now ?? (() => new Date()))();
    const newId = deps.newId ?? randomUUID;

    const mode = body.mode === 'free_now' ? 'free_now' : 'recurring';
    if (body.mode !== undefined && body.mode !== 'free_now' && body.mode !== 'recurring') {
      throw new Core1CommandError('invalid_mode', 400);
    }

    if (mode === 'free_now') {
      const rawDuration = body.duration_minutes ?? body.durationMinutes ?? 30;
      if (
        typeof rawDuration !== 'number' ||
        !Number.isInteger(rawDuration) ||
        rawDuration < 5 ||
        rawDuration > 240
      ) {
        throw new Core1CommandError('invalid_duration_minutes', 400);
      }

      const localParts = getLocalTimeParts(now, timezone);
      const startMinute = localParts.hour * 60 + localParts.minute;
      const rawEnd = startMinute + rawDuration;
      const endMinute = rawEnd === 1440 ? 1440 : rawEnd % 1440;
      const expiresAt = new Date(now.getTime() + rawDuration * 60_000).toISOString();
      const label = `Free now (${rawDuration} min)`;

      const created = await deps.store.createWindow(
        {
          id: newId(),
          familyId: actor.familyId,
          personId: actor.personId,
          timezone,
          startMinute,
          endMinute: endMinute === startMinute ? Math.min(1440, startMinute + 30) : endMinute,
          kind: 'ad_hoc',
          daysOfWeek: null,
          expiresAt,
          source: 'free_now',
          label,
        },
        { deactivateSource: 'free_now' },
      );

      if (deps.timeline) {
        await deps.timeline.append({
          familyId: actor.familyId,
          eventType: 'core1.matcher.free_now_enabled',
          entityId: created.id,
          humanLine: `${redactSensitiveText(person.displayName)} marked free now for ${rawDuration} min.`,
          payload: {
            windowId: created.id,
            personId: actor.personId,
            durationMinutes: rawDuration,
            expiresAt,
          },
          dedupeKey: `matcher_free_now:${created.id}`,
          occurredAt: now.toISOString(),
        });
      }

      return jsonResp({ ok: true, window: serializeWindow(created, person, now) }, 201);
    }

    // Recurring window
    let startMinute: number;
    let endMinute: number;
    let derivedLabel = '';

    if (typeof body.said === 'string' && body.said.trim()) {
      const parsed = parseHindiFreeTime(body.said);
      if (!parsed.ok) {
        throw new Core1CommandError('unparseable_free_time_phrase', 400);
      }
      startMinute = parsed.startMinute;
      endMinute = parsed.endMinute;
      derivedLabel = parsed.label;
    } else {
      const rawStart = body.start_time ?? body.startTime;
      const rawEnd = body.end_time ?? body.endTime;
      if (
        body.start_time !== undefined &&
        body.startTime !== undefined &&
        body.start_time !== body.startTime
      ) {
        throw new Core1CommandError('conflicting_start_time', 400);
      }
      if (
        body.end_time !== undefined &&
        body.endTime !== undefined &&
        body.end_time !== body.endTime
      ) {
        throw new Core1CommandError('conflicting_end_time', 400);
      }
      startMinute = parseHHMMToMinute(rawStart, 'start_time', false);
      endMinute = parseHHMMToMinute(rawEnd, 'end_time', true);
      if (startMinute === endMinute) {
        throw new Core1CommandError('invalid_time_range', 400);
      }
      derivedLabel = formatHindiWindowLabel(startMinute, endMinute);
    }

    const rawDays = body.days_of_week ?? body.daysOfWeek;
    let daysOfWeek: number[] | null = null;
    if (rawDays !== undefined && rawDays !== null) {
      if (!Array.isArray(rawDays) || rawDays.length === 0 || rawDays.length > 7) {
        throw new Core1CommandError('invalid_days_of_week', 400);
      }
      const uniqueDays = new Set<number>();
      for (const d of rawDays) {
        if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6) {
          throw new Core1CommandError('invalid_days_of_week', 400);
        }
        uniqueDays.add(d);
      }
      daysOfWeek = [...uniqueDays].sort((a, b) => a - b);
    }

    let label = derivedLabel;
    if (body.label !== undefined) {
      if (typeof body.label !== 'string' || body.label.length > 120) {
        throw new Core1CommandError('invalid_label', 400);
      }
      const cleaned = redactSensitiveText(body.label).trim();
      if (cleaned) label = cleaned;
    }

    const created = await deps.store.createWindow({
      id: newId(),
      familyId: actor.familyId,
      personId: actor.personId,
      timezone,
      startMinute,
      endMinute,
      kind: 'recurring',
      daysOfWeek,
      expiresAt: null,
      source: 'app',
      label,
    });

    if (deps.timeline) {
      await deps.timeline.append({
        familyId: actor.familyId,
        eventType: 'core1.matcher.window_added',
        entityId: created.id,
        humanLine: `${redactSensitiveText(person.displayName)} added a free window (${formatMinutesToHHMM(startMinute)}-${formatMinutesToHHMM(endMinute)}).`,
        payload: {
          windowId: created.id,
          personId: actor.personId,
          startMinute,
          endMinute,
          timezone,
        },
        dedupeKey: `matcher_window_add:${created.id}`,
        occurredAt: now.toISOString(),
      });
    }

    return jsonResp({ ok: true, window: serializeWindow(created, person, now) }, 201);
  } catch (error) {
    return handleError(error);
  }
}

export async function handleFreeTimesDelete(
  request: Request,
  deps: Core1MatcherDeps,
  pathWindowId?: string,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    let bodyObj: Record<string, unknown> | undefined;
    if (!pathWindowId && !url.searchParams.get('id')) {
      const rawText = await request.text();
      if (rawText.trim()) {
        try {
          const parsed = JSON.parse(rawText);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            bodyObj = parsed as Record<string, unknown>;
          }
        } catch {
          throw new Core1CommandError('invalid_json_body', 400);
        }
      }
    }

    const requestedFamilyId = extractRequestedFamilyId(request, bodyObj);
    const actor = await deps.auth.authenticate(request, requestedFamilyId);
    if (actor.role !== 'child' && actor.role !== 'parent') {
      throw new Core1CommandError('forbidden_role_for_free_times', 403);
    }

    const rawId =
      pathWindowId ??
      url.searchParams.get('id')?.trim() ??
      (typeof bodyObj?.id === 'string' ? bodyObj.id.trim() : undefined);
    const windowId = validateUuid(rawId, 'window_id');

    const deleted = await deps.store.deactivateWindow(actor.familyId, actor.personId, windowId);
    if (!deleted) {
      throw new Core1CommandError('free_window_not_found', 404);
    }

    const now = (deps.now ?? (() => new Date()))();
    if (deps.timeline) {
      await deps.timeline.append({
        familyId: actor.familyId,
        eventType: 'core1.matcher.window_deleted',
        entityId: windowId,
        humanLine: 'Removed a free-time window.',
        payload: { windowId, personId: actor.personId },
        dedupeKey: `matcher_window_del:${windowId}`,
        occurredAt: now.toISOString(),
      });
    }

    return jsonResp({ ok: true, deleted_id: windowId });
  } catch (error) {
    return handleError(error);
  }
}

function verifyCronHeader(request: Request, env: Record<string, string | undefined>): void {
  const secret = env.CRON_SECRET;
  if (!secret) {
    throw new Core1CommandError('not_configured', 503);
  }
  const cronHeader = request.headers.get('x-cron-secret') ?? bearerToken(request);
  if (!safeTokenEquals(cronHeader, secret)) {
    throw new Core1CommandError('unauthorized', 401);
  }
}

export async function handleMatcherTick(
  request: Request,
  deps: Core1MatcherDeps,
): Promise<Response> {
  try {
    const env = deps.env ?? process.env;
    verifyCronHeader(request, env);

    if (env.MAINTENANCE_KILL === 'true') {
      return jsonResp({ paused: true }, 503);
    }

    let requestedFamilyId: string | undefined;
    const rawText = await request.text();
    if (rawText.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        throw new Core1CommandError('invalid_json_body', 400);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Core1CommandError('invalid_json_body', 400);
      }
      const obj = parsed as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (k !== 'family_id' && k !== 'familyId') {
          throw new Core1CommandError(`unknown_field_${k}`, 400);
        }
      }
      const rawFam = obj.family_id ?? obj.familyId;
      if (rawFam !== undefined && rawFam !== null && rawFam !== '') {
        requestedFamilyId = validateUuid(rawFam, 'family_id');
      }
    }

    const now = (deps.now ?? (() => new Date()))();
    const newId = deps.newId ?? randomUUID;
    const timerScale = getDemoTimerScale(env);
    const tickIntervalMs = scaleDurationMs(MATCHER_TICK_INTERVAL_MS, env, 1_000);
    const candidateFamilyIds = await deps.store.listCandidateFamilyIds(requestedFamilyId);

    const nudgesSent: Array<{
      family_id: string;
      parent_person_id: string;
      child_person_id: string;
      local_date: string;
      nudge_id: string;
      outbox_id: string;
      push_count: number;
      dispatched: boolean;
    }> = [];
    const skipped: Array<{ family_id: string; reason: string }> = [];

    for (const familyId of candidateFamilyIds) {
      const [people, windows] = await Promise.all([
        deps.store.listFamilyPeople(familyId),
        deps.store.listActiveWindowsForFamily(familyId),
      ]);

      const parents = people.filter((p) => p.role === 'parent');
      const children = people.filter((p) => p.role === 'child');
      if (parents.length === 0 || children.length === 0) {
        skipped.push({ family_id: familyId, reason: 'missing_parent_or_child' });
        continue;
      }

      const windowsByPerson = new Map<string, FreeWindowRecord[]>();
      for (const w of windows) {
        const list = windowsByPerson.get(w.personId) ?? [];
        list.push(w);
        windowsByPerson.set(w.personId, list);
      }

      for (const parent of parents) {
        const bounds = getLocalDayBoundsUtc(now, parent.timezone);
        const existingNudge = await deps.store.getMatcherNudgeForDay(
          familyId,
          parent.id,
          bounds.localDate,
        );
        if (existingNudge && existingNudge.status === 'sent') {
          skipped.push({ family_id: familyId, reason: 'already_nudged_today' });
          continue;
        }

        const parentWindows = windowsByPerson.get(parent.id) ?? [];
        let matchedThisParent = false;

        for (const child of children) {
          const childWindows = windowsByPerson.get(child.id) ?? [];
          const talkedToday = await deps.store.hasTalkedToday({
            familyId,
            parentPersonId: parent.id,
            childPersonId: child.id,
            dayStartUtcIso: bounds.dayStartUtcIso,
            dayEndUtcIso: bounds.dayEndUtcIso,
          });

          const evaluation = evaluateFamilyPairMatch({
            familyId,
            parent,
            child,
            parentWindows,
            childWindows,
            localDate: bounds.localDate,
            nudgedToday: false,
            talkedToday,
            now,
          });

          if (!evaluation.eligibleToNudge) {
            skipped.push({
              family_id: familyId,
              reason: evaluation.skipReason ?? 'not_eligible',
            });
            continue;
          }

          const dedupeKey = `both_free_nudge:${familyId}:${parent.id}:${bounds.localDate}`;
          const logId = stableCore1Uuid(['matcher-log', dedupeKey]);
          const nudgeId = stableCore1Uuid(['matcher-nudge', dedupeKey]);
          const alertId = stableCore1Uuid(['matcher-alert', dedupeKey]);
          const outboxPreId = stableCore1Uuid(['matcher-outbox-ref', dedupeKey]);

          // Atomic one-per-day claim prevents duplicate nudges under concurrent ticks.
          const claim = await deps.store.claimMatcherNudgeForDay({
            id: logId,
            familyId,
            parentPersonId: parent.id,
            childPersonId: child.id,
            localDate: bounds.localDate,
            nudgeId,
            outboxId: outboxPreId,
            childAlertId: alertId,
            matchedAt: now.toISOString(),
          });

          if (!claim.claimed) {
            skipped.push({ family_id: familyId, reason: 'already_nudged_today' });
            matchedThisParent = true;
            break;
          }

          const expoTokens = await deps.store.listPushTokens(familyId, child.id);
          const outboxRes = await deps.outbox.enqueue({
            familyId,
            kind: 'core1.both_free_push',
            action: 'both_free_nudge',
            dedupeKey,
            payload: {
              channel: 'app_push',
              autoBridge: false,
              familyId,
              parentPersonId: parent.id,
              childPersonId: child.id,
              localDate: bounds.localDate,
              expoTokensCount: expoTokens.length,
              notification: {
                title: BOTH_FREE_NUDGE_TITLE,
                body: BOTH_FREE_NUDGE_BODY,
              },
            },
          });

          let pushDispatched = false;
          if (expoTokens.length > 0) {
            const pushSender = deps.sendPush ?? defaultSendExpoPush;
            const pushOutcome = await pushSender(
              expoTokens.map((token) => ({
                to: token,
                title: BOTH_FREE_NUDGE_TITLE,
                body: BOTH_FREE_NUDGE_BODY,
                sound: 'default',
                data: {
                  route: '/free-times',
                  kind: 'core1.both_free_nudge',
                  family_id: familyId,
                  parent_person_id: parent.id,
                },
              })),
            );
            pushDispatched = pushOutcome.sent > 0;
          }

          await deps.store.recordNudge({
            id: nudgeId,
            familyId,
            recipientPersonId: child.id,
            kind: 'both_free_nudge',
            scheduledAt: now.toISOString(),
            status: pushDispatched ? 'sent' : 'pending',
          });

          await deps.store.recordChildAlert({
            id: alertId,
            familyId,
            recipientPersonId: child.id,
            kind: 'both_free_nudge',
          });

          if (deps.timeline) {
            await deps.timeline.append({
              familyId,
              eventType: 'core1.matcher.both_free_nudge',
              entityId: nudgeId,
              humanLine: 'Both Maa and Riya are free — sent one nudge to Riya.',
              payload: {
                nudgeId,
                outboxId: outboxRes.outboxId,
                parentPersonId: parent.id,
                childPersonId: child.id,
                localDate: bounds.localDate,
                channel: 'app_push',
                autoBridge: false,
                pushDispatched,
              },
              dedupeKey: `timeline:${dedupeKey}`,
              occurredAt: now.toISOString(),
            });
          }

          nudgesSent.push({
            family_id: familyId,
            parent_person_id: parent.id,
            child_person_id: child.id,
            local_date: bounds.localDate,
            nudge_id: nudgeId,
            outbox_id: outboxRes.outboxId,
            push_count: expoTokens.length,
            dispatched: pushDispatched,
          });
          matchedThisParent = true;
          break;
        }

        if (matchedThisParent) break;
      }
    }

    return jsonResp({
      ok: true,
      checked_families: candidateFamilyIds.length,
      nudges_sent: nudgesSent,
      skipped,
      timer_scale: timerScale,
      tick_interval_ms: tickIntervalMs,
      auto_bridge: false,
    });
  } catch (error) {
    return handleError(error);
  }
}

function verifySarvamBearer(request: Request, env: Record<string, string | undefined>): void {
  const secret = env.SARVAM_TOOL_TOKEN || env.SARVAM_TOOL_BEARER;
  if (!secret) {
    throw new Core1CommandError('not_configured', 503);
  }
  const token = bearerToken(request);
  if (!safeTokenEquals(token, secret)) {
    throw new Core1CommandError('unauthorized', 401);
  }
}

function pickNestedRecord(
  root: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [root];
  for (const k of keys) {
    const val = root[k];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      out.push(val as Record<string, unknown>);
    }
  }
  return out;
}

function pickStringFromContainers(
  containers: readonly Record<string, unknown>[],
  keys: readonly string[],
): string | undefined {
  for (const obj of containers) {
    for (const k of keys) {
      const val = obj[k];
      if (typeof val === 'string' && val.trim()) {
        return val.trim();
      }
    }
  }
  return undefined;
}

export async function handleSarvamFreeTimeTool(
  request: Request,
  deps: Core1MatcherDeps,
): Promise<Response> {
  try {
    const env = deps.env ?? process.env;
    verifySarvamBearer(request, env);

    const body = await readCore1JsonRequest(request);
    const contextContainers = pickNestedRecord(body, ['variables', 'agent_variables', 'context']);
    const inputContainers = pickNestedRecord(body, ['input', 'arguments']);

    const rawFamilyId = pickStringFromContainers(contextContainers, ['family_id', 'familyId']);
    const rawParentId = pickStringFromContainers(contextContainers, ['parent_id', 'parentId']);
    if (!rawFamilyId || !rawParentId) {
      throw new Core1CommandError('missing_context', 400);
    }
    if (!isValidUuid(rawFamilyId) || !isValidUuid(rawParentId)) {
      throw new Core1CommandError('invalid_request', 400);
    }

    const said = pickStringFromContainers(inputContainers, ['said', 'utterance', 'text']) ?? '';
    if (said.length > 2000) {
      throw new Core1CommandError('invalid_request', 400);
    }

    const parent = await deps.store.getPerson(rawFamilyId, rawParentId);
    if (!parent) {
      throw new Core1CommandError('parent_not_found', 404);
    }
    if (parent.role !== 'parent') {
      throw new Core1CommandError('forbidden_not_parent', 403);
    }

    const parsed = parseHindiFreeTime(said);
    if (!parsed.ok) {
      return jsonResp({
        ok: false,
        saved: false,
        reason: parsed.reason,
        line_hi: parsed.readBackLine,
        read_back: parsed.readBackLine,
      });
    }

    const now = (deps.now ?? (() => new Date()))();
    const newId = deps.newId ?? randomUUID;
    const timezone = resolveSafeTimeZone(parent.timezone);
    const sanitizedSaid = redactSensitiveText(said).slice(0, 200);

    const savedWindow = await deps.store.createWindow(
      {
        id: newId(),
        familyId: rawFamilyId,
        personId: rawParentId,
        timezone,
        startMinute: parsed.startMinute,
        endMinute: parsed.endMinute,
        kind: 'recurring',
        daysOfWeek: null,
        expiresAt: null,
        source: 'sarvam_checkin',
        label: parsed.label,
        rawSaid: sanitizedSaid,
      },
      { deactivateSource: 'sarvam_checkin' },
    );

    if (deps.timeline) {
      await deps.timeline.append({
        familyId: rawFamilyId,
        eventType: 'core1.matcher.parent_free_time_saved',
        entityId: savedWindow.id,
        humanLine: `Saved ${redactSensitiveText(parent.displayName)}'s free time from check-in (${parsed.startTime}-${parsed.endTime}).`,
        payload: {
          windowId: savedWindow.id,
          parentPersonId: rawParentId,
          startTime: parsed.startTime,
          endTime: parsed.endTime,
          timezone,
          confidence: parsed.confidence,
        },
        dedupeKey: `matcher_sarvam_save:${savedWindow.id}`,
        occurredAt: now.toISOString(),
      });
    }

    return jsonResp({
      ok: true,
      saved: true,
      window_id: savedWindow.id,
      start_time: parsed.startTime,
      end_time: parsed.endTime,
      timezone,
      label: parsed.label,
      line_hi: parsed.readBackLine,
      read_back: parsed.readBackLine,
    });
  } catch (error) {
    return handleError(error);
  }
}
