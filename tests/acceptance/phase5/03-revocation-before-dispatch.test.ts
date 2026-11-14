import { describe, expect, it } from 'vitest';
import { consentIsCurrent, latestConsent } from '@/lib/media/consent';
import { createSyntheticCore1Fixtures } from '../../../harness/core1';
import { createSyntheticCore2Fixtures, selectEligibleTrustedContacts } from '../../../harness/core2';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';
import { ControlledClock } from './runner/ports';

describe('Matrix Row 03: Revocation before dispatch', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '03')!;

  it('unit/contract: consent revocation and trusted-contact withdrawal immediately exclude targets before dispatch', () => {
    const clock = new ControlledClock('2026-11-14T10:00:00.000Z');
    const c1 = createSyntheticCore1Fixtures('0003');
    const c2 = createSyntheticCore2Fixtures('0003');
    const callId = '11111111-0000-4000-8000-000000000001';

    const grant = {
      id: 'c-grant-1',
      familyId: c1.familyId,
      personId: c1.people.maa.id,
      callId,
      purpose: 'call_recording',
      answer: true,
      version: 'v1',
      createdAt: '2026-11-14T09:55:00.000Z',
    };
    const globalRefusalAtSameTs = {
      id: 'c-revoke-1',
      familyId: c1.familyId,
      personId: c1.people.maa.id,
      callId: null,
      purpose: 'call_recording',
      answer: false,
      version: 'v1',
      createdAt: '2026-11-14T09:55:00.000Z',
    };

    expect(
      consentIsCurrent({
        linked: grant,
        history: [grant],
        familyId: c1.familyId,
        personId: c1.people.maa.id,
        purpose: 'call_recording',
        callId,
        now: clock.nowDate(),
      }),
    ).toBe(true);

    // Equal-timestamp or later refusal revokes immediately.
    expect(
      latestConsent([grant, globalRefusalAtSameTs], c1.familyId, c1.people.maa.id, 'call_recording', callId)?.answer,
    ).toBe(false);
    expect(
      consentIsCurrent({
        linked: grant,
        history: [grant, globalRefusalAtSameTs],
        familyId: c1.familyId,
        personId: c1.people.maa.id,
        purpose: 'call_recording',
        callId,
        now: clock.nowDate(),
      }),
    ).toBe(false);

    const revokedContact = {
      ...c2.contacts.sharmaActiveSos,
      state: 'revoked' as const,
      revokedAtIso: clock.nowIso(),
    };
    expect(
      selectEligibleTrustedContacts([revokedContact], {
        familyId: c2.family.familyId,
        subjectPersonId: c2.family.people.riya.id,
        scope: 'sos',
        nowMs: clock.nowMs(),
      }),
    ).toHaveLength(0);
  });

  it('matrix status: remains blocked pending phase2/phase3 shared revocation advisory lock', () => {
    const result = evaluateMatrixStatus(rowSpec, {
      unitPassed: true,
      unitDetail: 'Foundation consentIsCurrent tie-to-refusal + trusted contact revocation filters verified',
      pgExecuted: false,
      pgPassed: false,
      pgDetail: 'Concurrent dispatch vs revocation lock tests blocked on kiro-a + kiro-b + agy3',
    });
    expect(result.overallStatus).toBe('blocked');
    expect(result.blockedBy).toEqual(['kiro-a (phase2-dispatch)', 'kiro-b (phase3-orchestration)', 'agy3 (core2)']);
  });
});
