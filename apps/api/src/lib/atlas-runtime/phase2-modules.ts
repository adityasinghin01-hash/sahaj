import type { Phase2Entrypoints } from "./bridge";
import * as dispatch from "../provider-dispatch";
import * as recording from "../recording-worker";

/**
 * STAGED INTEGRATION SEAM (the only file that changes when the Phase 2 branch is merged).
 *
 * This branch does not contain `apps/api/src/lib/provider-dispatch` or `recording-worker`, so the seam is null and every
 * provider capability reports `unavailable`. After merging Phase 2, replace the body with:
 *
 *   import * as dispatch from "../provider-dispatch";
 *   import * as recording from "../recording-worker";
 *   export const phase2Entrypoints: Phase2Entrypoints = {
 *     dispatchStore: db => dispatch.dispatchStore(db as never),
 *     runOutboxDispatchTick: deps => dispatch.runOutboxDispatchTick(deps as never),
 *     runStatusNormalizationJob: (deps, id) => dispatch.runStatusNormalizationJob(deps as never, id),
 *     recordingStore: db => recording.recordingStore(db as never),
 *     recordingStorage: db => recording.recordingStorage(db as never),
 *     runRecordingJob: (deps, db, id) => recording.runRecordingJob(deps as never, db as never, id),
 *   };
 *
 * `tests/atlas-runtime/merged-path.test.ts` exercises exactly this shape against the real Phase 2 modules once present.
 */
export const phase2Entrypoints: Phase2Entrypoints = {
  dispatchStore: db => dispatch.dispatchStore(db as never),
  runOutboxDispatchTick: deps => dispatch.runOutboxDispatchTick(deps as never),
  runStatusNormalizationJob: (deps, id) => dispatch.runStatusNormalizationJob(deps as never, id),
  recordingStore: db => recording.recordingStore(db as never),
  recordingStorage: db => recording.recordingStorage(db as never),
  runRecordingJob: (deps, db, id) => recording.runRecordingJob(deps as never, db as never, id),
};
