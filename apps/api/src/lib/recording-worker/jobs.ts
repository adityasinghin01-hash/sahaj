import { processRecordingEvent, type RecordingWorkerDeps } from "./worker";
import { runRecordingPurge, type PurgeDeps, type PurgeSummary } from "./purge";
import { readRawEvent, type RecordingDb } from "./supabase-store";

export type RecordingJobDisposition = { action: "complete" | "retry"; code: string };

/**
 * Entrypoint for a `core1.recording` job over ONE raw event id (Twilio or Sarvam retrieval request). `complete` covers stored,
 * already stored, ignored additional and permanent refusals (the code says which; a refusal is never retried). `retry` means a
 * transient failure: finish the job failed so it backs off, then call this again with the same id (paths and hashes are
 * deterministic, so retries resume instead of duplicating). All side effects are inside processRecordingEvent's checks.
 */
export async function runRecordingJob(deps: RecordingWorkerDeps, db: RecordingDb, rawEventId: string): Promise<RecordingJobDisposition> {
  let row;
  try { row = await readRawEvent(db, rawEventId); } catch { return { action: "retry", code: "store_unavailable" }; }
  if (!row) return { action: "complete", code: "event_not_found" };
  const out = await processRecordingEvent(deps, row);
  if (out.status === "retry") return { action: "retry", code: out.code };
  return { action: "complete", code: out.status === "rejected" ? `rejected:${out.code}` : out.status };
}

/** Scheduler entrypoint for retention and revocation purge. `enabled` gates every side effect: false lists and deletes nothing. */
export async function runRecordingPurgeTick(deps: PurgeDeps & { enabled: boolean }): Promise<PurgeSummary & { enabled: boolean }> {
  if (!deps.enabled) return { purged: 0, skipped: 0, failed: 0, refused: 0, enabled: false };
  return { ...(await runRecordingPurge(deps)), enabled: true };
}
