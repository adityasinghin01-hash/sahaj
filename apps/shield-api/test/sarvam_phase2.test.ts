import { describe, expect, it, vi } from "vitest";
import type { ShieldApp } from "@/lib/app";
import { createCheckinVarsHandler, createSarvamWebhookHandler, parseSarvamStatus } from "@/lib/sarvam_phase2";

const SECRET = "w".repeat(40);
const TOOL = "t".repeat(40);
const FAMILY = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";

function fakeApp(overrides: Partial<ShieldApp> = {}) {
  const recordBusyCallStatus = vi.fn(async (input: { family_id: string; parent_id: string }) => ({
    ok: true as const, family_id: input.family_id, parent_id: input.parent_id, at: new Date().toISOString(),
    result: { streak: "started" as const, streakId: "s-1", retryScheduled: true, alerted: false },
  }));
  const getWeeklyTip = vi.fn(async (input: { family_id: string }) => ({
    ok: true as const, family_id: input.family_id, as_of: "2026-11-14T13:00:00.000Z", simulated_checkin: true as const,
    note: "n", tip: { fraud_tip_hi: "KYC ke naam par link mat kholiye", fraud_tip_en: "Do not open KYC links" },
  }));
  const app = { env: { SARVAM_WEBHOOK_SECRET: SECRET, SARVAM_TOOL_TOKEN: TOOL }, recordBusyCallStatus, getWeeklyTip, ...overrides };
  return { app: app as unknown as ShieldApp, recordBusyCallStatus, getWeeklyTip };
}

const webhook = (body: unknown, secret = SECRET) => new Request(`http://x/api/sarvam/webhook/${secret}`, {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" },
});
const params = (secret = SECRET) => ({ params: Promise.resolve({ secret }) });
const checkinVars = { family_id: FAMILY, parent_id: PARENT, purpose: "checkin", in_checkin_window: "true" };

describe("Sarvam call-status webhook → busy-line watch (Phase 2 step 2.4)", () => {
  it("records a busy check-in result for the parent named in our own agent variables", async () => {
    const { app, recordBusyCallStatus } = fakeApp();
    const res = await createSarvamWebhookHandler(() => app)(webhook({ status: "busy", agent_variables: checkinVars }), params());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, streak: "started" });
    expect(recordBusyCallStatus).toHaveBeenCalledWith(expect.objectContaining({
      family_id: FAMILY, parent_id: PARENT, status: "busy", in_checkin_window: true }));
  });

  it("accepts status aliases and nested data", async () => {
    expect(parseSarvamStatus({ data: { call_status: "no-answer", agent_variables: checkinVars } })?.status).toBe("no_answer");
    expect(parseSarvamStatus({ status: "completed", agent_variables: checkinVars })?.status).toBe("connected");
  });

  it("wrong secret → 401 and nothing recorded", async () => {
    const { app, recordBusyCallStatus } = fakeApp();
    const res = await createSarvamWebhookHandler(() => app)(webhook({ status: "busy", agent_variables: checkinVars }, "x".repeat(40)), params("x".repeat(40)));
    expect(res.status).toBe(401);
    expect(recordBusyCallStatus).not.toHaveBeenCalled();
  });

  it("missing or short server secret → 500, accepts nothing", async () => {
    const { app, recordBusyCallStatus } = fakeApp({ env: { SARVAM_WEBHOOK_SECRET: "short" } } as Partial<ShieldApp>);
    const res = await createSarvamWebhookHandler(() => app)(webhook({ status: "busy", agent_variables: checkinVars }, "short"), params("short"));
    expect(res.status).toBe(500);
    expect(recordBusyCallStatus).not.toHaveBeenCalled();
  });

  it("non-check-in calls and unknown shapes are acknowledged but not recorded", async () => {
    const { app, recordBusyCallStatus } = fakeApp();
    const handler = createSarvamWebhookHandler(() => app);
    expect(await (await handler(webhook({ status: "busy", agent_variables: { ...checkinVars, purpose: "responder" } }), params())).json())
      .toMatchObject({ ignored: "not_checkin" });
    expect(await (await handler(webhook({ status: "weird", agent_variables: checkinVars }), params())).json())
      .toMatchObject({ ignored: "unrecognised_payload" });
    expect(await (await handler(webhook({ status: "busy", agent_variables: { ...checkinVars, family_id: "not-a-uuid" } }), params())).json())
      .toMatchObject({ ignored: "unrecognised_payload" });
    expect((await handler(webhook("{bad json"), params())).status).toBe(400);
    expect(recordBusyCallStatus).not.toHaveBeenCalled();
  });

  it("a parent that is not in the family is ignored (cross-check)", async () => {
    const { app } = fakeApp({ recordBusyCallStatus: vi.fn(async () => ({ ok: false as const, status: 404 as const, error: "parent_not_found" as const })) });
    const res = await createSarvamWebhookHandler(() => app)(webhook({ status: "busy", agent_variables: checkinVars }), params());
    expect(await res.json()).toMatchObject({ ok: true, ignored: "parent_not_found" });
  });
});

describe("check-in variables → weekly fraud tip (Phase 2 step 2.5)", () => {
  const get = (family: string, token = TOOL) => new Request(`http://x/api/sarvam/checkin-vars?family_id=${family}`, {
    headers: { authorization: `Bearer ${token}` } });

  it("returns the tip lines the check-in agent speaks", async () => {
    const { app } = fakeApp();
    const res = await createCheckinVarsHandler(() => app)(get(FAMILY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ fraud_tip_hi: "KYC ke naam par link mat kholiye", fraud_tip_en: "Do not open KYC links" });
  });

  it("bad token → 401; bad family id → 400; unknown family → 404", async () => {
    const { app } = fakeApp();
    expect((await createCheckinVarsHandler(() => app)(get(FAMILY, "nope"))).status).toBe(401);
    expect((await createCheckinVarsHandler(() => app)(get("nope"))).status).toBe(400);
    const missing = fakeApp({ getWeeklyTip: vi.fn(async () => ({ ok: false as const, status: 404 as const, error: "family_not_found" as const })) });
    expect((await createCheckinVarsHandler(() => missing.app)(get(FAMILY))).status).toBe(404);
  });
});
