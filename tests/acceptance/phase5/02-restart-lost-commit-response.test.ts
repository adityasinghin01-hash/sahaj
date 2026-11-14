import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, signTimelineEvent } from '@/lib/timeline';
import { core1RequestHash, core1ScopeHash, createSyntheticCore1Fixtures } from '../../../harness/core1';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';
import { getDisposableDatabaseUrl, withDisposableFamily } from './runner/pg-harness';
import { ControlledCrashPort } from './runner/ports';
import { SimulatedCrashError } from './runner/types';

describe('Matrix Row 02: Restart / lost commit response', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '02')!;

  it('unit/contract: core1_commands hashes are deterministic across crash-retry and conflict on altered payload', () => {
    const family = createSyntheticCore1Fixtures('0002');
    const scope = {
      familyId: family.familyId,
      actorPersonId: family.people.riya.id,
      commandKind: 'checkin.trigger' as const,
      idempotencyKey: 'idem-lost-response-01',
    };
    const scopeHash = core1ScopeHash(scope);
    const reqHashA = core1RequestHash('checkin.trigger', { schedule_id: 'sch-1', target_id: family.people.maa.id });
    const reqHashB = core1RequestHash('checkin.trigger', { schedule_id: 'sch-1', target_id: family.people.sharma.id });
    expect(scopeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(reqHashA).not.toBe(reqHashB);

    const crash = new ControlledCrashPort();
    crash.armOnce('after_commit_before_response', 'simulated lost HTTP 202');
    expect(() => crash.checkpoint('after_commit_before_response')).toThrowError(SimulatedCrashError);
    expect(() => crash.checkpoint('after_commit_before_response')).not.toThrow();
    expect(core1ScopeHash(scope)).toBe(scopeHash);
  });

  const pgUrl = getDisposableDatabaseUrl();
  it('disposable_integrated: append_timeline_event recovers exact dedupe replay and rejects conflicting payload while route idempotency stays blocked on kiro-b/phase4/core2', async () => {
    if (!pgUrl) {
      const res = evaluateMatrixStatus(rowSpec, {
        unitPassed: true,
        unitDetail: 'Deterministic scope/request hash & SimulatedCrashPort verified',
        pgExecuted: false,
        pgPassed: false,
        pgDetail: 'PHASE5_TEST_DATABASE_URL not set',
      });
      expect(res.overallStatus).toBe('blocked');
      return;
    }

    await withDisposableFamily('row02', async ({ pool, family }) => {
      const { privateKey } = generateKeyPairSync('ed25519');
      const payload1 = { step: 'initial' };
      const payloadCanonical1 = canonicalJson(payload1);
      const signed = signTimelineEvent(
        {
          eventId: 'aaaaaaaa-0000-4000-8000-000000000001',
          familyId: family.familyId,
          sequence: 1,
          previousHash: null,
          dedupeKey: 'row02-dedupe-01',
          eventType: 'checkin.triggered',
          entityId: family.maaPersonId,
          humanLine: 'Synthetic daily check-in scheduled',
          occurredAt: '2026-11-14T10:00:00.000Z',
          keyId: 'p5h-key-1',
          payload: payload1,
        },
        privateKey,
      );

      const pEvent = JSON.stringify(signed.envelope);
      const first = await pool.query<{ id: string }>(
        `SELECT id FROM public.append_timeline_event($1::jsonb, $2, $3, $4)`,
        [pEvent, payloadCanonical1, signed.chainHash, signed.signature],
      );
      const retry = await pool.query<{ id: string }>(
        `SELECT id FROM public.append_timeline_event($1::jsonb, $2, $3, $4)`,
        [pEvent, payloadCanonical1, signed.chainHash, signed.signature],
      );
      expect(retry.rows[0]?.id).toBe(first.rows[0]?.id);

      // Same dedupeKey with different payload MUST raise 23505 timeline_dedupe_conflict.
      const payload2 = { step: 'tampered' };
      const payloadCanonical2 = canonicalJson(payload2);
      const tampered = signTimelineEvent(
        {
          eventId: 'aaaaaaaa-0000-4000-8000-000000000002',
          familyId: family.familyId,
          sequence: 2,
          previousHash: signed.chainHash,
          dedupeKey: 'row02-dedupe-01',
          eventType: 'checkin.triggered',
          entityId: family.maaPersonId,
          humanLine: 'Synthetic daily check-in tampered',
          occurredAt: '2026-11-14T10:00:01.000Z',
          keyId: 'p5h-key-1',
          payload: payload2,
        },
        privateKey,
      );

      await expect(
        pool.query(
          `SELECT id FROM public.append_timeline_event($1::jsonb, $2, $3, $4)`,
          [JSON.stringify(tampered.envelope), payloadCanonical2, tampered.chainHash, tampered.signature],
        ),
      ).rejects.toThrow(/timeline_dedupe_conflict/);
    });

    const result = evaluateMatrixStatus(rowSpec, {
      unitPassed: true,
      unitDetail: 'Deterministic command hashes + crash/retry contract passed',
      pgExecuted: true,
      pgPassed: true,
      pgDetail: 'append_timeline_event dedupe recovery & conflict passed; HTTP route idempotency blocked on kiro-b/agy-phase4/agy3',
    });
    expect(result.overallStatus).toBe('blocked');
  });
});
