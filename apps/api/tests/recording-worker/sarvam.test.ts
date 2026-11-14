import { describe, expect, it } from "vitest";
import { processRecordingEvent, SARVAM_RETRIEVAL_EVENT, type RawEventRow } from "../../src/lib/recording-worker";
import { encryptWebhook } from "../../src/lib/webhook-security";
import { audioResponse, CALL, consent, CONSENT, FakeRecordingStore, FakeStorage, FAMILY, KEY_HEX, PERSON, scripted, workerDeps } from "./helpers";

const INTERACTION = "20261114/abc-123", ATTEMPT = "att-1", APP = "app-1";
const sarvam = { apiKey: "synthetic-key", orgId: "org-1", workspaceId: "ws-1", appId: APP };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const wav = (status = 200) => audioResponse(undefined, "audio/wav", status);

function sarvamRow(over: { payload?: Record<string, unknown>; metadata?: Record<string, unknown>; row?: Partial<RawEventRow> } = {}): RawEventRow {
  const providerEventId = `${APP}:recording:${INTERACTION}:requested`;
  const payload = { app_id: APP, call_ref: ATTEMPT, interaction_id: INTERACTION, status: "completed", call_id: CALL, consent_id: CONSENT, person_id: PERSON, ...over.payload };
  return {
    id: "55555555-5555-4555-8555-555555555555", familyId: FAMILY, source: "sarvam", providerEventId, eventType: SARVAM_RETRIEVAL_EVENT,
    metadata: { person_id: PERSON, status: "completed", call_id: CALL, consent_id: CONSENT, ...over.metadata },
    payloadCiphertext: encryptWebhook(Buffer.from(JSON.stringify(payload)), KEY_HEX, `sarvam:${providerEventId}`), ...over.row,
  };
}
function setup(external: string, ...responses: Parameters<typeof scripted>) {
  const store = new FakeRecordingStore(), storage = new FakeStorage(), t = scripted(...responses);
  store.call = { personId: PERSON, provider: "sarvam", externalId: external, aiDisclosed: true };
  return { store, storage, t, deps: workerDeps(store, storage, t.transport, { sarvam }) };
}

describe("Sarvam recording retrieval", () => {
  it("is explicitly unavailable until the Sarvam analytics configuration is supplied", async () => {
    const store = new FakeRecordingStore(), storage = new FakeStorage(), t = scripted(wav());
    store.call = { personId: PERSON, provider: "sarvam", externalId: ATTEMPT, aiDisclosed: true };
    expect(await processRecordingEvent(workerDeps(store, storage, t.transport), sarvamRow())).toEqual({ status: "rejected", code: "sarvam_recording_unavailable" });
    expect(t.calls).toHaveLength(0); expect(store.puts).toHaveLength(0);
  });
  it("an inbound call (stored id is the interaction) fetches the documented recording endpoint directly", async () => {
    const s = setup(INTERACTION, wav());
    expect(await processRecordingEvent(s.deps, sarvamRow({ payload: { call_ref: INTERACTION } }))).toEqual({ status: "stored" });
    expect(s.t.calls).toHaveLength(1);
    expect(s.t.calls[0]!.url).toBe("https://apps.sarvam.ai/api/analytics/v1/org-1/ws-1/app-1/recordings/20261114%2Fabc-123");
    expect((s.t.calls[0]!.init.headers as Record<string, string>)["X-API-Key"]).toBe("synthetic-key");
    expect(s.store.puts[0]!.objectPath).toMatch(new RegExp(`^${FAMILY}/calls/${CALL}/[0-9a-f]{32}\\.wav$`));
  });
  it("an outbound call confirms attempt to interaction with Sarvam before fetching audio", async () => {
    const s = setup(ATTEMPT, json({ items: [{ attempt_id: ATTEMPT, interaction_id: INTERACTION }], total: 1 }), wav());
    expect(await processRecordingEvent(s.deps, sarvamRow())).toEqual({ status: "stored" });
    expect(s.t.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/analytics/v1/org-1/ws-1/app-1/attempts", "/api/analytics/v1/org-1/ws-1/app-1/recordings/20261114%2Fabc-123"]);
  });
  it("an interaction id swapped in the unsigned webhook body is refused without fetching audio", async () => {
    const s = setup(ATTEMPT, json({ items: [{ attempt_id: ATTEMPT, interaction_id: "20261114/someone-else" }], total: 1 }));
    expect(await processRecordingEvent(s.deps, sarvamRow())).toEqual({ status: "rejected", code: "interaction_unverified" });
    expect(s.t.calls).toHaveLength(1); expect(s.storage.puts).toBe(0); expect(s.store.puts).toHaveLength(0);
    const unknown = setup(ATTEMPT, json({ items: [], total: 0 }));
    expect(await processRecordingEvent(unknown.deps, sarvamRow())).toEqual({ status: "rejected", code: "interaction_unverified" });
  });
  it("a different app, a call of another provider or another call reference is refused before any request", async () => {
    const cases: Array<[RawEventRow, (s: ReturnType<typeof setup>) => void]> = [
      [sarvamRow({ payload: { app_id: "app-2" } }), () => {}],
      [sarvamRow(), (s) => { s.store.call!.provider = "twilio"; }],
      [sarvamRow(), (s) => { s.store.call!.externalId = "att-other"; }],
      [sarvamRow({ payload: { interaction_id: "../../x" } }), () => {}],
    ];
    for (const [row, mutate] of cases) {
      const s = setup(ATTEMPT, wav()); mutate(s);
      expect((await processRecordingEvent(s.deps, row)).status).toBe("rejected");
      expect(s.t.calls).toHaveLength(0);
    }
  });
  it("the shared consent rechecks apply: no effective call_recording consent means no request", async () => {
    const s = setup(INTERACTION, wav()); s.store.consents = [consent(), consent({ id: "r1", callId: null, answer: false, createdAt: "2026-11-14T11:00:00.000Z" })];
    expect(await processRecordingEvent(s.deps, sarvamRow({ payload: { call_ref: INTERACTION } }))).toEqual({ status: "rejected", code: "consent_not_effective" });
    expect(s.t.calls).toHaveLength(0);
  });
  it("no recording yet (404) and provider outages are retryable; bad audio is not stored", async () => {
    expect((await processRecordingEvent(setup(INTERACTION, wav(404)).deps, sarvamRow({ payload: { call_ref: INTERACTION } }))).code).toBe("recording_not_ready");
    expect((await processRecordingEvent(setup(ATTEMPT, json({}, 503)).deps, sarvamRow())).status).toBe("retry");
    const bad = setup(INTERACTION, audioResponse(new Uint8Array(100).fill(1), "audio/wav"));
    expect(await processRecordingEvent(bad.deps, sarvamRow({ payload: { call_ref: INTERACTION } }))).toEqual({ status: "rejected", code: "media_invalid" });
    expect(bad.storage.puts).toBe(0);
  });
  it("a Twilio event can never be processed with Sarvam rules and vice versa", async () => {
    const s = setup(ATTEMPT, wav());
    expect((await processRecordingEvent(s.deps, sarvamRow({ row: { source: "twilio" } }))).code).toBe("wrong_event_type");
    expect((await processRecordingEvent(s.deps, sarvamRow({ row: { eventType: "twilio.recording.retrieval_requested" } }))).code).toBe("wrong_event_type");
  });
});
