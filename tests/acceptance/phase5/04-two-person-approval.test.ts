import { describe, expect, it } from 'vitest';
import { evaluateGate, requestFingerprint, type GateRequest } from '@sahaj/gate';
import {
  buildApproval,
  buildTwoPersonMedicinePermission,
  createSyntheticCore1Fixtures,
} from '../../../harness/core1';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';
import { ControlledClock } from './runner/ports';

describe('Matrix Row 04: Two-person approval (Cedar gate)', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '04')!;

  it('unit/contract: @sahaj/gate requires 2 distinct authorized approvers bound to exact requestFingerprint', () => {
    const clock = new ControlledClock('2026-11-14T10:00:00.000Z');
    const now = clock.nowDate();
    const nowIso = clock.nowIso();
    const fam = createSyntheticCore1Fixtures('0004');
    const permissionId = '50000000-0000-4000-8000-000000000001';
    const requestId = '50000000-0000-4000-8000-000000000002';

    const request: GateRequest = {
      id: requestId,
      familyId: fam.familyId,
      action: 'medicine_refill',
      targetId: fam.people.maa.id,
      vendorId: fam.vendor.guptaMedicalId,
      itemIds: [fam.vendor.paracetamolItemId],
      amountMinor: 42_000,
    };
    const permission = buildTwoPersonMedicinePermission(fam, permissionId, now);
    const fingerprint = requestFingerprint(request);

    // 1. Only 1 approval -> 'ask' with approvalRequired=1.
    const oneApproval = buildApproval({
      id: 'appr-1',
      familyId: fam.familyId,
      permissionId,
      requestId,
      requestFingerprint: fingerprint,
      approverId: fam.people.riya.id,
      now,
    });
    const d1 = evaluateGate({
      now: nowIso,
      actor: { id: fam.people.maa.id, familyId: fam.familyId, active: true },
      request,
      permissions: [permission],
      approvals: [oneApproval],
      consents: [],
    });
    expect(d1).toMatchObject({ decision: 'ask', reason: 'approval_required', approvalRequired: 1 });

    // 2. Same approver trying twice (distinct approval ids) -> 'deny' ('invalid_approval').
    const duplicateApprover = buildApproval({
      id: 'appr-2-same-person',
      familyId: fam.familyId,
      permissionId,
      requestId,
      requestFingerprint: fingerprint,
      approverId: fam.people.riya.id,
      now,
    });
    const dDup = evaluateGate({
      now: nowIso,
      actor: { id: fam.people.maa.id, familyId: fam.familyId, active: true },
      request,
      permissions: [permission],
      approvals: [oneApproval, duplicateApprover],
      consents: [],
    });
    expect(dDup).toMatchObject({ decision: 'deny', reason: 'invalid_approval' });

    // 3. Two distinct authorized approvers -> 'allow'.
    const secondApprover = buildApproval({
      id: 'appr-2-rohit',
      familyId: fam.familyId,
      permissionId,
      requestId,
      requestFingerprint: fingerprint,
      approverId: fam.people.rohit.id,
      now,
    });
    const dAllow = evaluateGate({
      now: nowIso,
      actor: { id: fam.people.maa.id, familyId: fam.familyId, active: true },
      request,
      permissions: [permission],
      approvals: [oneApproval, secondApprover],
      consents: [],
    });
    expect(dAllow).toMatchObject({ decision: 'allow', reason: 'allowed', permissionId });

    // 4. Modified amount after approval -> fingerprint mismatch -> 'deny' ('invalid_approval').
    const tamperedRequest: GateRequest = { ...request, amountMinor: 49_900 };
    const dTampered = evaluateGate({
      now: nowIso,
      actor: { id: fam.people.maa.id, familyId: fam.familyId, active: true },
      request: tamperedRequest,
      permissions: [permission],
      approvals: [oneApproval, secondApprover],
      consents: [],
    });
    expect(dTampered).toMatchObject({ decision: 'deny', reason: 'invalid_approval' });
  });

  it('matrix status: blocked until phase3 atomic approval-consumption + core1 refill command merge', () => {
    const result = evaluateMatrixStatus(rowSpec, {
      unitPassed: true,
      unitDetail: '@sahaj/gate evaluateGate & requestFingerprint verified across 1/dup/2/tampered cases',
      pgExecuted: false,
      pgPassed: false,
      pgDetail: 'DB atomic approval consumption blocked on kiro-b (phase3-orchestration) + agy-phase4 (core1)',
    });
    expect(result.overallStatus).toBe('blocked');
  });
});
