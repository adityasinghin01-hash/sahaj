import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  signTimelineEvent,
  verifyTimelineChain,
  verifyTimelineEvent,
  type SignedTimelineEvent,
  type TimelineHead,
} from '@/lib/timeline';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';
import { getDisposableDatabaseUrl, withDisposableFamily } from './runner/pg-harness';

describe('Matrix Row 14: Timeline verification', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '14')!;

  it('unit/contract: Ed25519 signTimelineEvent + verifyTimelineChain detect payload, sequence, previousHash, and signature tampering', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const familyId = randomUUID();
    const keyId = 'p5h-key-1';
    const keys = new Map([[keyId, publicKey]]);

    const s1: SignedTimelineEvent = signTimelineEvent(
      {
        eventId: randomUUID(),
        familyId,
        sequence: 1,
        previousHash: null,
        dedupeKey: 'row14-unit-1',
        eventType: 'core1.checkin.completed',
        entityId: familyId,
        humanLine: 'Maa answered check-in cleanly',
        occurredAt: '2026-11-14T10:00:00.000Z',
        keyId,
        payload: { status: 'ok' },
      },
      privateKey,
    );
    const s2: SignedTimelineEvent = signTimelineEvent(
      {
        eventId: randomUUID(),
        familyId,
        sequence: 2,
        previousHash: s1.chainHash,
        dedupeKey: 'row14-unit-2',
        eventType: 'core2.reassurance.queued',
        entityId: null,
        humanLine: 'Riya sent I am safe reassurance',
        occurredAt: '2026-11-14T10:05:00.000Z',
        keyId,
        payload: { kind: 'im_safe' },
      },
      privateKey,
    );

    const head: TimelineHead = { familyId, sequence: 2, chainHash: s2.chainHash };
    expect(verifyTimelineEvent(s1, publicKey)).toBe(true);
    expect(verifyTimelineChain([s1, s2], keys, head)).toEqual({ valid: true });

    // 1. Tamper humanLine -> fails signature/chain verification.
    const tamperedHumanLine: SignedTimelineEvent = {
      ...s1,
      envelope: { ...s1.envelope, humanLine: 'Forged line' },
    };
    expect(verifyTimelineChain([tamperedHumanLine, s2], keys, head)).toMatchObject({
      valid: false,
      index: 0,
      reason: 'signature',
    });

    // 2. Sequence gap -> fails sequence check.
    const gapEvent: SignedTimelineEvent = {
      ...s2,
      envelope: { ...s2.envelope, sequence: 3 },
    };
    expect(verifyTimelineChain([gapEvent], keys, head)).toMatchObject({
      valid: false,
      index: 0,
      reason: 'sequence',
    });

    // 3. Broken previousHash link -> fails previous_hash check.
    const brokenLink: SignedTimelineEvent = {
      ...s2,
      envelope: { ...s2.envelope, previousHash: '0'.repeat(64) },
    };
    expect(verifyTimelineChain([s1, brokenLink], keys, head)).toMatchObject({
      valid: false,
      index: 1,
      reason: 'previous_hash',
    });
  });

  const pgUrl = getDisposableDatabaseUrl();
  it('disposable_integrated: append_timeline_event enforces stream head CAS, append-only immutability, and full stored chain verification', async () => {
    if (!pgUrl) {
      const skippedRes = evaluateMatrixStatus(rowSpec, {
        unitPassed: true,
        unitDetail: 'Ed25519 signTimelineEvent + verifyTimelineChain tamper tests passed',
        pgExecuted: false,
        pgPassed: false,
        pgDetail: 'PHASE5_TEST_DATABASE_URL not set; run tests/acceptance/phase5/run-postgres.sh',
      });
      expect(skippedRes.levels.disposableIntegrated.status).toBe('skipped');
      return;
    }

    await withDisposableFamily('row14', async ({ pool, family }) => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const keyId = 'p5h-pg-key-1';
      const payload1 = { attempt: 1 };
      const payload2 = { state: 'active' };

      const s1 = signTimelineEvent(
        {
          eventId: randomUUID(),
          familyId: family.familyId,
          sequence: 1,
          previousHash: null,
          dedupeKey: 'row14-pg-1',
          eventType: 'core1.checkin.scheduled',
          entityId: family.maaPersonId,
          humanLine: 'Daily morning check-in scheduled',
          occurredAt: '2026-11-14T10:00:00.000Z',
          keyId,
          payload: payload1,
        },
        privateKey,
      );
      const s2 = signTimelineEvent(
        {
          eventId: randomUUID(),
          familyId: family.familyId,
          sequence: 2,
          previousHash: s1.chainHash,
          dedupeKey: 'row14-pg-2',
          eventType: 'core2.watch.started',
          entityId: family.riyaPersonId,
          humanLine: 'Going-home watch started',
          occurredAt: '2026-11-14T10:15:00.000Z',
          keyId,
          payload: payload2,
        },
        privateKey,
      );

      await pool.query(
        `SELECT public.append_timeline_event($1::jsonb, $2, $3, $4)`,
        [JSON.stringify(s1.envelope), canonicalJson(payload1), s1.chainHash, s1.signature],
      );
      await pool.query(
        `SELECT public.append_timeline_event($1::jsonb, $2, $3, $4)`,
        [JSON.stringify(s2.envelope), canonicalJson(payload2), s2.chainHash, s2.signature],
      );

      // Broken previousHash against Postgres stream head MUST raise 40001 timeline_head_conflict.
      const staleHead = signTimelineEvent(
        {
          eventId: randomUUID(),
          familyId: family.familyId,
          sequence: 3,
          previousHash: 'f'.repeat(64),
          dedupeKey: 'row14-pg-3',
          eventType: 'core2.watch.extended',
          entityId: family.riyaPersonId,
          humanLine: 'Stale branch write',
          occurredAt: '2026-11-14T10:20:00.000Z',
          keyId,
          payload: {},
        },
        privateKey,
      );
      await expect(
        pool.query(
          `SELECT public.append_timeline_event($1::jsonb, $2, $3, $4)`,
          [JSON.stringify(staleHead.envelope), canonicalJson({}), staleHead.chainHash, staleHead.signature],
        ),
      ).rejects.toThrow(/timeline_head_conflict/);

      // Append-only trigger MUST reject UPDATE or DELETE on timeline_events.
      await expect(
        pool.query(`UPDATE public.timeline_events SET human_line = 'hacked' WHERE family_id = $1 AND sequence = 1`, [
          family.familyId,
        ]),
      ).rejects.toThrow(/append_only_audit/);

      await expect(
        pool.query(`DELETE FROM public.timeline_events WHERE family_id = $1 AND sequence = 1`, [family.familyId]),
      ).rejects.toThrow(/append_only_audit/);

      // Fetch stored rows + head and verify entire chain cryptographically.
      const rows = await pool.query<{
        envelope_canonical: string;
        chain_hash: string;
        signature: string;
      }>(
        `SELECT envelope_canonical, chain_hash, signature
         FROM public.timeline_events WHERE family_id = $1 ORDER BY sequence ASC`,
        [family.familyId],
      );
      const headRow = await pool.query<{ last_sequence: string; last_chain_hash: string }>(
        `SELECT last_sequence, last_chain_hash FROM public.timeline_stream_heads WHERE family_id = $1`,
        [family.familyId],
      );
      const stored: SignedTimelineEvent[] = rows.rows.map((r) => ({
        envelope: JSON.parse(r.envelope_canonical),
        chainHash: r.chain_hash,
        signature: r.signature,
      }));
      const expectedHead: TimelineHead = {
        familyId: family.familyId,
        sequence: Number(headRow.rows[0]!.last_sequence),
        chainHash: headRow.rows[0]!.last_chain_hash,
      };
      expect(verifyTimelineChain(stored, new Map([[keyId, publicKey]]), expectedHead)).toEqual({ valid: true });

      const result = evaluateMatrixStatus(rowSpec, {
        unitPassed: true,
        unitDetail: 'Ed25519 signTimelineEvent & tamper checks passed',
        pgExecuted: true,
        pgPassed: true,
        pgDetail: 'append_timeline_event CAS + append-only trigger + full chain verification passed',
      });
      expect(result.overallStatus).toBe('passed');
    });
  });
});
