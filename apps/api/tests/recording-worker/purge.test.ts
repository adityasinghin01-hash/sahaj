import { describe, expect, it } from "vitest";
import { processRecordingEvent, runRecordingPurge, RecordingError, type PurgeCandidate, type PurgeStore } from "../../src/lib/recording-worker";
import { audioResponse, CALL, eventRow, FakeRecordingStore, FakeStorage, FAMILY, NOW, OTHER_FAMILY, scripted, workerDeps } from "./helpers";

const DB_NOW = new Date("2026-11-14T12:00:00.000Z");
const path = (family = FAMILY, call = CALL, name = "a".repeat(32)) => `${family}/calls/${call}/${name}.wav`;

/** Models list_recording_purge_candidates / finish_recording_purge: eligibility is retention or lost consent, as_of capped at the database clock. */
class FakePurgeStore implements PurgeStore {
  rows: Array<{ familyId: string; callId: string; path: string | null; expiresAt: Date; consentOk: boolean; purged: boolean }> = [];
  failFinish = false; lists: Array<{ limit: number; asOf: Date }> = [];
  private eligible(r: FakePurgeStore["rows"][number], asOf: Date) { return !!r.path && !r.purged && (r.expiresAt <= new Date(Math.min(asOf.getTime(), DB_NOW.getTime())) || !r.consentOk); }
  async listCandidates(limit: number, asOf: Date): Promise<PurgeCandidate[]> {
    this.lists.push({ limit, asOf });
    return this.rows.filter((r) => this.eligible(r, asOf)).slice(0, limit).map((r) => ({ familyId: r.familyId, callId: r.callId, objectPath: r.path!, reason: r.consentOk ? "retention" as const : "consent" as const }));
  }
  async finish(familyId: string, callId: string, objectPath: string, asOf: Date) {
    if (this.failFinish) throw new RecordingError("store_unavailable", true);
    const r = this.rows.find((x) => x.familyId === familyId && x.callId === callId && x.path === objectPath);
    if (!r || !this.eligible(r, asOf)) return false;
    r.path = null; r.purged = true; return true;
  }
}
const row = (over: Partial<FakePurgeStore["rows"][number]> = {}) => ({ familyId: FAMILY, callId: CALL, path: path(), expiresAt: new Date("2026-11-14T00:00:00Z"), consentOk: true, purged: false, ...over });
function setup(rows = [row()]) {
  const store = new FakePurgeStore(), storage = new FakeStorage(); store.rows = rows;
  for (const r of rows) if (r.path) storage.objects.set(r.path, new Uint8Array(1));
  return { store, storage, run: (over = {}) => runRecordingPurge({ store, storage, now: () => DB_NOW, ...over }) };
}

describe("recording purge", () => {
  it("deletes the exact stored object after retention, then clears metadata", async () => {
    const s = setup(); const r = await s.run();
    expect(r).toEqual({ purged: 1, skipped: 0, failed: 0, refused: 0 });
    expect(s.storage.removed).toEqual([path()]); expect(s.storage.objects.size).toBe(0); expect(s.store.rows[0]).toMatchObject({ path: null, purged: true });
  });
  it("leaves a recording that is neither expired nor revoked", async () => {
    const s = setup([row({ expiresAt: new Date("2027-01-01T00:00:00Z") })]);
    expect(await s.run()).toEqual({ purged: 0, skipped: 0, failed: 0, refused: 0 }); expect(s.storage.removed).toEqual([]);
  });
  it("purges when consent is revoked, even before retention ends", async () => {
    const s = setup([row({ expiresAt: new Date("2027-01-01T00:00:00Z"), consentOk: false })]);
    expect((await s.run()).purged).toBe(1); expect(s.storage.objects.size).toBe(0);
  });
  it("uses the injected clock but a clock ahead of the database cannot over-purge", async () => {
    const early = setup([row({ expiresAt: new Date("2026-11-14T11:00:00Z") })]);
    expect((await early.run({ now: () => new Date("2026-11-14T10:00:00Z") })).purged).toBe(0); // clock behind: not yet expired
    expect((await early.run({ now: () => new Date("2026-11-14T11:30:00Z") })).purged).toBe(1);
    const fast = setup([row({ expiresAt: new Date("2026-12-01T00:00:00Z") })]);
    expect((await fast.run({ now: () => new Date("2030-01-01T00:00:00Z") })).purged).toBe(0); // clock far ahead: capped at db now
    expect(fast.storage.removed).toEqual([]);
  });
  it("a failed delete never clears metadata and the next run completes", async () => {
    const s = setup(); s.storage.failRemove = true;
    expect(await s.run()).toMatchObject({ failed: 1, purged: 0 }); expect(s.store.rows[0]!.path).not.toBeNull();
    s.storage.failRemove = false;
    expect(await s.run()).toMatchObject({ purged: 1 });
  });
  it("a crash between delete and metadata update is repaired by deleting again", async () => {
    const s = setup(); s.store.failFinish = true;
    expect(await s.run()).toMatchObject({ failed: 1 }); expect(s.storage.objects.size).toBe(0); expect(s.store.rows[0]!.purged).toBe(false);
    s.store.failFinish = false;
    expect(await s.run()).toMatchObject({ purged: 1 }); expect(s.store.rows[0]!.purged).toBe(true);
  });
  it("refuses any path outside the row's own family and call directory without deleting anything", async () => {
    const bad = [
      path(OTHER_FAMILY), path(FAMILY, "55555555-5555-4555-8555-555555555555"), `${FAMILY}/calls/${CALL}/../x.wav`, `${FAMILY}/${CALL}/a.wav`,
      `${FAMILY}/calls/${CALL}/%2e%2e.wav`, `${FAMILY}/calls/${CALL}/a.txt`, `other-bucket/${FAMILY}/calls/${CALL}/a.wav`, "/etc/passwd",
    ];
    const s = setup(bad.map((p) => row({ path: p })));
    const out = await s.run({ limit: 100 });
    expect(out).toMatchObject({ refused: bad.length, purged: 0 }); expect(s.storage.removed).toEqual([]);
  });
  it("candidates are bounded by the limit", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({ callId: `66666666-6666-4666-8666-66666666666${i}`, path: path(FAMILY, `66666666-6666-4666-8666-66666666666${i}`) }));
    const s = setup(rows);
    expect((await s.run({ limit: 3 })).purged).toBe(3);
    await s.run({ limit: 100000 }); await s.run({ limit: -4 });
    expect(s.store.lists.map((l) => l.limit)).toEqual([3, 100, 1]);
  });
  it("a purged recording is not fetched or stored again by a replayed retrieval event", async () => {
    const store = new FakeRecordingStore(), storage = new FakeStorage(), t = scripted(audioResponse());
    store.slotValue = "purged";
    expect(await processRecordingEvent(workerDeps(store, storage, t.transport), eventRow())).toEqual({ status: "rejected", code: "recording_purged" });
    expect(t.calls).toHaveLength(0); expect(storage.puts).toBe(0);
    // SQL can also answer 'purged' after the fetch (purged between probe and write): the uploaded object is removed
    store.slotValue = "none"; store.putResult = "purged";
    const t2 = scripted(audioResponse());
    expect(await processRecordingEvent(workerDeps(store, storage, t2.transport), eventRow())).toEqual({ status: "rejected", code: "recording_purged" });
    expect(storage.objects.size).toBe(0);
    expect(NOW).toBeTruthy();
  });
});
