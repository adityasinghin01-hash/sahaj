import { describe, expect, it, vi } from 'vitest';
import { requestFingerprint } from '@sahaj/gate';
import { stableUuid } from '@/lib/atlas-runtime/db';
import { prepareCareDelivery, dispatchCareDelivery, careNoticeBody } from '@/lib/core2/authorized-delivery';
import type { VoiceNotifyDeps } from '@/lib/core1/voice-notify';
import { FakeStore, deps as providerDeps, scripted, json, FAMILY, PERSON, OUTBOX, CALL, CALL_SID, LEASE, KEY1 } from '../provider-dispatch/helpers';
import type { SupabaseClient } from '@supabase/supabase-js';
const family = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subject = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', recipient = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const input = { familyId: family, actorPersonId: subject, targetPersonId: recipient, outboxKind: 'core2.sos_alert',
  dedupeKey: 'sos:recipient', sosId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', trustedContactId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', payload: {} };
function fixture(kind = 'core2.sos_alert') {
  const requestId = stableUuid(['authorized-send-request', family, input.dedupeKey]);
  const action = kind === 'core2.reassurance' ? 'share_data' : 'send_alert';
  const calls: string[] = [];
  const snapshot = { found: true, now: '2026-11-15T00:00:00Z', revision: 'real-revision', actorActive: true, block: null,
    request: { actorId: 'server-principal', fingerprint: requestFingerprint({ id: requestId, familyId: family, action,
      targetId: recipient, ...(action === 'share_data' ? { consentSubjectId: subject } : {}) }),
      consumed: false, expired: false, hasDenial: false, status: 'pending' },
    permissions: [{ id: 'permission', familyId: family, actorId: 'server-principal', action,
      validFrom: '2026-11-14T00:00:00Z', expiresAt: '2026-11-16T00:00:00Z', maxAmountMinor: 0,
      vendorIds: [], itemIds: [], targetIds: [recipient], periodStart: '2026-11-14T00:00:00Z', periodEnd: '2026-11-16T00:00:00Z',
      maxUses: 2, usedCount: 0, approvalMode: 'setup' }], approvals: [], consents: [] };
  const chain = { select: vi.fn(() => chain), eq: vi.fn(() => chain), maybeSingle: vi.fn(async () => ({ data: null, error: null })) };
  const rpc = vi.fn(async (name: string) => {
    calls.push(name);
    return { error: null, data: name === 'prepare_care_send' ? { lease: 'sql-lease', channel: 'expo' } :
      name === 'load_gate_snapshot' ? snapshot : { status: 'enqueued', outbox_id: 'outbox' } };
  });
  const db = { from: vi.fn(() => chain), rpc } as unknown as SupabaseClient;
  const timeline = { append: vi.fn(async () => { calls.push('signed-source'); }) };
  return { db, rpc, timeline, calls, snapshot };
}
describe('C-15 durable care delivery', () => {
  it('signs source, loads the server-principal snapshot, then uses the atomic authorized enqueue', async () => {
    const f = fixture();
    const prepared = await prepareCareDelivery(f.db, f.timeline, input, '12'.repeat(32));
    expect(f.calls).toEqual(['signed-source','prepare_care_send','load_gate_snapshot','enqueue_authorized_command']);
    expect(f.rpc.mock.calls).toHaveLength(3);
    expect(prepared).toMatchObject({ id: 'outbox', channel: 'expo', send: { subjectId: subject, recipientId: recipient } });
    expect(f.timeline.append.mock.calls[0]).toBeDefined();
  });
  it('refuses before enqueue without current server permission', async () => {
    const f = fixture(); f.snapshot.permissions = [];
    await expect(prepareCareDelivery(f.db, f.timeline, input, '12'.repeat(32))).rejects.toThrow('send_not_authorized');
    expect(f.calls).not.toContain('enqueue_authorized_command');
  });
  it('requires subject-specific sharing consent for reassurance', async () => {
    const f = fixture('core2.reassurance');
    await expect(prepareCareDelivery(f.db, f.timeline, { ...input, outboxKind: 'core2.reassurance' }, '12'.repeat(32))).rejects.toThrow('send_not_authorized');
  });
  it('does not prepare a send if its signed source failed', async () => {
    const f = fixture(); f.timeline.append.mockRejectedValue(new Error('signing_failed'));
    await expect(prepareCareDelivery(f.db, f.timeline, input, '12'.repeat(32))).rejects.toThrow('signing_failed');
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('claims the guarded push once and preserves an ambiguous provider outcome', async () => {
    const claim = vi.fn(async () => ({ lease: 'lease', attempt: 1, callId: null, personId: recipient }));
    const claimPush = vi.fn(async () => ['ExponentPushToken[synthetic]']);
    const finish = vi.fn(); const sendPush = vi.fn(async () => { throw new Error('ambiguous'); });
    const deps = { pushEnabled: true, sendPush, repo: { claim, claimPush, updateOutboxStatus: finish } } as unknown as VoiceNotifyDeps;
    const send = { familyId: family, subjectId: subject, recipientId: recipient, sourceId: subject,
      kind: 'core2.sos_alert' as const, dedupeKey: 'sos', details: {} };
    await dispatchCareDelivery(deps, send, 'outbox', 'expo');
    expect(claimPush).toHaveBeenCalledWith(family, 'outbox', 'lease');
    expect(finish).toHaveBeenCalledWith('outbox', 'lease', 'delivery_unknown', 'push_delivery_unknown');
    claim.mockResolvedValueOnce(null as never);
    await dispatchCareDelivery(deps, send, 'outbox', 'expo');
    expect(sendPush).toHaveBeenCalledTimes(1);
  });
  it('retains pending work when push is disabled, and formats the demo refill acknowledgment', async () => {
    const claim = vi.fn();
    await dispatchCareDelivery({ pushEnabled: false, repo: { claim } } as unknown as VoiceNotifyDeps,
      { familyId: family, subjectId: subject, recipientId: recipient, sourceId: subject, kind: 'core1.refill_notice', dedupeKey: 'refill' }, 'outbox', 'expo');
    expect(claim).not.toHaveBeenCalled();
    expect(careNoticeBody('core1.refill_notice', { amountMinor: 54000 })).toBe('Gupta Medical ko order bhej diya — ₹540');
  });
  it('places a non-app notice through Phase 2 with the SQL lease and AI-disclosed TwiML', async () => {
    const store = new FakeStore();
    const transport = scripted(json({ sid: CALL_SID },201));
    const { store: _store, ...dispatchDeps } = providerDeps(store, transport.transport);
    const notify = { keypadBaseUrl: 'https://api.example.test', dispatch: { store, deps: dispatchDeps },
      repo: { claim: vi.fn(async () => ({ lease: LEASE, attempt: 1, callId: CALL, personId: PERSON })) } } as unknown as VoiceNotifyDeps;
    await dispatchCareDelivery(notify, { familyId: FAMILY, subjectId: subject, recipientId: PERSON, sourceId: subject,
      kind: 'core2.sos_alert', dedupeKey: 'synthetic-call', details: {} }, OUTBOX, 'twilio');
    expect(transport.calls).toHaveLength(1);
    expect(new URLSearchParams(String(transport.calls[0].init.body)).get('Url')).toBe(`https://api.example.test/api/core2/notices/twiml?outboxId=${OUTBOX}`);
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe('dispatched');
    expect(store.calls.get(CALL)?.ai).toBe(true);
  });

});
