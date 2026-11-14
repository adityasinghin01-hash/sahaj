import { describe, it, expect } from 'vitest';
import {
  compileFamilyReport,
  redactSensitiveText,
} from '../../src/core1/family-reports';
import { createClock } from '../../src/core1/types';
import type { RawTimelineRecord } from '../../src/core1/types';

describe('Family Reports & Timeline Redaction Domain Logic', () => {
  const familyId = '11111111-1111-4111-8111-111111111111';
  const childPersonId = '22222222-2222-4222-8222-222222222222';

  it('redacts unmasked Indian mobile numbers and 4+ digit numeric runs', () => {
    const raw = 'Sent SMS to 9876543210 with OTP 847291 for account 123456';
    const redacted = redactSensitiveText(raw);
    expect(redacted).not.toContain('9876543210');
    expect(redacted).not.toContain('847291');
    expect(redacted).toContain('<MOBILE_MASKED>');
    expect(redacted).toContain('******');
  });

  it('compiles family report with access control and correct stats aggregation', () => {
    const clock = createClock('2026-11-15T20:00:00.000Z');
    const records: RawTimelineRecord[] = [
      {
        id: 'r1',
        familyId,
        source: 'atlas',
        eventType: 'check_in.completed',
        createdAt: '2026-11-15T09:30:00.000Z',
      },
      {
        id: 'r2',
        familyId,
        source: 'atlas',
        eventType: 'incident.initiated',
        createdAt: '2026-11-15T11:00:00.000Z',
      },
      {
        id: 'r3',
        familyId,
        source: 'atlas',
        eventType: 'incident.closed',
        createdAt: '2026-11-15T11:30:00.000Z',
      },
      {
        id: 'r4',
        familyId,
        source: 'atlas',
        eventType: 'voice.shared',
        createdAt: '2026-11-15T14:00:00.000Z',
      },
      {
        id: 'r5',
        familyId,
        source: 'atlas',
        eventType: 'refill.requested',
        createdAt: '2026-11-15T16:00:00.000Z',
      },
      {
        id: 'r6',
        familyId,
        source: 'atlas',
        eventType: 'missed_call.nudge',
        createdAt: '2026-11-15T17:00:00.000Z',
      },
      // Event outside period
      {
        id: 'r-old',
        familyId,
        source: 'atlas',
        eventType: 'check_in.completed',
        createdAt: '2026-11-14T09:30:00.000Z', // Before start!
      },
      // Event for other family
      {
        id: 'r-other',
        familyId: '99999999-9999-4999-8999-999999999999',
        source: 'atlas',
        eventType: 'check_in.completed',
        createdAt: '2026-11-15T09:30:00.000Z',
      },
    ];

    const report = compileFamilyReport({
      familyId,
      requesterRole: 'child',
      requesterPersonId: childPersonId,
      periodStart: '2026-11-15T00:00:00.000Z',
      periodEnd: '2026-11-15T23:59:59.000Z',
      timelineRecords: records,
      clock,
    });

    expect(report.familyId).toBe(familyId);
    expect(report.stats.checkInsCompleted).toBe(1);
    expect(report.stats.urgentIncidentsRaised).toBe(1);
    expect(report.stats.urgentIncidentsResolved).toBe(1);
    expect(report.stats.voiceMessagesShared).toBe(1);
    expect(report.stats.refillProposalsGenerated).toBe(1);
    expect(report.stats.missedCallsDetected).toBe(1);
    expect(report.timeline.length).toBe(6);
    expect(report.timeline.every(t => !t.summary.includes('9876543210'))).toBe(true);
  });

  it('rejects unauthorized roles from compiling family reports', () => {
    const clock = createClock('2026-11-15T20:00:00.000Z');
    expect(() =>
      compileFamilyReport({
        familyId,
        requesterRole: 'stranger' as any,
        requesterPersonId: childPersonId,
        periodStart: '2026-11-15T00:00:00.000Z',
        periodEnd: '2026-11-15T23:59:59.000Z',
        timelineRecords: [],
        clock,
      })
    ).toThrow('Unauthorized role');
  });
});
