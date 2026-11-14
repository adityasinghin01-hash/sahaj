import { describe, expect, it, vi } from "vitest";
import { processRecordingEvent, RecordingError } from "../../src/lib/recording-worker";
import {
  ACCOUNT, audioResponse, CALL, CALL_SID, consent, CONSENT, eventRow, FakeRecordingStore, FakeStorage, FAMILY, NOW, OTHER_FAMILY, PERSON,
  REC_SID, REC_SID_2, scripted, spyAll, wavBytes, workerDeps,
} from "./helpers";

const PATH_RE = new RegExp(`^${FAMILY}/calls/${CALL}/[0-9a-f]{32}\\.wav$`);
const hang = () => (init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
function setup(...responses: Parameters<typeof scripted>) {
  const store = new FakeRecordingStore(), storage = new FakeStorage(), t = scripted(...responses);
  return { store, storage, t, deps: workerDeps(store, storage, t.transport) };
}

describe("successful retrieval", () => {
  it("fetches by SID, stores privately under a deterministic path, then writes metadata with the effective consent", async () => {
    const logs = spyAll();
    const s = setup(audioResponse());
    const out = await processRecordingEvent(s.deps, eventRow());
    expect(out).toEqual({ status: "stored" });
    expect(s.t.calls).toHaveLength(1);
    expect(s.t.calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Recordings/${REC_SID}.wav`);
    const [path] = [...s.storage.objects.keys()];
    expect(path).toMatch(PATH_RE);
    expect(s.store.puts).toEqual([expect.objectContaining({
      familyId: FAMILY, callId: CALL, consentId: CONSENT, objectPath: path, expiresAt: new Date(NOW.getTime() + 90 * 86_400_000),
    })]);
    expect(s.store.puts[0]!.refHash).toMatch(/^[0-9a-f]{64}$/);
    expect(logs.log).not.toHaveBeenCalled(); expect(logs.warn).not.toHaveBeenCalled(); expect(logs.error).not.toHaveBeenCalled();
  });
  it("retention is clamped to 1..365 days", async () => {
    for (const [days, expected] of [[0, 1], [9999, 365], [30, 30]] as const) {
      const s = setup(audioResponse());
      s.deps.retentionDays = days;
      await processRecordingEvent(s.deps, eventRow());
      expect(s.store.puts[0]!.expiresAt.getTime()).toBe(NOW.getTime() + expected * 86_400_000);
    }
  });
  it("replaying the same recording is idempotent and does not fetch or write again", async () => {
    const s = setup(); s.store.slotValue = "same";
    expect(await processRecordingEvent(s.deps, eventRow())).toEqual({ status: "already_stored" });
    expect(s.t.calls).toHaveLength(0); expect(s.storage.puts).toBe(0); expect(s.store.puts).toHaveLength(0);
  });
});

describe("multiple recordings per call", () => {
  it("a different recording after the slot is taken is ignored before any fetch", async () => {
    const s = setup(); s.store.slotValue = "other";
    const out = await processRecordingEvent(s.deps, eventRow({ payload: { recording_sid: REC_SID_2 }, row: { providerEventId: `${ACCOUNT}:recording:${REC_SID_2}:completed` }, contextId: `${ACCOUNT}:recording:${REC_SID_2}:completed` }));
    expect(out).toEqual({ status: "ignored_additional" });
    expect(s.t.calls).toHaveLength(0); expect(s.storage.puts).toBe(0);
  });
  it("losing the race in SQL deletes the object it just uploaded and keeps the winner's", async () => {
    const s = setup(audioResponse()); s.store.putResult = "ignored_additional";
    const out = await processRecordingEvent(s.deps, eventRow());
    expect(out).toEqual({ status: "ignored_additional" });
    expect(s.storage.objects.size).toBe(0); expect(s.storage.removed[0]).toMatch(PATH_RE);
  });
  it("the two recordings of one call map to different deterministic paths", async () => {
    const paths = new Set<string>();
    for (const sid of [REC_SID, REC_SID_2]) {
      const s = setup(audioResponse());
      const id = `${ACCOUNT}:recording:${sid}:completed`;
      await processRecordingEvent(s.deps, eventRow({ payload: { recording_sid: sid }, row: { providerEventId: id }, contextId: id }));
      paths.add(s.store.puts[0]!.objectPath);
    }
    expect(paths.size).toBe(2);
  });
});

describe("consent is rechecked", () => {
  const refused = async (mutate: (s: ReturnType<typeof setup>) => void) => {
    const s = setup(audioResponse()); mutate(s);
    const out = await processRecordingEvent(s.deps, eventRow());
    expect(out).toEqual({ status: "rejected", code: "consent_not_effective" });
    expect(s.t.calls).toHaveLength(0); expect(s.storage.puts).toBe(0); expect(s.store.puts).toHaveLength(0);
  };
  it("missing consent", () => refused((s) => { s.store.consents = []; }));
  it("a call-level refusal newer than the yes", () => refused((s) => { s.store.consents = [consent(), consent({ id: "a1", answer: false, createdAt: "2026-11-14T11:00:00.000Z" })]; }));
  it("a global refusal newer than the yes", () => refused((s) => { s.store.consents = [consent(), consent({ id: "a2", callId: null, answer: false, createdAt: "2026-11-14T11:00:00.000Z" })]; }));
  it("a refusal at the same instant wins", () => refused((s) => { s.store.consents = [consent(), consent({ id: "a3", callId: null, answer: false })]; }));
  it("a global yes never grants", () => refused((s) => { s.store.consents = [consent({ id: CONSENT, callId: null })]; }));
  it("consent given on another call does not count", () => refused((s) => { s.store.consents = [consent({ callId: "66666666-6666-4666-8666-666666666666" })]; }));
  it("another person's or another family's consent does not count", async () => {
    await refused((s) => { s.store.consents = [consent({ personId: "77777777-7777-4777-8777-777777777777" })]; });
    await refused((s) => { s.store.consents = [consent({ familyId: OTHER_FAMILY })]; });
  });
  it("a consent on a superseded version is not effective", () => refused((s) => { s.store.consents = [consent({ version: "consent-v0" })]; }));
  it("a call that never disclosed AI is refused", () => refused((s) => { s.store.call = { ...s.store.call!, aiDisclosed: false }; }));
  it("an event pointing at a consent id that is not a yes on this call is refused", () => refused((s) => { s.store.consents = [consent({ id: "88888888-8888-4888-8888-888888888888" })]; }));
  it("a newer yes on the same call is linked instead of the event's older consent", async () => {
    const s = setup(audioResponse());
    s.store.consents = [consent(), consent({ id: "99999999-9999-4999-8999-999999999990", createdAt: "2026-11-14T10:30:00.000Z" })];
    expect(await processRecordingEvent(s.deps, eventRow())).toEqual({ status: "stored" });
    expect(s.store.puts[0]!.consentId).toBe("99999999-9999-4999-8999-999999999990");
  });
  it("withdrawal while the bytes are in flight discards them without storing or writing metadata", async () => {
    const s = setup(audioResponse());
    s.store.laterConsents = [consent(), consent({ id: "b1", callId: null, answer: false, createdAt: "2026-11-14T11:59:00.000Z" })];
    expect(await processRecordingEvent(s.deps, eventRow())).toEqual({ status: "rejected", code: "consent_not_effective" });
    expect(s.t.calls).toHaveLength(1); expect(s.storage.objects.size).toBe(0); expect(s.store.puts).toHaveLength(0);
  });
  it("SQL refusing at write time deletes the stored object", async () => {
    const s = setup(audioResponse()); s.store.putResult = new RecordingError("consent_not_effective");
    expect(await processRecordingEvent(s.deps, eventRow())).toEqual({ status: "rejected", code: "consent_not_effective" });
    expect(s.storage.objects.size).toBe(0);
  });
  it("a failed cleanup after a refusal is reported as retry so the object is not forgotten", async () => {
    const s = setup(audioResponse()); s.store.putResult = new RecordingError("consent_not_effective"); s.storage.failRemove = true;
    expect(await processRecordingEvent(s.deps, eventRow())).toEqual({ status: "retry", code: "cleanup_failed" });
    // the retry meets the refusal before fetching and still tries to delete the deterministic path
    s.store.consents = [];
    s.storage.failRemove = false;
    expect(await processRecordingEvent(s.deps, eventRow())).toEqual({ status: "rejected", code: "consent_not_effective" });
    expect(s.storage.objects.size).toBe(0);
  });
});

describe("identity and reference substitution", () => {
  const rejected = async (row: ReturnType<typeof eventRow>, code: string, mutate: (s: ReturnType<typeof setup>) => void = () => {}) => {
    const s = setup(audioResponse()); mutate(s);
    expect(await processRecordingEvent(s.deps, row)).toEqual({ status: "rejected", code });
    expect(s.t.calls).toHaveLength(0); expect(s.storage.puts).toBe(0);
  };
  it("call external id must equal the CallSid in the event", () => rejected(eventRow(), "call_identity_mismatch", (s) => { s.store.call!.externalId = "CA" + "9".repeat(32); }));
  it("call must belong to the event's person and be a Twilio call", async () => {
    await rejected(eventRow(), "call_not_found", (s) => { s.store.call!.personId = "77777777-7777-4777-8777-777777777777"; });
    await rejected(eventRow(), "call_identity_mismatch", (s) => { s.store.call!.provider = "sarvam"; });
    await rejected(eventRow(), "call_not_found", (s) => { s.store.call = null; });
  });
  it("metadata and encrypted payload must agree", async () => {
    await rejected(eventRow({ metadata: { call_id: "66666666-6666-4666-8666-666666666666" } }), "event_mismatch");
    await rejected(eventRow({ metadata: { consent_id: "66666666-6666-4666-8666-666666666666" } }), "event_mismatch");
    await rejected(eventRow({ metadata: { person_id: "66666666-6666-4666-8666-666666666666" } }), "event_mismatch");
  });
  it("a recording from another Twilio account, status or event type is refused", async () => {
    await rejected(eventRow({ payload: { account_sid: "AC" + "e".repeat(32) } }), "wrong_provider_account");
    await rejected(eventRow({ payload: { status: "in-progress" }, metadata: { status: "in-progress" } }), "event_mismatch");
    await rejected(eventRow({ row: { eventType: "twilio.recording.status" } }), "wrong_event_type");
    await rejected(eventRow({ row: { source: "sarvam" } }), "wrong_event_type");
  });
  it("ciphertext bound to a different provider event id does not decrypt", () =>
    rejected(eventRow({ contextId: `${ACCOUNT}:recording:${REC_SID_2}:completed` }), "payload_unreadable"));
  it("a row moved to another family finds no such call there", () => rejected(eventRow({ row: { familyId: OTHER_FAMILY } }), "call_not_found", (s) => { s.store.call = null; }));
  it("malformed or missing fields are refused", async () => {
    await rejected(eventRow({ payload: { recording_sid: "RE../../x" } }), "invalid_event");
    await rejected(eventRow({ payload: { call_id: "not-a-uuid" } }), "invalid_event");
    await rejected(eventRow({ payload: { duration_seconds: -1 } }), "invalid_event");
    await rejected(eventRow({ row: { payloadCiphertext: null } }), "invalid_event");
    await rejected(eventRow({ row: { payloadCiphertext: "garbage" } }), "payload_unreadable");
  });
});

describe("media fetch bounds", () => {
  const run = async (response: Parameters<typeof scripted>[0], over: Partial<ReturnType<typeof workerDeps>> = {}) => {
    const s = setup(response); Object.assign(s.deps, over);
    return { out: await processRecordingEvent(s.deps, eventRow()), s };
  };
  it("oversized bodies (declared or streamed) are rejected and nothing is stored", async () => {
    const { out, s } = await run(audioResponse(wavBytes(2048)), { maxBytes: 1024 });
    expect(out).toEqual({ status: "rejected", code: "media_too_large" });
    expect(s.storage.puts).toBe(0);
    const big = new Response(new ReadableStream({ start(c) { c.enqueue(wavBytes(800)); c.enqueue(wavBytes(800)); c.close(); } }), { status: 200, headers: { "content-type": "audio/wav" } });
    expect((await run(big, { maxBytes: 1024 })).out).toEqual({ status: "rejected", code: "media_too_large" });
  });
  it("wrong content type, empty body and non-WAV bytes are rejected", async () => {
    expect((await run(audioResponse(wavBytes(), "text/html"))).out).toEqual({ status: "rejected", code: "media_type_rejected" });
    expect((await run(audioResponse(new Uint8Array()))).out).toEqual({ status: "rejected", code: "media_type_rejected" });
    const notWav = new Uint8Array(100).fill(7);
    const r = await run(audioResponse(notWav));
    expect(r.out).toEqual({ status: "rejected", code: "media_invalid" }); expect(r.s.storage.puts).toBe(0);
    expect((await run(audioResponse(wavBytes(20)))).out).toEqual({ status: "rejected", code: "media_invalid" }); // truncated header
  });
  it("redirects are never followed", async () => {
    const r = await run(new Response(null, { status: 302, headers: { location: "https://evil.test/a.wav" } }));
    expect(r.out).toEqual({ status: "rejected", code: "provider_rejected" });
    expect(r.s.t.calls).toHaveLength(1);
  });
  it("not ready, outage, timeout and network failure are retryable; auth failure is not", async () => {
    expect((await run(new Response("", { status: 404 }))).out).toEqual({ status: "retry", code: "recording_not_ready" });
    expect((await run(new Response("", { status: 503 }))).out).toEqual({ status: "retry", code: "provider_unavailable" });
    expect((await run(new Response("", { status: 429 }))).out).toEqual({ status: "retry", code: "provider_unavailable" });
    expect((await run(hang())).out).toEqual({ status: "retry", code: "provider_unavailable" });
    expect((await run(new Error("socket"))).out).toEqual({ status: "retry", code: "provider_unavailable" });
    expect((await run(new Response("", { status: 401 }))).out).toEqual({ status: "rejected", code: "provider_rejected" });
  });
  it("maxBytes can never exceed the bucket limit", async () => {
    const s = setup(audioResponse(wavBytes())); s.deps.maxBytes = 10 * 1024 * 1024 * 1024;
    expect((await processRecordingEvent(s.deps, eventRow())).status).toBe("stored");
  });
});

describe("storage and metadata failures recover with stable retries", () => {
  it("storage outage before upload is retryable and writes no metadata; the retry then completes", async () => {
    const s = setup(audioResponse(), audioResponse()); s.storage.failPut = true;
    expect(await processRecordingEvent(s.deps, eventRow())).toEqual({ status: "retry", code: "storage_unavailable" });
    expect(s.store.puts).toHaveLength(0);
    s.storage.failPut = false;
    expect(await processRecordingEvent(s.deps, eventRow())).toEqual({ status: "stored" });
    expect(s.storage.objects.size).toBe(1);
  });
  it("metadata outage after upload keeps the object; the retry reuses the same path and finishes", async () => {
    const s = setup(audioResponse(), audioResponse()); s.store.putResult = new RecordingError("store_unavailable", true);
    expect(await processRecordingEvent(s.deps, eventRow())).toEqual({ status: "retry", code: "metadata_unavailable" });
    expect(s.storage.objects.size).toBe(1);
    const first = [...s.storage.objects.keys()][0];
    s.store.putResult = "stored";
    expect(await processRecordingEvent(s.deps, eventRow())).toEqual({ status: "stored" });
    expect([...s.storage.objects.keys()]).toEqual([first]);
    expect(s.store.puts.map((p) => p.objectPath)).toEqual([first, first]);
  });
  it("database outages during checks are retryable and send nothing", async () => {
    const s = setup(audioResponse());
    s.store.getCall = async () => { throw new RecordingError("store_unavailable", true); };
    expect(await processRecordingEvent(s.deps, eventRow())).toEqual({ status: "retry", code: "store_unavailable" });
    s.store.getCall = async () => { throw new Error("boom with +919000000001"); };
    const out = await processRecordingEvent(s.deps, eventRow());
    expect(out).toEqual({ status: "retry", code: "store_unavailable" });
    expect(JSON.stringify(out)).not.toContain("9190");
    expect(s.t.calls).toHaveLength(0);
  });
  it("an unexpected throw while contacting the transport is retryable, not a crash", async () => {
    const s = setup(); s.deps.transport = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await processRecordingEvent(s.deps, eventRow())).toEqual({ status: "retry", code: "provider_unavailable" });
  });
});

describe("what the worker never does", () => {
  it("uses the call's own SID-derived URL, ignoring any URL smuggled into the payload", async () => {
    const s = setup(audioResponse());
    await processRecordingEvent(s.deps, eventRow({ payload: { recording_url: "https://evil.test/steal.wav", RecordingUrl: "https://evil.test/x" } }));
    expect(s.t.calls.map((c) => new URL(c.url).hostname)).toEqual(["api.twilio.com"]);
  });
  it("outcomes contain only codes", async () => {
    const s = setup(audioResponse());
    const out = await processRecordingEvent(s.deps, eventRow());
    expect(Object.keys(out)).toEqual(["status"]);
    expect(CALL_SID).toBeTruthy(); expect(PERSON).toBeTruthy(); expect(NOW).toBeTruthy();
  });
});
