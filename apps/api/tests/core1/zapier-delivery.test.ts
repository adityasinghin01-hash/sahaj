import { describe, expect, it, vi } from 'vitest';
import { postZapierHook, type ZapierZ5ReminderPayload } from '@/lib/core1/zapier';
import { postRedactedWebhook } from '@/lib/redacted-webhook';
const payload: ZapierZ5ReminderPayload = { schema: 'sahaj.zapier.z5.v1', event: 'reminder.refill_due',
  familyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', personId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  entityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', label: 'OTP 987654 phone +91 90000 00001',
  dueAt: '2026-11-15T00:00:00Z', summary: 'Refill due', occurredAt: '2026-11-15T00:00:00Z' };
describe('C-15 optional redacted hooks', () => {
  it('signs each attempt before sending and redacts contact, OTP and location fields', async () => {
    const order: string[] = []; let body = '';
    const result = await postZapierHook({ hook: 'ZAPIER_HOOK_Z5', env: { ZAPIER_HOOK_Z5: 'https://hooks.example/z5' },
      payload: { ...payload, phone: '9000000001', location: { lat: 28, lng: 77 } } as ZapierZ5ReminderPayload,
      audit: async () => { order.push('signed'); }, fetchImpl: async (_url, init) => {
        order.push('post'); body = String(init.body); return new Response('', { status: 200 });
      } });
    expect(result.sent).toBe(true); expect(order).toEqual(['signed','post']);
    expect(body).not.toContain('987654'); expect(body).not.toContain('90000'); expect(body).not.toContain('location');
  });
  it('does not send without a successful signed audit', async () => {
    const fetchImpl = vi.fn();
    const result = await postRedactedWebhook({ url: 'https://hooks.example/z1', payload: {}, fetchImpl,
      audit: async () => { throw new Error('signing_unavailable'); } });
    expect(result.ok).toBe(false); expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('bounds transports that ignore abort and does not throw on HTTP failures', async () => {
    const result = await postRedactedWebhook({ url: 'https://hooks.example/z1', payload: {}, timeoutMs: 5,
      audit: async () => {}, fetchImpl: () => new Promise(() => {}) });
    expect(result).toMatchObject({ ok: false, error: 'timeout' });
    expect(await postRedactedWebhook({ url: 'https://hooks.example/z1', payload: {}, audit: async () => {},
      fetchImpl: async () => new Response('', { status: 502 }) })).toMatchObject({ ok: false, status: 502 });
  });
  it('skips unconfigured hooks and rejects invalid protocols without HTTP', async () => {
    const fetchImpl = vi.fn();
    expect(await postZapierHook({ hook: 'ZAPIER_HOOK_Z5', payload, env: {}, fetchImpl })).toMatchObject({ skippedReason: 'not_configured' });
    expect(await postRedactedWebhook({ url: 'file:///private', payload: {}, fetchImpl, audit: async () => {} })).toMatchObject({ error: 'invalid_url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
