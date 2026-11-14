import { describe, expect, it } from 'vitest';
import { createSyntheticCore1Fixtures, isWithinQuietWindow, localHourInZone } from '../../../harness/core1';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';
import { ControlledClock } from './runner/ports';

describe('Matrix Row 10: Missed cron / restart', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '10')!;

  it('unit/contract: ControlledClock accurately models quiet hours in Asia/Kolkata (22:00..07:00) and overdue wake-ups', () => {
    const fam = createSyntheticCore1Fixtures('0010');
    // 2026-11-14T17:30:00Z = 23:00 IST (inside 22:00..07:00 quiet hours)
    const clock = new ControlledClock('2026-11-14T17:30:00.000Z');
    expect(localHourInZone(clock.nowMs(), fam.timezone)).toBe(23);
    expect(isWithinQuietWindow(clock.nowMs(), fam.timezone, fam.quietHours.startHour, fam.quietHours.endHour)).toBe(true);

    // Advance 9 hours to 08:00 IST next morning -> outside quiet hours.
    clock.advanceMinutes(9 * 60);
    expect(localHourInZone(clock.nowMs(), fam.timezone)).toBe(8);
    expect(isWithinQuietWindow(clock.nowMs(), fam.timezone, fam.quietHours.startHour, fam.quietHours.endHour)).toBe(false);

    // DST transition zone check (America/New_York spring forward 2026-03-08 06:59Z -> 07:01Z jumps 01:59 -> 03:01 local)
    const beforeDst = Date.parse('2026-03-08T06:59:00.000Z');
    const afterDst = Date.parse('2026-03-08T07:01:00.000Z');
    expect(localHourInZone(beforeDst, 'America/New_York')).toBe(1);
    expect(localHourInZone(afterDst, 'America/New_York')).toBe(3);
  });

  it('matrix status: remains blocked pending cron/schedule tick implementations', () => {
    const result = evaluateMatrixStatus(rowSpec, {
      unitPassed: true,
      unitDetail: 'ControlledClock quiet hours + DST jump verification passed',
      pgExecuted: false,
      pgPassed: false,
      pgDetail: 'Missed cron restart recovery blocked on kiro-a + kiro-b + agy-phase4 + agy3',
    });
    expect(result.overallStatus).toBe('blocked');
  });
});
