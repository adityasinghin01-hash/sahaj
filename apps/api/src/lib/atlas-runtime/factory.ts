import { createAtlas, atlasThreadId } from "@sahaj/atlas";
import { createPostgresCheckpointer } from "@sahaj/atlas/postgres";
import type { AtlasConfig } from "./config";
import { startLeaseHeartbeat } from "./lease-guard";
import { createAtlasPorts } from "./repository";
import type { AtlasLike, ClaimedJob, RunnerDeps } from "./runner";
import { acquireThreadLock, type PgPoolLike } from "./thread-lock";
import { createTimelineWriter, supabaseTimelineStore, type TimelineReadDb } from "./timeline-writer";
import type { StructuredUnderstandingPort } from "./understanding";
import type { ProviderBridge } from "./bridge";

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
 * Wires real PostgresSaver, service RPC ports, lease heartbeat and a durable per-thread advisory lock.
 * The checkpoint connection must be direct or session-mode (advisory locks are session scoped). Call `close()` after the tick.
 */
export function createAtlasRuntime(options: AtlasRuntimeOptions): { deps: RunnerDeps; close(): Promise<void> } {
  const { config, db } = options;
  const saver = createPostgresCheckpointer(config.databaseUrl);
  const pool = (saver as unknown as { pool: PgPoolLike }).pool;
  const writer = createTimelineWriter({ store: supabaseTimelineStore(db), privateKey: config.privateKey, publicKey: config.publicKey,
    keyId: config.keyId, now: options.now ?? (() => new Date()) });
  return {
    deps: {
      db, workerId: options.workerId, bridge: options.bridge,
      heartbeat: job => startLeaseHeartbeat(db, { familyId: job.family_id, jobId: job.id, token: job.lease_token }),
      lockThread: job => acquireThreadLock(pool, atlasThreadId({ familyId: job.family_id, jobId: job.id })),
      atlasFor(job: ClaimedJob, guard): AtlasLike {
        const ports = createAtlasPorts({ db, lease: { familyId: job.family_id, jobId: job.id, token: job.lease_token },
          encryptionKeyHex: config.encryptionKeyHex, appendTimeline: writer, understanding: options.understanding, guard });
        return createAtlas(ports, saver) as unknown as AtlasLike;
      },
    },
    close: () => saver.end(),
  };
}
