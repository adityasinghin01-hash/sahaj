/**
 * Daily check-in scheduling domain logic.
 *
 * Implements:
 * - Local windows and IANA timezones with exact DST transition convergence
 * - Quiet hours detection and deferral (including crossing midnight)
 * - In-progress call protection: treats 'scheduled', 'ringing', and 'connected' calls as active
 * - Finite retry policy with backoff
 * - Retry exhaustion and escalation alerting
 * - Affirmative consent validation and revocation checks
 * - Mandatory AI disclosure requirement (aiDisclose: true)
 * - Duplicate wake idempotency handling
 * - Cancellation handling
 * - Pure intent-only output (never directly dials or performs side-effects)
 */

import type {
  CheckInScheduleConfig,
  CheckInState,
  CheckInConsent,
  CheckInScheduleDecision,
  CheckInAttempt,
  TimeWindow,
  Clock,
} from './types';

export function parseMinutes(hhmm: string): number {
  if (typeof hhmm !== 'string') throw new Error(`Invalid time format: ${hhmm}`);
  const parts = hhmm.trim().split(':');
  if (parts.length !== 2) throw new Error(`Invalid time format: ${hhmm}`);
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error(`Invalid time components in ${hhmm}`);
  }
  return h * 60 + m;
}

export function getLocalTimeParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => {
    const p = parts.find(part => part.type === type);
    return p ? parseInt(p.value, 10) : 0;
  };
  let hour = get('hour');
  if (hour === 24) hour = 0;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

