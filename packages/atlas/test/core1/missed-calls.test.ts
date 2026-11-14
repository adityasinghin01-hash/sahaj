import { describe, it, expect } from 'vitest';
import {
  deduplicateAndOrderCalls,
  groupMissedCalls,
} from '../../src/core1/missed-calls';
import { createClock } from '../../src/core1/types';
import type { MissedCallEvent } from '../../src/core1/types';

describe('Missed-Call Grouping & Nudge Domain Logic', () => {
  const familyA = '11111111-1111-4111-8111-111111111111';
  const familyB = '22222222-2222-4222-8222-222222222222';
  const caller = '33333333-3333-4333-8333-333333333333';
  const recipientA = '44444444-4444-4444-8444-444444444444';
  const recipientB = '55555555-5555-4555-8555-555555555555';

  it('BLOCKER 4 FIX: preserves distinct events when providerCallId collides across different families', () => {
    // Both families happen to receive events with identical providerCallId 'call-collision-999'
    const calls: MissedCallEvent[] = [
      {
        providerCallId: 'call-collision-999',
        providerAccountId: 'acc-1',
        familyId: familyA,
        callerPersonId: caller,
        recipientPersonId: recipientA,
        timestamp: '2026-11-15T10:00:00.000Z',
      },
      {
        providerCallId: 'call-collision-999', // same call id!
        providerAccountId: 'acc-1',
        familyId: familyB, // DIFFERENT family!
        callerPersonId: caller,
        recipientPersonId: recipientB,
        timestamp: '2026-11-15T10:00:05.000Z',
      },
    ];

    const deduped = deduplicateAndOrderCalls(calls);
    expect(deduped.length).toBe(2);
    expect(deduped.some(c => c.familyId === familyA)).toBe(true);
    expect(deduped.some(c => c.familyId === familyB)).toBe(true);
  });

  it('deduplicates true identical duplicates within the same family and recipient', () => {
    const calls: MissedCallEvent[] = [
      {
        providerCallId: 'call-duplicate-1',
        providerAccountId: 'acc-1',
        familyId: familyA,
        callerPersonId: caller,
        recipientPersonId: recipientA,
        timestamp: '2026-11-15T10:00:00.000Z',
      },
      {
        providerCallId: 'call-duplicate-1', // identical duplicate!
        providerAccountId: 'acc-1',
        familyId: familyA,
        callerPersonId: caller,
        recipientPersonId: recipientA,
        timestamp: '2026-11-15T10:00:00.000Z',
      },
    ];

    const deduped = deduplicateAndOrderCalls(calls);
    expect(deduped.length).toBe(1);
  });

  it('classifies 1 call as single, 2 calls as repeated, and 3+ calls as urgent tier', () => {
    const clock = createClock('2026-11-15T10:01:00.000Z');

    // 1 call: single
    const singleCall: MissedCallEvent[] = [
      {
        providerCallId: 'c1',
        familyId: familyA,
        callerPersonId: caller,
        recipientPersonId: recipientA,
        timestamp: '2026-11-15T10:00:00.000Z',
      },
    ];
    const r1 = groupMissedCalls(singleCall, { windowSeconds: 20, clock });
    expect(r1.clusters[0].tier).toBe('single');
    expect(r1.clusters[0].proposedNudge.kind).toBe('missed_call_single');
    expect(r1.clusters[0].proposedNudge.urgency).toBe('routine');

    // 2 calls: repeated
    const twoCalls: MissedCallEvent[] = [
      ...singleCall,
      {
        providerCallId: 'c2',
        familyId: familyA,
        callerPersonId: caller,
        recipientPersonId: recipientA,
        timestamp: '2026-11-15T10:00:10.000Z',
      },
    ];
    const r2 = groupMissedCalls(twoCalls, { windowSeconds: 20, clock });
    expect(r2.clusters[0].tier).toBe('repeated');
    expect(r2.clusters[0].proposedNudge.kind).toBe('missed_call_repeated');
    expect(r2.clusters[0].proposedNudge.urgency).toBe('elevated');

    // 3 calls: urgent
    const threeCalls: MissedCallEvent[] = [
      ...twoCalls,
      {
        providerCallId: 'c3',
        familyId: familyA,
        callerPersonId: caller,
        recipientPersonId: recipientA,
        timestamp: '2026-11-15T10:00:15.000Z',
      },
    ];
    const r3 = groupMissedCalls(threeCalls, { windowSeconds: 20, clock });
    expect(r3.clusters[0].tier).toBe('urgent');
    expect(r3.clusters[0].proposedNudge.kind).toBe('missed_call_urgent');
    expect(r3.clusters[0].proposedNudge.urgency).toBe('urgent');
  });

  it('clusters calls within windowSeconds and splits calls outside the window', () => {
    const clock = createClock('2026-11-15T10:05:00.000Z');
    const calls: MissedCallEvent[] = [
      // Cluster 1 (0s and 10s -> within 20s)
      {
        providerCallId: 'c1',
        familyId: familyA,
        callerPersonId: caller,
        recipientPersonId: recipientA,
        timestamp: '2026-11-15T10:00:00.000Z',
      },
      {
        providerCallId: 'c2',
        familyId: familyA,
        callerPersonId: caller,
        recipientPersonId: recipientA,
        timestamp: '2026-11-15T10:00:10.000Z',
      },
      // Cluster 2 (60s -> outside 20s window)
      {
        providerCallId: 'c3',
        familyId: familyA,
        callerPersonId: caller,
        recipientPersonId: recipientA,
        timestamp: '2026-11-15T10:01:00.000Z',
      },
    ];

    const result = groupMissedCalls(calls, { windowSeconds: 20, clock });
    expect(result.clusters.length).toBe(2);
    expect(result.clusters[0].callCount).toBe(2);
    expect(result.clusters[0].tier).toBe('repeated');
    expect(result.clusters[1].callCount).toBe(1);
    expect(result.clusters[1].tier).toBe('single');
  });

  it('BLOCKER 6 FIX: throws on invalid timestamps or window values', () => {
    const clock = createClock('2026-11-15T10:00:00.000Z');
    const badTimestampCall: MissedCallEvent[] = [
      {
        providerCallId: 'c1',
        familyId: familyA,
        callerPersonId: caller,
        recipientPersonId: recipientA,
        timestamp: 'not-a-valid-date',
      },
    ];

    expect(() => deduplicateAndOrderCalls(badTimestampCall)).toThrow('Invalid missed call timestamp');

    expect(() =>
      groupMissedCalls(
        [
          {
            providerCallId: 'c1',
            familyId: familyA,
            callerPersonId: caller,
            recipientPersonId: recipientA,
            timestamp: '2026-11-15T10:00:00.000Z',
          },
        ],
        { windowSeconds: -10, clock }
      )
    ).toThrow('Invalid windowSeconds');
  });
});
