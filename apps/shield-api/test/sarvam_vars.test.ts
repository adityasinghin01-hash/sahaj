import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { createCallsPort } from "@/ports/calls";
import { createSarvamStartHandler, createPgSarvamStartStore } from "@/lib/sarvam_start";
import { contactSenderHash } from "@/ports/contacts";

vi.mock("@/ports/contacts", async importOriginal => ({
  ...await importOriginal<typeof import("@/ports/contacts")>(),
  createContactsPort: () => ({ resolve: async () => "+919000000001" }),
}));
const F = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333", C = "44444444-4444-4444-8444-444444444444";
const env = { SARVAM_API_KEY: "fake", SARVAM_ORG_ID: "org", SARVAM_WORKSPACE_ID: "workspace",
  SARVAM_AGENT_ID_CHECKIN: "checkin", SARVAM_AGENT_ID_RESPONDER: "responder", SARVAM_AGENT_ID_CALLBACK: "callback",
  SARVAM_AGENT_PHONE_NUMBER: "+919000000002", SARVAM_CONNECTION_ID: "connection", SARVAM_WEBHOOK_URL: "https://example.test/hook",
  SARVAM_OUTBOUND_ENABLED: "1", SARVAM_TOOL_TOKEN: "test-token", ALLOW_ANY_TOOL_IP: "1",
  DEFAULT_FAMILY_ID: F, DEFAULT_PARENT_ID: P, IDENTITY_HASH_SECRET: "synthetic-secret-at-least-32-characters", SARVAM_BRIDGE_TO: "riya-transfer" };
function sqlFake(check = true) {
  const queries: { text: string; values: unknown[] }[] = [];
  const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join("?"); queries.push({ text, values });
    if (text.includes("from public.family_checks")) return check ? [{ parent_id: P, responder_name: "Rohit १२३४५६", subject_name: "Meena", claimed_name: "Rohit" }] : [];
    if (text.includes("returning id")) return [{ id: "receipt" }];
    return [];
  }), { json: (v: unknown) => v });
  return { sql: sql as unknown as Sql, queries };
}
function callHarness(extraEnv = {}) {
  const db = sqlFake();
  const send = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ attempt_id: "attempt" }));
  return { ...db, send, calls: createCallsPort(db.sql, { ...env, ...extraEnv }, send as typeof fetch),
    body: () => JSON.parse(send.mock.calls[0]![1]!.body as string) };
}
describe("C-17 outbound prompt variables", () => {
  it("builds the responder card from the tenant/check/recipient binding; never uses the responder as parent", async () => {
    const h = callHarness();
    await h.calls.startResponderCall({ familyId: F, toPersonId: R, checkId: C });
    const vars = h.body().app_config.agent_variables;
    expect(vars).toMatchObject({ family_id: F, parent_id: P, purpose: "responder", responder_name: expect.stringContaining("Rohit"),
      subject_name: "Meena", incident_summary: expect.any(String), address_line: "", incident_id: C, is_danger: "no", bridge_to: "riya-transfer" });
    expect(vars.responder_name).not.toMatch(/\p{Nd}/u);
    expect(h.queries.find(q => q.text.includes("from public.family_checks"))!.values).toEqual(expect.arrayContaining([F, R, C]));
  });
  it("does not dial a missing or mismatched family check", async () => {
    const db = sqlFake(false), send = vi.fn();
    await createCallsPort(db.sql, env, send).startResponderCall({ familyId: F, toPersonId: R, checkId: C });
    expect(send).not.toHaveBeenCalled();
  });
  it("passes known callback identity and reason without inventing a missed count", async () => {
    const h = callHarness();
    await h.calls.startCallback({ familyId: F, parentId: P, line: "OTP १२३४५६ phone +919000000001", checkId: C });
    expect(h.body().app_config.agent_variables).toMatchObject({ callback_reason: "family_check_answer", check_id: C });
    expect(h.body().app_config.agent_variables).not.toHaveProperty("missed_count");
    expect(h.body().app_config.agent_variables.callback_line).not.toContain("123456");
  });
  it("passes a known missed-call count and reason", async () => {
    const h = callHarness();
    await h.calls.startCallback({ familyId: F, parentId: P, line: "Sab theek hai?", callbackReason: "missed_call", missedCount: 3 });
    expect(h.body().app_config.agent_variables).toMatchObject({ callback_reason: "missed_call", missed_count: "3" });
  });
  it.each([true, false])("experience agent configured=%s: sends script with an AI opening", async configured => {
    const h = callHarness(configured ? { SARVAM_AGENT_ID_EXPERIENCE: "experience" } : {});
    await h.calls.startResponderCall({ familyId: F, toPersonId: P, checkId: `exp.generic.${C}`, purpose: "experience_drill",
      script: { id: "generic", opening_hi: "Namaste ji", ask_hi: "Pay 123456", nudge_hi: "Nahi keh sakte hain" } });
    const body = h.body();
    expect(body.app_config.app_id).toBe(configured ? "experience" : "responder");
    expect(body.app_config.agent_variables).toMatchObject({ drill_id: `exp.generic.${C}`, opening: expect.stringContaining("AI awaaz"), ask: expect.any(String), nudge: "Nahi keh sakte hain" });
    expect(body.app_config.agent_variables.ask).not.toContain("123456");
  });
});
const profile = { address_form: "Meena ji १२३४५६", hearing_mode: true, consent_done: true, last_summary: "Call +919000000001 OTP 123456",
  open_requests: "Dawa 9999", pending_voice: "Riya 123456" };
