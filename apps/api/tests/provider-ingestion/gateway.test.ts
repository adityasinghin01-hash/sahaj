import { describe, expect, it, vi } from "vitest";
import { handleSarvam, handleTeleCmi, type SarvamConfig } from "../../src/lib/provider-ingestion/gateway";
import { CALL_ID, consent, CONSENT_ID, fakeStore, FAMILY, inbound, missed, outbound, PERSON, VERSION } from "./helpers";

const sarvam = { appId: "app-1", agentDigits: "918000000000", deploymentId: "dep-1", consentVersion: VERSION };
const telecmi = { appId: 123, virtualDigits: "918000000001" };
const buf = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v));
const NOW = 1_794_000_000_000 + 1000;

describe("sarvam outbound", () => {
  it("persists an allowlisted payload for a server-stored attempt", async () => {
    const store = fakeStore();
    const r = await handleSarvam(buf(outbound()), sarvam, () => store);
    expect(r).toEqual({ status: 200, body: { accepted: true, processing: "queued" } });
    expect(store.findSarvamAttempt).toHaveBeenCalledWith("app-1", "att-1");
    const event = store.ingest.mock.calls[0][0];
    expect(event).toMatchObject({ source: "sarvam", id: "app-1:outbound:att-1:connected", type: "sarvam.outbound", status: "connected", familyId: FAMILY, personId: PERSON });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("SYNTHETIC-SECRET");
    expect(serialized).not.toContain("9999999999");
    expect(serialized).not.toContain("80000");
  });
  it("rejects an unknown attempt without writing", async () => {
    const store = fakeStore({ findSarvamAttempt: async () => null });
    await expect(handleSarvam(buf(outbound()), sarvam, () => store)).rejects.toMatchObject({ status: 403, code: "unknown_attempt" });
    expect(store.ingest).not.toHaveBeenCalled();
  });
  it("rejects wrong app or wrong agent number before any lookup", async () => {
    for (const bad of [outbound({ app_id: "other" }), outbound({ channel_info: { agent_phone_number: "+919111111111" } })]) {
      const store = fakeStore();
      await expect(handleSarvam(buf(bad), sarvam, () => store)).rejects.toMatchObject({ status: 403, code: "wrong_provider_account" });
      expect(store.findSarvamAttempt).not.toHaveBeenCalled();
    }
  });
  it("rejects malformed payloads", async () => {
    const cases: unknown[] = ["not json", "[]", "null", outbound({ status: "weird" }), outbound({ duration: -1 }), outbound({ interaction_id: "../x" }),
      outbound({ app_version: "2" }), outbound({ channel_info: null }), outbound({ attempt_id: "a/b" })];
    for (const bad of cases) {
      const store = fakeStore();
      await expect(handleSarvam(buf(bad), sarvam, () => store)).rejects.toMatchObject({ status: 400 });
      expect(store.ingest).not.toHaveBeenCalled();
    }
  });
  it("does not acknowledge when persistence fails, and surfaces conflicts", async () => {
    const down = fakeStore({ ingest: async () => { throw new (await import("../../src/lib/webhook-security")).WebhookError("event_persistence_failed", 503); } });
    await expect(handleSarvam(buf(outbound()), sarvam, () => down)).rejects.toMatchObject({ status: 503 });
    const conflict = fakeStore({ ingest: async () => { throw new (await import("../../src/lib/webhook-security")).WebhookError("event_id_conflict", 409); } });
    await expect(handleSarvam(buf(outbound()), sarvam, () => conflict)).rejects.toMatchObject({ status: 409 });
  });
  it("replays of the same payload produce the same stable event id and payload", async () => {
    const store = fakeStore();
    await handleSarvam(buf(outbound()), sarvam, () => store);
    await handleSarvam(buf(outbound()), sarvam, () => store);
    expect(store.ingest.mock.calls[0][0]).toEqual(store.ingest.mock.calls[1][0]);
  });
  it("same event id with a changed duration yields identical id but different payload (store reports conflict)", async () => {
    const store = fakeStore();
    await handleSarvam(buf(outbound()), sarvam, () => store);
    await handleSarvam(buf(outbound({ duration: 99 })), sarvam, () => store);
    const [a, b] = store.ingest.mock.calls.map((c) => c[0]);
    expect(a.id).toBe(b.id);
    expect(a.payload).not.toEqual(b.payload);
  });
});

