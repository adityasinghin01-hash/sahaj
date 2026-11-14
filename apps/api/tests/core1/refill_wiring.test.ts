import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifyTimelineEvent, canonicalJson, signTimelineEvent, type SignedTimelineEvent } from '@/lib/timeline';
import {
  executeRefillProposalCommand,
  executeRefillCommand,
  type RefillServiceDeps,
  type RefillStore,
  type ExtendedMedicineRecord,
  type RefillPermissionRow,
  type RefillActionRequestRow,
  type RefillApprovalAnswerRow,
} from '@/lib/core1/refill-service';
import type { VendorRecord } from '../../../../packages/atlas/src/core1/types';
import type { Core1Actor, Core1OutboxEnqueueInput, Core1TimelineInput } from '@/lib/core1/wiring-common';

function createFakeRefillHarness(options?: {
  amountLimitMinor?: number;
  twoPersonRequired?: boolean;
  denyPermission?: boolean;
  instructionsConfirmed?: boolean;
  vendorApproved?: boolean;
  remainingCount?: number;
  refillThreshold?: number;
  env?: Record<string, string | undefined>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}) {
  const familyId = '11111111-1111-4111-8111-111111111111';
  const maaPersonId = '22222222-2222-4222-8222-222222222222';
  const riyaPersonId = '33333333-3333-4333-8333-333333333333';
  const rohitPersonId = '44444444-4444-4444-8444-444444444444';
  const assistantPrincipalId = '55555555-5555-4555-8555-555555555555';
  const foreignFamilyId = '99999999-9999-4999-8999-999999999999';
  const medicineId = '66666666-6666-4666-8666-666666666666';
  const vendorId = '77777777-7777-4777-8777-777777777777';
  const permissionId = '88888888-8888-4888-8888-888888888888';

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const encryptionKeyHex = randomBytes(32).toString('hex');

  const actors: Record<string, Core1Actor> = {
    'token-riya': { userId: 'u-riya', personId: riyaPersonId, familyId, role: 'child' },
    'token-rohit': { userId: 'u-rohit', personId: rohitPersonId, familyId, role: 'child' },
    'token-maa': { userId: 'u-maa', personId: maaPersonId, familyId, role: 'parent' },
    'token-assistant': { userId: 'u-assistant', personId: assistantPrincipalId, familyId, role: 'child' },
  };

  const medicines = new Map<string, ExtendedMedicineRecord>([
    [
      medicineId,
      {
        id: medicineId,
        familyId,
        personId: maaPersonId,
        label: 'Metformin 500mg',
        remainingCount: options?.remainingCount ?? 5,
        refillThreshold: options?.refillThreshold ?? 6,
        instructionsConfirmedByPerson: options?.instructionsConfirmed ?? true,
        unitDose: 1,
        packSize: 1,
        estimatedUnitPriceMinor: 25000,
      },
    ],
  ]);

  const vendors = new Map<string, VendorRecord>([
    [
      vendorId,
      {
        id: vendorId,
        familyId,
        approved: options?.vendorApproved ?? true,
        revokedAt: null,
      },
    ],
  ]);

  const nowMs = Date.parse('2026-11-15T06:00:00.000Z');
  const permissions: RefillPermissionRow[] = [
    {
      id: permissionId,
      familyId,
      personId: maaPersonId,
      principalId: assistantPrincipalId,
      action: 'medicine_refill',
      decision: 'allow',
      validFrom: '2026-11-14T00:00:00.000Z',
      expiresAt: '2026-11-20T00:00:00.000Z',
      periodStart: '2026-11-14T00:00:00.000Z',
      periodEnd: '2026-11-20T00:00:00.000Z',
      maxUses: 5,
      usedCount: 0,
      maxAmountMinor: options?.amountLimitMinor ?? 50000,
      targetIds: [maaPersonId],
      vendorIds: [vendorId],
      itemIds: [medicineId],
      twoPersonRequired: options?.twoPersonRequired ?? false,
      revokedAt: null,
    },
  ];
  if (options?.denyPermission) {
    permissions.push({
      ...permissions[0],
      id: '88888888-8888-4888-8888-888888888889',
      decision: 'deny',
    });
  }

  const actionRequests = new Map<string, RefillActionRequestRow>();
  const approvals = new Map<string, RefillApprovalAnswerRow[]>();
  const outboxRows: Core1OutboxEnqueueInput[] = [];
  const timelineEvents: SignedTimelineEvent[] = [];
  const cardAlerts: Array<{ id: string; kind: string; recipientPersonId: string }> = [];
  let prevChainHash: string | null = null;
  let seq = 0;

  // Avoid unused import warning for encryptionKeyHex
  void encryptionKeyHex;

  const store: RefillStore = {
    async getMedicine(fam, medId) {
      const m = medicines.get(medId);
      return m && m.familyId === fam ? { ...m } : null;
    },
    async getVendor(fam, venId) {
      const v = vendors.get(venId);
      return v && v.familyId === fam ? { ...v } : null;
    },
    async verifyPersonInFamily(fam, pid) {
      return fam === familyId && [maaPersonId, riyaPersonId, rohitPersonId, assistantPrincipalId].includes(pid);
    },
    async listMedicineRefillPermissions(fam) {
      return permissions.filter((p) => p.familyId === fam);
    },
    async createProposalState(input) {
      actionRequests.set(input.actionRequestId, {
        id: input.actionRequestId,
        requestId: input.requestId,
        errandId: input.errandId,
        familyId: input.familyId,
        personId: input.personId,
        permissionId: input.permissionId,
        principalId: input.principalId,
        action: 'medicine_refill',
        targetId: input.personId,
        amountMinor: input.amountMinor,
        vendorId: input.vendorId,
        medicineId: input.medicineId,
        itemIds: [input.medicineId],
        requestFingerprint: input.requestFingerprint,
        status: input.actionStatus,
        errandStatus: input.errandStatus,
        expiresAt: input.expiresAt,
        twoPersonRequired: input.twoPersonRequired,
        consumedAt: input.consumedAt,
      });
    },
    async getActionRequestWithErrand(fam, arId) {
      const row = actionRequests.get(arId);
      return row && row.familyId === fam ? { ...row } : null;
    },
    async listApprovals(_fam, arId) {
      return [...(approvals.get(arId) ?? [])];
    },
    async upsertApprovalAnswer(input) {
      const list = approvals.get(input.actionRequestId) ?? [];
      const idx = list.findIndex((a) => a.approverPersonId === input.approverPersonId);
      const entry: RefillApprovalAnswerRow = {
        actionRequestId: input.actionRequestId,
        approverPersonId: input.approverPersonId,
        answer: input.answer,
        answeredAt: input.answeredAt,
        approverActive: true,
        approverRole: input.approverPersonId === maaPersonId ? 'parent' : 'child',
      };
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
      approvals.set(input.actionRequestId, list);
    },
    async updateRefillState(input) {
      const row = actionRequests.get(input.actionRequestId);
      if (!row) return;
      row.status = input.actionStatus;
      row.errandStatus = input.errandStatus;
      if (input.permissionId !== undefined) row.permissionId = input.permissionId;
      if (input.consumedAt !== undefined) row.consumedAt = input.consumedAt;
    },
    async incrementPermissionUsage(_fam, permId) {
      const p = permissions.find((x) => x.id === permId);
      if (p) p.usedCount += 1;
    },
    async recordRiyaCardAlert(input) {
      cardAlerts.push({ id: input.id, kind: input.kind, recipientPersonId: input.recipientPersonId });
    },
    async findDefaultChildRecipient() {
      return riyaPersonId;
    },
    async decrementMedicineRemainingCount(input) {
      const m = medicines.get(input.medicineId)!;
      const previousCount = m.remainingCount;
      m.remainingCount = Math.max(0, previousCount - input.decrementBy);
      return { previousCount, newCount: m.remainingCount };
    },
  };

  const deps: RefillServiceDeps = {
    auth: {
      async authenticate(req) {
        const hdr = req.headers.get('authorization') ?? '';
        const token = hdr.replace(/^Bearer\s+/i, '');
        const actor = actors[token];
        if (!actor) throw new (await import('@/lib/core1/errors')).Core1CommandError('unauthorized', 401);
        return actor;
      },
    },
    store,
    outbox: {
      async enqueue(input: Core1OutboxEnqueueInput) {
        const idx = outboxRows.findIndex(
          (r) => r.familyId === input.familyId && r.dedupeKey === input.dedupeKey,
        );
        if (idx >= 0) {
          return { outboxId: `outbox-${idx + 1}`, deduped: true };
        }
        outboxRows.push(input);
        return { outboxId: `outbox-${outboxRows.length}`, deduped: false };
      },
    },
    timeline: {
      async append(input: Core1TimelineInput) {
        const existingIdx = timelineEvents.findIndex(
          (e) => e.envelope.familyId === input.familyId && e.envelope.dedupeKey === input.dedupeKey,
        );
        if (existingIdx >= 0) {
          const ex = timelineEvents[existingIdx];
          return { sequence: ex.envelope.sequence, chainHash: ex.chainHash, deduped: true };
        }
        seq += 1;
        const signed = signTimelineEvent(
          {
            familyId: input.familyId,
            eventId: `10000000-0000-4000-8000-00000000000${seq}`.slice(0, 36),
            sequence: seq,
            previousHash: prevChainHash,
            dedupeKey: input.dedupeKey,
            eventType: input.eventType,
            entityId: input.entityId,
            humanLine: input.humanLine,
            occurredAt: input.occurredAt ?? new Date(nowMs).toISOString(),
            keyId: 'test-key',
            payload: input.payload,
          },
          privatePem,
        );
        // Verify canonical JSON validity before storing
        canonicalJson(input.payload);
        timelineEvents.push(signed);
        prevChainHash = signed.chainHash;
        return { sequence: seq, chainHash: signed.chainHash, deduped: false };
      },
    },
    env: options?.env ?? {},
    fetchImpl: options?.fetchImpl,
    now: () => new Date(nowMs),
  };

  return {
    deps,
    familyId,
    foreignFamilyId,
    maaPersonId,
    riyaPersonId,
    rohitPersonId,
    medicineId,
    vendorId,
    medicines,
    outboxRows,
    timelineEvents,
    cardAlerts,
    actionRequests,
    publicPem,
  };
}

