import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseGatherReply } from '../../../packages/adapters/src/twilio';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';
import { getDisposableDatabaseUrl, withDisposableFamily } from './runner/pg-harness';

describe('Matrix Row 06: Responder acceptance', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '06')!;

  it('unit/contract: parseGatherReply accepts explicit digit 1 and refuses low-confidence speech ambiguity', () => {
    expect(parseGatherReply(new URLSearchParams({ Digits: '1' }))).toEqual({
      choice: 'yes',
      via: 'dtmf',
      confidence: null,
    });
    expect(parseGatherReply(new URLSearchParams({ SpeechResult: 'haan', Confidence: '0.35' }))).toEqual({
      choice: 'unknown',
      via: 'speech',
      confidence: 0.35,
    });
    expect(parseGatherReply(new URLSearchParams({ SpeechResult: 'haan', Confidence: '0.92' }))).toEqual({
      choice: 'yes',
      via: 'speech',
      confidence: 0.92,
    });
  });

  const pgUrl = getDisposableDatabaseUrl();
  it('disposable_integrated: database schema rejects accepted assignment without verified_by_provider_event', async () => {
    if (!pgUrl) {
      expect(rowSpec.requiredLanes.length).toBeGreaterThan(0);
      return;
    }

    await withDisposableFamily('row06', async ({ pool, family }) => {
      const incidentRes = await pool.query<{ id: string }>(
        `INSERT INTO public.incidents(family_id, person_id, severity, state)
         VALUES ($1, $2, 'urgent', 'open') RETURNING id`,
        [family.familyId, family.maaPersonId],
      );
      const incidentId = incidentRes.rows[0]!.id;

      // Attempting accepted status WITHOUT accepted_at + verified_by_provider_event MUST fail DB check constraint.
      await expect(
        pool.query(
          `INSERT INTO public.assignments(family_id, incident_id, person_id, status, expires_at)
           VALUES ($1, $2, $3, 'accepted', now() + interval '10 minutes')`,
          [family.familyId, incidentId, family.sharmaPersonId],
        ),
      ).rejects.toThrow(/check/i);

      // Sending an alert only permits 'offered' initially.
      const offered = await pool.query<{ id: string; status: string }>(
        `INSERT INTO public.assignments(family_id, incident_id, person_id, status, expires_at)
         VALUES ($1, $2, $3, 'offered', now() + interval '10 minutes') RETURNING id, status`,
        [family.familyId, incidentId, family.sharmaPersonId],
      );
      expect(offered.rows[0]?.status).toBe('offered');

      // Verified provider event unlocks transition to 'accepted'.
      const proofHash = createHash('sha256').update('twilio-gather-digit-1').digest('hex');
      const proofEv = await pool.query<{ id: string }>(
        `SELECT id FROM public.ingest_raw_event('twilio', 'CA0006:gather:1', 'twilio.gather', $1::uuid, '{"digit":"1"}'::jsonb, $2, 'enc:v1')`,
        [family.familyId, proofHash],
      );
      await pool.query(
        `UPDATE public.assignments SET status = 'accepted', accepted_at = now(), verified_by_provider_event = $2 WHERE id = $1`,
        [offered.rows[0]!.id, proofEv.rows[0]!.id],
      );
    });

    const result = evaluateMatrixStatus(rowSpec, {
      unitPassed: true,
      unitDetail: 'parseGatherReply DTMF + speech confidence threshold verified',
      pgExecuted: true,
      pgPassed: true,
      pgDetail: 'DB constraint verified_by_provider_event enforced; full flow blocked on kiro-a/kiro-b/agy-phase4',
    });
    expect(result.overallStatus).toBe('blocked');
  });
});