describe("sarvam inbound", () => {
  it("persists for the configured deployment and a registered caller", async () => {
    const store = fakeStore();
    expect((await handleSarvam(buf(inbound()), sarvam, () => store)).status).toBe(200);
    expect(store.resolveContact).toHaveBeenCalledWith("sarvam", "app-1", "919876543210");
    const event = store.ingest.mock.calls[0][0];
    expect(event.id).toBe("dep-1:inbound:20261114/in-1");
    expect(JSON.stringify(event)).not.toMatch(/SYNTHETIC|9876543210/);
  });
  it("rejects unknown callers, wrong deployment, and missing deployment config", async () => {
    const unknown = fakeStore({ resolveContact: async () => null });
    await expect(handleSarvam(buf(inbound()), sarvam, () => unknown)).rejects.toMatchObject({ status: 403, code: "unregistered_sender" });
    expect(unknown.ingest).not.toHaveBeenCalled();
    const store = fakeStore();
    await expect(handleSarvam(buf(inbound({ deployment_id: "dep-x" })), sarvam, () => store)).rejects.toMatchObject({ status: 403 });
    await expect(handleSarvam(buf(inbound()), { ...sarvam, deploymentId: undefined }, () => store)).rejects.toMatchObject({ status: 503 });
    expect(store.resolveContact).not.toHaveBeenCalled();
  });
});

describe("telecmi missed call", () => {
  it("persists for configured account and registered caller", async () => {
    const store = fakeStore();
    expect((await handleTeleCmi(buf(missed()), telecmi, () => store, NOW)).status).toBe(200);
    expect(store.resolveContact).toHaveBeenCalledWith("telecmi", "123", "919876543210");
    const event = store.ingest.mock.calls[0][0];
    expect(event).toMatchObject({ id: "123:missed:cmi-uuid-0001", type: "telecmi.missed_call", status: "missed" });
    expect(JSON.stringify(event)).not.toContain("9876543210");
  });
  it("rejects wrong account, unknown caller, and malformed payloads", async () => {
    const store = fakeStore();
    await expect(handleTeleCmi(buf(missed({ appid: 999 })), telecmi, () => store, NOW)).rejects.toMatchObject({ status: 403 });
    await expect(handleTeleCmi(buf(missed({ virtual_number: "919000000000" })), telecmi, () => store, NOW)).rejects.toMatchObject({ status: 403 });
    for (const bad of [missed({ status: "answered" }), missed({ type: "x" }), missed({ cmiuuid: "x" }), missed({ time: NOW + 10 * 24 * 3600_000 }), missed({ from: "abc" }), "{", "[]"]) {
      await expect(handleTeleCmi(buf(bad), telecmi, () => store, NOW)).rejects.toMatchObject({ status: 400 });
    }
    const unknown = fakeStore({ resolveContact: async () => null });
    await expect(handleTeleCmi(buf(missed()), telecmi, () => unknown, NOW)).rejects.toMatchObject({ status: 403, code: "unregistered_sender" });
    expect(unknown.ingest).not.toHaveBeenCalled();
    expect(store.ingest).not.toHaveBeenCalled();
  });
  it("does not acknowledge on persistence failure", async () => {
    const store = fakeStore({ ingest: async () => { throw new (await import("../../src/lib/webhook-security")).WebhookError("event_persistence_failed", 503); } });
    await expect(handleTeleCmi(buf(missed()), telecmi, () => store, NOW)).rejects.toMatchObject({ status: 503 });
  });
});

