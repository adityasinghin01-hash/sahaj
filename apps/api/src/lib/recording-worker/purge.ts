import { validateObjectPath } from "../media/paths";
import type { RecordingStorage } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PurgeCandidate { familyId: string; callId: string; objectPath: string; reason: "retention" | "consent" }
/** Service-role access to list_recording_purge_candidates and finish_recording_purge. */
export interface PurgeStore {
  listCandidates(limit: number, asOf: Date): Promise<PurgeCandidate[]>;
  /** Compare-and-set on family, call and exact path; false when the row is no longer eligible. */
  finish(familyId: string, callId: string, objectPath: string, asOf: Date): Promise<boolean>;
}
export interface PurgeDeps { store: PurgeStore; storage: RecordingStorage; now?: () => Date; limit?: number }
export interface PurgeSummary { purged: number; skipped: number; failed: number; refused: number }

/**
 * Delete private recordings that are past retention or whose consent is no longer effective. Entrypoint for the parent's scheduler.
 *  - Only rows SQL lists are touched, and only the exact path stored for that family and call: the path must be a valid
 *    object path of that family AND live under `<family>/calls/<call>/`. Anything else is refused and never deleted.
 *  - Storage deletion happens first and is idempotent; metadata is cleared afterwards by compare-and-set. A crash in between
 *    is repaired by the next run (remove again, then finish). A failed delete never clears metadata.
 *  - The clock is injected. SQL treats it as an upper bound that cannot exceed the database clock, so a fast clock cannot over-purge.
 *  - The bucket is fixed by the storage adapter; this function cannot name another bucket or an arbitrary path.
 */
export async function runRecordingPurge(deps: PurgeDeps): Promise<PurgeSummary> {
  const asOf = (deps.now ?? (() => new Date()))();
  const limit = Math.min(Math.max(Math.trunc(deps.limit ?? 25), 1), 100);
  const summary: PurgeSummary = { purged: 0, skipped: 0, failed: 0, refused: 0 };
  const candidates = await deps.store.listCandidates(limit, asOf);
  for (const c of candidates.slice(0, limit)) {
    const safe = UUID.test(c.familyId) && UUID.test(c.callId) && validateObjectPath(c.objectPath, c.familyId) !== null
      && c.objectPath.startsWith(`${c.familyId}/calls/${c.callId}/`);
    if (!safe) { summary.refused++; continue; }
    try { await deps.storage.remove(c.objectPath); } catch { summary.failed++; continue; }
    try { (await deps.store.finish(c.familyId, c.callId, c.objectPath, asOf)) ? summary.purged++ : summary.skipped++; } catch { summary.failed++; }
  }
  return summary;
}
