import {
  evaluateGate,
  requestFingerprint,
  type GateApproval,
  type GateDecision,
  type GateRequest,
  type SetupPermission,
} from '@sahaj/gate';
import {
  generateRefillProposal,
  isStrictNonNegativeInteger,
  isStrictPositiveInteger,
} from '../../../../../packages/atlas/src/core1/medicine-inventory';
import type { MedicineRecord, VendorRecord } from '../../../../../packages/atlas/src/core1/types';
import { Core1CommandError } from './errors';
import { assertCommandCapability } from './capabilities';
import {
  extractIdempotencyKey,
  isValidUuid,
  validateUuid,
} from './validation';
import {
  clockAt,
  createSupabaseCore1AuthPort,
  createSupabaseCore1OutboxPort,
  createSupabaseCore1TimelinePort,
  parseOptionalFamilyId,
  readCore1JsonRequest,
  stableCore1Uuid,
  toFamilyMembership,
  type Core1AuthPort,
  type Core1OutboxPort,
  type Core1TimelinePort,
  type SupabaseClientLike,
} from './wiring-common';
import { postZapierHook, type ZapierDispatchOutcome, type ZapierFetch } from './zapier';
import { serviceDatabase } from '../database';

export interface RefillPermissionRow {
  id: string;
  familyId: string;
  personId: string;
  principalId: string | null;
  action: string;
  decision: 'allow' | 'deny' | 'ask';
  validFrom: string;
  expiresAt: string;
  periodStart: string;
  periodEnd: string;
  maxUses: number;
  usedCount: number;
  maxAmountMinor: number;
  targetIds: string[];
  vendorIds: string[];
  itemIds: string[];
  twoPersonRequired: boolean;
  revokedAt: string | null;
}

export interface RefillActionRequestRow {
  id: string;
  requestId: string;
  errandId: string;
  familyId: string;
  personId: string;
  permissionId: string | null;
  principalId: string | null;
  action: 'medicine_refill';
  targetId: string | null;
  amountMinor: number;
  vendorId: string | null;
  medicineId: string;
  itemIds: string[];
  requestFingerprint: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';
  errandStatus: 'pending' | 'authorized' | 'dispatched' | 'completed' | 'failed' | 'cancelled';
  expiresAt: string;
  twoPersonRequired: boolean;
  consumedAt: string | null;
}

export interface RefillApprovalAnswerRow {
  actionRequestId: string;
  approverPersonId: string;
  answer: boolean;
  answeredAt: string;
  approverActive: boolean;
  approverRole: 'parent' | 'child' | 'circle';
}

export interface ExtendedMedicineRecord extends MedicineRecord {
  estimatedUnitPriceMinor: number;
}

export interface RefillStore {
  getMedicine(familyId: string, medicineId: string): Promise<ExtendedMedicineRecord | null>;
  getVendor(familyId: string, vendorId: string): Promise<VendorRecord | null>;
  verifyPersonInFamily(familyId: string, personId: string): Promise<boolean>;
  listMedicineRefillPermissions(familyId: string): Promise<RefillPermissionRow[]>;
  createProposalState(input: {
    requestId: string;
    actionRequestId: string;
    errandId: string;
    familyId: string;
    personId: string;
    principalId: string;
    permissionId: string | null;
    medicineId: string;
    vendorId: string;
    amountMinor: number;
    requestFingerprint: string;
    twoPersonRequired: boolean;
    requestStatus: 'pending' | 'approved' | 'denied';
    actionStatus: 'pending' | 'approved' | 'denied';
    errandStatus: 'pending' | 'authorized' | 'cancelled';
    expiresAt: string;
    consumedAt: string | null;
  }): Promise<void>;
  getActionRequestWithErrand(familyId: string, actionRequestId: string): Promise<RefillActionRequestRow | null>;
  listApprovals(familyId: string, actionRequestId: string): Promise<RefillApprovalAnswerRow[]>;
  upsertApprovalAnswer(input: {
    familyId: string;
    actionRequestId: string;
    approverPersonId: string;
    answer: boolean;
    answeredAt: string;
  }): Promise<void>;
  updateRefillState(input: {
    familyId: string;
    actionRequestId: string;
    requestId: string;
    errandId: string;
    permissionId?: string | null;
    actionStatus: 'pending' | 'approved' | 'denied' | 'executed';
    requestStatus: 'pending' | 'approved' | 'denied' | 'completed';
    errandStatus: 'pending' | 'authorized' | 'dispatched' | 'completed' | 'cancelled';
    consumedAt?: string | null;
  }): Promise<void>;
  incrementPermissionUsage(familyId: string, permissionId: string): Promise<void>;
  recordRiyaCardAlert(input: {
    id: string;
    familyId: string;
    recipientPersonId: string;
    kind: string;
  }): Promise<void>;
  findDefaultChildRecipient(familyId: string): Promise<string | null>;
  decrementMedicineRemainingCount(input: {
    familyId: string;
    medicineId: string;
    decrementBy: number;
  }): Promise<{ previousCount: number; newCount: number }>;
}

export interface RefillServiceDeps {
  auth: Core1AuthPort;
  store: RefillStore;
  outbox: Core1OutboxPort;
  timeline: Core1TimelinePort;
  env?: Record<string, string | undefined>;
  fetchImpl?: ZapierFetch;
  now?: () => Date;
}

function asArrayOfStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function createSupabaseRefillStore(db: SupabaseClientLike): RefillStore {
  return {
    async getMedicine(familyId, medicineId) {
      const { data, error } = await db
        .from('medicines')
        .select('id,family_id,person_id,label,remaining_count,refill_threshold,instructions_confirmed_by_person')
        .eq('family_id', familyId)
        .eq('id', medicineId)
        .maybeSingle();
      if (error) throw new Core1CommandError('medicine_lookup_failed', 503);
      if (!data) return null;
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id),
        familyId: String(r.family_id),
        personId: String(r.person_id),
        label: String(r.label),
        remainingCount: Number(r.remaining_count ?? 0),
        refillThreshold: Number(r.refill_threshold ?? 3),
        instructionsConfirmedByPerson: Boolean(r.instructions_confirmed_by_person),
        unitDose: 1,
        packSize: 1,
        estimatedUnitPriceMinor: 0,
      };
    },

    async getVendor(familyId, vendorId) {
      const { data, error } = await db
        .from('vendors')
        .select('id,family_id,approved_at,revoked_at')
        .eq('family_id', familyId)
        .eq('id', vendorId)
        .maybeSingle();
      if (error) throw new Core1CommandError('vendor_lookup_failed', 503);
      if (!data) return null;
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id),
        familyId: String(r.family_id),
        approved: Boolean(r.approved_at),
        revokedAt: typeof r.revoked_at === 'string' ? r.revoked_at : null,
      };
    },

    async verifyPersonInFamily(familyId, personId) {
      const { data, error } = await db
        .from('people')
        .select('id')
        .eq('family_id', familyId)
        .eq('id', personId)
        .maybeSingle();
      if (error) throw new Core1CommandError('person_lookup_failed', 503);
      return Boolean(data && (data as { active?: boolean }).active !== false);
    },

    async listMedicineRefillPermissions(familyId) {
      const { data, error } = await db
        .from('permissions')
        .select('id,family_id,person_id,principal_id,action,decision,limits,valid_from,expires_at,period_start,period_end,max_uses,used_count,max_amount_minor,target_ids,vendor_ids,item_ids,two_person_required,revoked_at,created_at')
        .eq('family_id', familyId)
        .eq('action', 'medicine_refill');
      if (error) throw new Core1CommandError('permission_lookup_failed', 503);
      return ((data ?? []) as Array<Record<string, unknown>>).map((p) => {
        const limits = (p.limits && typeof p.limits === 'object' ? p.limits : {}) as Record<string, unknown>;
        const targetIds = asArrayOfStrings(p.target_ids);
        const vendorIds = asArrayOfStrings(p.vendor_ids);
        const itemIds = asArrayOfStrings(p.item_ids);
        return {
          id: String(p.id),
          familyId: String(p.family_id),
          personId: String(p.person_id),
          principalId: typeof p.principal_id === 'string' ? p.principal_id : null,
          action: String(p.action),
          decision: p.decision as 'allow' | 'deny' | 'ask',
          validFrom: String(p.valid_from ?? p.created_at),
          expiresAt: String(p.expires_at),
          periodStart: String(p.period_start ?? p.valid_from ?? p.created_at),
          periodEnd: String(p.period_end ?? p.expires_at),
          maxUses: Number(p.max_uses ?? limits.max_uses ?? 100),
          usedCount: Number(p.used_count ?? 0),
          maxAmountMinor: Number(p.max_amount_minor ?? limits.max_amount_minor ?? 0),
          targetIds: targetIds.length > 0 ? targetIds : asArrayOfStrings(limits.target_ids),
          vendorIds: vendorIds.length > 0 ? vendorIds : asArrayOfStrings(limits.vendor_ids),
          itemIds: itemIds.length > 0 ? itemIds : asArrayOfStrings(limits.item_ids),
          twoPersonRequired: Boolean(p.two_person_required),
          revokedAt: typeof p.revoked_at === 'string' ? p.revoked_at : null,
        };
      });
    },

    async createProposalState(input) {
      const { data: existingAr } = await db
        .from('action_requests')
        .select('id')
        .eq('family_id', input.familyId)
        .eq('id', input.actionRequestId)
        .maybeSingle();
      if (existingAr) return;

      const { error: reqErr } = await db.from('requests').upsert(
        {
          id: input.requestId,
          family_id: input.familyId,
          person_id: input.personId,
          kind: 'medicine_refill',
          status: input.requestStatus,
        },
        { onConflict: 'id' },
      );
      if (reqErr) throw new Core1CommandError('request_persist_failed', 503);

      const { error: arErr } = await db.from('action_requests').upsert(
        {
          id: input.actionRequestId,
          family_id: input.familyId,
          person_id: input.personId,
          permission_id: input.permissionId,
          principal_id: input.principalId,
          action: 'medicine_refill',
          target_id: input.personId,
          amount_minor: input.amountMinor,
          vendor_id: input.vendorId,
          item_ids: [input.medicineId],
          request_fingerprint: input.requestFingerprint,
          status: input.actionStatus,
          expires_at: input.expiresAt,
          two_person_required: input.twoPersonRequired,
          consumed_at: input.consumedAt,
        },
        { onConflict: 'id' },
      );
      if (arErr) throw new Core1CommandError('action_request_persist_failed', 503);

      const { error: errErr } = await db.from('errands').upsert(
        {
          id: input.errandId,
          family_id: input.familyId,
          request_id: input.requestId,
          action_request_id: input.actionRequestId,
          vendor_id: input.vendorId,
          medicine_id: input.medicineId,
          status: input.errandStatus,
        },
        { onConflict: 'id' },
      );
      if (errErr) throw new Core1CommandError('errand_persist_failed', 503);
    },

    async getActionRequestWithErrand(familyId, actionRequestId) {
      const [{ data: ar, error: arErr }, { data: er, error: erErr }] = await Promise.all([
        db
          .from('action_requests')
          .select('id,family_id,person_id,permission_id,principal_id,action,target_id,amount_minor,vendor_id,item_ids,request_fingerprint,status,expires_at,two_person_required,consumed_at')
          .eq('family_id', familyId)
          .eq('id', actionRequestId)
          .maybeSingle(),
        db
          .from('errands')
          .select('id,request_id,vendor_id,medicine_id,status')
          .eq('family_id', familyId)
          .eq('action_request_id', actionRequestId)
          .maybeSingle(),
      ]);
      if (arErr || erErr) throw new Core1CommandError('action_request_lookup_failed', 503);
      if (!ar || !er) return null;
      const a = ar as Record<string, unknown>;
      const e = er as Record<string, unknown>;
      return {
        id: String(a.id),
        requestId: String(e.request_id),
        errandId: String(e.id),
        familyId: String(a.family_id),
        personId: String(a.person_id),
        permissionId: typeof a.permission_id === 'string' ? a.permission_id : null,
        principalId: typeof a.principal_id === 'string' ? a.principal_id : null,
        action: 'medicine_refill',
        targetId: typeof a.target_id === 'string' ? a.target_id : null,
        amountMinor: Number(a.amount_minor ?? 0),
        vendorId: typeof e.vendor_id === 'string' ? e.vendor_id : (typeof a.vendor_id === 'string' ? a.vendor_id : null),
        medicineId: String(e.medicine_id),
        itemIds: asArrayOfStrings(a.item_ids),
        requestFingerprint: typeof a.request_fingerprint === 'string' ? a.request_fingerprint : null,
        status: a.status as RefillActionRequestRow['status'],
        errandStatus: e.status as RefillActionRequestRow['errandStatus'],
        expiresAt: String(a.expires_at),
        twoPersonRequired: Boolean(a.two_person_required),
        consumedAt: typeof a.consumed_at === 'string' ? a.consumed_at : null,
      };
    },

    async listApprovals(familyId, actionRequestId) {
      const [{ data: answers, error: ansErr }, { data: members, error: memErr }] = await Promise.all([
        db
          .from('action_answers')
          .select('action_request_id,approver_person_id,answer,answered_at')
          .eq('family_id', familyId)
          .eq('action_request_id', actionRequestId),
        db
          .from('family_memberships')
          .select('person_id,role,revoked_at,people!inner(id)')
          .eq('family_id', familyId)
          .is('revoked_at', null),
      ]);
      if (ansErr || memErr) throw new Core1CommandError('approvals_lookup_failed', 503);

      const memberMap = new Map<string, { role: 'parent' | 'child' | 'circle'; active: boolean }>();
      for (const m of (members ?? []) as Array<Record<string, unknown>>) {
        const person = Array.isArray(m.people) ? m.people[0] : m.people;
        const active = !person || (person as { active?: boolean }).active !== false;
        memberMap.set(String(m.person_id), {
          role: m.role as 'parent' | 'child' | 'circle',
          active,
        });
      }

      return ((answers ?? []) as Array<Record<string, unknown>>).map((a) => {
        const approverId = String(a.approver_person_id);
        const mem = memberMap.get(approverId);
        return {
          actionRequestId: String(a.action_request_id),
          approverPersonId: approverId,
          answer: Boolean(a.answer),
          answeredAt: String(a.answered_at),
          approverActive: Boolean(mem?.active),
          approverRole: mem?.role ?? 'circle',
        };
      });
    },

    async upsertApprovalAnswer(input) {
      const { error } = await db.from('action_answers').upsert(
        {
          family_id: input.familyId,
          action_request_id: input.actionRequestId,
          approver_person_id: input.approverPersonId,
          answer: input.answer,
          answered_at: input.answeredAt,
        },
        { onConflict: 'family_id,action_request_id,approver_person_id' },
      );
      if (error) throw new Core1CommandError('approval_persist_failed', 503);
    },

    async updateRefillState(input) {
      const arUpdate: Record<string, unknown> = { status: input.actionStatus };
      if (input.permissionId !== undefined) arUpdate.permission_id = input.permissionId;
      if (input.consumedAt !== undefined) arUpdate.consumed_at = input.consumedAt;

      const [{ error: arErr }, { error: erErr }, { error: reqErr }] = await Promise.all([
        db
          .from('action_requests')
          .update(arUpdate)
          .eq('family_id', input.familyId)
          .eq('id', input.actionRequestId),
        db
          .from('errands')
          .update({ status: input.errandStatus })
          .eq('family_id', input.familyId)
          .eq('id', input.errandId),
        db
          .from('requests')
          .update({ status: input.requestStatus })
          .eq('family_id', input.familyId)
          .eq('id', input.requestId),
      ]);
      if (arErr || erErr || reqErr) {
        throw new Core1CommandError('refill_state_update_failed', 503);
      }
    },

    async incrementPermissionUsage(familyId, permissionId) {
      const { data: row, error: readErr } = await db
        .from('permissions')
        .select('used_count')
        .eq('family_id', familyId)
        .eq('id', permissionId)
        .maybeSingle();
      if (readErr || !row) return;
      const nextCount = Number((row as { used_count?: number }).used_count ?? 0) + 1;
      await db
        .from('permissions')
        .update({ used_count: nextCount })
        .eq('family_id', familyId)
        .eq('id', permissionId);
    },

    async recordRiyaCardAlert(input) {
      const { error } = await db.from('child_alerts').upsert(
        {
          id: input.id,
          family_id: input.familyId,
          person_id: input.recipientPersonId,
          incident_id: null,
          kind: input.kind,
        },
        { onConflict: 'id' },
      );
      if (error) throw new Core1CommandError('card_alert_persist_failed', 503);
    },

    async findDefaultChildRecipient(familyId) {
      const { data, error } = await db
        .from('family_memberships')
        .select('person_id')
        .eq('family_id', familyId)
        .eq('role', 'child')
        .is('revoked_at', null)
        .order('created_at', { ascending: true })
        .limit(1);
      if (error) return null;
      const first = (data ?? [])[0] as { person_id?: string } | undefined;
      return first?.person_id ?? null;
    },

    async decrementMedicineRemainingCount(input) {
      const { data: row, error: readErr } = await db
        .from('medicines')
        .select('remaining_count')
        .eq('family_id', input.familyId)
        .eq('id', input.medicineId)
        .single();
      if (readErr || !row) throw new Core1CommandError('medicine_lookup_failed', 503);
      const previousCount = Number((row as { remaining_count?: number }).remaining_count ?? 0);
      const newCount = Math.max(0, previousCount - input.decrementBy);
      const { error: updateErr } = await db
        .from('medicines')
        .update({ remaining_count: newCount })
        .eq('family_id', input.familyId)
        .eq('id', input.medicineId);
      if (updateErr) throw new Core1CommandError('medicine_update_failed', 503);
      return { previousCount, newCount };
    },
  };
}

