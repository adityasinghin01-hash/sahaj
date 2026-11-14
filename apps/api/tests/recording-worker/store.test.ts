import { describe, expect, it } from "vitest";
import { readRawEvent, recordingStorage, recordingStore, type RecordingDb } from "../../src/lib/recording-worker";
import { CALL, CONSENT, FAMILY, PERSON } from "./helpers";

type Err = { code?: string; message?: string; statusCode?: string | number } | null;
/** Chainable query double: records filters and resolves a scripted result for each terminal call. */
function fakeDb(opts: { rows?: unknown[]; single?: unknown; rpc?: { data?: unknown; error?: Err }; upload?: Err; remove?: Err; error?: Err } = {}) {
  const log: Array<{ table: string; filters: string[] }> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const buckets: string[] = [];
  const db: RecordingDb = {
    from(table: string) {
      const entry = { table, filters: [] as string[] }; log.push(entry);
      const q: any = { // eslint-disable-line @typescript-eslint/no-explicit-any
        select: () => q, order: () => q, limit: () => q,
        eq: (c: string, v: unknown) => { entry.filters.push(`${c}=${String(v)}`); return q; },
        is: (c: string, v: unknown) => { entry.filters.push(`${c} is ${String(v)}`); return q; },
        maybeSingle: async () => ({ data: opts.single ?? null, error: opts.error ?? null }),
        then: (res: (v: unknown) => unknown) => res({ data: opts.rows ?? [], error: opts.error ?? null }),
      };
      return q;
    },
    async rpc(name, args) { rpcCalls.push({ name, args }); return { data: opts.rpc?.data ?? null, error: opts.rpc?.error ?? null }; },
    storage: { from: (b: string) => { buckets.push(b); return { upload: async () => ({ error: opts.upload ?? null }), remove: async () => ({ error: opts.remove ?? null }) }; } },
  };
  return { db, log, rpcCalls, buckets };
}
const put = { familyId: FAMILY, callId: CALL, consentId: CONSENT, objectPath: `${FAMILY}/calls/${CALL}/${"a".repeat(32)}.wav`, expiresAt: new Date("2027-01-01T00:00:00Z"), refHash: "f".repeat(64) };

