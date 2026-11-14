import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../../src/lib/database", () => ({ serviceDatabase: () => ({ rpc }) }));
import { POST } from "../../src/app/api/cron/tick/route";
import { phase2Entrypoints } from "../../src/lib/atlas-runtime/phase2-modules";

const req = (secret: string | null) => new Request("http://x/api/cron/tick", { method: "POST", headers: secret ? { "x-cron-secret": secret } : {} });
const SECRET = "s".repeat(40);
beforeEach(() => { vi.stubEnv("CRON_SECRET", SECRET); });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("rejects missing or wrong secrets before touching the database", async () => {
  expect((await POST(req(null))).status).toBe(401);
  expect((await POST(req("wrong"))).status).toBe(401);
  expect(rpc).not.toHaveBeenCalled();
});
it("routes durable events, dead-letters unknown types, and reports no care actions without Atlas config", async () => {
  rpc.mockImplementation(async (name: string) => name === "claim_raw_events"
    ? { data: [{ id: "1", event_type: "whatsapp.text", lease_token: "t" }, { id: "2", event_type: "unknown.kind", lease_token: "t" }], error: null }
    : { data: null, error: null });
  const res = await POST(req(SECRET));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ dispatched: 1, deadLettered: 1, failed: 0, care_actions_run: 0, workflow: { status: "not_configured" } });
  expect(rpc.mock.calls.map(c => c[0])).toEqual(["claim_raw_events", "dispatch_raw_event", "dead_letter_raw_event"]);
  expect(rpc.mock.calls[1][1]).toMatchObject({ p_workflow_kind: "core1.atlas" });
});
it("enable flags alone never configure dispatch; purge is unavailable without the seam and fails closed with it", async () => {
  for (const n of ["PROVIDER_DISPATCH_ENABLED", "RECORDING_PURGE_ENABLED", "RECORDING_RETRIEVAL_ENABLED", "SARVAM_OUTBOUND_ENABLED"]) vi.stubEnv(n, "true");
  rpc.mockImplementation(async (name: string) => name === "claim_raw_events" ? { data: [], error: null } : { data: null, error: null });
  const body = await (await POST(req(SECRET))).json();
  // Dispatch needs contact key, identity secret and complete provider config, none of which are set here.
  expect(body.providers.dispatch).toEqual({ status: "unavailable" }); expect(body.providers.recording).toBe("unavailable");
  if (!phase2Entrypoints) {
    expect(body.providers).toMatchObject({ purge: { status: "unavailable" }, status: "unavailable" });
    expect(body.providers.unavailable[0]).toBe("phase2_entrypoints");
    expect(rpc.mock.calls.map(c => c[0])).toEqual(["claim_raw_events"]); // nothing claimed, listed or deleted
  } else {
    // Combined tree: purge runs, the (mocked) store returns no candidate list, and the tick reports failed. No deletion.
    expect(body.providers.purge).toEqual({ status: "failed" });
    expect(rpc.mock.calls.map(c => c[0])).toEqual(["claim_raw_events", "list_recording_purge_candidates"]);
  }
  for (const p of body.providers.unavailable) expect(p).toMatch(/^([A-Z0-9_]+:(missing|invalid)|[a-z0-9_]+)$/); // names only, never values
});
it("returns 503 when any event cannot be dispatched so the failure is visible", async () => {
  rpc.mockImplementation(async (name: string) => name === "claim_raw_events"
    ? { data: [{ id: "1", event_type: "whatsapp.text", lease_token: "t" }], error: null }
    : name === "dispatch_raw_event" ? { data: null, error: { code: "40001" } } : { data: null, error: null });
  expect((await POST(req(SECRET))).status).toBe(503);
});
it("honours the maintenance kill switch", async () => {
  vi.stubEnv("MAINTENANCE_KILL", "true");
  expect((await POST(req(SECRET))).status).toBe(503);
  expect(rpc).not.toHaveBeenCalled();
});
