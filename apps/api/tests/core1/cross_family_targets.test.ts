import { describe, it, expect } from 'vitest';
import { executeCore1Command } from '../../src/lib/core1';
import {
  createTestServicePorts,
  createHttpRequest,
  SYNTHETIC_FAMILY_A,
  SYNTHETIC_PERSON_PARENT,
  SYNTHETIC_MEDICINE,
  SYNTHETIC_VENDOR,
} from './helpers';

describe('Cross-Family Entity Reference Guards (Blocker 1 Fix)', () => {
  it('rejects foreign incidentId not owned by the authenticated family', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'urgent_help',
        subjectPersonId: SYNTHETIC_PERSON_PARENT,
        incidentId: '00000000-0000-4000-8000-000000000999', // Foreign incident!
        severity: 'urgent',
      },
      idempotencyKey: 'idemp-foreign-inc',
    });

    await expect(executeCore1Command(req, ports)).rejects.toMatchObject({
      code: 'foreign_incident_reference',
      status: 403,
    });
  });

  it('rejects foreign subject or personId not in the family', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'check_in',
        personId: '00000000-0000-4000-8000-000000000999', // Foreign person!
      },
      idempotencyKey: 'idemp-foreign-person',
    });

    await expect(executeCore1Command(req, ports)).rejects.toMatchObject({
      code: 'foreign_person_reference',
      status: 403,
    });
  });

  it('rejects foreign medicineId or vendorId in refill proposals', async () => {
    const { ports } = createTestServicePorts();

    // Foreign medicine
    const reqMed = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'refill_proposal',
        personId: SYNTHETIC_PERSON_PARENT,
        medicineId: '00000000-0000-4000-8000-000000000888', // Foreign med!
        vendorId: SYNTHETIC_VENDOR,
      },
      idempotencyKey: 'idemp-foreign-med',
    });

    await expect(executeCore1Command(reqMed, ports)).rejects.toMatchObject({
      code: 'foreign_medicine_reference',
      status: 403,
    });

    // Foreign vendor
    const reqVen = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'refill_proposal',
        personId: SYNTHETIC_PERSON_PARENT,
        medicineId: SYNTHETIC_MEDICINE,
        vendorId: '00000000-0000-4000-8000-000000000777', // Foreign vendor!
      },
      idempotencyKey: 'idemp-foreign-ven',
    });

    await expect(executeCore1Command(reqVen, ports)).rejects.toMatchObject({
      code: 'foreign_vendor_reference',
      status: 403,
    });
  });

  it('rejects foreign consentId in voice message commands', async () => {
    const { ports } = createTestServicePorts();
    const req = createHttpRequest({
      token: 'token-child',
      body: {
        command: 'voice_message',
        recipientPersonId: SYNTHETIC_PERSON_PARENT,
        mediaObjectPath: `${SYNTHETIC_FAMILY_A}/voice/audio1.m4a`,
        consentId: '00000000-0000-4000-8000-000000000666', // Foreign consent!
      },
      idempotencyKey: 'idemp-foreign-consent',
    });

    await expect(executeCore1Command(req, ports)).rejects.toMatchObject({
      code: 'foreign_consent_reference',
      status: 403,
    });
  });
});
