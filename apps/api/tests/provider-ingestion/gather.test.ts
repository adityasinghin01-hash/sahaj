import { describe, expect, it, vi } from "vitest";
import { handleTwilioGather, handleTwilioStatus, type GatherStore, type TwilioConfig } from "../../src/lib/provider-ingestion/gateway";
import { WebhookError } from "../../src/lib/webhook-security";
import { ACCOUNT_SID, AUTH, CALL_ID, CALL_SID, fakeStore, FAMILY, STATUS_URL, twilioSign } from "./helpers";

const GATHER_URL = "https://api.example.test/api/twilio/gather";
const cfg: TwilioConfig = { accountSid: ACCOUNT_SID, authToken: AUTH, statusUrl: STATUS_URL, gatherUrl: GATHER_URL };
const FORM = "application/x-www-form-urlencoded";
const form = (o: Record<string, string> = {}) => new URLSearchParams({ AccountSid: ACCOUNT_SID, CallSid: CALL_SID, Digits: "1", CallStatus: "in-progress", ...o });
const PROOF = { proofEventId: "99999999-9999-4999-8999-999999999999", assignmentId: "88888888-8888-4888-8888-888888888888" };
const gatherStore = (impl?: GatherStore["acceptFromGather"]) => ({ acceptFromGather: vi.fn<GatherStore["acceptFromGather"]>(impl ?? (async () => PROOF)) });
const send = (f: URLSearchParams, o: { store?: ReturnType<typeof fakeStore>; gather?: ReturnType<typeof gatherStore>; c?: TwilioConfig; sig?: string | null; type?: string | null; url?: string } = {}) => {
  const store = o.store ?? fakeStore(), gather = o.gather ?? gatherStore();
  return { store, gather, run: () => handleTwilioGather(Buffer.from(f.toString()), o.type === undefined ? FORM : o.type, o.sig === undefined ? twilioSign(o.url ?? GATHER_URL, f) : o.sig, o.c ?? cfg, () => store, () => gather) };
};

describe("signed Gather acceptance", () => {
  it("explicit 1 on a stored call persists raw evidence first, then resolves acceptance from stored records", async () => {
    const s = send(form()); const r = await s.run();
    expect(r.status).toBe(200); expect(r.body).toEqual({ accepted: true }); expect(r.twiml).toContain("<Hangup/>");
    const event = s.store.ingest.mock.calls[0]![0];
    expect(event).toMatchObject({ source: "twilio", type: "twilio.gather.response", digit: "1", familyId: FAMILY, callId: CALL_ID, id: `${ACCOUNT_SID}:gather:${CALL_SID}` });
    expect(JSON.stringify(event.payload)).toBe(JSON.stringify({ account_sid: ACCOUNT_SID, call_sid: CALL_SID, digit: "1" }));
    expect(s.gather.acceptFromGather).toHaveBeenCalledWith(FAMILY, `${ACCOUNT_SID}:gather:${CALL_SID}`);
    expect(s.store.ingest.mock.invocationCallOrder[0]).toBeLessThan(s.gather.acceptFromGather.mock.invocationCallOrder[0]!);
  });
  it("assignment, incident, responder or outbox values in the form are ignored", async () => {
    const s = send(form({ AssignmentId: "x", IncidentId: "y", ResponderPersonId: "z", OutboxId: "w" }));
    await s.run();
    expect(s.gather.acceptFromGather.mock.calls[0]).toEqual([FAMILY, `${ACCOUNT_SID}:gather:${CALL_SID}`]);
    expect(JSON.stringify(s.store.ingest.mock.calls[0]![0])).not.toMatch(/AssignmentId|IncidentId|OutboxId/);
  });
  it.each([["2"], ["#"], ["11"], ["0"], ["*"]])("digit %s is not acceptance and writes no evidence", async (digits) => {
    const s = send(form({ Digits: digits })); const r = await s.run();
    expect(r.body).toEqual({ accepted: false }); expect(s.store.ingest).not.toHaveBeenCalled(); expect(s.gather.acceptFromGather).not.toHaveBeenCalled();
  });
  it("no digits (timeout, or a connected/completed status only) is not acceptance", async () => {
    for (const status of ["in-progress", "completed", "answered"]) {
      const f = form({ CallStatus: status }); f.delete("Digits");
      const s = send(f); expect((await s.run()).body).toEqual({ accepted: false });
      expect(s.store.ingest).not.toHaveBeenCalled(); expect(s.gather.acceptFromGather).not.toHaveBeenCalled();
    }
  });
  it("the status callback can never accept a responder, whatever the status", async () => {
    const gather = gatherStore(); const store = fakeStore();
    const f = new URLSearchParams({ AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: "completed", SequenceNumber: "3", Digits: "1" });
    await handleTwilioStatus(Buffer.from(f.toString()), FORM, twilioSign(STATUS_URL, f), cfg, () => store);
    expect(gather.acceptFromGather).not.toHaveBeenCalled();
    expect(store.ingest.mock.calls[0]![0]).toMatchObject({ type: "twilio.call_status", callId: CALL_ID });
    expect(store.ingest.mock.calls[0]![0].digit).toBeUndefined();
  });
});

