import { describe, expect, it } from 'vitest';
import { createSyntheticCore1Fixtures, resolveScopedCore1Target } from '../../../harness/core1';
import { createSyntheticCore2Fixtures, selectEligibleTrustedContacts } from '../../../harness/core2';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';

describe('Matrix Row 05: Same-family target substitution', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '05')!;

  it('unit/contract: family membership alone never grants responder or contact substitution', () => {
    const c1 = createSyntheticCore1Fixtures('0005');
    const c2 = createSyntheticCore2Fixtures('0005');

    // Core 1 resolver rejects unapproved same-family member.
    const directory = [
      { personId: c1.people.sharma.id, familyId: c1.familyId, active: true, role: 'circle' as const, scopes: ['urgent_responder'] },
      { personId: c1.people.rohit.id, familyId: c1.familyId, active: true, role: 'child' as const, scopes: [] },
    ];
    expect(resolveScopedCore1Target(c1.people.sharma.id, c1.familyId, 'urgent_responder', directory).ok).toBe(true);
    expect(resolveScopedCore1Target(c1.people.rohit.id, c1.familyId, 'urgent_responder', directory)).toEqual({
      ok: false,
      code: 'target_unscoped_or_revoked',
    });

    // Core 2 trusted contact selector excludes same-family pending_consent member (Rohit).
    const eligible = selectEligibleTrustedContacts(
      [c2.contacts.sharmaActiveSos, c2.contacts.rohitUnconsentedFamilyMember],
      {
        familyId: c2.family.familyId,
        subjectPersonId: c2.family.people.riya.id,
        scope: 'sos',
        nowMs: Date.parse('2026-11-14T10:00:00.000Z'),
      },
    );
    expect(eligible.map((c) => c.contactPersonId)).toEqual([c2.family.people.sharma.id]);
  });

  it('matrix status: remains blocked pending Core 1 + Core 2 route target resolvers', () => {
    const result = evaluateMatrixStatus(rowSpec, {
      unitPassed: true,
      unitDetail: 'Core 1 & Core 2 contract resolvers reject same-family unscoped substitution',
      pgExecuted: false,
      pgPassed: false,
      pgDetail: 'Server endpoint resolver tests blocked on agy-phase4 (core1) + agy3 (core2)',
    });
    expect(result.overallStatus).toBe('blocked');
  });
});
