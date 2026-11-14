import { describe, expect, it, vi } from 'vitest';
import { createSarvamHandler, FALLBACK_LINE, REAL_NEWS_LINE, type SarvamPorts } from '@/lib/core1/sarvam-tools/handler';

const family_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const parent_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const env = { SARVAM_TOOL_TOKEN: 'test-tool-secret', ALLOW_ANY_TOOL_IP: '1' };
const cases = {
  raise_urgent: { said: 'Main gir gayi', severity: 'urgent' },
  check_status: {},
  leave_message: { transcript: 'Riya ghar aa jao 98765 43210 OTP ४ ५ ६ ७' },
  child_status: {},
  child_scam_check: { asked_for: 'Riya ke liye 123456 bhejo' },
  record_consent: { purpose: 'record', answer: true, call_id: id, turn_id: 'consent-record' },
  reschedule: { hours: 2, schedule_id: id },
  mark_private: { call_id: id },
  cancel_permission: { permission_id: id, confirmed: true },
  medicine_count: { medicine_id: id, count: 6, vendor_id: id },
  accept_incident: { call_id: id, incident_id: id, assignment_id: id, responder_person_id: id, raw_event_id: id, promise_minutes: 4 },
  decline_incident: { call_id: id, incident_id: id, assignment_id: id, responder_person_id: id, raw_event_id: id },
} as const;
function request(input: unknown, token: string | null = 'test-tool-secret') {
  return new Request('http://localhost/api/core1/sarvam/tool', { method: 'POST', headers: {
    'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    'idempotency-key': 'test-turn',
  }, body: JSON.stringify(input) });
}
function fixture() {
  const execute = vi.fn().mockResolvedValue({ status: 'saved' });
  const ports: SarvamPorts = { assertParent: vi.fn().mockResolvedValue(undefined), execute };
  return { ports, execute, handle: createSarvamHandler(() => ports, env) };
}
describe('Core 1 Sarvam boundary', () => {
  it.each([null, 'wrong'])('rejects missing/wrong auth %s before initializing services', async token => {
    const factory = vi.fn();
    const response = await createSarvamHandler(factory, env)(request({}, token), 'raise_urgent');
    expect(response.status).toBe(401); expect(factory).not.toHaveBeenCalled();
    expect((await response.json()).line_hi).toBe(FALLBACK_LINE);
  });
  it('rejects missing context', async () => {
    const f = fixture();
    expect((await f.handle(request({}), 'check_status')).status).toBe(400);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('enforces the same Sarvam IP allowlist as Shield', async () => {
    const f = fixture();
    const response = await createSarvamHandler(() => f.ports, { SARVAM_TOOL_TOKEN: env.SARVAM_TOOL_TOKEN })(request({ family_id, parent_id }), 'check_status');
    expect(response.status).toBe(401); expect(f.execute).not.toHaveBeenCalled();
  });
  it('requires stable idempotency for mutations', async () => {
    const f = fixture(); const req = request({ family_id, parent_id, permission_id: id, confirmed: true });
    req.headers.delete('idempotency-key');
    expect((await f.handle(req, 'cancel_permission')).status).toBe(400);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('derives idempotency from trusted call and invocation variables', async () => {
    const f = fixture(); const req = request({ agent_variables: { family_id, parent_id, call_id: id, turn_id: 'tool-invocation' }, input: { transcript: 'Riya ghar aa jao' } });
    req.headers.delete('idempotency-key');
    expect((await f.handle(req, 'leave_message')).status).toBe(200);
    expect(f.execute.mock.calls[0][3]).toBe(`${id}:tool-invocation`);
  });
  it.each(Object.entries(cases))('%s invokes its command with verified context', async (tool, fields) => {
    const f = fixture();
    const response = await f.handle(request({ family_id, parent_id, ...fields }), tool);
    expect(response.status).toBe(200);
    expect(f.ports.assertParent).toHaveBeenCalledWith({ familyId: family_id, parentId: parent_id });
    expect(f.execute).toHaveBeenCalledWith(tool, { familyId: family_id, parentId: parent_id }, expect.any(Object), 'test-turn');
    const body = await response.json();
    expect(body.line_hi.length).toBeGreaterThan(5); expect(body.transfer).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/\d{4,}|[०-९]{4,}/);
    expect(JSON.stringify(f.execute.mock.calls)).not.toContain('98765');
    expect(JSON.stringify(f.execute.mock.calls)).not.toContain('123456');
    if (tool === 'child_scam_check') expect(body.line_hi).toBe(REAL_NEWS_LINE);
  });
  it.each(['variables', 'agent_variables', 'context'])('accepts %s and arguments envelope', async envelope => {
    const f = fixture();
    const response = await f.handle(request({ [envelope]: { family_id, parent_id }, arguments: {} }), 'check_status');
    expect(response.status).toBe(200);
  });
  it.each(Object.keys(cases))('%s transfers on internal failure without leaking errors', async tool => {
    const f = fixture(); f.execute.mockRejectedValue(new Error('OTP 123456 phone 9876543210'));
    const response = await f.handle(request({ family_id, parent_id, ...cases[tool as keyof typeof cases] }), tool);
    expect(await response.json()).toEqual({ line_hi: FALLBACK_LINE, result: { error: 'unavailable' }, transfer: true });
  });
  it('does not return service extras, raw identifiers, addresses or OTPs', async () => {
    const f = fixture(); f.execute.mockResolvedValue({ status: 'safe', location: 'Delhi', otp: '123456', phone: '9876543210' });
    const body = await (await f.handle(request({ family_id, parent_id }), 'child_status')).json();
    expect(body).not.toHaveProperty('location'); expect(JSON.stringify(body)).not.toMatch(/Delhi|123456|9876543210/);
  });
  it('transfers when parent scope verification fails', async () => {
    const f = fixture(); vi.mocked(f.ports.assertParent).mockRejectedValue(new Error('foreign parent'));
    expect((await (await f.handle(request({ family_id, parent_id }), 'check_status')).json()).transfer).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([
    ['medicine_count', { medicine_id: id, count: -1 }],
    ['medicine_count', { medicine_id: id, count: 1.5 }],
    ['cancel_permission', { permission_id: id, confirmed: false }],
    ['record_consent', { purpose: 'record', answer: 'haan', call_id: id }],
    ['mark_private', {}],
  ])('rejects invalid %s input', async (tool, input) => {
    const f = fixture();
    expect((await f.handle(request({ family_id, parent_id, ...input }), tool as string)).status).toBe(400);
    expect(f.execute).not.toHaveBeenCalled();
  });
  it('bounds request bytes and handles malformed JSON', async () => {
    const f = fixture();
    for (const raw of ['{', JSON.stringify({ family_id, parent_id, transcript: 'x'.repeat(70000) })]) {
      const req = new Request('http://localhost', { method: 'POST', headers: { authorization: 'Bearer test-tool-secret' }, body: raw });
      expect((await f.handle(req, 'leave_message')).status).toBe(400);
    }
  });
  it('keeps the never-dead line bounded on a stalled dependency', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); f.execute.mockImplementation(() => new Promise(() => {}));
      const pending = f.handle(request({ family_id, parent_id }), 'check_status');
      await vi.advanceTimersByTimeAsync(4500);
      expect((await (await pending).json()).transfer).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('does not start a mutation after context lookup exceeds the deadline', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let resolve!: () => void;
      vi.mocked(f.ports.assertParent).mockImplementation(() => new Promise<void>(done => { resolve = done; }));
      const pending = f.handle(request({ family_id, parent_id, ...cases.raise_urgent }), 'raise_urgent');
      await vi.advanceTimersByTimeAsync(4500);
      expect((await (await pending).json()).transfer).toBe(true);
      resolve(); await vi.advanceTimersByTimeAsync(1);
      expect(f.execute).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('K-SARVAMCALL: responder decision needs no raw_event_id, reads saved ids from agent_variables, is keyed per call id', async () => {
    const f = fixture();
    f.execute.mockResolvedValue({ status: 'accepted' });
    const body = { agent_variables: { family_id, parent_id, call_id: id, incident_id: id, assignment_id: id, responder_person_id: id, attempt_id: 'att-synth-1' },
      input: { promise_minutes: 10 } };
    const req = new Request('http://localhost/api/core1/sarvam/accept_incident', { method: 'POST', headers: {
      'content-type': 'application/json', authorization: 'Bearer test-tool-secret' }, body: JSON.stringify(body) });
    const response = await f.handle(req, 'accept_incident');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { status: 'accepted' }, transfer: false });
    expect(f.execute).toHaveBeenCalledWith('accept_incident', { familyId: family_id, parentId: parent_id },
      { call_id: id, incident_id: id, assignment_id: id, responder_person_id: id, provider_call_ref: 'att-synth-1', promise_minutes: 10 },
      `responder-decision:${id}`);
  });
  it('K-SARVAMCALL: a refused decision (foreign/expired call) transfers with the fixed line', async () => {
    const f = fixture();
    f.execute.mockRejectedValue(new Error('sarvam_decision_refused'));
    const response = await f.handle(request({ family_id, parent_id, call_id: id, incident_id: id, assignment_id: id, responder_person_id: id }), 'decline_incident');
    expect(await response.json()).toEqual({ line_hi: FALLBACK_LINE, result: { error: 'unavailable' }, transfer: true });
    const bad = await f.handle(request({ family_id, parent_id, call_id: id, incident_id: id, assignment_id: id, responder_person_id: id, provider_call_ref: 'bad ref!' }), 'decline_incident');
    expect(bad.status).toBe(400);
  });
});
