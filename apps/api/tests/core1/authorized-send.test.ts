import { describe, it, expect, vi } from 'vitest';
import { enqueueAuthorizedSend, type AuthorizedSendInput } from '@/lib/core1/authorized-send';
import { requestFingerprint } from '@sahaj/gate';
import { stableUuid, type RpcDb } from '@/lib/atlas-runtime/db';
import { createSupabaseCore1OutboxPort } from '@/lib/core1/wiring-common';
import { createSupabaseDispatchPort } from '@/lib/core2/supabase';
import { createDeviceStore } from '@/lib/core2-device/supabase';

const input: AuthorizedSendInput = { familyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  subjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', recipientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  sourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', kind: 'core1.voice_notify', dedupeKey: 'synthetic-voice' };
const KEY = '12'.repeat(32);
function fixture() {
  const requestId = stableUuid(['authorized-send-request', input.familyId, input.dedupeKey]);
  const snapshot = { found: true, now: '2026-11-15T00:00:00Z', revision: 'revision', actorActive: true, block: null as null | string,
    request: { actorId: 'principal', fingerprint: requestFingerprint({ id: requestId, familyId: input.familyId,
      action: 'voice_message', targetId: input.recipientId, consentSubjectId: input.subjectId }),
      consumed: false, expired: false, hasDenial: false, status: 'pending' },
    permissions: [{ id: 'permission', familyId: input.familyId, actorId: 'principal', action: 'voice_message',
      validFrom: '2026-11-14T00:00:00Z', expiresAt: '2026-11-16T00:00:00Z', maxAmountMinor: 0,
      vendorIds: [], itemIds: [], targetIds: [input.recipientId], periodStart: '2026-11-14T00:00:00Z',
      periodEnd: '2026-11-16T00:00:00Z', maxUses: 1, usedCount: 0, approvalMode: 'setup' }], approvals: [], consents: [] };
  const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => ({ data:
    name === 'prepare_authorized_send' ? { lease: 'lease', channel: 'twilio' } :
    name === 'load_gate_snapshot' ? snapshot : { status: 'enqueued', outbox_id: 'outbox', recovered: false }, error: null }));
  return { db: { rpc } satisfies RpcDb, rpc, snapshot };
}
describe('authorized production send boundaries', () => {
  it('passes a Cedar-issued request to the atomic enqueue with the SQL lease and revision', async () => {
    const { db, rpc } = fixture();
    expect(await enqueueAuthorizedSend(db, KEY, input)).toEqual({ id: 'outbox', duplicate: false, channel: 'twilio' });
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['prepare_authorized_send','load_gate_snapshot','enqueue_authorized_command','finish_workflow_job']);
    expect(rpc.mock.calls[2][1]).toMatchObject({ p_lease_token: 'lease', p_revision: 'revision', p_action: 'voice_message' });
    // The one-shot send job is closed with the same lease once the outbox row is queued (never left 'processing').
    expect(rpc.mock.calls[3][1]).toEqual({ p_job_id: stableUuid(['authorized-send-job', input.familyId, input.dedupeKey]),
      p_lease_token: 'lease', p_state: 'completed', p_error_code: null });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain('unencrypted_unavailable');
  });
  it.each(['block','missing_permission','inactive','fingerprint'] as const)('refuses %s authority before enqueue', async mode => {
    const { db, rpc, snapshot } = fixture();
    if (mode === 'block') snapshot.block = 'deny';
    if (mode === 'missing_permission') snapshot.permissions = [];
    if (mode === 'inactive') snapshot.actorActive = false;
    if (mode === 'fingerprint') snapshot.request.fingerprint = 'tampered';
    await expect(enqueueAuthorizedSend(db, KEY, input)).rejects.toThrow();
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain('enqueue_authorized_command');
    // The refused send's job is closed as failed with a code, not left 'processing'.
    expect(rpc.mock.calls.at(-1)).toEqual(['finish_workflow_job', expect.objectContaining({ p_lease_token: 'lease', p_state: 'failed',
      p_error_code: expect.stringMatching(/^send_[a-z_]+$/) })]);
  });
  it('keeps the queued result when closing the send job fails', async () => {
    const { db } = fixture();
    const failing: RpcDb = { rpc: async (name, args) => name === 'finish_workflow_job' ? { data: null, error: { code: 'XX000' } } : db.rpc(name, args) };
    expect(await enqueueAuthorizedSend(failing, KEY, input)).toEqual({ id: 'outbox', duplicate: false, channel: 'twilio' });
  });
  it('refuses missing encryption before preparing any durable work', async () => {
    const { db, rpc } = fixture();
    await expect(enqueueAuthorizedSend(db, undefined, input)).rejects.toThrow('send_encryption_not_configured');
    expect(rpc).not.toHaveBeenCalled();
  });
  it('refuses the unbound refill notice before a bare outbox write', async () => {
    const db = { from: vi.fn(), rpc: vi.fn() };
    const port = createSupabaseCore1OutboxPort(db as unknown as Parameters<typeof createSupabaseCore1OutboxPort>[0], KEY);
    await expect(port.enqueue({ familyId: input.familyId, kind: 'core1.refill_vendor_order', action: 'medicine_refill',
      dedupeKey: 'vendor', payload: {} })).rejects.toThrow('authorized_send_binding_missing');
    expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
  });
  it('refuses unbound Core 2 sends before inserting an outbox row or fence', async () => {
    const db = { from: vi.fn(), rpc: vi.fn() };
    const port = createSupabaseDispatchPort(db as unknown as Parameters<typeof createSupabaseDispatchPort>[0]);
    await expect(port.enqueueAuthorized({ familyId: input.familyId, actionRequestId: null, kind: 'core2.sos_alert',
      dedupeKey: 'sos', payloadCiphertext: 'encrypted' })).rejects.toThrow('authorized dispatch binding');
    expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
  });
  it('refuses phone-dying notice completion before its legacy bare-outbox RPC', async () => {
    const db = { from: vi.fn(), rpc: vi.fn() };
    const port = createDeviceStore(db as unknown as Parameters<typeof createDeviceStore>[0], 'unused', 'test');
    await expect(port.complete({} as never, {} as never, [{} as never])).rejects.toThrow('notice authorization source missing');
    expect(db.from).not.toHaveBeenCalled(); expect(db.rpc).not.toHaveBeenCalled();
  });
});