describe("Gather fails closed", () => {
  const closed = async (s: ReturnType<typeof send>, status: number) => {
    await expect(s.run()).rejects.toMatchObject({ status });
    expect(s.store.ingest).not.toHaveBeenCalled(); expect(s.gather.acceptFromGather).not.toHaveBeenCalled();
  };
  it("missing, wrong, tampered or other-URL signatures", async () => {
    await closed(send(form(), { sig: null }), 401);
    await closed(send(form(), { sig: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" }), 401);
    await closed(send(form(), { url: STATUS_URL }), 401); // signed for the status URL, replayed against Gather
    const f = form(); const sig = twilioSign(GATHER_URL, f); f.set("CallSid", "CA" + "c".repeat(32));
    await closed(send(f, { sig }), 401); // call changed after signing
  });
  it("unconfigured exact URL, token or account", async () => {
    await closed(send(form(), { c: { ...cfg, gatherUrl: undefined } }), 503);
    await closed(send(form(), { c: { ...cfg, authToken: "" } }), 503);
    await closed(send(form({ AccountSid: "AC" + "e".repeat(32) })), 403);
  });
  it("wrong content type, duplicate parameters and malformed identifiers", async () => {
    await closed(send(form(), { type: "application/json" }), 415);
    await closed(send(new URLSearchParams(`AccountSid=${ACCOUNT_SID}&CallSid=${CALL_SID}&Digits=1&Digits=2`)), 400);
    await closed(send(form({ CallSid: "CA../x" })), 400);
    await closed(send(form({ Digits: "<x>" })), 400);
  });
  it("a call this system did not place is refused", async () => {
    await closed(send(form(), { store: fakeStore({ findCall: vi.fn(async () => null) }) }), 403);
  });
  it("acceptance that cannot be proven from stored records is refused after the raw press is kept", async () => {
    const s = send(form(), { gather: gatherStore(async () => null) });
    await expect(s.run()).rejects.toMatchObject({ status: 403, code: "acceptance_not_provable" });
    expect(s.store.ingest).toHaveBeenCalledTimes(1);
  });
  it("persistence failures never acknowledge acceptance", async () => {
    const ingestFails = send(form(), { store: fakeStore({ ingest: vi.fn(async () => { throw new WebhookError("event_persistence_failed", 503); }) }) });
    await expect(ingestFails.run()).rejects.toMatchObject({ status: 503 });
    expect(ingestFails.gather.acceptFromGather).not.toHaveBeenCalled();
    const acceptFails = send(form(), { gather: gatherStore(async () => { throw new WebhookError("acceptance_persistence_failed", 503); }) });
    await expect(acceptFails.run()).rejects.toMatchObject({ status: 503 });
  });
});

describe("Gather replays and races", () => {
  it("concurrent identical callbacks all resolve to one proof under one durable raw event id", async () => {
    const accepted = new Map<string, typeof PROOF>();
    const gather = gatherStore(async (_f, id) => { if (!accepted.has(id)) accepted.set(id, PROOF); return accepted.get(id)!; });
    const store = fakeStore();
    const runs = await Promise.all(Array.from({ length: 6 }, () => send(form(), { store, gather }).run()));
    expect(runs.every((r) => r.body.accepted === true)).toBe(true);
    expect(new Set(store.ingest.mock.calls.map((c) => c[0].id)).size).toBe(1);
    expect(accepted.size).toBe(1);
  });
  it("a conflicting stored event id surfaces as a conflict, not acceptance", async () => {
    const s = send(form(), { store: fakeStore({ ingest: vi.fn(async () => { throw new WebhookError("event_id_conflict", 409); }) }) });
    await expect(s.run()).rejects.toMatchObject({ status: 409 });
    expect(s.gather.acceptFromGather).not.toHaveBeenCalled();
  });
});
