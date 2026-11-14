import {
  findActiveQuietWindow,
  getLocalDateString,
  getLocalTimeParts,
  localTimeToUtc,
} from '../../../../../packages/atlas/src/core1/check-in';
import type { TimeWindow } from '../../../../../packages/atlas/src/core1/types';
import type {
  FamilyMatchEvaluation,
  FreeWindowRecord,
  PersonScheduleContext,
} from './types';

export const BOTH_FREE_NUDGE_TITLE = 'Sahaj';
export const BOTH_FREE_NUDGE_BODY =
  'Abhi aap dono free hain — aap Maa ko call kar sakti hain.';
export const MATCHER_TICK_INTERVAL_MS = 10 * 60_000;

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function isValidIanaTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== 'string' || tz.length > 80) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveSafeTimeZone(tz: string | null | undefined): string {
  if (tz && isValidIanaTimeZone(tz)) return tz;
  return 'Asia/Kolkata';
}

export function getLocalWeekday(date: Date, timeZone: string): number {
  const short = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveSafeTimeZone(timeZone),
    weekday: 'short',
  }).format(date);
  return WEEKDAY_MAP[short] ?? 0;
}

export function getLocalDayBoundsUtc(
  now: Date,
  timeZone: string,
): { localDate: string; dayStartUtcIso: string; dayEndUtcIso: string } {
  const tz = resolveSafeTimeZone(timeZone);
  const parts = getLocalTimeParts(now, tz);
  const localDate = getLocalDateString(now, tz);
  const startUtc = localTimeToUtc(parts.year, parts.month, parts.day, 0, 0, tz);
  const nextCal = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const endUtc = localTimeToUtc(
    nextCal.getUTCFullYear(),
    nextCal.getUTCMonth() + 1,
    nextCal.getUTCDate(),
    0,
    0,
    tz,
  );
  return {
    localDate,
    dayStartUtcIso: startUtc.toISOString(),
    dayEndUtcIso: endUtc.toISOString(),
  };
}

export function isFreeWindowActiveAt(window: FreeWindowRecord, now: Date): boolean {
  if (!window.active) return false;

  if (window.kind === 'ad_hoc') {
    if (!window.expiresAt) return false;
    const expMs = Date.parse(window.expiresAt);
    return Number.isFinite(expMs) && expMs > now.getTime();
  }

  if (window.expiresAt) {
    const expMs = Date.parse(window.expiresAt);
    if (Number.isFinite(expMs) && expMs <= now.getTime()) return false;
  }

  const tz = resolveSafeTimeZone(window.timezone);
  if (window.daysOfWeek && window.daysOfWeek.length > 0) {
    const weekday = getLocalWeekday(now, tz);
    if (!window.daysOfWeek.includes(weekday)) return false;
  }

  const parts = getLocalTimeParts(now, tz);
  const currentMinute = parts.hour * 60 + parts.minute;
  if (window.startMinute < window.endMinute) {
    return currentMinute >= window.startMinute && currentMinute < window.endMinute;
  }
  if (window.startMinute > window.endMinute) {
    return currentMinute >= window.startMinute || currentMinute < window.endMinute;
  }
  return false;
}

export function normalizeQuietWindows(raw: unknown): TimeWindow[] {
  if (!Array.isArray(raw)) return [];
  const valid: TimeWindow[] = [];
  const hhmmRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.start === 'string' && typeof rec.end === 'string') {
      const start = rec.start.trim();
      const end = rec.end.trim();
      if (hhmmRe.test(start) && hhmmRe.test(end) && start !== end) {
        valid.push({ start, end });
      }
    }
  }
  return valid;
}

export function isQuietHoursAt(
  quietWindows: TimeWindow[],
  timezone: string,
  now: Date,
): boolean {
  if (!quietWindows.length) return false;
  return Boolean(findActiveQuietWindow(now, resolveSafeTimeZone(timezone), quietWindows));
}

export function evaluateFamilyPairMatch(input: {
  familyId: string;
  parent: PersonScheduleContext;
  child: PersonScheduleContext;
  parentWindows: FreeWindowRecord[];
  childWindows: FreeWindowRecord[];
  localDate: string;
  nudgedToday: boolean;
  talkedToday: boolean;
  now: Date;
}): FamilyMatchEvaluation {
  const maaFreeNow = input.parentWindows.some((w) => isFreeWindowActiveAt(w, input.now));
  const riyaFreeNow = input.childWindows.some((w) => isFreeWindowActiveAt(w, input.now));
  const bothFreeNow = maaFreeNow && riyaFreeNow;
  const maaQuietNow = isQuietHoursAt(input.parent.quietWindows, input.parent.timezone, input.now);

  let skipReason: FamilyMatchEvaluation['skipReason'] = null;
  if (!bothFreeNow) {
    skipReason = 'not_both_free';
  } else if (maaQuietNow) {
    skipReason = 'maa_quiet_hours';
  } else if (input.nudgedToday) {
    skipReason = 'already_nudged_today';
  } else if (input.talkedToday) {
    skipReason = 'already_talked_today';
  }

  return {
    familyId: input.familyId,
    parentPersonId: input.parent.id,
    childPersonId: input.child.id,
    localDate: input.localDate,
    bothFreeNow,
    maaFreeNow,
    riyaFreeNow,
    maaQuietNow,
    talkedToday: input.talkedToday,
    nudgedToday: input.nudgedToday,
    eligibleToNudge: skipReason === null,
    skipReason,
  };
}