function evaluateRefillCedarGate(params: {
  familyId: string;
  actorId: string;
  gateRequest: GateRequest;
  permissions: RefillPermissionRow[];
  answers: RefillApprovalAnswerRow[];
  requestExpiresAt: string;
  forceTwoPerson: boolean;
  nowIso: string;
}): { decision: 'allow' | 'ask' | 'deny'; reason: string; permissionId?: string; approvalRequired?: number } {
  const { familyId, actorId, gateRequest, permissions, answers, requestExpiresAt, forceTwoPerson, nowIso } = params;

  const hasLiveDeny = permissions.some(
    (p) =>
      p.decision === 'deny' &&
      !p.revokedAt &&
      Date.parse(p.validFrom) <= Date.parse(nowIso) &&
      Date.parse(nowIso) < Date.parse(p.expiresAt),
  );
  if (hasLiveDeny) {
    return { decision: 'deny', reason: 'permission_denied' };
  }

  const allowRows = permissions.filter((p) => p.decision === 'allow');
  if (allowRows.length === 0) {
    return { decision: 'deny', reason: 'no_permission' };
  }

  if (answers.some((a) => !a.answer)) {
    return { decision: 'deny', reason: 'denied_by_family' };
  }

  const fingerprint = requestFingerprint(gateRequest);
  let lastDecision: { decision: 'allow' | 'ask' | 'deny'; reason: string; permissionId?: string; approvalRequired?: number } = {
    decision: 'deny',
    reason: 'limits_exceeded',
  };

  for (const row of allowRows) {
    const boundActorId = row.principalId ?? actorId;
    const perm: SetupPermission = {
      id: row.id,
      familyId,
      actorId: boundActorId,
      action: 'medicine_refill',
      validFrom: row.validFrom,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      maxAmountMinor: row.maxAmountMinor,
      vendorIds: row.vendorIds,
      itemIds: row.itemIds,
      targetIds: row.targetIds,
      approvalMode: row.twoPersonRequired || forceTwoPerson ? 'two_person' : 'setup',
    };

    const approvals: GateApproval[] = answers
      .filter((a) => a.answer)
      .map((a) => ({
        id: `${gateRequest.id}:${a.approverPersonId}`,
        familyId,
        requestId: gateRequest.id,
        permissionId: row.id,
        approverId: a.approverPersonId,
        approverActive: a.approverActive,
        approverCanApprove: a.approverRole === 'parent' || a.approverRole === 'child',
        requestFingerprint: fingerprint,
        createdAt: a.answeredAt,
        expiresAt: requestExpiresAt,
      }));

    const decision = evaluateGate({
      actor: { id: boundActorId, familyId, active: true },
      request: gateRequest,
      permissions: [perm],
      approvals,
      consents: [],
      now: nowIso,
    });

    if (decision.decision === 'allow' || decision.decision === 'ask') {
      return decision;
    }
    lastDecision = decision;
  }

  return lastDecision;
}

