import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rpc = vi.fn();
const calls: Array<{ table: string; filters: Record<string, unknown> }> = [];
let row: unknown = { family_id: "f", person_id: "p" };
let failure: unknown = null;
let list: unknown[] = [];
vi.mock("../../src/lib/database", () => ({
  serviceDatabase: () => ({
    rpc,
    from: (table: string) => {
      const entry = { table, filters: {} as Record<string, unknown> };
      calls.push(entry);
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (k: string, v: unknown) => { entry.filters[k] = v; return q; },
        is: (k: string, v: unknown) => { entry.filters[k] = v; return q; },
        order: () => q, limit: () => q,
        maybeSingle: async () => ({ data: row, error: failure }),
        then: (ok: (v: unknown) => unknown) => ok({ data: list, error: failure }),
      };
      return q;
    },
  }),
}));

import { providerStore } from "../../src/lib/provider-ingestion/store";
import { decryptWebhook, identityHash } from "../../src/lib/webhook-security";

const KEY = "ab".repeat(32), ID_SECRET = "i".repeat(40);
beforeEach(() => {
  rpc.mockReset(); calls.length = 0; list = []; row = { family_id: "f", person_id: "p" }; failure = null;
  vi.stubEnv("WEBHOOK_ENCRYPTION_KEY", KEY); vi.stubEnv("IDENTITY_HASH_SECRET", ID_SECRET);
});
afterEach(() => vi.unstubAllEnvs());

const event = { source: "sarvam" as const, id: "app:outbound:a:connected", type: "sarvam.outbound", status: "connected", familyId: "f", personId: "p", payload: { attempt_id: "a", status: "connected" } };

it("fails closed when encryption or identity secrets are missing", () => {
  vi.stubEnv("WEBHOOK_ENCRYPTION_KEY", "");
  expect(() => providerStore()).toThrow();
});
it("writes an encrypted payload and enum-only metadata through ingest_raw_event", async () => {
  rpc.mockResolvedValue({ data: {}, error: null });
  await providerStore().ingest(event);
  const [name, args] = rpc.mock.calls[0];
  expect(name).toBe("ingest_raw_event");
  expect(args.p_metadata).toEqual({ person_id: "p", status: "connected" });
  expect(args.p_payload_ciphertext).not.toContain("attempt_id");
  expect(JSON.parse(decryptWebhook(args.p_payload_ciphertext, KEY, `sarvam:${event.id}`).toString())).toEqual({ person_id: "p", ...event.payload });
});
it("maps unique violations to 409 and other failures to 503", async () => {
  rpc.mockResolvedValueOnce({ data: null, error: { code: "23505" } });
  await expect(providerStore().ingest(event)).rejects.toMatchObject({ status: 409, code: "event_id_conflict" });
  rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "secret detail" } });
  await expect(providerStore().ingest(event)).rejects.toMatchObject({ status: 503, code: "event_persistence_failed" });
});
it("looks up attempts by hash, app, binding kind and active flags", async () => {
  expect(await providerStore().findSarvamAttempt("app-1", "att-1")).toEqual({ familyId: "f", personId: "p" });
  expect(calls[0].filters).toMatchObject({
    source: "sarvam", account_id: "app-1", binding_kind: "attempt", attempt_id: "att-1", agent_id: "app-1", enabled: true, revoked_at: null,
    external_id_hash: identityHash("sarvam", "app-1", "att-1", ID_SECRET),
  });
});
it("returns null for unknown identities and throws 503 on lookup errors", async () => {
  row = null;
  expect(await providerStore().resolveContact("telecmi", "123", "919876543210")).toBeNull();
  expect(await providerStore().findCall("twilio", "CA1")).toBeNull();
  failure = { code: "x" };
  await expect(providerStore().resolveContact("telecmi", "123", "9")).rejects.toMatchObject({ status: 503 });
});
it("resolves the internal call id and disclosure flag from the calls row", async () => {
  row = { id: "call-1", family_id: "f", person_id: "p", ai_disclosed_at: "2026-01-01" };
  expect(await providerStore().findCall("twilio", "CA1")).toEqual({ familyId: "f", personId: "p", callId: "call-1", aiDisclosed: true });
  expect(calls[0].filters).toMatchObject({ provider: "twilio", external_id: "CA1" });
});
it("queries this call's and call-independent consents separately, scoped by family, person and purpose", async () => {
  list = [{ id: "c1", family_id: "f", person_id: "p", call_id: null, purpose: "call_recording", answer: false, version: "v", created_at: "2026-01-01T00:00:00Z" }];
  const rows = await providerStore().findConsents("f", "p", "call-1", "call_recording");
  expect(calls.map((c) => c.table)).toEqual(["consents", "consents"]);
  expect(calls[0].filters).toMatchObject({ family_id: "f", person_id: "p", purpose: "call_recording", call_id: "call-1" });
  expect(calls[1].filters).toMatchObject({ family_id: "f", person_id: "p", purpose: "call_recording", call_id: null, answer: false });
  expect(calls[0].filters).not.toHaveProperty("answer");
  expect(rows[0]).toMatchObject({ id: "c1", callId: null, answer: false });
  failure = { code: "x" };
  await expect(providerStore().findConsents("f", "p", "call-1", "call_recording")).rejects.toMatchObject({ status: 503 });
});
it("puts person_id in the hashed, encrypted envelope so identity reassignment on replay conflicts", async () => {
  rpc.mockResolvedValue({ data: {}, error: null });
  const store = providerStore();
  await store.ingest(event);
  await store.ingest(event);
  await store.ingest({ ...event, personId: "p2" });
  const [a, b, c] = rpc.mock.calls.map((x) => x[1]);
  expect(a.p_payload_hash).toBe(b.p_payload_hash);
  expect(c.p_payload_hash).not.toBe(a.p_payload_hash);
  expect(c.p_metadata.person_id).toBe("p2");
  expect(JSON.parse(decryptWebhook(c.p_payload_ciphertext, KEY, `sarvam:${event.id}`).toString()).person_id).toBe("p2");
});
it("puts call and consent IDs and the review flag in metadata as IDs and enums only", async () => {
  rpc.mockResolvedValue({ data: {}, error: null });
  await providerStore().ingest({ ...event, callId: "call-1", consentId: "consent-1" });
  await providerStore().ingest({ ...event, review: "consent_missing" });
  expect(rpc.mock.calls[0][1].p_metadata).toEqual({ person_id: "p", status: "connected", call_id: "call-1", consent_id: "consent-1" });
  expect(rpc.mock.calls[1][1].p_metadata).toEqual({ person_id: "p", status: "connected", review: "consent_missing" });
  const other = rpc.mock.calls[0][1].p_payload_hash;
  expect(other).not.toBe(rpc.mock.calls[1][1].p_payload_hash);
});