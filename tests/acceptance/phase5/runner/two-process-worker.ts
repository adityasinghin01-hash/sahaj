import { createRequire } from 'node:module';
import path from 'node:path';
import {
  createAtlas,
  atlasThreadId,
  type AtlasPorts,
  type JobScope,
} from '../../../../packages/atlas/src/index';
import { CHECKPOINT_SCHEMA } from '../../../../packages/atlas/src/postgres';

const require = createRequire(import.meta.url);
const pgPath = require.resolve('pg', {
  paths: [
    process.cwd(),
    path.join(process.cwd(), 'packages/atlas'),
    path.join(process.cwd(), 'node_modules'),
  ],
});
const { Pool } = require(pgPath) as typeof import('pg');
const saverPath = require.resolve('@langchain/langgraph-checkpoint-postgres', {
  paths: [
    process.cwd(),
    path.join(process.cwd(), 'packages/atlas'),
    path.join(process.cwd(), 'node_modules'),
  ],
});
import type { createPostgresCheckpointer } from '../../../../packages/atlas/src/postgres';
const { PostgresSaver } = require(saverPath) as {
  PostgresSaver: new (
    pool: unknown,
    serde?: undefined,
    options?: { schema?: string },
  ) => ReturnType<typeof createPostgresCheckpointer> & { end?: () => Promise<void> };
};

const mode = process.argv[2];
const dbUrl = process.env.PHASE5_TEST_DATABASE_URL;
const familyId = process.env.P5H_FAMILY_ID;
const jobId = process.env.P5H_JOB_ID;
const eventId = process.env.P5H_EVENT_ID;
const actorId = process.env.P5H_ACTOR_ID;
const requestId = process.env.P5H_REQUEST_ID;
const targetId = process.env.P5H_TARGET_ID;
const outboxId = process.env.P5H_OUTBOX_ID;

if (!dbUrl || !familyId || !jobId || !eventId || !actorId || !requestId || !targetId || !outboxId) {
  console.error('Missing required P5H_* or PHASE5_TEST_DATABASE_URL env variables');
  process.exit(2);
}

const pool = new Pool({ connectionString: dbUrl });

function buildPorts(modeLabel: 'worker-a' | 'worker-b'): AtlasPorts {
  const now = new Date('2026-11-14T10:00:00.000Z');
  return {
    async loadJob(scope: JobScope) {
      return {
        familyId: scope.familyId,
        jobId: scope.jobId,
        eventId: eventId!,
        actorId: actorId!,
        requestId: requestId!,
        targetId: targetId!,
      };
    },
    async understand() {
      return { action: 'check_in', certainty: 'ready' };
    },
    async loadGateInput() {
      return {
        now: now.toISOString(),
        actor: { id: actorId!, familyId: familyId!, active: true },
        request: {
          id: requestId!,
          familyId: familyId!,
          action: 'check_in',
          targetId: targetId!,
        },
        permissions: [
          {
            id: requestId!,
            familyId: familyId!,
            actorId: actorId!,
            action: 'check_in',
            approvalMode: 'setup',
            maxAmountMinor: 0,
            maxUses: 5,
            usedCount: 0,
            vendorIds: [],
            itemIds: [],
            targetIds: [targetId!],
            validFrom: '2026-11-01T00:00:00.000Z',
            expiresAt: '2026-12-31T00:00:00.000Z',
            periodStart: '2026-11-01T00:00:00.000Z',
            periodEnd: '2026-12-31T00:00:00.000Z',
          },
        ],
        approvals: [],
        consents: [],
      };
    },
    async enqueueAuthorized() {
      return { status: 'enqueued', outboxId: outboxId! };
    },
    async observeDelivery() {
      if (modeLabel === 'worker-a') {
        // Worker A pauses on delivery_pending interrupt, persisting Postgres checkpoint before crashing.
        return { verified: true, status: 'pending', responderAccepted: false };
      }
      // Worker B observes verified delivery in fresh process and finishes workflow.
      return { verified: true, status: 'delivered', responderAccepted: false };
    },
    async appendSignedOutcome() {
      // Signed outcome persistence is tested directly in Row 14.
    },
    async withJobLock<T>(_scope: JobScope, work: () => Promise<T>) {
      return work();
    },
  };
}

