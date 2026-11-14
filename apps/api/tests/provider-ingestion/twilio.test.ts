import { describe, expect, it } from "vitest";
import { handleTwilioRecording, handleTwilioStatus, verifyTwilioSignature, type TwilioConfig } from "../../src/lib/provider-ingestion/gateway";
import { ACCOUNT_SID, AUTH, CALL_ID, CALL_SID, consent, CONSENT_ID, fakeStore, FAMILY, PERSON, RECORDING_URL, REC_SID, STATUS_URL, twilioSign, VERSION } from "./helpers";

const cfg: TwilioConfig = { accountSid: ACCOUNT_SID, authToken: AUTH, statusUrl: STATUS_URL, recordingUrl: RECORDING_URL, consentVersion: VERSION };
const FORM = "application/x-www-form-urlencoded";
const statusForm = (o: Record<string, string> = {}) => new URLSearchParams({ AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: "completed", SequenceNumber: "3", ...o });
const recForm = (o: Record<string, string> = {}) => new URLSearchParams({ AccountSid: ACCOUNT_SID, CallSid: CALL_SID, RecordingSid: REC_SID, RecordingStatus: "completed", RecordingDuration: "42", RecordingUrl: "https://api.twilio.com/secret-recording", ...o });
const send = (h: typeof handleTwilioStatus, form: URLSearchParams, url: string, store = fakeStore(), c = cfg, sig?: string | null, type: string | null = FORM) =>
  h(Buffer.from(form.toString()), type, sig === undefined ? twilioSign(url, form) : sig, c, () => store);

