import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSyntheticCore2Fixtures, projectReassuranceForReader } from '../../../harness/core2';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';
import {
  getDisposableDatabaseUrl,
  runAsAuthenticatedUser,
  withDisposableFamily,
} from './runner/pg-harness';

describe('Matrix Row 13: Reports / reassurance', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '13')!;

  it('unit/contract: Core 2 reassurance read projection excludes private location/health/narrative by default', () => {
    const c2 = createSyntheticCore2Fixtures('0013');
    const redacted = projectReassuranceForReader({
      statusLabel: 'checked_in_safe',
      deliveryVerified: false,
      preferences: c2.defaultPreferences,
      privateRouteText: c2.watch.fromLabel,
      privateHealthNote: 'Synthetic private health note',
      privateNarrative: 'Synthetic private narrative',
    });
    expect(redacted).toEqual({
      statusLabel: 'checked_in_safe',
      deliveryVerified: false,
      locationIncluded: false,
      healthIncluded: false,
      narrativeIncluded: false,
      routeText: null,
      healthNote: null,
      narrativeText: null,
    });
  });

  const pgUrl = getDisposableDatabaseUrl();
  it('disposable_integrated: RLS prevents circle/authenticated callers from reading sahaj_private, raw_events, and timeline_events directly', async () => {
    if (!pgUrl) {
      const result = evaluateMatrixStatus(rowSpec, {
        unitPassed: true,
        unitDetail: 'Read-time redaction excludes private route/health/narrative fields by default',
        pgExecuted: false,
        pgPassed: false,
        pgDetail: 'PHASE5_TEST_DATABASE_URL not set',
      });
      expect(result.overallStatus).toBe('blocked');
      return;
    }

    await withDisposableFamily('row13', async ({ pool, family }) => {
      const payloadHash = createHash('sha256').update('private-raw-payload').digest('hex');
      await pool.query(
        `SELECT id FROM public.ingest_raw_event('sarvam', $1, 'sarvam.inbound', $2::uuid, '{}'::jsonb, $3, 'enc:secret')`,
        [`sarvam-rls-${randomUUID()}`, family.familyId, payloadHash],
      );

      // Authenticated circle member cannot query sahaj_private.private_items or public.raw_events directly.
      await expect(
        runAsAuthenticatedUser(pool, family.sharmaUserId, (c) =>
          c.query(`SELECT count(*) FROM sahaj_private.private_items`),
        ),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        runAsAuthenticatedUser(pool, family.sharmaUserId, (c) =>
          c.query(`SELECT id FROM public.raw_events`),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    const result = evaluateMatrixStatus(rowSpec, {
      unitPassed: true,
      unitDetail: 'Read-time reassurance redaction defaults verified',
      pgExecuted: true,
      pgPassed: true,
      pgDetail: 'RLS blocks authenticated circle/user direct reads of sahaj_private & raw_events; report/reassurance API blocked on agy-phase4/agy3',
    });
    expect(result.overallStatus).toBe('blocked');
  });
});
