import { describe, expect, it, vi } from "vitest";
import { handleSarvam, SARVAM_RETRIEVAL_EVENT, type SarvamConfig } from "../../src/lib/provider-ingestion/gateway";
import { CALL_ID, consent, CONSENT_ID, fakeStore, FAMILY, inbound, outbound, PERSON, VERSION } from "./helpers";

const cfg: SarvamConfig = { appId: "app-1", agentDigits: "918000000000", deploymentId: "dep-1", consentVersion: VERSION, recordingRetrieval: true };
const buf = (o: unknown) => Buffer.from(JSON.stringify(o));
const retrievals = (store: ReturnType<typeof fakeStore>) => store.ingest.mock.calls.map((c) => c[0]).filter((e) => e.type === SARVAM_RETRIEVAL_EVENT);

describe("Sarvam recording retrieval request", () => {
  it("is queued once for a connected outbound call with disclosure and exact-call recording consent", async () => {
    const store = fakeStore();
    await handleSarvam(buf(outbound()), cfg, () => store);
    const [e] = retrievals(store);
    expect(retrievals(store)).toHaveLength(1);
    expect(e).toMatchObject({ source: "sarvam", status: "completed", familyId: FAMILY, personId: PERSON, callId: CALL_ID, consentId: CONSENT_ID, id: "app-1:recording:20261114/abc123:requested" });
    expect(e.payload).toEqual({ app_id: "app-1", call_ref: "att-1", interaction_id: "20261114/abc123", status: "completed", call_id: CALL_ID, consent_id: CONSENT_ID });
    expect(JSON.stringify(e)).not.toContain("SYNTHETIC-SECRET-TRANSCRIPT");
  });
  it("is queued for an inbound call keyed by its interaction id", async () => {
    const store = fakeStore();
    await handleSarvam(buf(inbound()), cfg, () => store);
    expect(retrievals(store)[0]!.payload).toMatchObject({ call_ref: "20261114/in-1", interaction_id: "20261114/in-1" });
  });
  it("is off by default", async () => {
    const store = fakeStore();
    await handleSarvam(buf(outbound()), { ...cfg, recordingRetrieval: undefined }, () => store);
    expect(retrievals(store)).toHaveLength(0);
    expect(store.findConsents).not.toHaveBeenCalled();
  });
  it.each([
    ["no_answer", { status: "no_answer", interaction_id: null }],
    ["failed", { status: "failed" }],
    ["busy", { status: "busy" }],
    ["no interaction id", { interaction_id: null }],
  ])("is not queued for %s", async (_n, over) => {
    const store = fakeStore();
    await handleSarvam(buf(outbound(over)), cfg, () => store);
    expect(retrievals(store)).toHaveLength(0);
  });
  it("is not queued without AI disclosure, without consent, after a refusal or on the wrong version", async () => {
    const cases: Array<[string, Parameters<typeof fakeStore>[0]]> = [
      ["no disclosure", { findCall: vi.fn(async () => ({ familyId: FAMILY, personId: PERSON, callId: CALL_ID, aiDisclosed: false })) }],
      ["no consent", { findConsents: vi.fn(async () => []) }],
      ["newer global refusal", { findConsents: vi.fn(async (_f, _p, _c, purpose) => [consent({ purpose }), consent({ id: "r1", callId: null, answer: false, purpose, createdAt: "2026-11-14T11:00:00.000Z" })]) }],
      ["wrong version", { findConsents: vi.fn(async (_f, _p, _c, purpose) => [consent({ purpose, version: "old" })]) }],
      ["unknown call", { findCall: vi.fn(async () => null) }],
    ];
    for (const [, over] of cases) {
      const store = fakeStore(over);
      await handleSarvam(buf(outbound()), cfg, () => store);
      expect(retrievals(store)).toHaveLength(0);
      expect(store.ingest.mock.calls.some((c) => c[0].type === "sarvam.outbound")).toBe(true); // the raw status event still persists
    }
  });
  it("a call belonging to another person is not used to queue retrieval", async () => {
    const store = fakeStore({ findCall: vi.fn(async () => ({ familyId: FAMILY, personId: "99999999-9999-4999-8999-999999999999", callId: CALL_ID, aiDisclosed: true })) });
    await handleSarvam(buf(outbound()), cfg, () => store);
    expect(retrievals(store)).toHaveLength(0);
    expect(store.ingest.mock.calls.find((c) => c[0].type === "sarvam.outbound")![0].callId).toBeUndefined(); // identity mismatch: our call id is not attached
  });
  it("the raw outbound event carries our call id so delivery proof can be derived from stored records", async () => {
    const store = fakeStore();
    await handleSarvam(buf(outbound({ status: "no_answer", interaction_id: null })), cfg, () => store);
    expect(store.ingest.mock.calls[0]![0]).toMatchObject({ type: "sarvam.outbound", callId: CALL_ID });
  });
});
