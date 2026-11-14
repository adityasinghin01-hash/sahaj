import { describe, expect, it } from 'vitest';
import { evaluateGate, requestFingerprint, type GateInput, type GateApproval } from '../src/index';

function fixture(): GateInput {
  return {
    now: '2026-11-14T10:00:00Z', actor: { id: 'atlas', familyId: 'demo-family', active: true },
    request: { id: 'request-1', familyId: 'demo-family', action: 'check_in', targetId: 'demo-parent' },
    permissions: [{ id: 'permission-1', familyId: 'demo-family', actorId: 'atlas', action: 'check_in',
      validFrom: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z',
      maxAmountMinor: 50000, vendorIds: ['demo-pharmacy'], itemIds: ['medicine-a'], targetIds: ['demo-parent'],
      periodStart: '2026-11-14T00:00:00Z', periodEnd: '2026-11-15T00:00:00Z', maxUses: 2, usedCount: 0,
      approvalMode: 'setup' }], consents: [], approvals: [],
  };
}
function approved(input: GateInput, who: string): GateApproval {
  return { id: `approval-${who}`, approverId: who, requestId: input.request.id,
    requestFingerprint: requestFingerprint(input.request), permissionId: input.permissions[0].id,
    familyId: input.request.familyId, approverActive: true, approverCanApprove: true,
    createdAt: '2026-11-14T09:00:00Z', expiresAt: '2026-11-14T11:00:00Z' };
}

describe('Cedar setup authorization', () => {
  it('allows an exact explicit permission via the real Cedar engine', () => {
    expect(evaluateGate(fixture())).toEqual({ decision: 'allow', reason: 'allowed', permissionId: 'permission-1' });
  });
  it('requires a permission even for a free check-in', () => {
    const input = fixture(); input.permissions = [];
    expect(evaluateGate(input)).toMatchObject({ decision: 'ask', reason: 'no_permission' });
  });
  it.each(['payment', 'collect_otp', 'medical_diagnosis'] as const)('prohibits %s even with matching permission', action => {
    const input = fixture(); input.request.action = action; input.permissions[0].action = action;
    expect(evaluateGate(input)).toMatchObject({ decision: 'deny', reason: 'prohibited_action' });
  });
  it.each(['family', 'actor', 'action'])('does not borrow permission for another %s', field => {
    const input = fixture();
    if (field === 'family') input.permissions[0].familyId = 'other-family';
    if (field === 'actor') input.permissions[0].actorId = 'other-actor';
    if (field === 'action') input.permissions[0].action = 'send_alert';
    expect(evaluateGate(input).decision).toBe('ask');
  });
  it('denies cross-family actor and inactive membership', () => {
    const input = fixture(); input.actor.familyId = 'other-family'; expect(evaluateGate(input).decision).toBe('deny');
    input.actor.familyId = 'demo-family'; input.actor.active = false; expect(evaluateGate(input).decision).toBe('deny');
  });
  it.each(['expired', 'future', 'revoked', 'period-ended', 'period-future'])('denies %s permission', variant => {
    const input = fixture(), p = input.permissions[0];
    if (variant === 'expired') p.expiresAt = input.now;
    if (variant === 'future') p.validFrom = '2026-11-14T10:00:01Z';
    if (variant === 'revoked') p.revokedAt = input.now;
    if (variant === 'period-ended') p.periodEnd = input.now;
    if (variant === 'period-future') p.periodStart = '2026-11-14T10:00:01Z';
    expect(evaluateGate(input)).toMatchObject({ decision: 'deny', reason: 'permission_inactive' });
  });
  it('allows amount boundary and last available use; denies exceeding either', () => {
    const input = fixture(); input.request.amountMinor = 50000; input.permissions[0].usedCount = 1;
    expect(evaluateGate(input).decision).toBe('allow');
    input.request.amountMinor = 50001; expect(evaluateGate(input)).toMatchObject({ decision: 'deny', reason: 'limits_exceeded' });
    input.request.amountMinor = 50000; input.permissions[0].usedCount = 2;
    expect(evaluateGate(input)).toMatchObject({ decision: 'deny', reason: 'limits_exceeded' });
  });
  it('checks vendor and every item using Cedar set containment', () => {
    const input = fixture(); input.request.vendorId = 'demo-pharmacy'; input.request.itemIds = ['medicine-a'];
    expect(evaluateGate(input).decision).toBe('allow');
    input.request.itemIds.push('medicine-b'); expect(evaluateGate(input).decision).toBe('deny');
    input.request.itemIds = ['medicine-a']; input.request.vendorId = 'other-vendor'; expect(evaluateGate(input).decision).toBe('deny');
  });
  it('denies targets outside the explicit setup allowlist', () => {
    const input = fixture(); input.request.targetId = 'another-parent';
    expect(evaluateGate(input)).toMatchObject({ decision: 'deny', reason: 'limits_exceeded' });
  });
  it('denies refill requests with unknown cost, vendor or items', () => {
    const input = fixture(); input.request.action = 'medicine_refill'; input.permissions[0].action = 'medicine_refill';
    expect(evaluateGate(input).reason).toBe('invalid_input');
    input.request.amountMinor = 0; input.request.vendorId = 'demo-pharmacy';
    expect(evaluateGate(input).reason).toBe('invalid_input');
  });
  it.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('fails closed for invalid amount %s', amount => {
    const input = fixture(); input.request.amountMinor = amount;
    expect(evaluateGate(input)).toMatchObject({ decision: 'deny', reason: 'invalid_input' });
  });
  it('fails closed on malformed snapshots and dates', () => {
    expect(evaluateGate(null as unknown as GateInput).decision).toBe('deny');
    const input = fixture(); input.permissions[0].usedCount = -1; expect(evaluateGate(input).decision).toBe('deny');
    input.permissions[0].usedCount = 0; input.now = 'unknown'; expect(evaluateGate(input).decision).toBe('deny');
  });
});