async function emitOptionalZapierWebhooks(params: {
  deps: RefillServiceDeps;
  z1Event: 'refill.authorized' | 'refill.dispatched' | 'refill.delivered' | 'refill.approval_requested';
  familyId: string;
  personId: string;
  medicine: ExtendedMedicineRecord;
  vendorId: string | null;
  actionRequestId: string;
  errandId: string;
  reorderPacks: number;
  amountMinor: number;
  status: string;
  occurredAt: string;
}): Promise<{ z1: ZapierDispatchOutcome; z5?: ZapierDispatchOutcome }> {
  const z1 = await postZapierHook({
    hook: 'ZAPIER_HOOK_Z1',
    env: params.deps.env,
    fetchImpl: params.deps.fetchImpl,
    payload: {
      schema: 'sahaj.zapier.z1.v1',
      event: params.z1Event,
      familyId: params.familyId,
      personId: params.personId,
      medicineId: params.medicine.id,
      vendorId: params.vendorId,
      actionRequestId: params.actionRequestId,
      errandId: params.errandId,
      medicineLabel: params.medicine.label,
      reorderPacks: params.reorderPacks,
      amountMinor: params.amountMinor,
      status: params.status,
      occurredAt: params.occurredAt,
    },
  });

  let z5: ZapierDispatchOutcome | undefined;
  if (params.medicine.remainingCount <= params.medicine.refillThreshold) {
    z5 = await postZapierHook({
      hook: 'ZAPIER_HOOK_Z5',
      env: params.deps.env,
      fetchImpl: params.deps.fetchImpl,
      payload: {
        schema: 'sahaj.zapier.z5.v1',
        event: 'reminder.refill_due',
        familyId: params.familyId,
        personId: params.personId,
        entityId: params.medicine.id,
        label: params.medicine.label,
        dueAt: params.occurredAt,
        summary: `Low stock threshold reached (${params.medicine.remainingCount} remaining) for ${params.medicine.label}.`,
        occurredAt: params.occurredAt,
      },
    });
  }

  return { z1, z5 };
}

function parseProposeBody(raw: Record<string, unknown>) {
  const allowed = new Set([
    'medicineId', 'medicine_id',
    'personId', 'person_id',
    'vendorId', 'vendor_id',
    'reorderPacks', 'reorder_packs',
    'amountMinor', 'amount_minor',
    'twoPersonRequired', 'two_person_required',
    'doseAction', 'dose_action',
    'doseCount', 'dose_count',
    'familyId', 'family_id',
    'idempotencyKey', 'idempotency_key',
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new Core1CommandError(`unexpected_field_${key}`, 400);
    }
  }

  const medicineId = validateUuid(raw.medicineId ?? raw.medicine_id, 'medicine_id');
  const personId = validateUuid(raw.personId ?? raw.person_id, 'person_id');
  const vendorId = validateUuid(raw.vendorId ?? raw.vendor_id, 'vendor_id');

  let reorderPacks = 1;
  const rpRaw = raw.reorderPacks ?? raw.reorder_packs;
  if (rpRaw !== undefined) {
    if (typeof rpRaw !== 'number' || !isStrictPositiveInteger(rpRaw) || rpRaw > 100) {
      throw new Core1CommandError('invalid_reorder_packs', 400);
    }
    reorderPacks = rpRaw;
  }

  let amountMinorOverride: number | undefined;
  const amtRaw = raw.amountMinor ?? raw.amount_minor;
  if (amtRaw !== undefined) {
    if (typeof amtRaw !== 'number' || !isStrictNonNegativeInteger(amtRaw)) {
      throw new Core1CommandError('invalid_amount_minor', 400);
    }
    amountMinorOverride = amtRaw;
  }

  const twoRaw = raw.twoPersonRequired ?? raw.two_person_required;
  if (twoRaw !== undefined && typeof twoRaw !== 'boolean') {
    throw new Core1CommandError('invalid_two_person_required', 400);
  }

  return {
    medicineId,
    personId,
    vendorId,
    reorderPacks,
    amountMinorOverride,
    twoPersonRequired: twoRaw === true,
  };
}

/**
 * POST /api/core1/refill-proposal:
 * Runs `@sahaj/atlas` refill guards + Cedar `evaluateGate` with `medicine_refill` BEFORE
 * anything is enqueued, creates Riya approval card + request state, writes signed timeline
 * events per step, and NEVER decrements `medicines.remaining_count`.
 */
