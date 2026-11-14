import type { Phase2Entrypoints } from "./bridge";

/**
 * STAGED INTEGRATION SEAM (the only file that changes when the Phase 2 branch is merged).
 *
 * This branch does not contain `apps/api/src/lib/provider-dispatch` or `recording-worker`, so the seam is null and every
 * provider capability reports `unavailable`. In the combined tree, replace the body with exactly:
 *
 *   import * as dispatch from "../provider-dispatch";
 *   import * as recording from "../recording-worker";
 *   export const phase2Entrypoints: Phase2Entrypoints | null = {
 *     dispatchStore: db => dispatch.dispatchStore(db as never) as unknown,
 *     runOutboxDispatchTick: deps => dispatch.runOutboxDispatchTick(deps as never) as never,
 *     runStatusNormalizationJob: (deps, id) => dispatch.runStatusNormalizationJob(deps as never, id),
 *     createContactResolver: (db, cfg) => dispatch.createContactResolver(db as never, cfg),
 *     recordingStore: db => recording.recordingStore(db as never) as unknown,
 *     recordingStorage: db => recording.recordingStorage(db as never) as unknown,
 *     runRecordingJob: (deps, db, id) => recording.runRecordingJob(deps as never, db as never, id),
 *     purgeStore: db => recording.purgeStore(db as never) as unknown,
 *     runRecordingPurgeTick: deps => recording.runRecordingPurgeTick(deps as never),
 *   };
 *
 * `tests/atlas-runtime/merged-path.test.ts` exercises exactly this shape against the real Phase 2 modules once present.
 */
export const phase2Entrypoints: Phase2Entrypoints | null = null;
