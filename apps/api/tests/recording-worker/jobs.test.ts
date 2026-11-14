import { describe, expect, it, vi } from "vitest";
import { runRecordingJob, runRecordingPurgeTick, type RecordingDb } from "../../src/lib/recording-worker";
import { audioResponse, consent, eventRow, FakeRecordingStore, FakeStorage, scripted, workerDeps } from "./helpers";

const dbWith = (data: unknown, error: unknown = null): RecordingDb => ({
  from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data, error }) }; return q; }, // eslint-disable-line @typescript-eslint/no-explicit-any
  rpc: async () => ({ data: null, error: null }), storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) },
});
const rawRow = () => { const r = eventRow(); return { id: r.id, family_id: r.familyId, source: r.source, provider_event_id: r.providerEventId, event_type: r.eventType, metadata: r.metadata, payload_ciphertext: r.payloadCiphertext }; };
function setup(...responses: Parameters<typeof scripted>) {
  const store = new FakeRecordingStore(), storage = new FakeStorage(), t = scripted(...responses);
  return { store, storage, t, deps: workerDeps(store, storage, t.transport) };
}

describe("runRecordingJob", () => {
  it("reads the raw event by id, stores the recording and tells the runner to complete", async () => {
    const s = setup(audioResponse());
    expect(await runRecordingJob(s.deps, dbWith(rawRow()), "id")).toEqual({ action: "complete", code: "stored" });
    expect(s.store.puts).toHaveLength(1);
  });
  it("a permanent refusal completes with its code and is never retried", async () => {
    const s = setup(audioResponse()); s.store.consents = [consent(), consent({ id: "r", callId: null, answer: false, createdAt: "2026-11-14T11:00:00.000Z" })];
    expect(await runRecordingJob(s.deps, dbWith(rawRow()), "id")).toEqual({ action: "complete", code: "rejected:consent_not_effective" });
    expect(s.t.calls).toHaveLength(0);
  });
  it("transient failures ask for a retry; a replay after a metadata outage resumes without a second object", async () => {
    const s = setup(audioResponse(), audioResponse()); s.store.putResult = new Error("db down");
    expect(await runRecordingJob(s.deps, dbWith(rawRow()), "id")).toEqual({ action: "retry", code: "metadata_unavailable" });
    s.store.putResult = "stored";
    expect(await runRecordingJob(s.deps, dbWith(rawRow()), "id")).toEqual({ action: "complete", code: "stored" });
    expect(s.storage.objects.size).toBe(1);
  });
  it("a missing event completes; a database error retries", async () => {
    const s = setup();
    expect(await runRecordingJob(s.deps, dbWith(null), "id")).toEqual({ action: "complete", code: "event_not_found" });
    expect(await runRecordingJob(s.deps, dbWith(null, { message: "x" }), "id")).toEqual({ action: "retry", code: "store_unavailable" });
  });
});

describe("runRecordingPurgeTick", () => {
  it("is gated: disabled lists and deletes nothing", async () => {
    const store = { listCandidates: vi.fn(async () => []), finish: vi.fn(async () => true) }, storage = new FakeStorage();
    expect(await runRecordingPurgeTick({ store, storage, enabled: false })).toEqual({ purged: 0, skipped: 0, failed: 0, refused: 0, enabled: false });
    expect(store.listCandidates).not.toHaveBeenCalled();
    expect((await runRecordingPurgeTick({ store, storage, enabled: true })).enabled).toBe(true);
    expect(store.listCandidates).toHaveBeenCalledTimes(1);
  });
});