export async function executeRefillProposalCommand(
  request: Request,
  deps: RefillServiceDeps,
): Promise<Response> {
  try {
    const body = await readCore1JsonRequest(request);
    const idempotencyKey = extractIdempotencyKey(request, body);
    const requestedFamilyId = parseOptionalFamilyId(request, body);
    const parsed = parseProposeBody(body);

    const actor = await deps.auth.authenticate(request, requestedFamilyId);
    assertCommandCapability('refill_proposal', toFamilyMembership(actor), null);

    const [medicine, vendor, personOk] = await Promise.all([
      deps.store.getMedicine(actor.familyId, parsed.medicineId),
      deps.store.getVendor(actor.familyId, parsed.vendorId),
      deps.store.verifyPersonInFamily(actor.familyId, parsed.personId),
    ]);

    if (!medicine || !vendor || !personOk || medicine.personId !== parsed.personId) {
      throw new Core1CommandError('forbidden_cross_family_target', 403);
    }

    if (!medicine.instructionsConfirmedByPerson) {
      return Response.json(
        { error: 'instructions_not_confirmed', reason: 'instructions_not_confirmed' },
        { status: 422 },
      );
    }

    const nowDate = (deps.now ?? (() => new Date()))();
    const nowIso = nowDate.toISOString();
    const clock = clockAt(nowDate);

    const effectiveMedicine: ExtendedMedicineRecord = {
      ...medicine,
      estimatedUnitPriceMinor:
        parsed.amountMinorOverride !== undefined
          ? parsed.amountMinorOverride
          : medicine.estimatedUnitPriceMinor,
    };

    const proposal = generateRefillProposal({
      medicine: effectiveMedicine,
      vendor,
      reorderPacks: parsed.reorderPacks,
      clock,
    });

    if (!proposal) {
      return Response.json(
        { error: 'vendor_not_approved', reason: 'vendor_not_approved' },
        { status: 403 },
      );
    }

    const requestId = stableCore1Uuid(['core1-refill-req', actor.familyId, idempotencyKey]);
    const actionRequestId = stableCore1Uuid(['core1-refill-ar', actor.familyId, idempotencyKey]);
    const errandId = stableCore1Uuid(['core1-refill-errand', actor.familyId, idempotencyKey]);
    const expiresAt = new Date(nowDate.getTime() + 24 * 60 * 60 * 1000).toISOString();

    const gateRequest: GateRequest = {
      id: actionRequestId,
      familyId: actor.familyId,
      action: 'medicine_refill',
      amountMinor:
        parsed.amountMinorOverride !== undefined ? parsed.amountMinorOverride : proposal.amountMinor,
      vendorId: vendor.id,
      itemIds: [medicine.id],
      targetId: medicine.personId,
    };
    const fingerprint = requestFingerprint(gateRequest);
    const permissions = await deps.store.listMedicineRefillPermissions(actor.familyId);
    const decision = evaluateRefillCedarGate({
      familyId: actor.familyId,
      actorId: actor.personId,
      gateRequest,
      permissions,
      answers: [],
      requestExpiresAt: expiresAt,
      forceTwoPerson: parsed.twoPersonRequired,
      nowIso,
    });

    const childRecipientId = (await deps.store.findDefaultChildRecipient(actor.familyId)) ?? actor.personId;
    const matchedPermission = permissions.find((p) => p.id === decision.permissionId);
    const principalId = matchedPermission?.principalId ?? actor.personId;
    const isTwoPerson = parsed.twoPersonRequired || Boolean(matchedPermission?.twoPersonRequired);

    if (decision.decision === 'deny') {
      await deps.store.createProposalState({
        requestId,
        actionRequestId,
        errandId,
        familyId: actor.familyId,
        personId: medicine.personId,
        principalId,
        permissionId: decision.permissionId ?? null,
        medicineId: medicine.id,
        vendorId: vendor.id,
        amountMinor: gateRequest.amountMinor ?? 0,
        requestFingerprint: fingerprint,
        twoPersonRequired: isTwoPerson,
        requestStatus: 'denied',
        actionStatus: 'denied',
        errandStatus: 'cancelled',
        expiresAt,
        consumedAt: null,
      });

      const tl = await deps.timeline.append({
        familyId: actor.familyId,
        eventType: 'core1.refill.denied',
        entityId: errandId,
        humanLine: `Medicine refill denied by Cedar gate (${decision.reason}) for ${medicine.label}`,
        payload: {
          actionRequestId,
          errandId,
          medicineId: medicine.id,
          vendorId: vendor.id,
          reason: decision.reason,
        },
        dedupeKey: `refill_proposal:denied:${actor.familyId}:${actionRequestId}`,
        occurredAt: nowIso,
      });

      return Response.json(
        {
          status: 'denied',
          commandType: 'refill_proposal',
          decision: 'deny',
          reason: decision.reason,
          cardState: 'denied',
          actionRequestId,
          errandId,
          requestId,
          timelineSequence: tl.sequence,
        },
        { status: 403 },
      );
    }

    if (decision.decision === 'ask') {
      await deps.store.createProposalState({
        requestId,
        actionRequestId,
        errandId,
        familyId: actor.familyId,
        personId: medicine.personId,
        principalId,
        permissionId: decision.permissionId ?? null,
        medicineId: medicine.id,
        vendorId: vendor.id,
        amountMinor: gateRequest.amountMinor ?? 0,
        requestFingerprint: fingerprint,
        twoPersonRequired: true,
        requestStatus: 'pending',
        actionStatus: 'pending',
        errandStatus: 'pending',
        expiresAt,
        consumedAt: null,
      });

      await deps.store.recordRiyaCardAlert({
        id: stableCore1Uuid(['core1-refill-card', actor.familyId, actionRequestId, 'pending']),
        familyId: actor.familyId,
        recipientPersonId: childRecipientId,
        kind: 'refill_approval_card',
      });

      const tl = await deps.timeline.append({
        familyId: actor.familyId,
        eventType: 'core1.refill.approval_requested',
        entityId: errandId,
        humanLine: `Refill approval card sent to family for ${medicine.label}`,
        payload: {
          actionRequestId,
          errandId,
          medicineId: medicine.id,
          vendorId: vendor.id,
          approvalsRequired: decision.approvalRequired ?? 2,
          twoPersonRequired: true,
        },
        dedupeKey: `refill_proposal:ask:${actor.familyId}:${actionRequestId}`,
        occurredAt: nowIso,
      });

      const zapier = await emitOptionalZapierWebhooks({
        deps,
        z1Event: 'refill.approval_requested',
        familyId: actor.familyId,
        personId: medicine.personId,
        medicine,
        vendorId: vendor.id,
        actionRequestId,
        errandId,
        reorderPacks: parsed.reorderPacks,
        amountMinor: gateRequest.amountMinor ?? 0,
        status: 'awaiting_approval',
        occurredAt: nowIso,
      });

      return Response.json(
        {
          status: 'awaiting_approval',
          commandType: 'refill_proposal',
          decision: 'ask',
          reason: decision.reason,
          cardState: 'awaiting_second_approval',
          twoPersonRequired: true,
          approvalsCount: 0,
          approvalsRequired: decision.approvalRequired ?? 2,
          actionRequestId,
          errandId,
          requestId,
          timelineSequence: tl.sequence,
          zapier,
        },
        { status: 202 },
      );
    }

    // Refuse a missing route before consuming the request or charging usage.
    deps.outbox.assertRouteAvailable?.('core1.refill_vendor_order');
    // decision === 'allow'
    await deps.store.createProposalState({
      requestId,
      actionRequestId,
      errandId,
      familyId: actor.familyId,
      personId: medicine.personId,
      principalId,
      permissionId: decision.permissionId ?? null,
      medicineId: medicine.id,
      vendorId: vendor.id,
      amountMinor: gateRequest.amountMinor ?? 0,
      requestFingerprint: fingerprint,
      twoPersonRequired: isTwoPerson,
      requestStatus: 'approved',
      actionStatus: 'approved',
      errandStatus: 'authorized',
      expiresAt,
      consumedAt: nowIso,
    });

    if (decision.permissionId) {
      await deps.store.incrementPermissionUsage(actor.familyId, decision.permissionId);
    }

    const outboxRes = await deps.outbox.enqueue({
      familyId: actor.familyId,
      actionRequestId,
      permissionId: decision.permissionId ?? null,
      kind: 'core1.refill_vendor_order',
      action: 'medicine_refill',
      dedupeKey: `refill_vendor:${actor.familyId}:${actionRequestId}`,
      payload: {
        channel: 'phase2_outbox',
        action: 'medicine_refill',
        familyId: actor.familyId,
        personId: medicine.personId,
        medicineId: medicine.id,
        medicineLabel: medicine.label,
        vendorId: vendor.id,
        errandId,
        actionRequestId,
        reorderPacks: parsed.reorderPacks,
        amountMinor: gateRequest.amountMinor ?? 0,
        authorizedAt: nowIso,
      },
    });

    await deps.store.recordRiyaCardAlert({
      id: stableCore1Uuid(['core1-refill-card', actor.familyId, actionRequestId, 'authorized']),
      familyId: actor.familyId,
      recipientPersonId: childRecipientId,
      kind: 'refill_authorized_card',
    });

    const tl = await deps.timeline.append({
      familyId: actor.familyId,
      eventType: 'core1.refill.authorized',
      entityId: errandId,
      humanLine: `Medicine refill authorized and vendor notice queued for ${medicine.label}`,
      payload: {
        actionRequestId,
        errandId,
        outboxId: outboxRes.outboxId,
        medicineId: medicine.id,
        vendorId: vendor.id,
        amountMinor: gateRequest.amountMinor ?? 0,
      },
      dedupeKey: `refill_proposal:allow:${actor.familyId}:${actionRequestId}`,
      occurredAt: nowIso,
    });

    const zapier = await emitOptionalZapierWebhooks({
      deps,
      z1Event: 'refill.authorized',
      familyId: actor.familyId,
      personId: medicine.personId,
      medicine,
      vendorId: vendor.id,
      actionRequestId,
      errandId,
      reorderPacks: parsed.reorderPacks,
      amountMinor: gateRequest.amountMinor ?? 0,
      status: 'authorized',
      occurredAt: nowIso,
    });

    return Response.json(
      {
        status: 'authorized',
        commandType: 'refill_proposal',
        decision: 'allow',
        cardState: 'authorized',
        outboxId: outboxRes.outboxId,
        actionRequestId,
        errandId,
        requestId,
        timelineSequence: tl.sequence,
        zapier,
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof Core1CommandError) {
      return Response.json({ error: error.code }, { status: error.status });
    }
    return Response.json({ error: 'internal_command_error' }, { status: 500 });
  }
}

/**
 * POST /api/core1/refill:
 * Handles:
 * 1) Approval / second-person approval (`action: 'approve' | 'deny'` or `answer: boolean`)
 *    re-evaluating Cedar `evaluateGate` and enqueuing vendor order notice once allowed;
 * 2) Confirmed delivery (`action: 'confirm_delivery'` or `deliveryConfirmed: true`), which is
 *    the ONLY step permitted to decrement `medicines.remaining_count` (idempotently);
 * 3) Direct proposal payload (`medicineId, personId, vendorId`) delegated to `executeRefillProposalCommand`.
 */
export async function executeRefillCommand(
  request: Request,
  deps: RefillServiceDeps,
): Promise<Response> {
  try {
    const rawBody = await readCore1JsonRequest(request);

    // If caller submitted a proposal directly to POST /api/core1/refill, route to proposal handler.
    if (
      (rawBody.medicineId !== undefined || rawBody.medicine_id !== undefined) &&
      rawBody.actionRequestId === undefined &&
      rawBody.action_request_id === undefined
    ) {
      const replayRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(rawBody),
      });
      return executeRefillProposalCommand(replayRequest, deps);
    }

    const allowed = new Set([
      'actionRequestId', 'action_request_id',
      'action', 'answer',
      'deliveryConfirmed', 'delivery_confirmed',
      'decrementCount', 'decrement_count',
      'familyId', 'family_id',
      'idempotencyKey', 'idempotency_key',
    ]);
    for (const key of Object.keys(rawBody)) {
      if (!allowed.has(key)) {
        throw new Core1CommandError(`unexpected_field_${key}`, 400);
      }
    }

    const idempotencyKey = extractIdempotencyKey(request, rawBody);
    const requestedFamilyId = parseOptionalFamilyId(request, rawBody);
    const actionRequestId = validateUuid(
      rawBody.actionRequestId ?? rawBody.action_request_id,
      'action_request_id',
    );

    const actor = await deps.auth.authenticate(request, requestedFamilyId);
    if (actor.role !== 'parent' && actor.role !== 'child') {
      throw new Core1CommandError('forbidden_role_refill_action', 403);
    }

    const ar = await deps.store.getActionRequestWithErrand(actor.familyId, actionRequestId);
    if (!ar) {
      throw new Core1CommandError('action_request_not_found', 404);
    }

    const medicine = await deps.store.getMedicine(actor.familyId, ar.medicineId);
    if (!medicine) {
      throw new Core1CommandError('medicine_not_found', 404);
    }

    const nowDate = (deps.now ?? (() => new Date()))();
    const nowIso = nowDate.toISOString();

    const isDelivery =
      rawBody.action === 'confirm_delivery' ||
      rawBody.deliveryConfirmed === true ||
      rawBody.delivery_confirmed === true;

    if (isDelivery) {
      if (ar.errandStatus === 'completed') {
        return Response.json(
          {
            status: 'delivered',
            commandType: 'refill',
            cardState: 'delivered',
            deduped: true,
            remainingCount: medicine.remainingCount,
            actionRequestId: ar.id,
            errandId: ar.errandId,
            idempotencyKey,
          },
          { status: 200 },
        );
      }

      if (ar.errandStatus !== 'authorized' && ar.errandStatus !== 'dispatched') {
        return Response.json(
          { error: 'refill_not_authorized', reason: `errand_status_${ar.errandStatus}` },
          { status: 409 },
        );
      }

      const rawDec = rawBody.decrementCount ?? rawBody.decrement_count;
      let decrementBy = medicine.unitDose || 1;
      if (rawDec !== undefined) {
        if (!isStrictPositiveInteger(rawDec)) {
          throw new Core1CommandError('invalid_decrement_count', 400);
        }
        decrementBy = rawDec;
      }

      const { previousCount, newCount } = await deps.store.decrementMedicineRemainingCount({
        familyId: actor.familyId,
        medicineId: medicine.id,
        decrementBy,
      });

      await deps.store.updateRefillState({
        familyId: actor.familyId,
        actionRequestId: ar.id,
        requestId: ar.requestId,
        errandId: ar.errandId,
        actionStatus: 'executed',
        requestStatus: 'completed',
        errandStatus: 'completed',
      });

      const tl = await deps.timeline.append({
        familyId: actor.familyId,
        eventType: 'core1.refill.delivered',
        entityId: ar.errandId,
        humanLine: `Medicine delivery confirmed for ${medicine.label}; remaining count updated to ${newCount}`,
        payload: {
          actionRequestId: ar.id,
          errandId: ar.errandId,
          medicineId: medicine.id,
          previousCount,
          newCount,
          decrementBy,
        },
        dedupeKey: `refill:delivered:${actor.familyId}:${ar.id}`,
        occurredAt: nowIso,
      });

      const zapier = await emitOptionalZapierWebhooks({
        deps,
        z1Event: 'refill.delivered',
        familyId: actor.familyId,
        personId: ar.personId,
        medicine: { ...medicine, remainingCount: newCount },
        vendorId: ar.vendorId,
        actionRequestId: ar.id,
        errandId: ar.errandId,
        reorderPacks: 1,
        amountMinor: ar.amountMinor,
        status: 'delivered',
        occurredAt: nowIso,
      });

      return Response.json(
        {
          status: 'delivered',
          commandType: 'refill',
          cardState: 'delivered',
          previousRemainingCount: previousCount,
          remainingCount: newCount,
          decrementedBy: decrementBy,
          actionRequestId: ar.id,
          errandId: ar.errandId,
          timelineSequence: tl.sequence,
          idempotencyKey,
          zapier,
        },
        { status: 200 },
      );
    }

    // Approval or denial branch
    const answerBool =
      rawBody.action === 'deny'
        ? false
        : rawBody.action === 'approve'
          ? true
          : typeof rawBody.answer === 'boolean'
            ? rawBody.answer
            : null;
    if (answerBool === null) {
      throw new Core1CommandError('invalid_refill_action', 400);
    }

    if (ar.status === 'denied' || ar.errandStatus === 'cancelled') {
      return Response.json(
        { status: 'denied', reason: 'already_denied', cardState: 'denied', actionRequestId: ar.id, errandId: ar.errandId },
        { status: 409 },
      );
    }

    if (ar.principalId && actor.personId === ar.principalId && answerBool) {
      return Response.json(
        { error: 'self_approval_forbidden', reason: 'invalid_approval' },
        { status: 403 },
      );
    }

    await deps.store.upsertApprovalAnswer({
      familyId: actor.familyId,
      actionRequestId: ar.id,
      approverPersonId: actor.personId,
      answer: answerBool,
      answeredAt: nowIso,
    });

    if (!answerBool) {
      await deps.store.updateRefillState({
        familyId: actor.familyId,
        actionRequestId: ar.id,
        requestId: ar.requestId,
        errandId: ar.errandId,
        actionStatus: 'denied',
        requestStatus: 'denied',
        errandStatus: 'cancelled',
      });

      const tl = await deps.timeline.append({
        familyId: actor.familyId,
        eventType: 'core1.refill.denied',
        entityId: ar.errandId,
        humanLine: `Medicine refill denied by family approver for ${medicine.label}`,
        payload: {
          actionRequestId: ar.id,
          errandId: ar.errandId,
          approverPersonId: actor.personId,
          reason: 'denied_by_family',
        },
        dedupeKey: `refill:denied:${actor.familyId}:${ar.id}:${actor.personId}`,
        occurredAt: nowIso,
      });

      return Response.json(
        {
          status: 'denied',
          commandType: 'refill',
          reason: 'denied_by_family',
          cardState: 'denied',
          actionRequestId: ar.id,
          errandId: ar.errandId,
          timelineSequence: tl.sequence,
          idempotencyKey,
        },
        { status: 200 },
      );
    }

    // Check if already authorized/executed -> idempotent
    if (ar.status === 'approved' || ar.errandStatus === 'authorized' || ar.errandStatus === 'completed') {
      return Response.json(
        {
          status: 'authorized',
          commandType: 'refill',
          cardState: 'authorized',
          deduped: true,
          actionRequestId: ar.id,
          errandId: ar.errandId,
          idempotencyKey,
        },
        { status: 200 },
      );
    }

    const [permissions, answers] = await Promise.all([
      deps.store.listMedicineRefillPermissions(actor.familyId),
      deps.store.listApprovals(actor.familyId, ar.id),
    ]);

    const gateRequest: GateRequest = {
      id: ar.id,
      familyId: ar.familyId,
      action: 'medicine_refill',
      amountMinor: ar.amountMinor,
      ...(ar.vendorId ? { vendorId: ar.vendorId } : {}),
      itemIds: ar.itemIds.length > 0 ? ar.itemIds : [ar.medicineId],
      targetId: ar.targetId ?? ar.personId,
    };

    const gateActorId = ar.principalId ?? ar.personId;
    const decision = evaluateRefillCedarGate({
      familyId: actor.familyId,
      actorId: gateActorId,
      gateRequest,
      permissions,
      answers,
      requestExpiresAt: ar.expiresAt,
      forceTwoPerson: ar.twoPersonRequired,
      nowIso,
    });

    const yesCount = answers.filter((a) => a.answer).length;

    if (decision.decision === 'deny') {
      await deps.store.updateRefillState({
        familyId: actor.familyId,
        actionRequestId: ar.id,
        requestId: ar.requestId,
        errandId: ar.errandId,
        actionStatus: 'denied',
        requestStatus: 'denied',
        errandStatus: 'cancelled',
      });

      const tl = await deps.timeline.append({
        familyId: actor.familyId,
        eventType: 'core1.refill.denied',
        entityId: ar.errandId,
        humanLine: `Medicine refill denied by Cedar gate (${decision.reason}) for ${medicine.label}`,
        payload: {
          actionRequestId: ar.id,
          errandId: ar.errandId,
          reason: decision.reason,
        },
        dedupeKey: `refill:gate_denied:${actor.familyId}:${ar.id}`,
        occurredAt: nowIso,
      });

      return Response.json(
        {
          status: 'denied',
          commandType: 'refill',
          reason: decision.reason,
          cardState: 'denied',
          actionRequestId: ar.id,
          errandId: ar.errandId,
          timelineSequence: tl.sequence,
        },
        { status: 403 },
      );
    }

    if (decision.decision === 'ask') {
      const tl = await deps.timeline.append({
        familyId: actor.familyId,
        eventType: 'core1.refill.approval_recorded',
        entityId: ar.errandId,
        humanLine: `Approval ${yesCount} recorded; waiting for second family approval for ${medicine.label}`,
        payload: {
          actionRequestId: ar.id,
          errandId: ar.errandId,
          approverPersonId: actor.personId,
          approvalsCount: yesCount,
          approvalsRequired: decision.approvalRequired ?? 1,
        },
        dedupeKey: `refill:approval:${actor.familyId}:${ar.id}:${actor.personId}`,
        occurredAt: nowIso,
      });

      return Response.json(
        {
          status: 'awaiting_approval',
          commandType: 'refill',
          decision: 'ask',
          reason: decision.reason,
          cardState: 'awaiting_second_approval',
          twoPersonRequired: true,
          approvalsCount: yesCount,
          approvalsRequired: decision.approvalRequired ?? 1,
          actionRequestId: ar.id,
          errandId: ar.errandId,
          timelineSequence: tl.sequence,
          idempotencyKey,
        },
        { status: 202 },
      );
    }

    // Refuse a missing route before consuming the request or charging usage.
    deps.outbox.assertRouteAvailable?.('core1.refill_vendor_order');
    // decision === 'allow'
    await deps.store.updateRefillState({
      familyId: actor.familyId,
      actionRequestId: ar.id,
      requestId: ar.requestId,
      errandId: ar.errandId,
      permissionId: decision.permissionId ?? ar.permissionId,
      actionStatus: 'approved',
      requestStatus: 'approved',
      errandStatus: 'authorized',
      consumedAt: nowIso,
    });

    if (decision.permissionId && isValidUuid(decision.permissionId)) {
      await deps.store.incrementPermissionUsage(actor.familyId, decision.permissionId);
    }

    const outboxRes = await deps.outbox.enqueue({
      familyId: actor.familyId,
      actionRequestId: ar.id,
      permissionId: decision.permissionId ?? ar.permissionId,
      kind: 'core1.refill_vendor_order',
      action: 'medicine_refill',
      dedupeKey: `refill_vendor:${actor.familyId}:${ar.id}`,
      payload: {
        channel: 'phase2_outbox',
        action: 'medicine_refill',
        familyId: actor.familyId,
        personId: ar.personId,
        medicineId: medicine.id,
        medicineLabel: medicine.label,
        vendorId: ar.vendorId,
        errandId: ar.errandId,
        actionRequestId: ar.id,
        amountMinor: ar.amountMinor,
        approvalsCount: yesCount,
        authorizedAt: nowIso,
      },
    });

    const childRecipientId = (await deps.store.findDefaultChildRecipient(actor.familyId)) ?? actor.personId;
    await deps.store.recordRiyaCardAlert({
      id: stableCore1Uuid(['core1-refill-card', actor.familyId, ar.id, 'authorized']),
      familyId: actor.familyId,
      recipientPersonId: childRecipientId,
      kind: 'refill_authorized_card',
    });

    const tl = await deps.timeline.append({
      familyId: actor.familyId,
      eventType: 'core1.refill.authorized',
      entityId: ar.errandId,
      humanLine: `Medicine refill approved and vendor notice queued for ${medicine.label}`,
      payload: {
        actionRequestId: ar.id,
        errandId: ar.errandId,
        outboxId: outboxRes.outboxId,
        approvalsCount: yesCount,
      },
      dedupeKey: `refill:authorized:${actor.familyId}:${ar.id}`,
      occurredAt: nowIso,
    });

    const zapier = await emitOptionalZapierWebhooks({
      deps,
      z1Event: 'refill.authorized',
      familyId: actor.familyId,
      personId: ar.personId,
      medicine,
      vendorId: ar.vendorId,
      actionRequestId: ar.id,
      errandId: ar.errandId,
      reorderPacks: 1,
      amountMinor: ar.amountMinor,
      status: 'authorized',
      occurredAt: nowIso,
    });

    return Response.json(
      {
        status: 'authorized',
        commandType: 'refill',
        decision: 'allow',
        cardState: 'authorized',
        outboxId: outboxRes.outboxId,
        approvalsCount: yesCount,
        actionRequestId: ar.id,
        errandId: ar.errandId,
        timelineSequence: tl.sequence,
        idempotencyKey,
        zapier,
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof Core1CommandError) {
      return Response.json({ error: error.code }, { status: error.status });
    }
    return Response.json({ error: 'internal_command_error' }, { status: 500 });
  }
}

export function createProductionRefillDeps(
  env: Record<string, string | undefined> = process.env,
): RefillServiceDeps {
  const db = serviceDatabase();
  const encryptionKeyHex = env.WEBHOOK_ENCRYPTION_KEY;
  return {
    auth: createSupabaseCore1AuthPort(db),
    store: createSupabaseRefillStore(db),
    outbox: createSupabaseCore1OutboxPort(db, encryptionKeyHex),
    timeline: createSupabaseCore1TimelinePort(
      db,
      env.TIMELINE_SIGNING_PRIVATE_KEY ?? env.SIGNING_PRIVATE_KEY,
      env.TIMELINE_SIGNING_KEY_ID ?? env.SIGNING_KEY_ID ?? 'core1-default',
    ),
    env,
  };
}
