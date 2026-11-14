import { describe, it, expect } from 'vitest';
import {
  evaluateCheckInWake,
  parseMinutes,
  localTimeToUtc,
  findActiveQuietWindow,
  calculateQuietWindowEnd,
} from '../../src/core1/check-in';
import { createClock } from '../../src/core1/types';
import type {
  CheckInScheduleConfig,
  CheckInState,
  CheckInConsent,
} from '../../src/core1/types';

describe('Daily Check-in Domain Logic', () => {
  const familyId = '11111111-1111-4111-8111-111111111111';
  const personId = '22222222-2222-4222-8222-222222222222';
  const scheduleId = '33333333-3333-4333-8333-333333333333';

  const baseSchedule: CheckInScheduleConfig = {
    id: scheduleId,
    familyId,
    personId,
    enabled: true,
    timezone: 'Asia/Kolkata',
    preferredTime: '09:00',
    quietWindows: [
      { start: '21:00', end: '07:00' }, // crosses midnight
    ],
    retryPolicy: {
      maxAttempts: 3,
      retryIntervalMinutes: 30,
    },
  };

  const baseConsent: CheckInConsent = {
    hasConsent: true,
  };

  const baseState: CheckInState = {
    scheduleId,
    familyId,
    personId,
    localDate: '2026-11-15',
    attempts: [],
  };

  it('schedules initial call intent with explicit AI disclosure at preferred local time', () => {
    // 08:00 IST = 02:30 UTC. Preferred is 09:00 IST = 03:30 UTC
    const clock = createClock('2026-11-15T02:30:00.000Z');
    const decision = evaluateCheckInWake({
      schedule: baseSchedule,
      currentState: baseState,
      consent: baseConsent,
      wake: {
        wakeToken: 'wake-token-1',
        wakeTime: '2026-11-15T02:30:00.000Z',
      },
      clock,
    });

    expect(decision.action).toBe('schedule_call');
    if (decision.action === 'schedule_call') {
      expect(decision.intent.aiDisclose).toBe(true);
      expect(decision.intent.attemptNumber).toBe(1);
      expect(decision.intent.familyId).toBe(familyId);
      expect(decision.intent.personId).toBe(personId);
      // Preferred time 09:00 IST on 2026-11-15 is 03:30:00 UTC
      expect(decision.intent.targetTime).toBe('2026-11-15T03:30:00.000Z');
      expect(decision.nextState.attempts.length).toBe(1);
      expect(decision.nextState.attempts[0].status).toBe('scheduled');
    }
  });

  it('BLOCKER 5 FIX: correctly resolves DST transition quiet hours in America/New_York (2026-03-08)', () => {
    // On 2026-03-08, US clocks jump from 02:00 to 03:00 (EST -> EDT).
    // Target: quiet window ends at 03:30 local in America/New_York.
    // 03:30 EDT is UTC-4 => 07:30 UTC! (NOT 08:30 UTC)
    const nyTime = localTimeToUtc(2026, 3, 8, 3, 30, 'America/New_York');
    expect(nyTime.toISOString()).toBe('2026-03-08T07:30:00.000Z');

    // Test quiet window calculation during the DST transition
    const windowEnd = calculateQuietWindowEnd(
      new Date('2026-03-08T06:00:00.000Z'), // 01:00 EST (before jump)
      'America/New_York',
      { start: '22:00', end: '03:30' }
    );
    expect(windowEnd.toISOString()).toBe('2026-03-08T07:30:00.000Z');
  });

  it('BLOCKER 2 FIX: treats connected call as in-progress and avoids duplicate scheduling', () => {
    const clock = createClock('2026-11-15T04:00:00.000Z');
    const stateWithConnectedCall: CheckInState = {
      ...baseState,
      attempts: [
        {
          attemptNumber: 1,
          scheduledAt: '2026-11-15T03:30:00.000Z',
          status: 'connected', // call is currently active!
        },
      ],
    };

    const decision = evaluateCheckInWake({
      schedule: baseSchedule,
      currentState: stateWithConnectedCall,
      consent: baseConsent,
      wake: {
        wakeToken: 'wake-token-2',
        wakeTime: '2026-11-15T04:00:00.000Z',
      },
      clock,
    });

    expect(decision.action).toBe('in_progress');
    if (decision.action === 'in_progress') {
      expect(decision.attemptNumber).toBe(1);
    }
  });

  it('defers scheduling when target falls into quiet hours', () => {
    // 22:30 IST = 17:00 UTC (quiet window is 21:00 - 07:00 IST)
    const clock = createClock('2026-11-15T17:00:00.000Z');
    const scheduleLate: CheckInScheduleConfig = {
      ...baseSchedule,
      preferredTime: '22:30',
    };

    const decision = evaluateCheckInWake({
      schedule: scheduleLate,
      currentState: baseState,
      consent: baseConsent,
      wake: {
        wakeToken: 'wake-token-quiet',
        wakeTime: '2026-11-15T17:00:00.000Z',
      },
      clock,
    });

    expect(decision.action).toBe('defer_quiet_hours');
    if (decision.action === 'defer_quiet_hours') {
      // 07:00 IST next day (2026-11-16) = 01:30 UTC
      expect(decision.deferredUntil).toBe('2026-11-16T01:30:00.000Z');
    }
  });

  it('blocks check-in when consent is missing, revoked, or expired', () => {
    const clock = createClock('2026-11-15T03:30:00.000Z');

    // Missing consent
    const d1 = evaluateCheckInWake({
      schedule: baseSchedule,
      currentState: baseState,
      consent: { hasConsent: false },
      wake: { wakeToken: 'w1', wakeTime: '2026-11-15T03:30:00.000Z' },
      clock,
    });
    expect(d1.action).toBe('blocked_missing_consent');

    // Revoked consent
    const d2 = evaluateCheckInWake({
      schedule: baseSchedule,
      currentState: baseState,
      consent: { hasConsent: true, revokedAt: '2026-11-14T10:00:00.000Z' },
      wake: { wakeToken: 'w2', wakeTime: '2026-11-15T03:30:00.000Z' },
      clock,
    });
    expect(d2.action).toBe('blocked_missing_consent');

    // Expired consent
    const d3 = evaluateCheckInWake({
      schedule: baseSchedule,
      currentState: baseState,
      consent: { hasConsent: true, expiresAt: '2026-11-14T00:00:00.000Z' },
      wake: { wakeToken: 'w3', wakeTime: '2026-11-15T03:30:00.000Z' },
      clock,
    });
    expect(d3.action).toBe('blocked_missing_consent');
  });

  it('ignores duplicate wake tokens idempotently', () => {
    const clock = createClock('2026-11-15T03:30:00.000Z');
    const stateWithWake: CheckInState = {
      ...baseState,
      lastWakeToken: 'existing-wake-token',
    };

    const decision = evaluateCheckInWake({
      schedule: baseSchedule,
      currentState: stateWithWake,
      consent: baseConsent,
      wake: {
        wakeToken: 'existing-wake-token',
        wakeTime: '2026-11-15T03:30:00.000Z',
      },
      clock,
    });

    expect(decision.action).toBe('duplicate_wake_ignored');
  });

  it('handles bounded retries and raises escalation alert on retry exhaustion', () => {
    const clock = createClock('2026-11-15T05:00:00.000Z');
    const exhaustedState: CheckInState = {
      ...baseState,
      attempts: [
        { attemptNumber: 1, scheduledAt: '2026-11-15T03:30:00.000Z', status: 'failed' },
        { attemptNumber: 2, scheduledAt: '2026-11-15T04:00:00.000Z', status: 'failed' },
        { attemptNumber: 3, scheduledAt: '2026-11-15T04:30:00.000Z', status: 'failed' },
      ],
    };

    const decision = evaluateCheckInWake({
      schedule: baseSchedule,
      currentState: exhaustedState,
      consent: baseConsent,
      wake: {
        wakeToken: 'wake-retry-check',
        wakeTime: '2026-11-15T05:00:00.000Z',
      },
      clock,
    });

    expect(decision.action).toBe('exhausted');
    if (decision.action === 'exhausted') {
      expect(decision.alert.severity).toBe('urgent');
      expect(decision.alert.attemptsCount).toBe(3);
      expect(decision.alert.reason).toBe('retry_exhausted');
    }
  });

  it('handles cancellation and already-completed states cleanly', () => {
    const clock = createClock('2026-11-15T05:00:00.000Z');

    // Already completed
    const completedState: CheckInState = {
      ...baseState,
      attempts: [
        {
          attemptNumber: 1,
          scheduledAt: '2026-11-15T03:30:00.000Z',
          status: 'completed',
          completedAt: '2026-11-15T03:35:00.000Z',
        },
      ],
    };

    const d1 = evaluateCheckInWake({
      schedule: baseSchedule,
      currentState: completedState,
      consent: baseConsent,
      wake: { wakeToken: 'w-comp', wakeTime: '2026-11-15T05:00:00.000Z' },
      clock,
    });
    expect(d1.action).toBe('already_completed');

    // Cancelled state
    const cancelledState: CheckInState = {
      ...baseState,
      cancelledAt: '2026-11-15T02:00:00.000Z',
      cancellationReason: 'Parent travelling',
    };

    const d2 = evaluateCheckInWake({
      schedule: baseSchedule,
      currentState: cancelledState,
      consent: baseConsent,
      wake: { wakeToken: 'w-canc', wakeTime: '2026-11-15T05:00:00.000Z' },
      clock,
    });
    expect(d2.action).toBe('cancelled');
  });

  it('throws on cross-family or cross-person schedule/state mismatch', () => {
    const clock = createClock('2026-11-15T03:30:00.000Z');
    const wrongFamilyState: CheckInState = {
      ...baseState,
      familyId: '99999999-9999-4999-8999-999999999999',
    };

    expect(() =>
      evaluateCheckInWake({
        schedule: baseSchedule,
        currentState: wrongFamilyState,
        consent: baseConsent,
        wake: { wakeToken: 'w-mismatch', wakeTime: '2026-11-15T03:30:00.000Z' },
        clock,
      })
    ).toThrow('Schedule and state family/person mismatch');
  });
});