describe("sarvam transcript retention", () => {
  const withContent = (o: Record<string, unknown> = {}) => ({ interaction_transcript: [{ role: "user", en_text: "SYNTHETIC-HEALTH-NOTE" }], final_agent_variables: { note: "SYNTHETIC-VARIABLE" }, ...o });
  const calls = (rows: ReturnType<typeof consent>[], call: unknown = { familyId: FAMILY, personId: PERSON, callId: CALL_ID, aiDisclosed: true }) =>
    fakeStore({ findCall: vi.fn(async () => call as never), findConsents: vi.fn(async () => rows) });

  it("retains transcript and variables only inside the encrypted payload when consent is proven", async () => {
    const store = calls([consent({ purpose: "call_transcript" })]);
    await handleSarvam(buf(outbound(withContent())), sarvam, () => store);
    expect(store.findCall).toHaveBeenCalledWith("sarvam", "att-1");
    expect(store.findConsents).toHaveBeenCalledWith(FAMILY, PERSON, CALL_ID, "call_transcript");
    const event = store.ingest.mock.calls[0][0];
    expect(event.payload).toMatchObject({ interaction_transcript: [{ role: "user", en_text: "SYNTHETIC-HEALTH-NOTE" }], final_agent_variables: { note: "SYNTHETIC-VARIABLE" }, call_id: CALL_ID, consent_id: CONSENT_ID });
    expect(event).toMatchObject({ callId: CALL_ID, consentId: CONSENT_ID });
    const { payload, ...ids } = event;
    expect(JSON.stringify(ids)).not.toMatch(/SYNTHETIC/);
  });
  it("applies the same rule to inbound calls, looked up by interaction id", async () => {
    const store = calls([consent({ purpose: "call_transcript" })]);
    await handleSarvam(buf(inbound(withContent())), sarvam, () => store);
    expect(store.findCall).toHaveBeenCalledWith("sarvam", "20261114/in-1");
    expect(store.ingest.mock.calls[0][0].payload).toHaveProperty("interaction_transcript");
  });
  const redacted = async (store: ReturnType<typeof calls>, cfg: SarvamConfig = sarvam) => {
    expect((await handleSarvam(buf(outbound(withContent())), cfg, () => store)).status).toBe(200);
    const event = store.ingest.mock.calls[0][0];
    expect(JSON.stringify(event)).not.toMatch(/SYNTHETIC/);
    expect(event.review).toBe("consent_missing");
    expect(event.payload).toMatchObject({ review_required: "consent_missing" });
    expect(event.consentId).toBeUndefined();
  };
  it("redacts and flags review without proven consent", async () => {
    await redacted(calls([]));
    await redacted(calls([consent({ purpose: "call_transcript", answer: false })]));
    await redacted(calls([consent({ purpose: "call_recording" })]));
    await redacted(calls([consent({ purpose: "call_transcript", personId: "other" })]));
    await redacted(calls([consent({ purpose: "call_transcript", callId: "other" })]));
    await redacted(calls([consent({ purpose: "call_transcript" })], null));
    await redacted(calls([consent({ purpose: "call_transcript" })], { familyId: FAMILY, personId: "someone-else", callId: CALL_ID, aiDisclosed: true }));
    await redacted(calls([consent({ purpose: "call_transcript" })]), { ...sarvam, consentVersion: undefined });
  });
  it("does not look up consent when the payload has no content, and rejects malformed content", async () => {
    const store = calls([]);
    await handleSarvam(buf(outbound()), sarvam, () => store);
    expect(store.findCall).not.toHaveBeenCalled();
    expect(store.ingest.mock.calls[0][0].review).toBeUndefined();
    for (const bad of [{ interaction_transcript: "x" }, { final_agent_variables: [] }]) {
      await expect(handleSarvam(buf(outbound(bad)), sarvam, () => calls([]))).rejects.toMatchObject({ status: 400 });
    }
  });
});