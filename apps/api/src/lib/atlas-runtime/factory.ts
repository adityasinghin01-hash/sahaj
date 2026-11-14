import { createPrivateKey, createPublicKey } from "node:crypto";
import { createAtlas } from "@sahaj/atlas";
import { createPostgresCheckpointer } from "@sahaj/atlas/postgres";
import { createAtlasPorts } from "./repository";
import { createTimelineWriter, supabaseTimelineStore, type TimelineReadDb } from "./timeline-writer";
import type { AtlasLike, ClaimedJob, RunnerDeps } from "./runner";
import type { StructuredUnderstandingPort } from "./understanding";

export interface AtlasRuntimeConfig {
  db: TimelineReadDb;
  workerId: string;
  encryptionKeyHex: string;
  /** Restricted checkpoint-role URL (verify-full TLS is enforced by the checkpointer). */
  databaseUrl: string;
  timelinePrivateKeyPem: string;
  timelineKeyId: string;
  understanding?: StructuredUnderstandingPort;
  now?: () => Date;
}

/** Wires real PostgresSaver + service RPC ports. The caller must `close()` after the tick. */
export function createAtlasRuntime(config: AtlasRuntimeConfig): { deps: RunnerDeps; close(): Promise<void> } {
  const saver = createPostgresCheckpointer(config.databaseUrl);
  const privateKey = createPrivateKey(config.timelinePrivateKeyPem);
  const writer = createTimelineWriter({ store: supabaseTimelineStore(config.db), privateKey, publicKey: createPublicKey(privateKey),
    keyId: config.timelineKeyId, now: config.now ?? (() => new Date()) });
  return {
    deps: {
      db: config.db, workerId: config.workerId,
      atlasFor(job: ClaimedJob): AtlasLike {
        const ports = createAtlasPorts({ db: config.db, lease: { familyId: job.family_id, jobId: job.id, token: job.lease_token },
          encryptionKeyHex: config.encryptionKeyHex, appendTimeline: writer, understanding: config.understanding });
        return createAtlas(ports, saver) as unknown as AtlasLike;
      },
    },
    close: () => saver.end(),
  };
}
