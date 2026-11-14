import { describe, expect, it } from 'vitest';
import {
  applyWatchOverdueTickContract,
  createSyntheticCore2Fixtures,
  resolveWatchSafeContract,
  type Core2WatchStateMachine,
} from '../../../harness/core2';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';
import { BarrierConcurrency, ControlledClock } from './runner/ports';

describe('Matrix Row 09: Safe vs timeout', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '09')!;

  it('unit/contract: concurrent I-am-safe and watch timeout settle monotonically without post-safe escalation', async () => {
    const clock = new ControlledClock('2026-11-14T18:00:00.000Z');
    const c2 = createSyntheticCore2Fixtures('0009');
    const barrier = new BarrierConcurrency();

    let sharedWatch: Core2WatchStateMachine = {
      id: '90000000-0000-4000-8000-000000000001',
      familyId: c2.family.familyId,
      subjectPersonId: c2.family.people.riya.id,
      state: 'checking_in',
      version: 2,
      deadlineAtMs: clock.nowMs() - 600_000,
      graceUntilMs: clock.nowMs() - 1_000, // already past grace so tick would escalate if safe hadn't won
      safeAtMs: null,
    };

    // Simulate serialized row lock where /safe claims lock v2 first, then overdue tick runs right after.
    let lockChain: Promise<void> = Promise.resolve();
    const withRowLock = <T>(fn: () => T): Promise<T> => {
      const next = lockChain.then(fn);
      lockChain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };

    const res = await barrier.runBarrier<unknown>([
      () =>
        withRowLock(() => {
          const out = resolveWatchSafeContract(sharedWatch, 2, clock.nowMs());
          if (out.status === 200) sharedWatch = out.watch;
          return out;
        }),
      () =>
        withRowLock(() => {
          const out = applyWatchOverdueTickContract(sharedWatch, 2, clock.nowMs());
          sharedWatch = out.watch;
          return out;
        }),
    ]);

    expect(res.rejected).toHaveLength(0);
    expect(sharedWatch.state).toBe('safe');
    expect(sharedWatch.version).toBe(3);

    // A later stale timeout tick still cannot re-escalate a settled safe watch.
    const lateTick = applyWatchOverdueTickContract(sharedWatch, 3, clock.nowMs() + 300_000);
    expect(lateTick.transitioned).toBe(false);
    expect(sharedWatch.state).toBe('safe');
  });

  it('matrix status: remains blocked pending transactional public.core2_resolve_watch_safe SQL', () => {
    const result = evaluateMatrixStatus(rowSpec, {
      unitPassed: true,
      unitDetail: 'Safe-vs-timeout barrier contract converges monotonically to safe without post-safe escalation',
      pgExecuted: false,
      pgPassed: false,
      pgDetail: 'Transactional core2_resolve_watch_safe + core2_claim_due_watches blocked on agy3 (core2)',
    });
    expect(result.overallStatus).toBe('blocked');
    expect(result.blockedBy).toEqual(['agy3 (core2)']);
  });
});
