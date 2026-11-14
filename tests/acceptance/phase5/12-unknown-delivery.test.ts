import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTwilioCall } from '../../../packages/adapters/src/twilio';
import { AdapterError, type DispatchLedger } from '../../../packages/adapters/src/contracts';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';
import { getDisposableDatabaseUrl, withDisposableFamily } from './runner/pg-harness';
import { ScriptedTransport } from './runner/ports';

describe('Matrix Row 12: Unknown delivery', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '12')!;

  it('unit/contract: Twilio dispatch marks delivery_unknown on timeout and never retries same idempotencyKey', async () => {
    const transport = new ScriptedTransport();
    transport.push({ kind: 'timeout' });

    const ledgerState = new Map<string, string>();
    const ledger: DispatchLedger = {
      async claim(key) {
        if (ledgerState.has(key)) return false;
        ledgerState.set(key, 'claimed');
        return true;
      },
      async markDispatched(key) {
        ledgerState.set(key, 'dispatched');
      },
      async markFailed(key) {
        ledgerState.set(key, 'failed');
      },
      async markDeliveryUnknown(key) {
        ledgerState.set(key, 'delivery_unknown');
      },
    };

    const req = {
      personId: 'person-maa-001',
      idempotencyKey: 'row12-twilio-idem-1',
      authorization: {
        decision: 'allow' as const,
        consent: true,
        personId: 'person-maa-001',
        action: 'twilio.create_call',
        idempotencyKey: 'row12-twilio-idem-1',
        expiresAt: Date.now() + 60_000,
      },
      payload: {
        to: '+919000000001',
        twimlUrl: 'https://api.synthetic.test/twiml/1',
      },
    };

    await expect(
      createTwilioCall(
        {
          transport: transport.fetch,
          ledger,
          accountSid: 'AC00000000000000000000000000000001',
          authToken: 'p5h-synthetic-token',
          fromNumber: '+919000000999',
          statusCallbackUrl: 'https://api.synthetic.test/twilio/status',
          allowedWebhookHosts: ['api.synthetic.test'],
        },
        req,
      ),
    ).rejects.toMatchObject({ name: 'AdapterError', code: 'delivery_unknown' });

    expect(ledgerState.get('row12-twilio-idem-1')).toBe('delivery_unknown');
    expect(transport.calls()).toHaveLength(1);

    // Second dispatch attempt with same idempotencyKey MUST reject as duplicate_dispatch without touching provider!
    await expect(
      createTwilioCall(
        {
          transport: transport.fetch,
          ledger,
          accountSid: 'AC00000000000000000000000000000001',
          authToken: 'p5h-synthetic-token',
          fromNumber: '+919000000999',
          statusCallbackUrl: 'https://api.synthetic.test/twilio/status',
          allowedWebhookHosts: ['api.synthetic.test'],
        },
        req,
      ),
    ).rejects.toThrowError(AdapterError);
    expect(transport.calls()).toHaveLength(1);
  });

  const pgUrl = getDisposableDatabaseUrl();
  it('disposable_integrated: outbox claim/expiry sets delivery_unknown (no resend) and reconcile_outbox finalizes on callback', async () => {
    if (!pgUrl) {
      const result = evaluateMatrixStatus(rowSpec, {
        unitPassed: true,
        unitDetail: 'createTwilioCall timeout -> delivery_unknown + zero auto-retry passed',
        pgExecuted: false,
        pgPassed: false,
        pgDetail: 'PHASE5_TEST_DATABASE_URL not set',
      });
      expect(result.overallStatus).toBe('blocked');
      return;
    }

    await withDisposableFamily('row12', async ({ pool, family }) => {
      const outboxRes = await pool.query<{ id: string }>(
        `INSERT INTO public.outbox(family_id, kind, dedupe_key, payload_ciphertext, status)
         VALUES ($1, 'urgent.call', $2, 'enc:v1', 'pending') RETURNING id`,
        [family.familyId, `row12-outbox-${randomUUID()}`],
      );
      const outboxId = outboxRes.rows[0]!.id;

      // Worker 1 claims outbox -> lease expires before finish_outbox -> next claim_outbox transitions it to delivery_unknown!
      const claim1 = await pool.query<{ id: string; lease_token: string }>(
        `SELECT id, lease_token FROM public.claim_outbox('worker-timeout', 50, 10) WHERE id = $1`,
        [outboxId],
      );
      expect(claim1.rowCount).toBe(1);
      await pool.query(`UPDATE public.outbox SET lease_until = now() - interval '2 seconds' WHERE id = $1`, [outboxId]);

      const claim2 = await pool.query<{ id: string }>(
        `SELECT id FROM public.claim_outbox('worker-sweeper', 50, 10) WHERE id = $1`,
        [outboxId],
      );
      expect(claim2.rowCount).toBe(0); // NEVER reclaimed for blind resend!

      const afterExpiry = await pool.query<{ status: string; last_error_code: string }>(
        `SELECT status, last_error_code FROM public.outbox WHERE id = $1`,
        [outboxId],
      );
      expect(afterExpiry.rows[0]).toEqual({ status: 'delivery_unknown', last_error_code: 'lease_expired' });

      // Signed callback later arrives as processed delivery.confirmed raw_event -> reconcile_outbox resolves to completed.
      const proofHash = createHash('sha256').update('twilio-completed-callback').digest('hex');
      const rawEv = await pool.query<{ id: string }>(
        `SELECT id FROM public.ingest_raw_event('twilio', $1, 'delivery.confirmed', $2::uuid, $3::jsonb, $4, 'enc:v1')`,
        [
          `twilio:delivered:${randomUUID()}`,
          family.familyId,
          JSON.stringify({ outbox_id: outboxId, outcome: 'delivered' }),
          proofHash,
        ],
      );
      const rawEventId = rawEv.rows[0]!.id;
      await pool.query(`UPDATE public.raw_events SET status = 'processed' WHERE id = $1`, [rawEventId]);

      const reconciled = await pool.query<{ ok: boolean }>(
        `SELECT public.reconcile_outbox($1, $2, 'delivered') AS ok`,
        [outboxId, rawEventId],
      );
      expect(reconciled.rows[0]?.ok).toBe(true);

      const finalRow = await pool.query<{ status: string; reconciliation_event_id: string }>(
        `SELECT status, reconciliation_event_id FROM public.outbox WHERE id = $1`,
        [outboxId],
      );
      expect(finalRow.rows[0]).toEqual({ status: 'completed', reconciliation_event_id: rawEventId });
    });

    const result = evaluateMatrixStatus(rowSpec, {
      unitPassed: true,
      unitDetail: 'Twilio adapter marks delivery_unknown & blocks second send',
      pgExecuted: true,
      pgPassed: true,
      pgDetail: 'claim_outbox expiry -> delivery_unknown + reconcile_outbox passed; worker tick glue blocked on kiro-a/kiro-b',
    });
    expect(result.overallStatus).toBe('blocked');
  });
});
