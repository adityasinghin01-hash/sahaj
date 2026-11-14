import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { PHASE5_ACCEPTANCE_MATRIX, evaluateMatrixStatus } from './matrix';
import { getDisposableDatabaseUrl, withDisposableFamily } from './runner/pg-harness';

const execFileAsync = promisify(execFile);

describe('Matrix Row 11: Lease / checkpoint theft', () => {
  const rowSpec = PHASE5_ACCEPTANCE_MATRIX.find((r) => r.rowId === '11')!;

  it('unit/contract: matrix row 11 has zero blocked lane dependencies', () => {
    expect(rowSpec.requiredLanes).toEqual([]);
    expect(rowSpec.foundationChecksAvailable).toBe(true);
  });

  const pgUrl = getDisposableDatabaseUrl();
  it('disposable_integrated: Process A crashes after Postgres checkpoint, Process B reclaims expired lease and resumes while stale lease is rejected', async () => {
    if (!pgUrl) {
      const skippedRes = evaluateMatrixStatus(rowSpec, {
        unitPassed: true,
        unitDetail: 'Row 11 requires no unmerged lane dependencies',
        pgExecuted: false,
        pgPassed: false,
        pgDetail: 'PHASE5_TEST_DATABASE_URL not set; run tests/acceptance/phase5/run-postgres.sh',
      });
      expect(skippedRes.levels.disposableIntegrated.status).toBe('skipped');
      return;
    }

    await withDisposableFamily('row11', async ({ pool, family }) => {
      const payloadHash = createHash('sha256').update('row11-checkin-event').digest('hex');
      const rawRes = await pool.query<{ id: string }>(
        `SELECT id FROM public.ingest_raw_event('internal', $1, 'checkin.due', $2::uuid, '{}'::jsonb, $3, 'enc:v1')`,
        [`row11-${randomUUID()}`, family.familyId, payloadHash],
      );
      const rawEventId = rawRes.rows[0]!.id;

      const jobRes = await pool.query<{ id: string }>(
        `INSERT INTO public.workflow_jobs(family_id, raw_event_id, thread_id, workflow_kind, state)
         VALUES ($1, $2, $3, 'checkin', 'pending') RETURNING id`,
        [family.familyId, rawEventId, `atlas:row11:${randomUUID()}`],
      );
      const jobId = jobRes.rows[0]!.id;

      const outboxRes = await pool.query<{ id: string }>(
        `INSERT INTO public.outbox(family_id, workflow_job_id, kind, dedupe_key, payload_ciphertext, status)
         VALUES ($1, $2, 'checkin.call', $3, 'enc:v1', 'pending') RETURNING id`,
        [family.familyId, jobId, `row11-outbox-${randomUUID()}`],
      );
      const outboxId = outboxRes.rows[0]!.id;

      const tsxBin = path.join(process.cwd(), 'node_modules/.bin/tsx');
      const workerScript = path.join(process.cwd(), 'tests/acceptance/phase5/runner/two-process-worker.ts');
      const requestId = randomUUID();
      const baseEnv = {
        ...process.env,
        PHASE5_TEST_DATABASE_URL: pgUrl,
        P5H_FAMILY_ID: family.familyId,
        P5H_JOB_ID: jobId,
        P5H_EVENT_ID: rawEventId,
        P5H_ACTOR_ID: family.maaPersonId,
        P5H_REQUEST_ID: requestId,
        P5H_TARGET_ID: family.maaPersonId,
        P5H_OUTBOX_ID: outboxId,
      };

      // OS Process A: claims job lease, runs Atlas start() into PostgresSaver checkpoint, crashes before finish_workflow_job.
      const procA = await execFileAsync(tsxBin, [workerScript, 'claim-and-crash'], { env: baseEnv });
      const outA = JSON.parse(procA.stdout.trim()) as {
        event: string;
        leaseToken: string;
        threadId: string;
        checkpointId: string;
      };
      expect(outA.event).toBe('worker_a_crashed_after_checkpoint');
      expect(outA.leaseToken).toMatch(/^[0-9a-f-]{36}$/i);

      // Simulate lease expiry while Process A is dead.
      await pool.query(
        `UPDATE public.workflow_jobs SET lease_until = now() - interval '2 seconds' WHERE id = $1`,
        [jobId],
      );

      // OS Process B: rejects stale lease from A, reclaims lease, resumes PostgresSaver checkpoint, finishes job.
      const procB = await execFileAsync(tsxBin, [workerScript, 'verify-stale-and-resume'], {
        env: { ...baseEnv, P5H_STALE_LEASE_TOKEN: outA.leaseToken },
      });
      const outB = JSON.parse(procB.stdout.trim()) as {
        event: string;
        threadId: string;
        resumedStatus: string;
        resumedNextCount: number;
        staleAcceptedBeforeReclaim: boolean;
        staleAcceptedWhileWorkerBHolds: boolean;
        workerBFreshLeaseFinished: boolean;
        workerBAttempt: number;
      };
      expect(outB.event).toBe('worker_b_resumed_and_verified');
      expect(outB.threadId).toBe(outA.threadId);
      expect(outB.staleAcceptedBeforeReclaim).toBe(false);
      expect(outB.staleAcceptedWhileWorkerBHolds).toBe(false);
      expect(outB.workerBFreshLeaseFinished).toBe(true);
      expect(outB.resumedStatus).toBe('delivered');
      expect(outB.resumedNextCount).toBe(0);

      // Also verify outbox lease theft fence directly: expired outbox lease cannot be committed with old token.
      const claim1 = await pool.query<{ id: string; lease_token: string }>(
        `SELECT id, lease_token FROM public.claim_outbox('worker-1', 50, 10) WHERE id = $1`,
        [outboxId],
      );
      expect(claim1.rowCount).toBe(1);
      const staleOutboxToken = claim1.rows[0]!.lease_token;
      await pool.query(`UPDATE public.outbox SET lease_until = now() - interval '2 seconds' WHERE id = $1`, [outboxId]);
      const finishStaleOutbox = await pool.query<{ ok: boolean }>(
        `SELECT public.finish_outbox($1, $2::uuid, true, NULL) AS ok`,
        [outboxId, staleOutboxToken],
      );
      expect(finishStaleOutbox.rows[0]?.ok).toBe(false);

      const result = evaluateMatrixStatus(rowSpec, {
        unitPassed: true,
        unitDetail: 'Row 11 requires no unmerged lanes',
        pgExecuted: true,
        pgPassed: true,
        pgDetail: 'Real 2-process Atlas PostgresSaver crash/resume + stale workflow/outbox lease rejection passed',
      });
      expect(result.overallStatus).toBe('passed');
    });
  });
});
