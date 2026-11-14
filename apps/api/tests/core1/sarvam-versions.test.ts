import { describe, expect, it } from 'vitest';
import { sarvamAgentVersion } from '../../src/lib/core1/sarvam-calls';
import { withSarvamAgentVariablesTransport } from '../../src/lib/core1/check-in-service';

describe('Sarvam agent versions per role', () => {
  it('per-role version wins over the shared one', () => {
    const env = { SARVAM_AGENT_VERSION: '1', SARVAM_AGENT_VERSION_CHECKIN: '4', SARVAM_AGENT_VERSION_RESPONDER: '2' };
    expect(sarvamAgentVersion(env, 'CHECKIN')).toBe(4);
    expect(sarvamAgentVersion(env, 'RESPONDER')).toBe(2);
    expect(sarvamAgentVersion(env, 'CALLBACK')).toBe(1);
  });
  it('defaults to 1 and refuses non-numbers', () => {
    expect(sarvamAgentVersion({}, 'CALLBACK')).toBe(1);
    expect(Number.isNaN(sarvamAgentVersion({ SARVAM_AGENT_VERSION_CALLBACK: 'v3' }, 'CALLBACK'))).toBe(true);
  });
});

describe('check-in call variables', () => {
  it('carries schedule_id and the sole medicine to the check-in agent', async () => {
    let sent = '';
    const transport = async (_url: string, init?: RequestInit) => { sent = String(init?.body); return new Response('{}'); };
    const wrapped = withSarvamAgentVariablesTransport(transport, {
      family_id: '11111111-1111-4111-8111-111111111111', parent_id: '22222222-2222-4222-8222-222222222222',
      address_form: 'Meena ji', call_id: '33333333-3333-4333-8333-333333333333', attempt_number: '1',
      schedule_id: '44444444-4444-4444-8444-444444444444', medicine_id: '55555555-5555-4555-8555-555555555551',
      medicine_label: 'Amlodipine 5 mg',
    });
    await wrapped('https://apps.sarvam.ai/api/outbounds/v1/orgs/o/workspaces/w/outbounds', {
      method: 'POST', body: JSON.stringify({ app_config: { app_id: 'check-in', agent_variables: {} } }),
    });
    const vars = JSON.parse(sent).app_config.agent_variables;
    expect(vars.schedule_id).toBe('44444444-4444-4444-8444-444444444444');
    expect(vars.medicine_id).toBe('55555555-5555-4555-8555-555555555551');
    expect(vars.medicine_label).toBe('Amlodipine 5 mg');
  });
});

import { validateToolInput } from '../../src/lib/core1/sarvam-tools/handler';

describe('dashboard text fields', () => {
  const CALL = '33333333-3333-4333-8333-333333333333';
  it('accepts text whole numbers and spoken yes/no, refuses unclear', () => {
    expect(validateToolInput('reschedule', { schedule_id: CALL, hours: '3' }).hours).toBe(3);
    expect(validateToolInput('medicine_count', { medicine_id: CALL, count: ' 12 ' }).count).toBe(12);
    expect(validateToolInput('accept_incident', { call_id: CALL, incident_id: CALL, assignment_id: CALL, responder_person_id: CALL, promise_minutes: '10' }).promise_minutes).toBe(10);
    expect(validateToolInput('record_consent', { purpose: 'Call', answer: 'haan', call_id: CALL, turn_id: 'consent_call_1' }).answer).toBe(true);
    expect(validateToolInput('record_consent', { purpose: 'record', answer: 'false', call_id: CALL, turn_id: 'consent_record_1' }).answer).toBe(false);
    expect(() => validateToolInput('record_consent', { purpose: 'share', answer: 'shayad', call_id: CALL, turn_id: 't1' })).toThrow();
    expect(() => validateToolInput('reschedule', { schedule_id: CALL, hours: '3.5' })).toThrow();
    expect(() => validateToolInput('reschedule', { schedule_id: CALL, hours: '500' })).toThrow();
  });
});