describe('two-person approval', () => {
  it('allows an explicit setup-preapproved refill once per month', () => {
    const input = fixture(); input.request.action = 'medicine_refill'; input.permissions[0].action = 'medicine_refill';
    input.request.amountMinor = 60000; input.request.vendorId = 'demo-pharmacy'; input.request.itemIds = ['medicine-a'];
    input.permissions[0].maxAmountMinor = 60000; input.permissions[0].maxUses = 1;
    input.permissions[0].periodStart = '2026-11-01T00:00:00Z'; input.permissions[0].periodEnd = '2026-12-01T00:00:00Z';
    expect(evaluateGate(input)).toMatchObject({ decision: 'allow', reason: 'allowed' });
    input.permissions[0].usedCount = 1;
    expect(evaluateGate(input)).toMatchObject({ decision: 'deny', reason: 'limits_exceeded' });
  });
  it('requires two distinct people for a refill and binds their decisions to the payload', () => {
    const input = fixture(); input.request.action = 'medicine_refill'; input.permissions[0].action = 'medicine_refill';
    input.request.amountMinor = 0; input.request.vendorId = 'demo-pharmacy'; input.request.itemIds = ['medicine-a'];
    input.permissions[0].approvalMode = 'two_person';
    expect(evaluateGate(input)).toMatchObject({ decision: 'ask', reason: 'approval_required', approvalRequired: 2 });
    input.approvals = [approved(input, 'person-a')]; expect(evaluateGate(input).approvalRequired).toBe(1);
    input.approvals.push(approved(input, 'person-b')); expect(evaluateGate(input).decision).toBe('allow');
    input.request.amountMinor = 1; expect(evaluateGate(input)).toMatchObject({ decision: 'deny', reason: 'invalid_approval' });
  });
  it('honors two-person mode for otherwise safe actions', () => {
    const input = fixture(); input.permissions[0].approvalMode = 'two_person';
    expect(evaluateGate(input).decision).toBe('ask');
    input.approvals = [approved(input, 'person-a'), approved(input, 'person-b')]; expect(evaluateGate(input).decision).toBe('allow');
  });
  it.each(['duplicate-person', 'duplicate-id', 'wrong-family', 'wrong-permission', 'expired', 'future', 'revoked', 'inactive', 'unauthorized', 'self'])('rejects %s approval', variant => {
    const input = fixture(); input.permissions[0].approvalMode = 'two_person';
    input.approvals = [approved(input, 'person-a'), approved(input, 'person-b')]; const a = input.approvals[1];
    if (variant === 'duplicate-person') a.approverId = 'person-a';
    if (variant === 'duplicate-id') a.id = input.approvals[0].id;
    if (variant === 'wrong-family') a.familyId = 'other-family';
    if (variant === 'wrong-permission') a.permissionId = 'other-permission';
    if (variant === 'expired') a.expiresAt = input.now;
    if (variant === 'future') a.createdAt = '2026-11-14T10:00:01Z';
    if (variant === 'revoked') a.revokedAt = input.now;
    if (variant === 'inactive') a.approverActive = false;
    if (variant === 'unauthorized') a.approverCanApprove = false;
    if (variant === 'self') a.approverId = input.actor.id;
    expect(evaluateGate(input)).toMatchObject({ decision: 'deny', reason: 'invalid_approval' });
  });
  it('cannot override Cedar amount restrictions with approvals', () => {
    const input = fixture(); input.permissions[0].approvalMode = 'two_person'; input.request.amountMinor = 50001;
    input.approvals = [approved(input, 'person-a'), approved(input, 'person-b')];
    expect(evaluateGate(input)).toMatchObject({ decision: 'deny', reason: 'limits_exceeded' });
  });
});

describe('recording and data sharing consent', () => {
  it.each(['record_audio', 'share_data'] as const)('requires live subject-specific consent for %s', action => {
    const input = fixture(); input.request.action = action; input.permissions[0].action = action; input.request.consentSubjectId = 'demo-parent';
    input.approvals = [approved(input, 'person-a'), approved(input, 'person-b')];
    expect(evaluateGate(input)).toMatchObject({ decision: 'ask', reason: 'consent_required' });
    input.consents = [{ subjectId: 'demo-parent', targetId: 'demo-parent', familyId: 'demo-family', scope: action,
      grantedAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z' }];
    expect(evaluateGate(input).decision).toBe('allow');
    input.consents[0].revokedAt = input.now; expect(evaluateGate(input).decision).toBe('ask');
    input.consents[0].revokedAt = null; input.consents[0].expiresAt = input.now; expect(evaluateGate(input).decision).toBe('ask');
    input.consents[0].expiresAt = '2026-12-01T00:00:00Z'; input.consents[0].subjectId = 'other-parent'; expect(evaluateGate(input).decision).toBe('ask');
    input.consents[0].subjectId = 'demo-parent'; input.consents[0].targetId = 'another-recipient';
    expect(evaluateGate(input).reason).toBe('consent_required');
  });
});