function hookHarness(overrides: Record<string, string> = {}) {
  const store = { lookupCaller: vi.fn(async (_hash: string) => ({ familyId: F, parentId: P })),
    getParent: vi.fn(async (_f: string, _p: string) => profile) };
  const handler = createSarvamStartHandler(() => ({ env: { ...env, ...overrides },
    getWeeklyTip: async () => ({ ok: true, tip: { fraud_tip_hi: "OTP 123456 mat dena" } }) } as never), () => store);
  return { store, handler, request: (body: unknown = {}, token = "test-token", ip?: string) => handler(new Request("https://test/api/sarvam/hook/start", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(ip ? { "x-real-ip": ip } : {}) }, body: JSON.stringify(body),
  })) };
}
describe("C-17 inbound on-start hook", () => {
  it("resolves the caller by hash; returns exactly the prompt context with masked text and no phone", async () => {
    const h = hookHarness();
    const res = await h.request({ caller_number: "+919000000001", family_id: "forged" });
    expect(res.status).toBe(200);
    expect(h.store.lookupCaller).toHaveBeenCalledWith(contactSenderHash(env, "sarvam", "919000000001"));
    const data = await res.json();
    expect(Object.keys(data).sort()).toEqual(["family_id", "parent_id", "address_form", "greeting", "hearing_mode", "consent_done", "last_summary", "open_requests", "pending_voice", "fraud_tip", "bridge_to"].sort());
    expect(data).toMatchObject({ family_id: F, parent_id: P, greeting: "Namaste", hearing_mode: true, consent_done: true, bridge_to: "riya-transfer" });
    expect(JSON.stringify(data)).not.toMatch(/9000000001|123456|१२३४५६|9999/);
  });
  it("uses lab defaults only when no caller number is supplied", async () => {
    const h = hookHarness();
    expect((await h.request()).status).toBe(200);
    expect(h.store.lookupCaller).not.toHaveBeenCalled();
    expect(h.store.getParent).toHaveBeenCalledWith(F, P);
  });
  it("unknown caller never falls back to the lab family", async () => {
    const h = hookHarness(); h.store.lookupCaller.mockResolvedValue(null as never);
    expect((await h.request({ caller_number: "+919000000099" })).status).toBe(404);
    expect(h.store.getParent).not.toHaveBeenCalled();
  });
  it.each([null, "", "not-a-phone", 919000000001])("invalid caller %s cannot use defaults", async caller_number => {
    const h = hookHarness(); expect((await h.request({ caller_number })).status).toBe(400);
    expect(h.store.getParent).not.toHaveBeenCalled();
  });
  it("requires bearer and the same IP policy as tools before reading any caller", async () => {
    const h = hookHarness({ ALLOW_ANY_TOOL_IP: "0" });
    expect((await h.request({}, "wrong", "4.213.167.70")).status).toBe(401);
    expect((await h.request({}, "test-token", "192.0.2.1")).status).toBe(401);
    expect(h.store.lookupCaller).not.toHaveBeenCalled(); expect(h.store.getParent).not.toHaveBeenCalled();
  });
  it("missing lab defaults or missing parent fail closed", async () => {
    expect((await hookHarness({ DEFAULT_PARENT_ID: "" }).request()).status).toBe(400);
    const h = hookHarness(); h.store.getParent.mockResolvedValue(null as never);
    expect((await h.request()).status).toBe(404);
  });
  it("never echoes a numeric transfer target or a database error", async () => {
    const h = hookHarness({ SARVAM_BRIDGE_TO: "+919000000001" });
    expect((await (await h.request()).json()).bridge_to).toBe("");
    h.store.getParent.mockRejectedValue(new Error("phone +919000000001"));
    const response = await h.request(); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("9000000001");
  });
  it("hash lookup requires one active parent contact in the configured Sarvam account", async () => {
    const db = sqlFake(); const store = createPgSarvamStartStore(db.sql, env);
    expect(await store.lookupCaller("a".repeat(64))).toBeNull();
    const q = db.queries[0]!;
    expect(q.text).toContain("provider_identities"); expect(q.text).toContain("revoked_at is null");
    expect(q.text).toContain("'contact'"); expect(q.text).toContain("'parent'");
    expect(q.values).toContain("checkin"); expect(q.values).toContain("a".repeat(64));
  });
});
