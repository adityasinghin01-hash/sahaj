import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/database', () => ({ serviceDatabase: () => ({ rpc: f.rpc }) }));
import { POST } from '@/app/api/core2/notices/twiml/route';
const base = 'https://api.example.test', account = `AC${'a'.repeat(32)}`, token = 'synthetic-token';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function request(valid = true, overrides: Record<string,string> = {}) {
  vi.stubEnv('TWILIO_AUTH_TOKEN', token); vi.stubEnv('TWILIO_ACCOUNT_SID', account); vi.stubEnv('TWILIO_VOICE_BASE_URL', base);
  const url = `${base}/api/core2/notices/twiml?outboxId=${id}`;
  const form = new URLSearchParams({ AccountSid: account, CallSid: `CA${'b'.repeat(32)}`, ...overrides });
  let data = url; [...form.keys()].sort().forEach(key => { data += key + form.get(key); });
  const signature = createHmac('sha1', token).update(data).digest('base64');
  return new Request(url, { method: 'POST', headers: { 'x-twilio-signature': valid ? signature : 'bad' }, body: form });
}
afterEach(() => { vi.unstubAllEnvs(); f.rpc.mockReset(); });
describe('C-15 verified care notice TwiML', () => {
  it('rejects invalid signatures and another account before database access', async () => {
    expect((await POST(request(false))).status).toBe(401);
    expect((await POST(request(true, { AccountSid: `AC${'c'.repeat(32)}` }))).status).toBe(401);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('requires the stored call/outbox binding and current SQL authorization', async () => {
    f.rpc.mockResolvedValue({ data: null, error: null });
    expect((await POST(request())).status).toBe(403);
    expect(f.rpc).toHaveBeenCalledWith('read_care_notice', { p_outbox_id: id, p_call_sid: `CA${'b'.repeat(32)}` });
  });
  it('discloses AI and escapes the calm status without claiming acceptance or heard proof', async () => {
    f.rpc.mockResolvedValue({ data: { kind: 'core2.reassurance', details: { statusLabel: '<safe & calm>' } }, error: null });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Main Sahaj AI hoon. Parivar ka sandesh: &lt;safe &amp; calm&gt;');
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
});
