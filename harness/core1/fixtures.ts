import type { SetupPermission, GateApproval, GateConsent } from '@sahaj/gate';

export interface SyntheticFamilyFixtures {
  readonly familyId: string;
  readonly timezone: 'Asia/Kolkata';
  readonly quietHours: { readonly startHour: number; readonly endHour: number };
  readonly people: {
    readonly maa: { id: string; role: 'parent'; name: string; phone: string };
    readonly riya: { id: string; role: 'child'; name: string; phone: string; userId: string };
    readonly rohit: { id: string; role: 'child'; name: string; phone: string; userId: string };
    readonly sharma: { id: string; role: 'circle'; name: string; phone: string; userId: string };
  };
  readonly vendor: {
    readonly guptaMedicalId: string;
    readonly paracetamolItemId: string;
    readonly metforminItemId: string;
  };
}

export function createSyntheticCore1Fixtures(seedTag = '0001'): SyntheticFamilyFixtures {
  const s = seedTag.padStart(4, '0').slice(-4);
  return {
    familyId: `10000000-0000-4000-8000-00000000${s}`,
    timezone: 'Asia/Kolkata',
    quietHours: { startHour: 22, endHour: 7 },
    people: {
      maa: {
        id: `10000000-0000-4000-8000-00000001${s}`,
        role: 'parent',
        name: 'Meena Maa',
        phone: '+919000000001',
      },
      riya: {
        id: `10000000-0000-4000-8000-00000002${s}`,
        role: 'child',
        name: 'Riya',
        phone: '+919000000002',
        userId: `20000000-0000-4000-8000-00000002${s}`,
      },
      rohit: {
        id: `10000000-0000-4000-8000-00000003${s}`,
        role: 'child',
        name: 'Rohit',
        phone: '+919000000003',
        userId: `20000000-0000-4000-8000-00000003${s}`,
      },
      sharma: {
        id: `10000000-0000-4000-8000-00000004${s}`,
        role: 'circle',
        name: 'Sharma Uncle',
        phone: '+919000000004',
        userId: `20000000-0000-4000-8000-00000004${s}`,
      },
    },
    vendor: {
      guptaMedicalId: `30000000-0000-4000-8000-00000001${s}`,
      paracetamolItemId: 'med-paracetamol-500mg',
      metforminItemId: 'med-metformin-500mg',
    },
  };
}

export function buildTwoPersonMedicinePermission(
  f: SyntheticFamilyFixtures,
  permissionId: string,
  now: Date,
): SetupPermission {
  const past = new Date(now.getTime() - 86_400_000).toISOString();
  const future = new Date(now.getTime() + 7 * 86_400_000).toISOString();
  return {
    id: permissionId,
    familyId: f.familyId,
    actorId: f.people.maa.id,
    action: 'medicine_refill',
    approvalMode: 'two_person',
    maxAmountMinor: 150_000, // INR 1,500.00 in paise
    maxUses: 1,
    usedCount: 0,
    vendorIds: [f.vendor.guptaMedicalId],
    itemIds: [f.vendor.paracetamolItemId, f.vendor.metforminItemId],
    targetIds: [f.people.maa.id],
    validFrom: past,
    expiresAt: future,
    periodStart: past,
    periodEnd: future,
  };
}

export function buildApproval(params: {
  id: string;
  familyId: string;
  permissionId: string;
  requestId: string;
  requestFingerprint: string;
  approverId: string;
  now: Date;
  approverCanApprove?: boolean;
}): GateApproval {
  return {
    id: params.id,
    familyId: params.familyId,
    permissionId: params.permissionId,
    requestId: params.requestId,
    requestFingerprint: params.requestFingerprint,
    approverId: params.approverId,
    approverActive: true,
    approverCanApprove: params.approverCanApprove ?? true,
    createdAt: new Date(params.now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(params.now.getTime() + 3_600_000).toISOString(),
  };
}

export function buildGateConsent(params: {
  familyId: string;
  subjectId: string;
  targetId: string;
  scope: 'record_audio' | 'share_data';
  now: Date;
  revokedAt?: Date;
}): GateConsent {
  return {
    familyId: params.familyId,
    subjectId: params.subjectId,
    targetId: params.targetId,
    scope: params.scope,
    grantedAt: new Date(params.now.getTime() - 3_600_000).toISOString(),
    expiresAt: new Date(params.now.getTime() + 86_400_000).toISOString(),
    ...(params.revokedAt ? { revokedAt: params.revokedAt.toISOString() } : {}),
  };
}
