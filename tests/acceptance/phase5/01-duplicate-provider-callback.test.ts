import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  handleTeleCmi,
  handleTwilioStatus,
  type TeleCmiConfig,
  type TwilioConfig,
} from '@/lib/provider-ingestion/gateway';
import { WebhookError } from '@/lib/webhook-security';
import { createContractProviderStore, createSyntheticCore1Fixtures } from '../../../harness/core1';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';
import { getDisposableDatabaseUrl, withDisposableFamily } from './runner/pg-harness';
import { RealCallbackSigner } from './runner/ports';

describe('Matrix Row 01: Duplicate signed provider callback', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '01')!;

  it('unit/contract: duplicate Twilio status and TeleCMI callbacks deduplicate safely while forged signatures reject', async () => {
    const family = createSyntheticCore1Fixtures('0001');
    const signer = new RealCallbackSigner();
    const accountSid = 'AC00000000000000000000000000000001';
    const callSid = 'CA00000000000000000000000000000001';
    const authToken = 'p5h-synthetic-twilio-auth-token-32chars';
    const statusUrl = 'https://api.synthetic.test/api/providers/twilio/status';

    const twilioCfg: TwilioConfig = { accountSid, authToken, statusUrl };
    const teleCmiCfg: TeleCmiConfig = { appId: 990011, virtualDigits: '919000000900' };

    const { store, log } = createContractProviderStore({
      calls: [
        {
          provider: 'twilio',
          externalId: callSid,
          call: {
            familyId: family.familyId,
            personId: family.people.maa.id,
            callId: '00000000-0000-4000-8000-000000000111',
            aiDisclosed: true,
          },
        },
      ],
      identities: [
        {
          provider: 'telecmi',
          account: '990011',
          digits: '919000000001',
          identity: { familyId: family.familyId, personId: family.people.maa.id },
        },
      ],
    });

    const signed = signer.signTwilioForm(
      statusUrl,
      {
        AccountSid: accountSid,
        CallSid: callSid,
        CallStatus: 'completed',
        SequenceNumber: '2',
      },
      authToken,
    );

    const first = await handleTwilioStatus(signed.rawBody, signed.contentType, signed.signature, twilioCfg, () => store);
    const second = await handleTwilioStatus(signed.rawBody, signed.contentType, signed.signature, twilioCfg, () => store);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(log.ingested).toHaveLength(1);

    await expect(
      handleTwilioStatus(signed.rawBody, signed.contentType, 'invalid-signature-00000000000=', twilioCfg, () => store),
    ).rejects.toThrowError(WebhookError);

    const teleBody = Buffer.from(
      JSON.stringify({
        type: 'cdr',
        direction: 'inbound',
        status: 'missed',
        appid: 990011,
        virtual_number: '+919000000900',
        cmiuuid: 'cmi-synthetic-0001',
        from: '+919000000001',
        time: 1_760_000_000_000,
      }),
      'utf8',
    );
    await handleTeleCmi(teleBody, teleCmiCfg, () => store, 1_760_000_000_100);
    await handleTeleCmi(teleBody, teleCmiCfg, () => store, 1_760_000_000_200);
    expect(log.ingested).toHaveLength(2);
  });

  const pgUrl = getDisposableDatabaseUrl();
  it('disposable_integrated: ingest_raw_event replays identical callbacks and rejects altered payload conflicts, while full downstream binding stays blocked on phase2/phase3', async () => {
    if (!pgUrl) {
      const result = evaluateMatrixStatus(rowSpec, {
        unitPassed: true,
        unitDetail: 'Gateway signature + idempotent store verified',
        pgExecuted: false,
        pgPassed: false,
        pgDetail: 'PHASE5_TEST_DATABASE_URL not set; skipped disposable DB checks',
      });
      expect(result.overallStatus).toBe('blocked');
      expect(result.blockedBy).toContain('kiro-a (phase2-dispatch)');
      return;
    }

    await withDisposableFamily('row01', async ({ pool, family }) => {
      const payloadHash = createHash('sha256').update('synthetic-twilio-status-v1').digest('hex');
      const otherHash = createHash('sha256').update('tampered-twilio-status-v2').digest('hex');
      const eventId = 'AC00000000000000000000000000000001:call:CA0001:completed:2';

      const first = await pool.query<{ id: string }>(
        `SELECT id FROM public.ingest_raw_event('twilio', $1, 'twilio.call_status', $2::uuid, '{"attempt":1}'::jsonb, $3, 'enc:v1')`,
        [eventId, family.familyId, payloadHash],
      );
      const replay = await pool.query<{ id: string }>(
        `SELECT id FROM public.ingest_raw_event('twilio', $1, 'twilio.call_status', $2::uuid, '{"attempt":1}'::jsonb, $3, 'enc:v1')`,
        [eventId, family.familyId, payloadHash],
      );
      expect(replay.rows[0]?.id).toBe(first.rows[0]?.id);

      await expect(
        pool.query(
          `SELECT id FROM public.ingest_raw_event('twilio', $1, 'twilio.call_status', $2::uuid, '{"attempt":2}'::jsonb, $3, 'enc:v2')`,
          [eventId, family.familyId, otherHash],
        ),
      ).rejects.toThrow(/provider_event_conflict/);

      const result = evaluateMatrixStatus(rowSpec, {
        unitPassed: true,
        unitDetail: 'handleTwilioStatus + handleTeleCmi idempotent ingestion + invalid sig rejection passed',
        pgExecuted: true,
        pgPassed: true,
        pgDetail:
          'public.ingest_raw_event replay/conflict verified; end-to-end delivery/acceptance + timeline binding blocked on kiro-a + kiro-b',
      });
      expect(result.overallStatus).toBe('blocked');
    });
  });
});
