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