describe("recording store", () => {
  it("looks up consents with two bounded queries: exact call, and global refusals only", async () => {
    const f = fakeDb({ rows: [{ id: CONSENT, family_id: FAMILY, person_id: PERSON, call_id: CALL, purpose: "call_recording", answer: true, version: "v1", created_at: "2026-11-14T10:00:00Z" }] });
    const rows = await recordingStore(f.db).findConsents(FAMILY, PERSON, CALL);
    const queries = f.log.filter((l) => l.table === "consents").map((l) => l.filters);
    expect(queries).toHaveLength(2);
    expect(queries.some((q) => q.includes(`call_id=${CALL}`))).toBe(true);
    expect(queries.some((q) => q.includes("call_id is null") && q.includes("answer=false"))).toBe(true);
    for (const q of queries) expect(q).toEqual(expect.arrayContaining([`family_id=${FAMILY}`, `person_id=${PERSON}`, "purpose=call_recording"]));
    expect(rows[0]).toMatchObject({ id: CONSENT, callId: CALL, answer: true });
  });
  it("getCall is scoped by family and id, and reports AI disclosure as a boolean", async () => {
    const f = fakeDb({ single: { person_id: PERSON, provider: "twilio", external_id: "CAx", ai_disclosed_at: "2026-11-14T10:00:00Z" } });
    expect(await recordingStore(f.db).getCall(FAMILY, CALL)).toEqual({ personId: PERSON, provider: "twilio", externalId: "CAx", aiDisclosed: true });
    expect(f.log[0]!.filters).toEqual([`family_id=${FAMILY}`, `id=${CALL}`]);
    expect(await recordingStore(fakeDb().db).getCall(FAMILY, CALL)).toBeNull();
  });
  it("put calls the single metadata writer RPC and maps SQL refusals", async () => {
    const ok = fakeDb({ rpc: { data: "stored" } });
    expect(await recordingStore(ok.db).put(put)).toBe("stored");
    expect(ok.rpcCalls[0]).toEqual({ name: "put_call_recording", args: {
      p_family_id: FAMILY, p_call_id: CALL, p_consent_id: CONSENT, p_object_path: put.objectPath, p_expires_at: "2027-01-01T00:00:00.000Z", p_recording_ref_hash: "f".repeat(64) } });
    await expect(recordingStore(fakeDb({ rpc: { error: { code: "42501", message: "consent_not_effective" } } }).db).put(put)).rejects.toMatchObject({ code: "consent_not_effective", retryable: false });
    await expect(recordingStore(fakeDb({ rpc: { error: { code: "42501", message: "call_not_found" } } }).db).put(put)).rejects.toMatchObject({ code: "identity_mismatch", retryable: false });
    await expect(recordingStore(fakeDb({ rpc: { error: { code: "22023" } } }).db).put(put)).rejects.toMatchObject({ code: "invalid_metadata", retryable: false });
    await expect(recordingStore(fakeDb({ rpc: { error: { code: "08006", message: "connection" } } }).db).put(put)).rejects.toMatchObject({ retryable: true });
    await expect(recordingStore(fakeDb({ rpc: { data: "weird" } }).db).put(put)).rejects.toMatchObject({ retryable: true });
  });
  it("slot fails closed on unexpected values", async () => {
    expect(await recordingStore(fakeDb({ rpc: { data: "same" } }).db).slot(FAMILY, CALL, "f".repeat(64))).toBe("same");
    await expect(recordingStore(fakeDb({ rpc: { data: "maybe" } }).db).slot(FAMILY, CALL, "f".repeat(64))).rejects.toMatchObject({ retryable: true });
  });
});

describe("recording storage", () => {
  it("creates with upsert disabled and maps an existing object to 'exists'", async () => {
    const bytes = new Uint8Array(1);
    expect(await recordingStorage(fakeDb().db).put("p.wav", bytes, "audio/wav")).toBe("created");
    expect(await recordingStorage(fakeDb({ upload: { statusCode: "409", message: "x" } }).db).put("p.wav", bytes, "audio/wav")).toBe("exists");
    expect(await recordingStorage(fakeDb({ upload: { message: "The resource already exists" } }).db).put("p.wav", bytes, "audio/wav")).toBe("exists");
    await expect(recordingStorage(fakeDb({ upload: { statusCode: "500", message: "boom" } }).db).put("p.wav", bytes, "audio/wav")).rejects.toMatchObject({ retryable: true });
    await expect(recordingStorage(fakeDb({ remove: { message: "boom" } }).db).remove("p.wav")).rejects.toMatchObject({ retryable: true });
  });
  it("only ever targets the private recordings bucket", async () => {
    const f = fakeDb();
    await recordingStorage(f.db).put("p.wav", new Uint8Array(1), "audio/wav");
    await recordingStorage(f.db).remove("p.wav");
    expect(f.buckets).toEqual(["sahaj-recordings", "sahaj-recordings"]);
  });
});

describe("readRawEvent", () => {
  it("returns only the columns the worker needs, or null", async () => {
    const f = fakeDb({ single: { id: "e1", family_id: FAMILY, source: "twilio", provider_event_id: "p", event_type: "t", metadata: { a: 1 }, payload_ciphertext: "v1.x" } });
    expect(await readRawEvent(f.db, "e1")).toEqual({ id: "e1", familyId: FAMILY, source: "twilio", providerEventId: "p", eventType: "t", metadata: { a: 1 }, payloadCiphertext: "v1.x" });
    expect(await readRawEvent(fakeDb().db, "e1")).toBeNull();
    await expect(readRawEvent(fakeDb({ error: { message: "x" } }).db, "e1")).rejects.toMatchObject({ retryable: true });
  });
});
