import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../../src/lib/database", () => ({ serviceDatabase: () => ({ rpc }) }));
import { POST } from "../../src/app/api/cron/tick/route";

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
