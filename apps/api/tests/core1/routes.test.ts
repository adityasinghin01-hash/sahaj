import { describe, it, expect } from 'vitest';
import { handleCore1ApiRoute } from '../../src/lib/core1';
import {
  createTestServicePorts,
  createHttpRequest,
  SYNTHETIC_FAMILY_A,
  SYNTHETIC_PERSON_PARENT,
  SYNTHETIC_MEDICINE,
  SYNTHETIC_VENDOR,
  SYNTHETIC_CONSENT,
} from './helpers';

describe('Core 1 API Route Handlers', () => {
  it('handles general POST /api/core1 command endpoint returning 202', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'check_in',
        personId: SYNTHETIC_PERSON_PARENT,
      },
      idempotencyKey: 'idemp-route-1',
    });

    const res = await handleCore1ApiRoute(req, ports);
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe('queued');
    expect(json.commandType).toBe('check_in');
  });

  it('handles dedicated POST /api/core1/check-in route', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        personId: SYNTHETIC_PERSON_PARENT,
        preferredTime: '09:00',
      },
      idempotencyKey: 'idemp-checkin-route',
    });

    const res = await handleCore1ApiRoute(req, ports, 'check_in');
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.commandType).toBe('check_in');
  });

  it('handles dedicated POST /api/core1/urgent-help route', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        subjectPersonId: SYNTHETIC_PERSON_PARENT,
        severity: 'urgent',
      },
      idempotencyKey: 'idemp-urgent-route',
    });

    const res = await handleCore1ApiRoute(req, ports, 'urgent_help');
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.commandType).toBe('urgent_help');
  });

  it('handles dedicated POST /api/core1/voice-message route', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        recipientPersonId: SYNTHETIC_PERSON_PARENT,
        mediaObjectPath: `${SYNTHETIC_FAMILY_A}/voice/message_01.m4a`,
        consentId: SYNTHETIC_CONSENT,
      },
      idempotencyKey: 'idemp-voice-route',
    });

    const res = await handleCore1ApiRoute(req, ports, 'voice_message');
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.commandType).toBe('voice_message');
  });

  it('handles dedicated POST /api/core1/refill route', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        medicineId: SYNTHETIC_MEDICINE,
        personId: SYNTHETIC_PERSON_PARENT,
        vendorId: SYNTHETIC_VENDOR,
        reorderPacks: 2,
      },
      idempotencyKey: 'idemp-refill-route',
    });

    const res = await handleCore1ApiRoute(req, ports, 'refill_proposal');
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.commandType).toBe('refill_proposal');
  });

  it('handles dedicated POST /api/core1/missed-call-nudge route', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        callerPersonId: SYNTHETIC_PERSON_PARENT,
        recipientPersonId: SYNTHETIC_PERSON_PARENT,
        providerCallId: 'twilio-call-999',
      },
      idempotencyKey: 'idemp-nudge-route',
    });

    const res = await handleCore1ApiRoute(req, ports, 'missed_call_nudge');
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.commandType).toBe('missed_call_nudge');
  });

  it('handles dedicated POST /api/core1/family-report route', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        periodStart: '2026-11-01T00:00:00.000Z',
        periodEnd: '2026-11-15T00:00:00.000Z',
      },
      idempotencyKey: 'idemp-report-route',
    });

    const res = await handleCore1ApiRoute(req, ports, 'family_report');
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.commandType).toBe('family_report');
  });
});