describe('Core 1 Refill Approval Gate & Delivery Wiring', () => {
  it('evaluates Cedar gate before outbox, enqueues allowed refill, writes signed timeline, and never decrements count early', async () => {
    const h = createFakeRefillHarness({ remainingCount: 5 });

    const req = new Request('http://localhost/api/core1/refill-proposal', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-assistant',
        'idempotency-key': 'refill-prop-1',
      },
      body: JSON.stringify({
        medicineId: h.medicineId,
        personId: h.maaPersonId,
        vendorId: h.vendorId,
        reorderPacks: 1,
      }),
    });

    const res = await executeRefillProposalCommand(req, h.deps);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('authorized');
    expect(body.decision).toBe('allow');
    expect(body.cardState).toBe('authorized');
    expect(body.outboxId).toBeTruthy();

    expect(h.outboxRows).toHaveLength(1);
    expect(h.outboxRows[0].action).toBe('medicine_refill');
    expect(h.outboxRows[0].kind).toBe('core1.refill_vendor_order');
    expect(h.cardAlerts.some((c) => c.kind === 'refill_authorized_card')).toBe(true);

    // Remaining count MUST NOT change before confirmed delivery!
    expect(h.medicines.get(h.medicineId)?.remainingCount).toBe(5);

    expect(h.timelineEvents).toHaveLength(1);
    expect(h.timelineEvents[0].envelope.eventType).toBe('core1.refill.authorized');
    expect(verifyTimelineEvent(h.timelineEvents[0], h.publicPem)).toBe(true);
  });

  it('enforces two_person_required gate, blocks self-approval, enqueues only after 2nd approval, and decrements only on confirmed delivery', async () => {
    const h = createFakeRefillHarness({ twoPersonRequired: true, remainingCount: 5 });

    // 1. Propose
    const propRes = await executeRefillProposalCommand(
      new Request('http://localhost/api/core1/refill-proposal', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-assistant',
          'idempotency-key': 'refill-2p-1',
        },
        body: JSON.stringify({
          medicineId: h.medicineId,
          personId: h.maaPersonId,
          vendorId: h.vendorId,
          twoPersonRequired: true,
        }),
      }),
      h.deps,
    );
    expect(propRes.status).toBe(202);
    const propBody = await propRes.json();
    expect(propBody.status).toBe('awaiting_approval');
    expect(propBody.cardState).toBe('awaiting_second_approval');
    expect(propBody.approvalsRequired).toBe(2);
    expect(h.outboxRows).toHaveLength(0);
    expect(h.medicines.get(h.medicineId)?.remainingCount).toBe(5);

    // Principal cannot self-approve
    const selfRes = await executeRefillCommand(
      new Request('http://localhost/api/core1/refill', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-assistant',
          'idempotency-key': 'self-approve',
        },
        body: JSON.stringify({
          actionRequestId: propBody.actionRequestId,
          action: 'approve',
        }),
      }),
      h.deps,
    );
    expect(selfRes.status).toBe(403);
    expect(h.outboxRows).toHaveLength(0);

    // Confirm delivery before authorization must fail (409) and never decrement
    const earlyDelivery = await executeRefillCommand(
      new Request('http://localhost/api/core1/refill', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-riya',
          'idempotency-key': 'early-delivery',
        },
        body: JSON.stringify({
          actionRequestId: propBody.actionRequestId,
          action: 'confirm_delivery',
        }),
      }),
      h.deps,
    );
    expect(earlyDelivery.status).toBe(409);
    expect(h.medicines.get(h.medicineId)?.remainingCount).toBe(5);

    // 2. First approval by Riya -> still waiting for second approval
    const firstApp = await executeRefillCommand(
      new Request('http://localhost/api/core1/refill', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-riya',
          'idempotency-key': 'approve-riya',
        },
        body: JSON.stringify({
          actionRequestId: propBody.actionRequestId,
          action: 'approve',
        }),
      }),
      h.deps,
    );
    expect(firstApp.status).toBe(202);
    const firstBody = await firstApp.json();
    expect(firstBody.status).toBe('awaiting_approval');
    expect(firstBody.approvalsCount).toBe(1);
    expect(firstBody.approvalsRequired).toBe(1);
    expect(h.outboxRows).toHaveLength(0);
    expect(h.medicines.get(h.medicineId)?.remainingCount).toBe(5);

    // 3. Second approval by Rohit -> Cedar allows and enqueues vendor order notice
    const secondApp = await executeRefillCommand(
      new Request('http://localhost/api/core1/refill', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-rohit',
          'idempotency-key': 'approve-rohit',
        },
        body: JSON.stringify({
          actionRequestId: propBody.actionRequestId,
          action: 'approve',
        }),
      }),
      h.deps,
    );
    expect(secondApp.status).toBe(202);
    const secondBody = await secondApp.json();
    expect(secondBody.status).toBe('authorized');
    expect(secondBody.approvalsCount).toBe(2);
    expect(h.outboxRows).toHaveLength(1);
    expect(h.medicines.get(h.medicineId)?.remainingCount).toBe(5);

    // 4. Confirmed delivery -> ONLY NOW decrements count once (idempotent on replay)
    const deliveredRes = await executeRefillCommand(
      new Request('http://localhost/api/core1/refill', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-riya',
          'idempotency-key': 'deliver-1',
        },
        body: JSON.stringify({
          actionRequestId: propBody.actionRequestId,
          action: 'confirm_delivery',
        }),
      }),
      h.deps,
    );
    expect(deliveredRes.status).toBe(200);
    const delivBody = await deliveredRes.json();
    expect(delivBody.status).toBe('delivered');
    expect(delivBody.previousRemainingCount).toBe(5);
    expect(delivBody.remainingCount).toBe(4);
    expect(h.medicines.get(h.medicineId)?.remainingCount).toBe(4);

    // Replay confirmed delivery is idempotent
    const replayDelivered = await executeRefillCommand(
      new Request('http://localhost/api/core1/refill', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-riya',
          'idempotency-key': 'deliver-2',
        },
        body: JSON.stringify({
          actionRequestId: propBody.actionRequestId,
          deliveryConfirmed: true,
        }),
      }),
      h.deps,
    );
    expect(replayDelivered.status).toBe(200);
    const replayBody = await replayDelivered.json();
    expect(replayBody.deduped).toBe(true);
    expect(h.medicines.get(h.medicineId)?.remainingCount).toBe(4);

    // Every step recorded a cryptographically valid signed timeline event
    expect(h.timelineEvents.map((e) => e.envelope.eventType)).toEqual([
      'core1.refill.approval_requested',
      'core1.refill.approval_recorded',
      'core1.refill.authorized',
      'core1.refill.delivered',
    ]);
    for (const ev of h.timelineEvents) {
      expect(verifyTimelineEvent(ev, h.publicPem)).toBe(true);
    }
  });

  it('denies refill clearly when Cedar limits are exceeded or permission denied without enqueueing', async () => {
    const h = createFakeRefillHarness({ amountLimitMinor: 10000 }); // below 25000 price

    const res = await executeRefillProposalCommand(
      new Request('http://localhost/api/core1/refill-proposal', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-assistant',
          'idempotency-key': 'refill-over-limit',
        },
        body: JSON.stringify({
          medicineId: h.medicineId,
          personId: h.maaPersonId,
          vendorId: h.vendorId,
        }),
      }),
      h.deps,
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.status).toBe('denied');
    expect(body.reason).toBe('limits_exceeded');
    expect(h.outboxRows).toHaveLength(0);
    expect(h.timelineEvents[0].envelope.eventType).toBe('core1.refill.denied');
    expect(verifyTimelineEvent(h.timelineEvents[0], h.publicPem)).toBe(true);
  });

  it('blocks unconfirmed instructions and unapproved vendors without calling outbox', async () => {
    const unconfirmed = createFakeRefillHarness({ instructionsConfirmed: false });
    const r1 = await executeRefillProposalCommand(
      new Request('http://localhost/api/core1/refill-proposal', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-assistant',
          'idempotency-key': 'unconfirmed-med',
        },
        body: JSON.stringify({
          medicineId: unconfirmed.medicineId,
          personId: unconfirmed.maaPersonId,
          vendorId: unconfirmed.vendorId,
        }),
      }),
      unconfirmed.deps,
    );
    expect(r1.status).toBe(422);
    expect(unconfirmed.outboxRows).toHaveLength(0);

    const unapprovedVendor = createFakeRefillHarness({ vendorApproved: false });
    const r2 = await executeRefillProposalCommand(
      new Request('http://localhost/api/core1/refill-proposal', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-assistant',
          'idempotency-key': 'unapproved-vendor',
        },
        body: JSON.stringify({
          medicineId: unapprovedVendor.medicineId,
          personId: unapprovedVendor.maaPersonId,
          vendorId: unapprovedVendor.vendorId,
        }),
      }),
      unapprovedVendor.deps,
    );
    expect(r2.status).toBe(403);
    expect(unapprovedVendor.outboxRows).toHaveLength(0);
  });

  it('posts Z1 & Z5 Zapier catch hooks only when configured and never blocks core flow when webhook fails', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const h = createFakeRefillHarness({
      remainingCount: 2,
      refillThreshold: 3,
      env: {
        ZAPIER_HOOK_Z1: 'https://hooks.zapier.test/z1',
        ZAPIER_HOOK_Z5: 'https://hooks.zapier.test/z5',
      },
      fetchImpl: async (url, init) => {
        calls.push({ url, body: String(init.body) });
        throw new Error('zapier_network_timeout');
      },
    });

    const res = await executeRefillProposalCommand(
      new Request('http://localhost/api/core1/refill-proposal', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-assistant',
          'idempotency-key': 'refill-zapier-fail-open',
        },
        body: JSON.stringify({
          medicineId: h.medicineId,
          personId: h.maaPersonId,
          vendorId: h.vendorId,
        }),
      }),
      h.deps,
    );

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('authorized');
    expect(body.zapier.z1.sent).toBe(false);
    expect(body.zapier.z1.error).toBe('zapier_network_timeout');
    expect(body.zapier.z5.sent).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual([
      'https://hooks.zapier.test/z1',
      'https://hooks.zapier.test/z5',
    ]);
  });
});