describe("twilio signature fixed vectors", () => {
  // Independent of twilioSign(): values computed with Python hmac/hashlib, not with this repo's signer.
  it("matches the example published in Twilio's request-validation docs", () => {
    const p = new URLSearchParams({ CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" });
    expect(verifyTwilioSignature("https://mycompany.com/myapp.php?foo=1&bar=2", p, "0/KCTR6DLpKmkAf8muzZqo1nDgQ=", "12345")).toBe(true);
  });
  it("de-duplicates identical repeated values before signing (twilio-node toFormUrlEncodedParam)", () => {
    const url = "https://api.example.test/api/twilio/status";
    const dup = new URLSearchParams("AccountSid=AC1&CallStatus=completed&Tag=y&Tag=x&Tag=x");
    expect(verifyTwilioSignature(url, dup, "LOqebAxu9btajKK0N8wGD/QwcPA=", AUTH)).toBe(true);
    // Signature over the non-deduplicated string must NOT validate.
    expect(verifyTwilioSignature(url, dup, "kMdDxX+uTO5OkXYbbLHfZ4/0s4c=", AUTH)).toBe(false);
    // Different distinct values still change the signature.
    expect(verifyTwilioSignature(url, new URLSearchParams("AccountSid=AC1&CallStatus=completed&Tag=x&Tag=z"), "LOqebAxu9btajKK0N8wGD/QwcPA=", AUTH)).toBe(false);
  });
});

describe("twilio signature", () => {
  it("matches Twilio's documented algorithm and rejects tampering", () => {
    const p = new URLSearchParams({ B: "2", A: "1", C: "x" });
    expect(verifyTwilioSignature(STATUS_URL, p, twilioSign(STATUS_URL, p), AUTH)).toBe(true);
    expect(verifyTwilioSignature(STATUS_URL, p, twilioSign(STATUS_URL, p), "other-token")).toBe(false);
    expect(verifyTwilioSignature("https://evil.example.test/x", p, twilioSign(STATUS_URL, p), AUTH)).toBe(false);
    expect(verifyTwilioSignature(STATUS_URL, new URLSearchParams({ A: "1", B: "3", C: "x" }), twilioSign(STATUS_URL, p), AUTH)).toBe(false);
    expect(verifyTwilioSignature("http://api.example.test/x", p, twilioSign("http://api.example.test/x", p), AUTH)).toBe(false);
    for (const s of [null, "", "short", "!!!"]) expect(verifyTwilioSignature(STATUS_URL, p, s, AUTH)).toBe(false);
  });
});

describe("twilio status", () => {
  it("persists IDs and enums for a known call", async () => {
    const store = fakeStore();
    const r = await send(handleTwilioStatus, statusForm(), STATUS_URL, store);
    expect(r.status).toBe(200);
    expect(store.findCall).toHaveBeenCalledWith("twilio", CALL_SID);
    expect(store.ingest.mock.calls[0][0]).toMatchObject({ source: "twilio", id: `${ACCOUNT_SID}:call:${CALL_SID}:completed:3`, type: "twilio.call_status", familyId: FAMILY });
  });
  it("rejects bad or missing signature before any lookup", async () => {
    for (const sig of [null, "AAAA", twilioSign(STATUS_URL, statusForm(), "wrong-token"), twilioSign(RECORDING_URL, statusForm())]) {
      const store = fakeStore();
      await expect(send(handleTwilioStatus, statusForm(), STATUS_URL, store, cfg, sig)).rejects.toMatchObject({ status: 401 });
      expect(store.findCall).not.toHaveBeenCalled();
    }
  });
  it("fails closed when URL or credentials are not configured, and on wrong content type", async () => {
    await expect(send(handleTwilioStatus, statusForm(), STATUS_URL, fakeStore(), { ...cfg, statusUrl: undefined })).rejects.toMatchObject({ status: 503 });
    await expect(send(handleTwilioStatus, statusForm(), STATUS_URL, fakeStore(), { ...cfg, authToken: "" })).rejects.toMatchObject({ status: 503 });
    await expect(send(handleTwilioStatus, statusForm(), STATUS_URL, fakeStore(), cfg, undefined, "application/json")).rejects.toMatchObject({ status: 415 });
  });
  it("rejects wrong account, unknown call, malformed, and duplicate parameters", async () => {
    const wrong = "AC" + "d".repeat(32);
    await expect(send(handleTwilioStatus, statusForm({ AccountSid: wrong }), STATUS_URL)).rejects.toMatchObject({ status: 403, code: "wrong_provider_account" });
    const unknown = fakeStore({ findCall: async () => null });
    await expect(send(handleTwilioStatus, statusForm(), STATUS_URL, unknown)).rejects.toMatchObject({ status: 403, code: "unknown_call" });
    expect(unknown.ingest).not.toHaveBeenCalled();
    await expect(send(handleTwilioStatus, statusForm({ CallStatus: "bogus" }), STATUS_URL)).rejects.toMatchObject({ status: 400 });
    await expect(send(handleTwilioStatus, statusForm({ CallSid: "CAx" }), STATUS_URL)).rejects.toMatchObject({ status: 400 });
    const dup = statusForm(); dup.append("CallStatus", "failed");
    await expect(send(handleTwilioStatus, dup, STATUS_URL)).rejects.toMatchObject({ status: 400 });
  });
  it("does not acknowledge on persistence failure", async () => {
    const { WebhookError } = await import("../../src/lib/webhook-security");
    const store = fakeStore({ ingest: async () => { throw new WebhookError("event_persistence_failed", 503); } });
    await expect(send(handleTwilioStatus, statusForm(), STATUS_URL, store)).rejects.toMatchObject({ status: 503 });
  });
});

describe("twilio recording", () => {
  it("queues retrieval only after identity and consent, without storing the media URL", async () => {
    const store = fakeStore();
    const r = await send(handleTwilioRecording, recForm(), RECORDING_URL, store);
    expect(r.body).toEqual({ accepted: true, processing: "queued" });
    const event = store.ingest.mock.calls[0][0];
    expect(event).toMatchObject({ type: "twilio.recording.retrieval_requested", id: `${ACCOUNT_SID}:recording:${REC_SID}:completed` });
    expect(JSON.stringify(event)).not.toContain("secret-recording");
    expect(JSON.stringify(r)).not.toMatch(/deliver|heard|stored/i);
  });
  it("stores exact call_id and consent_id in payload and ID-only fields", async () => {
    const store = fakeStore();
    await send(handleTwilioRecording, recForm(), RECORDING_URL, store);
    expect(store.findConsents).toHaveBeenCalledWith(FAMILY, PERSON, CALL_ID, "call_recording");
    expect(store.ingest.mock.calls[0][0]).toMatchObject({ callId: CALL_ID, consentId: CONSENT_ID, payload: { call_id: CALL_ID, consent_id: CONSENT_ID } });
  });
  const denied = async (rows: ReturnType<typeof consent>[], aiDisclosed = true, c: TwilioConfig = cfg) => {
    const store = fakeStore({
      findCall: async () => ({ familyId: FAMILY, personId: PERSON, callId: CALL_ID, aiDisclosed }),
      findConsents: async () => rows,
    });
    await expect(send(handleTwilioRecording, recForm(), RECORDING_URL, store, c)).rejects.toMatchObject({ status: expect.any(Number) });
    expect(store.ingest).not.toHaveBeenCalled();
  };
  it("rejects with no write: no consent row, a refusal, wrong person, wrong call, wrong version, wrong purpose, no AI disclosure", async () => {
    await denied([]);
    await denied([consent({ answer: false })]);
    await denied([consent({ personId: "55555555-5555-4555-8555-555555555555" })]);
    await denied([consent({ callId: "66666666-6666-4666-8666-666666666666" })]);
    await denied([consent({ version: "old" })]);
    await denied([consent({ purpose: "call_transcript" })]);
    await denied([consent({ familyId: "77777777-7777-4777-8777-777777777777" })]);
    await denied([consent()], false);
    await denied([consent()], true, { ...cfg, consentVersion: undefined });
  });
  it("later revocation for this call wins, and a later yes for a different call does not revive it", async () => {
    const other = "66666666-6666-4666-8666-666666666666";
    await denied([consent(), consent({ id: "r1", answer: false, createdAt: "2026-11-14T11:00:00.000Z" })]);
    await denied([consent(), consent({ id: "r1", answer: false, createdAt: "2026-11-14T11:00:00.000Z" }), consent({ id: "y2", callId: other, createdAt: "2026-11-14T12:00:00.000Z" })]);
  });
  it("a later global yes never restores consent ended by a global refusal, even with 25 newer global yes rows", async () => {
    const yes = (i: number) => consent({ id: `gy${i}`, callId: null, createdAt: new Date(Date.UTC(2026, 10, 14, 12, 0, i)).toISOString() });
    const refusal = consent({ id: "g", callId: null, answer: false, createdAt: "2026-11-14T11:00:00.000Z" });
    await denied([consent({ createdAt: "2026-11-14T10:00:00.000Z" }), refusal, yes(0)]);
    await denied([consent({ createdAt: "2026-11-14T10:00:00.000Z" }), refusal, ...Array.from({ length: 25 }, (_, i) => yes(i))]);
    const store = fakeStore({ findConsents: async () => [refusal, consent({ createdAt: "2026-11-14T11:30:00.000Z" }), yes(1)] });
    expect((await send(handleTwilioRecording, recForm(), RECORDING_URL, store)).status).toBe(200);
  });
  it("call-independent refusal at or after the yes blocks, a later call-specific yes re-allows", async () => {
    await denied([consent(), consent({ id: "g", callId: null, answer: false, createdAt: "2026-11-14T10:00:00.000Z" })]);
    await denied([consent(), consent({ id: "g", callId: null, answer: false, createdAt: "2026-11-14T10:30:00.000Z" })]);
    const store = fakeStore({ findConsents: async () => [consent({ id: "g", callId: null, answer: false, createdAt: "2026-11-14T09:00:00.000Z" }), consent()] });
    expect((await send(handleTwilioRecording, recForm(), RECORDING_URL, store)).status).toBe(200);
  });
  it("uses the recording URL for signatures, so status signatures cannot be replayed here", async () => {
    await expect(send(handleTwilioRecording, recForm(), STATUS_URL)).rejects.toMatchObject({ status: 401 });
  });
  it("records non-completed statuses as status events, not retrieval requests", async () => {
    const store = fakeStore();
    await send(handleTwilioRecording, recForm({ RecordingStatus: "failed" }), RECORDING_URL, store);
    expect(store.ingest.mock.calls[0][0].type).toBe("twilio.recording.status");
  });
  it("rejects wrong account, unknown call, malformed fields", async () => {
    await expect(send(handleTwilioRecording, recForm({ AccountSid: "AC" + "e".repeat(32) }), RECORDING_URL)).rejects.toMatchObject({ status: 403 });
    await expect(send(handleTwilioRecording, recForm({ RecordingSid: "RE1" }), RECORDING_URL)).rejects.toMatchObject({ status: 400 });
    await expect(send(handleTwilioRecording, recForm({ RecordingStatus: "x" }), RECORDING_URL)).rejects.toMatchObject({ status: 400 });
    await expect(send(handleTwilioRecording, recForm({ RecordingDuration: "-1" }), RECORDING_URL)).rejects.toMatchObject({ status: 400 });
    const unknown = fakeStore({ findCall: async () => null });
    await expect(send(handleTwilioRecording, recForm(), RECORDING_URL, unknown)).rejects.toMatchObject({ status: 403 });
  });
});