export function getLocalDateString(date: Date, timeZone: string): string {
  const parts = getLocalTimeParts(date, timeZone);
  const y = parts.year.toString().padStart(4, '0');
  const m = parts.month.toString().padStart(2, '0');
  const d = parts.day.toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Robust convergence of local date/time components to UTC Date in any IANA time zone,
 * correctly handling DST transitions (e.g. spring forward / fall back).
 */
export function localTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  for (let i = 0; i < 6; i++) {
    const parts = getLocalTimeParts(guess, timeZone);
    const guessLocalAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const targetLocalAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
    const diff = targetLocalAsUtc - guessLocalAsUtc;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

export function isMinutesInWindow(currentMinutes: number, window: TimeWindow): boolean {
  const start = parseMinutes(window.start);
  const end = parseMinutes(window.end);
  if (start > end) {
    // Crosses midnight, e.g. 21:00 to 07:00
    return currentMinutes >= start || currentMinutes < end;
  }
  // Same day window, e.g. 13:00 to 15:00
  return currentMinutes >= start && currentMinutes < end;
}

export function findActiveQuietWindow(date: Date, timeZone: string, windows: TimeWindow[]): TimeWindow | undefined {
  if (!windows.length) return undefined;
  const parts = getLocalTimeParts(date, timeZone);
  const currentMinutes = parts.hour * 60 + parts.minute;
  return windows.find(w => isMinutesInWindow(currentMinutes, w));
}

/**
 * Calculates the exact UTC Date when the quiet window ends, handling DST transitions cleanly.
 */
export function calculateQuietWindowEnd(date: Date, timeZone: string, window: TimeWindow): Date {
  const parts = getLocalTimeParts(date, timeZone);
  const currentMinutes = parts.hour * 60 + parts.minute;
  const start = parseMinutes(window.start);
  const end = parseMinutes(window.end);

  const endH = Math.floor(end / 60);
  const endM = end % 60;

  // Determine target local day
  let targetYear = parts.year;
  let targetMonth = parts.month;
  let targetDay = parts.day;

  if (start > end && currentMinutes >= start) {
    // Night before midnight, window ends on next local day
    const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
    targetYear = nextDay.getUTCFullYear();
    targetMonth = nextDay.getUTCMonth() + 1;
    targetDay = nextDay.getUTCDate();
  }

  return localTimeToUtc(targetYear, targetMonth, targetDay, endH, endM, timeZone);
}

export interface EvaluateCheckInParams {
  schedule: CheckInScheduleConfig;
  currentState: CheckInState;
  consent: CheckInConsent;
  wake: {
    wakeToken: string;
    wakeTime: string; // ISO 8601
  };
  clock: Clock;
}

/**
 * Pure domain function to evaluate a check-in wake and determine the next action/intent.
 */
export function evaluateCheckInWake(params: EvaluateCheckInParams): CheckInScheduleDecision {
  const { schedule, currentState, consent, wake, clock } = params;

  // 0. Validate schedule/state correspondences
  if (schedule.familyId !== currentState.familyId || schedule.personId !== currentState.personId) {
    throw new Error('Schedule and state family/person mismatch');
  }

  // Use current clock as authoritative source of current time
  const now = clock.now();
  const wakeDate = new Date(wake.wakeTime);
  if (isNaN(wakeDate.getTime())) {
    throw new Error(`Invalid wakeTime timestamp: ${wake.wakeTime}`);
  }

  // 1. Check if schedule or state is cancelled
  if (currentState.cancelledAt) {
    return {
      action: 'cancelled',
      reason: currentState.cancellationReason ?? 'Check-in was cancelled',
      nextState: currentState,
    };
  }

  if (!schedule.enabled) {
    return {
      action: 'cancelled',
      reason: 'Schedule is disabled',
      nextState: {
        ...currentState,
        lastWakeToken: wake.wakeToken,
      },
    };
  }

  // 2. Duplicate wake detection
  if (currentState.lastWakeToken && currentState.lastWakeToken === wake.wakeToken) {
    return {
      action: 'duplicate_wake_ignored',
      wakeToken: wake.wakeToken,
      nextState: currentState,
    };
  }

  // 3. Affirmative consent checks
  if (!consent.hasConsent) {
    return {
      action: 'blocked_missing_consent',
      reason: 'Affirmative consent is not granted for daily check-in',
      nextState: {
        ...currentState,
        lastWakeToken: wake.wakeToken,
      },
    };
  }

  if (consent.revokedAt) {
    return {
      action: 'blocked_missing_consent',
      reason: 'Consent was revoked',
      nextState: {
        ...currentState,
        lastWakeToken: wake.wakeToken,
      },
    };
  }

  if (consent.expiresAt && now.getTime() >= new Date(consent.expiresAt).getTime()) {
    return {
      action: 'blocked_missing_consent',
      reason: 'Consent has expired',
      nextState: {
        ...currentState,
        lastWakeToken: wake.wakeToken,
      },
    };
  }

  // 4. Check if today's check-in is already completed
  const completedAttempt = currentState.attempts.find(a => a.status === 'completed');
  if (completedAttempt) {
    return {
      action: 'already_completed',
      completedAt: completedAttempt.completedAt ?? completedAttempt.scheduledAt,
      nextState: {
        ...currentState,
        lastWakeToken: wake.wakeToken,
      },
    };
  }

  // 5. Check if an attempt is currently in-progress
  // MUST treat 'connected' call as ongoing and avoid scheduling another call while it is active
  const inProgressAttempt = currentState.attempts.find(
    a => a.status === 'scheduled' || a.status === 'ringing' || a.status === 'connected'
  );
  if (inProgressAttempt) {
    return {
      action: 'in_progress',
      attemptNumber: inProgressAttempt.attemptNumber,
      nextState: {
        ...currentState,
        lastWakeToken: wake.wakeToken,
      },
    };
  }

  // 6. Check finite retries
  const failedAttempts = currentState.attempts.filter(a => a.status === 'failed');
  const maxAttempts = schedule.retryPolicy.maxAttempts;

  if (failedAttempts.length >= maxAttempts) {
    return {
      action: 'exhausted',
      alert: {
        familyId: schedule.familyId,
        personId: schedule.personId,
        scheduleId: schedule.id,
        attemptsCount: failedAttempts.length,
        reason: 'retry_exhausted',
        severity: 'urgent',
        occurredAt: clock.nowIso(),
      },
      nextState: {
        ...currentState,
        lastWakeToken: wake.wakeToken,
      },
    };
  }

  // 7. Determine attempt number and target time
  const nextAttemptNumber = failedAttempts.length + 1;
  let targetTime: Date;

  // Base calculation on current clock
  const baseTime = now.getTime() > wakeDate.getTime() ? now : wakeDate;

  if (nextAttemptNumber === 1) {
    // For first attempt, target preferred time on current date
    const localDateStr = currentState.localDate || getLocalDateString(baseTime, schedule.timezone);
    const dateParts = localDateStr.split('-').map(Number);
    const prefMinutes = parseMinutes(schedule.preferredTime);
    const prefH = Math.floor(prefMinutes / 60);
    const prefM = prefMinutes % 60;

    targetTime = localTimeToUtc(dateParts[0], dateParts[1], dateParts[2], prefH, prefM, schedule.timezone);

    // If preferred time is in the past relative to current clock, use current clock
    if (targetTime.getTime() < baseTime.getTime()) {
      targetTime = baseTime;
    }
  } else {
    // Retry: calculate from last failed attempt with retryInterval
    const lastAttempt = failedAttempts[failedAttempts.length - 1];
    const lastAttemptTime = lastAttempt ? new Date(lastAttempt.scheduledAt).getTime() : baseTime.getTime();
    const retryDelayMs = schedule.retryPolicy.retryIntervalMinutes * 60 * 1000;
    targetTime = new Date(Math.max(lastAttemptTime + retryDelayMs, baseTime.getTime()));
  }

  // 8. Quiet hours check
  const quietWindow = findActiveQuietWindow(targetTime, schedule.timezone, schedule.quietWindows);
  if (quietWindow) {
    const deferredUntilDate = calculateQuietWindowEnd(targetTime, schedule.timezone, quietWindow);
    return {
      action: 'defer_quiet_hours',
      deferredUntil: deferredUntilDate.toISOString(),
      nextState: {
        ...currentState,
        lastWakeToken: wake.wakeToken,
      },
    };
  }

  // 9. Emit schedule call intent with mandatory AI disclosure
  const newAttempt: CheckInAttempt = {
    attemptNumber: nextAttemptNumber,
    scheduledAt: targetTime.toISOString(),
    status: 'scheduled',
  };

  const nextState: CheckInState = {
    ...currentState,
    attempts: [...currentState.attempts, newAttempt],
    lastWakeToken: wake.wakeToken,
  };

  return {
    action: 'schedule_call',
    intent: {
      familyId: schedule.familyId,
      personId: schedule.personId,
      scheduleId: schedule.id,
      targetTime: targetTime.toISOString(),
      attemptNumber: nextAttemptNumber,
      aiDisclose: true,
      recordingConsentRequired: true,
      wakeToken: wake.wakeToken,
    },
    nextState,
  };
}
