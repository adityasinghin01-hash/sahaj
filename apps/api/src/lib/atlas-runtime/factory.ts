import { createAtlas, atlasThreadId } from "@sahaj/atlas";
import { CheckpointFence, createCheckpointPool, createFencedCheckpointer } from "@sahaj/atlas/fenced";
import type { ProviderBridge } from "./bridge";
import type { AtlasConfig } from "./config";
import { RuntimeError } from "./db";
import { startLeaseHeartbeat } from "./lease-guard";
import { createAtlasPorts } from "./repository";
import type { AtlasLike, ClaimedJob, RunnerDeps } from "./runner";
import { createTimelineWriter, supabaseTimelineStore, type TimelineReadDb } from "./timeline-writer";
import type { StructuredUnderstandingPort } from "./understanding";

export interface AtlasRuntimeOptions {
  db: TimelineReadDb;
  workerId: string;
  config: AtlasConfig;
  /** Model/provider understanding. Absent means every non-exact input pauses for durable review. */
  understanding?: StructuredUnderstandingPort;
  bridge?: ProviderBridge;
  now?: () => Date;
}

/**
 * Wires real PostgresSaver, service RPC ports, lease heartbeat and the per-thread CheckpointFence. Each Atlas job runs on
 * its own fenced session: the advisory lock and every checkpoint statement share one connection (direct or session-mode
 * DATABASE_URL required). Call `close()` after the tick.
 */
export function createAtlasRuntime(options: AtlasRuntimeOptions): { deps: RunnerDeps; close(): Promise<void> } {
  const { config, db } = options;
  const pool = createCheckpointPool(config.databaseUrl);
  const writer = createTimelineWriter({ store: supabaseTimelineStore(db), privateKey: config.privateKey, publicKey: config.publicKey,
    keyId: config.keyId, now: options.now ?? (() => new Date()) });
  return {
    deps: {
      db, workerId: options.workerId, bridge: options.bridge,
      heartbeat: job => startLeaseHeartbeat(db, { familyId: job.family_id, jobId: job.id, token: job.lease_token }),
      lockThread: job => CheckpointFence.acquire(pool, atlasThreadId({ familyId: job.family_id, jobId: job.id })),
      atlasFor(job: ClaimedJob, guard, lock): AtlasLike {
        if (!(lock instanceof CheckpointFence)) throw new RuntimeError("thread_lock_required");
        const ports = createAtlasPorts({ db, lease: { familyId: job.family_id, jobId: job.id, token: job.lease_token },
          encryptionKeyHex: config.encryptionKeyHex, appendTimeline: writer, understanding: options.understanding, guard });
        return createAtlas(ports, createFencedCheckpointer(lock)) as unknown as AtlasLike;
      },
    },
    close: () => pool.end(),
  };
}
