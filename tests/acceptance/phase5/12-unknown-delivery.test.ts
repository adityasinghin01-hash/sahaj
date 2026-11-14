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
  it('disposable_integrated: outbox claim/expiry sets delivery_unknown (no resend); only normalized callback proof reconciles it', async () => {
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

    // K-INT2: driven through the real Phase 2/3 chain. Phase 2 final (PR #3) only reconciles an outbox from a NORMALIZED
    // proof event (record_delivery_proof) whose dispatch ledger row was reconciled first; a hand-inserted
    // `delivery.confirmed` raw event is refused. A connected call is never delivery proof, so the callback here is a
    // Sarvam `no_answer` status -> confirmed_not_sent.
    await withDisposableFamily('row12', async ({ pool, family }) => {
      const fam = family.familyId;
      const maa = family.maaPersonId;
      const app = `app-${fam.slice(0, 8)}`;
      const contactHash = createHash('sha256').update(`row12-contact:${fam}`).digest('hex');
      const attemptHash = createHash('sha256').update(`row12-attempt:${fam}`).digest('hex');
      const ids = { principal: randomUUID(), consent: randomUUID(), event: randomUUID(), job: randomUUID(), lease: randomUUID(), request: randomUUID() };
      const attempt = `att-row12-${fam.slice(0, 8)}`;

      const contact = await pool.query<{ id: string }>(
        `INSERT INTO public.provider_identities(family_id, person_id, source, account_id, external_id_hash, binding_kind, contact_ciphertext)
         VALUES ($1, $2, 'sarvam', $3, $4, 'contact', 'enc:v1') RETURNING id`,
        [fam, maa, app, contactHash],
      );
      await pool.query(`INSERT INTO public.atlas_principals(id, family_id, label) VALUES ($1, $2, 'row12')`, [ids.principal, fam]);
      await pool.query(
        `INSERT INTO public.consents(id, family_id, person_id, purpose, question, answer, version)
         VALUES ($1, $2, $3, 'permission_setup', 'q', true, 'v1')`,
        [ids.consent, fam, maa],
      );
      await pool.query(
        `INSERT INTO public.permissions(family_id, person_id, principal_id, action, decision, expires_at, consent_id, valid_from,
           period_start, period_end, max_uses, target_ids)
         VALUES ($1, $2, $3, 'check_in', 'allow', now() + interval '1 day', $4, now() - interval '1 hour', now() - interval '1 hour',
           now() + interval '1 day', 5, array[$5::text])`,
        [fam, maa, ids.principal, ids.consent, maa],
      );
      await pool.query(
        `INSERT INTO public.raw_events(id, family_id, source, provider_event_id, event_type, status, payload_hash)
         VALUES ($1, $2, 'whatsapp', $3, 'whatsapp.text', 'processed', $4)`,
        [ids.event, fam, `row12-${randomUUID()}`, 'a'.repeat(64)],
      );
      await pool.query(
        `INSERT INTO public.workflow_jobs(id, family_id, raw_event_id, thread_id, workflow_kind, state, lease_token, lease_until)
         VALUES ($1, $2, $3, 'row12', 'core1.atlas', 'processing', $4, clock_timestamp() + interval '5 minutes')`,
        [ids.job, fam, ids.event, ids.lease],
      );
      await pool.query(`SELECT public.ensure_action_request($1, $2, $3, $4, $5, 'check_in', $6::text, $7)`, [
        fam, ids.job, ids.lease, ids.request, maa, maa, 'f'.repeat(64),
      ]);
      const revision = (await pool.query<{ r: string }>(`SELECT sahaj_private.authorization_revision($1, $2) AS r`, [fam, ids.request])).rows[0]!.r;
      const enq = await pool.query<{ r: { status: string; outbox_id: string } }>(
        `SELECT public.enqueue_authorized_command($1, $2, $3, $4, 'check_in', $5, 'enc:v1', $6, $7, null, null) AS r`,
        [fam, ids.job, ids.lease, ids.request, `row12-${randomUUID()}`, 'b'.repeat(64), revision],
      );
      expect(enq.rows[0]!.r.status).toBe('enqueued');
      const outboxId = enq.rows[0]!.r.outbox_id;
      const binding = await pool.query<{ call_id: string }>(`SELECT call_id FROM public.dispatch_bindings WHERE outbox_id = $1`, [outboxId]);
      const callId = binding.rows[0]!.call_id;

      // Worker 1 claims the outbox and the dispatch, the provider times out after accepting: ledger -> delivery_unknown.
      const claim1 = await pool.query<{ id: string; lease_token: string }>(
        `SELECT id, lease_token FROM public.claim_outbox('worker-timeout', 50, 10) WHERE id = $1`,
        [outboxId],
      );
      expect(claim1.rowCount).toBe(1);
      const key = `dispatch:${outboxId}:a1`;
      const claimed = await pool.query<{ r: string }>(
        `SELECT public.claim_dispatch_contact($1, $2, $3, 'sarvam', 'sarvam.outbound_call', $4, $5, $6, $7, $8, $9) AS r`,
        [fam, maa, key, outboxId, claim1.rows[0]!.lease_token, callId, contact.rows[0]!.id, app, contactHash],
      );
      expect(claimed.rows[0]!.r).toBe('claimed');
      expect((await pool.query(`SELECT public.mark_dispatch_unknown($1, $2, 'provider_timeout', $3) AS ok`, [fam, key, attempt])).rows[0].ok).toBe(true);
      expect((await pool.query(`SELECT public.bind_dispatch_identity($1, $2, $3, $4, true) AS ok`, [fam, key, app, attemptHash])).rows[0].ok).toBe(true);

      // The outbox lease expires before finish_outbox: the next claim turns it into delivery_unknown and never resends it.
      await pool.query(`UPDATE public.outbox SET lease_until = now() - interval '2 seconds' WHERE id = $1`, [outboxId]);
      const claim2 = await pool.query<{ id: string }>(
        `SELECT id FROM public.claim_outbox('worker-sweeper', 50, 10) WHERE id = $1`,
        [outboxId],
      );
      expect(claim2.rowCount).toBe(0);
      const afterExpiry = await pool.query<{ status: string; last_error_code: string }>(
        `SELECT status, last_error_code FROM public.outbox WHERE id = $1`,
        [outboxId],
      );
      expect(afterExpiry.rows[0]).toEqual({ status: 'delivery_unknown', last_error_code: 'lease_expired' });
      const ledgerRows = await pool.query(`SELECT 1 FROM public.dispatch_ledger WHERE outbox_id = $1`, [outboxId]);
      expect(ledgerRows.rowCount).toBe(1); // exactly one provider attempt

      // A hand-written, non-normalized "delivery" event with perfect-looking metadata is NOT proof.
      const forged = await pool.query<{ id: string }>(
        `INSERT INTO public.raw_events(family_id, source, provider_event_id, event_type, metadata, status, payload_hash)
         VALUES ($1, 'sarvam', $2, 'delivery.not_sent', $3::jsonb, 'processed', $4) RETURNING id`,
        [fam, `row12-forged-${randomUUID()}`, JSON.stringify({ outbox_id: outboxId, outcome: 'confirmed_not_sent', dispatch_key: key, provider_ref: attempt, action: 'check_in', provider_action: 'sarvam.outbound_call', account_id: app }), 'c'.repeat(64)],
      );
      expect((await pool.query(`SELECT public.reconcile_outbox($1, $2, 'confirmed_not_sent') AS ok`, [outboxId, forged.rows[0]!.id])).rows[0].ok).toBe(false);
      expect((await pool.query(`SELECT public.reconcile_dispatch($1, $2, $3, 'confirmed_not_sent') AS ok`, [fam, key, forged.rows[0]!.id])).rows[0].ok).toBe(false);

      // The signature-verified provider callback (stored raw, processed) arrives later: no_answer.
      const src = await pool.query<{ id: string }>(
        `INSERT INTO public.raw_events(family_id, source, provider_event_id, event_type, metadata, status, payload_hash)
         VALUES ($1, 'sarvam', $2, 'sarvam.outbound', $3::jsonb, 'processed', $4) RETURNING id`,
        [fam, `row12-status-${randomUUID()}`, JSON.stringify({ status: 'no_answer', provider_ref: attempt, person_id: maa }), 'd'.repeat(64)],
      );
      // A delivered outcome cannot be claimed from a call status.
      await expect(pool.query(`SELECT public.record_delivery_proof($1, $2, 'delivered')`, [fam, src.rows[0]!.id])).rejects.toMatchObject({ code: '42501' });
      const proof = await pool.query<{ p: { proof_event_id: string; outbox_id: string; dispatch_key: string } }>(
        `SELECT public.record_delivery_proof($1, $2, 'confirmed_not_sent') AS p`,
        [fam, src.rows[0]!.id],
      );
      const proofId = proof.rows[0]!.p.proof_event_id;
      expect(proof.rows[0]!.p).toMatchObject({ outbox_id: outboxId, dispatch_key: key });
      // Outbox reconciliation requires the ledger to be reconciled with the same proof first.
      expect((await pool.query(`SELECT public.reconcile_outbox($1, $2, 'confirmed_not_sent') AS ok`, [outboxId, proofId])).rows[0].ok).toBe(false);
      expect((await pool.query(`SELECT public.reconcile_dispatch($1, $2, $3, 'confirmed_not_sent') AS ok`, [fam, key, proofId])).rows[0].ok).toBe(true);
      expect((await pool.query(`SELECT public.reconcile_outbox($1, $2, 'confirmed_not_sent') AS ok`, [outboxId, proofId])).rows[0].ok).toBe(true);

      const finalRow = await pool.query<{ status: string; reconciliation_event_id: string }>(
        `SELECT status, reconciliation_event_id FROM public.outbox WHERE id = $1`,
        [outboxId],
      );
      expect(['failed', 'dead']).toContain(finalRow.rows[0]!.status);
      expect(finalRow.rows[0]!.reconciliation_event_id).toBe(proofId);
      const ledgerFinal = await pool.query<{ status: string }>(`SELECT status FROM public.dispatch_ledger WHERE idempotency_key = $1`, [key]);
      expect(ledgerFinal.rows[0]!.status).toBe('not_sent');
    });

    const result = evaluateMatrixStatus(rowSpec, {
      unitPassed: true,
      unitDetail: 'Twilio adapter marks delivery_unknown & blocks second send',
      pgExecuted: true,
      pgPassed: true,
      pgDetail: 'claim_outbox expiry -> delivery_unknown; forged event refused; record_delivery_proof -> reconcile_dispatch -> reconcile_outbox passed; worker tick glue blocked on kiro-a/kiro-b',
    });
    expect(result.overallStatus).toBe('blocked');
  });
});