async function main() {
  const scope: JobScope = { familyId: familyId!, jobId: jobId! };
  const threadId = atlasThreadId(scope);

  if (mode === 'claim-and-crash') {
    const checkpointer = new PostgresSaver(pool as never, undefined, { schema: CHECKPOINT_SCHEMA });
    await checkpointer.setup();
    const atlas = createAtlas(buildPorts('worker-a'), checkpointer);

    // 1. Worker A claims lease with valid minimum 10s lease.
    const claimed = await pool.query<{ id: string; lease_token: string; attempt_count: number }>(
      `SELECT id, lease_token, attempt_count FROM public.claim_workflow_jobs('worker-a', 50, 10) WHERE id = $1`,
      [jobId],
    );
    if (claimed.rowCount !== 1) {
      throw new Error(`Expected worker-a to claim workflow job ${jobId}, got ${claimed.rowCount}`);
    }
    const { lease_token: leaseToken, attempt_count: attemptCount } = claimed.rows[0]!;

    // 2. Run Atlas start() -> interrupts cleanly at delivery_pending and persists checkpoint into sahaj_checkpoints.
    const snapshot = await atlas.start(scope);
    const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
    if (!tuple) {
      throw new Error('Expected persisted Atlas checkpoint tuple after worker-a start()');
    }

    // Exit WITHOUT calling finish_workflow_job (simulates Process A crash mid-flight after checkpointing).
    console.log(
      JSON.stringify({
        event: 'worker_a_crashed_after_checkpoint',
        jobId,
        leaseToken,
        attemptCount,
        threadId,
        checkpointId: tuple.checkpoint.id,
        statusAtInterrupt: snapshot.values?.status ?? null,
      }),
    );
    await pool.end();
    process.exit(0);
  }

  if (mode === 'verify-stale-and-resume') {
    const staleLeaseToken = process.env.P5H_STALE_LEASE_TOKEN;
    if (!staleLeaseToken) {
      throw new Error('P5H_STALE_LEASE_TOKEN is required in verify-stale-and-resume mode');
    }
    const checkpointer = new PostgresSaver(pool as never, undefined, { schema: CHECKPOINT_SCHEMA });
    await checkpointer.setup();
    const atlas = createAtlas(buildPorts('worker-b'), checkpointer);

    // 1. Stale worker-a tries to commit finish_workflow_job after lease expired -> MUST return false.
    const staleAttempt = await pool.query<{ finished: boolean }>(
      `SELECT public.finish_workflow_job($1, $2::uuid, 'completed', $3, NULL, NULL) AS finished`,
      [jobId, staleLeaseToken, threadId],
    );

    // 2. Worker B reclaims the expired lease.
    const reclaim = await pool.query<{ id: string; lease_token: string; attempt_count: number }>(
      `SELECT id, lease_token, attempt_count FROM public.claim_workflow_jobs('worker-b', 50, 30) WHERE id = $1`,
      [jobId],
    );
    if (reclaim.rowCount !== 1) {
      throw new Error(`Expected worker-b to reclaim expired workflow job ${jobId}, got ${reclaim.rowCount}`);
    }
    const { lease_token: freshLeaseToken, attempt_count: attemptCount } = reclaim.rows[0]!;

    // 3. Stale worker-a still rejected while worker-b holds active lease.
    const staleWhileWorkerBHolds = await pool.query<{ finished: boolean }>(
      `SELECT public.finish_workflow_job($1, $2::uuid, 'completed', $3, NULL, NULL) AS finished`,
      [jobId, staleLeaseToken, threadId],
    );

    // 4. Fresh OS process resumes interrupted Atlas checkpoint written by worker-a -> reaches delivered/completed.
    const resumed = await atlas.resume(scope);

    // 5. Worker B completes with fresh lease token -> MUST return true.
    const freshFinish = await pool.query<{ finished: boolean }>(
      `SELECT public.finish_workflow_job($1, $2::uuid, 'completed', $3, NULL, NULL) AS finished`,
      [jobId, freshLeaseToken, threadId],
    );

    console.log(
      JSON.stringify({
        event: 'worker_b_resumed_and_verified',
        jobId,
        threadId,
        resumedStatus: resumed.values?.status ?? null,
        resumedNextCount: resumed.next?.length ?? -1,
        staleAcceptedBeforeReclaim: staleAttempt.rows[0]?.finished ?? null,
        staleAcceptedWhileWorkerBHolds: staleWhileWorkerBHolds.rows[0]?.finished ?? null,
        workerBFreshLeaseFinished: freshFinish.rows[0]?.finished ?? null,
        workerBAttempt: attemptCount,
      }),
    );
    await pool.end();
    process.exit(0);
  }

  throw new Error(`Unknown worker mode: ${mode}`);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
