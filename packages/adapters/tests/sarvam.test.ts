import { describe, expect, it } from "vitest";
import { createSarvamOutboundCall, getSarvamRecording, parseSarvamInboundWebhook, parseSarvamOutboundWebhook, type SarvamOutboundDeps } from "../src/sarvam";
import { AI_DISCLOSURE } from "../src/audio";
import { PHONE, MemoryLedger, code, hang, json, req, scripted, KEY } from "./helpers";

const base = (transport: SarvamOutboundDeps["transport"], ledger = new MemoryLedger()): SarvamOutboundDeps => ({
  transport, ledger, apiKey: "synthetic-key", orgId: "org1", workspaceId: "ws1", appId: "app-1", appVersion: 2,
  connectionId: "conn-1", agentPhoneNumber: "+918000000000", webhookUrl: "https://api.example.test/api/sarvam/outbound", timeoutMs: 30,
});
const call = (over = {}) => req("sarvam.outbound_call", { userPhoneNumber: PHONE, ...over });

describe("createSarvamOutboundCall", () => {
  it("sends the documented body, discloses AI and records the dispatch", async () => {
    const t = scripted(json({ attempt_id: "att-1" }));
    const deps = base(t.transport);
    const res = await createSarvamOutboundCall(deps, call());
    expect(res.data.attemptId).toBe("att-1");
    expect(t.calls[0]!.url).toBe("https://apps.sarvam.ai/api/outbounds/v1/orgs/org1/workspaces/ws1/outbounds");
    const body = JSON.parse(t.calls[0]!.init.body as string);
    expect(body.app_config.connection_config).toEqual({ connection_id: "conn-1", agent_phone_number: "+918000000000" });
    expect(body.app_config.app_overrides.initial_bot_message).toBe(AI_DISCLOSURE.Hindi);
    expect(body.user_config.user_phone_number).toBe(PHONE);
    expect(body.webhook_config.metadata).toEqual({ idempotency_key: KEY });
    expect((t.calls[0]!.init.headers as Record<string, string>)["X-API-Key"]).toBe("synthetic-key");
    expect((deps.ledger as MemoryLedger).state.get(KEY)).toBe("dispatched:att-1");
  });
  it("always keeps the AI disclosure in front of custom text", async () => {
    const t = scripted(json({ attempt_id: "a" }));
    await createSarvamOutboundCall(base(t.transport), call({ openingMessage: "दवाई का समय है", language: "Hindi" }));
    expect(JSON.parse(t.calls[0]!.init.body as string).app_config.app_overrides.initial_bot_message.startsWith(AI_DISCLOSURE.Hindi)).toBe(true);
  });
  it("makes no network call without a valid authorization", async () => {
    const t = scripted();
    for (const bad of [{ decision: "ask" }, { consent: false }, { action: "x" }, { idempotencyKey: "other" }, { expiresAt: 1 }, { personId: "p2" }] as const) {
      const r = call(); r.authorization = { ...r.authorization, ...bad };
      expect(await code(createSarvamOutboundCall(base(t.transport), r))).toBe("authorization_denied");
    }
    expect(t.calls).toHaveLength(0);
  });
  it("rejects bad numbers before claiming", async () => {
    const ledger = new MemoryLedger(); const t = scripted();
    expect(await code(createSarvamOutboundCall(base(t.transport, ledger), call({ userPhoneNumber: "9000000001" })))).toBe("invalid_payload");
    expect(ledger.claims.size).toBe(0);
  });
  it("refuses a duplicate dispatch", async () => {
    const ledger = new MemoryLedger(); const t = scripted(json({ attempt_id: "a" }));
    await createSarvamOutboundCall(base(t.transport, ledger), call());
    expect(await code(createSarvamOutboundCall(base(t.transport, ledger), call()))).toBe("duplicate_dispatch");
    expect(t.calls).toHaveLength(1);
  });
  it("timeout is delivery_unknown, is recorded, and is not retried", async () => {
    const ledger = new MemoryLedger(); const t = scripted(hang());
    expect(await code(createSarvamOutboundCall(base(t.transport, ledger), call()))).toBe("delivery_unknown");
    expect(ledger.state.get(KEY)).toBe("unknown");
    expect(t.calls).toHaveLength(1);
    expect(await code(createSarvamOutboundCall(base(t.transport, ledger), call()))).toBe("duplicate_dispatch");
  });
  it("5xx and a 2xx without attempt_id are delivery_unknown; 422 is a clean failure", async () => {
    const l1 = new MemoryLedger(), l2 = new MemoryLedger(), l3 = new MemoryLedger();
    expect(await code(createSarvamOutboundCall(base(scripted(json({}, 503)).transport, l1), call()))).toBe("delivery_unknown");
    expect(await code(createSarvamOutboundCall(base(scripted(json({ nope: 1 })).transport, l2), call()))).toBe("delivery_unknown");
    expect(await code(createSarvamOutboundCall(base(scripted(json({ detail: [] }, 422)).transport, l3), call()))).toBe("provider_rejected");
    expect([l1, l2, l3].map((l) => l.state.get(KEY))).toEqual(["unknown", "unknown", "failed"]);
  });
  it("errors never leak the key, phone or response body", async () => {
    try { await createSarvamOutboundCall(base(scripted(json({ detail: PHONE }, 422)).transport), call()); } catch (e) {
      expect(JSON.stringify(e) + String(e)).not.toMatch(/synthetic-key|9000000001/);
    }
  });
});

describe("getSarvamRecording", () => {
  const rr = (over = {}) => req("sarvam.recording.read", { appId: "app-1", interactionId: "20260828/abc-123", ...over });
  const cfg = (t: ReturnType<typeof scripted>) => ({ transport: t.transport, apiKey: "synthetic-key", orgId: "org1", workspaceId: "ws1", timeoutMs: 30 });
  const wav = (n = 8, status = 200, type = "audio/wav") => new Response(new Uint8Array(n), { status, headers: { "content-type": type } });
  it("downloads WAV with the interaction id path-encoded", async () => {
    const t = scripted(wav());
    const res = await getSarvamRecording(cfg(t), rr());
    expect(res.data.audio.byteLength).toBe(8);
    expect(t.calls[0]!.url).toBe("https://apps.sarvam.ai/api/analytics/v1/org1/ws1/app-1/recordings/20260828%2Fabc-123");
  });
  it("rejects malformed ids without calling out", async () => {
    const t = scripted();
    for (const id of ["abc", "2026/abc", "20260828/../x", "20260828/a b"]) expect(await code(getSarvamRecording(cfg(t), rr({ interactionId: id })))).toBe("invalid_payload");
    expect(t.calls).toHaveLength(0);
  });
  it("enforces size cap, content type and 404", async () => {
    expect(await code(getSarvamRecording(cfg(scripted(wav(100))), rr(), { maxBytes: 10 }))).toBe("payload_too_large");
    expect(await code(getSarvamRecording(cfg(scripted(wav(8, 200, "text/html"))), rr()))).toBe("provider_rejected");
    expect(await code(getSarvamRecording(cfg(scripted(json({ detail: "x" }, 404))), rr()))).toBe("provider_rejected");
  });
  it("is gated by authorization and reports timeouts as unavailable", async () => {
    const t = scripted();
    const r = rr(); r.authorization = { ...r.authorization, action: "sarvam.outbound_call" };
    expect(await code(getSarvamRecording(cfg(t), r))).toBe("authorization_denied");
    expect(await code(getSarvamRecording(cfg(scripted(hang())), rr()))).toBe("provider_unavailable");
  });
});

describe("outbound webhook parser", () => {
  const stored = { attemptId: "att-1", appId: "app-1", agentPhoneNumber: "+918000000000" };
  const payload = (over: Record<string, unknown> = {}) => ({
    attempt_id: "att-1", status: "connected", channel_info: { channel_type: "v2v", channel_provider: "exotel", agent_phone_number: "+918000000000" },
    app_id: "app-1", app_version: 2, duration: 16.8, interaction_id: "20250920/1ae056a30013510b66a6a0", failure_reason: null,
    final_agent_variables: { secret_health_note: "x" }, webhook_config: { url: "https://x.test", metadata: { idempotency_key: KEY } },
    interaction_transcript: [{ role: "user", en_text: "my sugar is high" }], ...over,
  });
  it("accepts a matching connected callback and drops transcript and variables", () => {
    const ev = parseSarvamOutboundWebhook(payload(), stored);
    expect(ev).toMatchObject({ status: "connected", attemptId: "att-1", durationSeconds: 16.8, idempotencyKey: KEY });
    expect(JSON.stringify(ev)).not.toMatch(/sugar|secret_health_note/);
  });
  it("accepts no_answer / busy / failed with null fields", () => {
    for (const status of ["no_answer", "busy", "failed"]) {
      expect(parseSarvamOutboundWebhook(payload({ status, duration: null, interaction_id: null, failure_reason: status === "failed" ? "exotel: x" : null }), stored).status).toBe(status);
    }
  });
  it("fails closed on unknown attempt, other app, or other agent number", () => {
    expect(() => parseSarvamOutboundWebhook(payload(), null)).toThrow(/unknown_identity/);
    expect(() => parseSarvamOutboundWebhook(payload({ attempt_id: "att-2" }), stored)).toThrow(/unknown_identity/);
    expect(() => parseSarvamOutboundWebhook(payload({ app_id: "app-9" }), stored)).toThrow(/unknown_identity/);
    expect(() => parseSarvamOutboundWebhook(payload({ channel_info: { agent_phone_number: "+918000000009" } }), stored)).toThrow(/unknown_identity/);
  });
  it("rejects malformed payloads", () => {
    for (const bad of [null, [], "x", {}, payload({ status: "weird" }), payload({ duration: -1 }), payload({ interaction_id: "../x" }), payload({ app_version: "2" }), payload({ channel_info: null })]) {
      expect(() => parseSarvamOutboundWebhook(bad, stored)).toThrow(/invalid_payload|unknown_identity/);
    }
  });
  it("an inbound-shaped payload is not accepted as outbound", () => {
    expect(() => parseSarvamOutboundWebhook({ app_id: "app-1", interaction_id: "20260828/x", deployment_id: "d", user_phone_number: PHONE, agent_phone_number: "+918000000000" }, stored)).toThrow();
  });
});

describe("inbound webhook parser", () => {
  const dep = { deploymentId: "dep-1", appId: "app-1", agentPhoneNumber: "+918000000000" };
  const payload = (over: Record<string, unknown> = {}) => ({
    app_id: "app-1", app_version: 3, deployment_id: "dep-1", interaction_id: "20260828/8448d531-12:47:17-0f1a2cb7",
    user_phone_number: PHONE, agent_phone_number: "+918000000000", duration: 51.58, start_datetime: "2026-08-28T07:16:25Z", end_datetime: "2026-08-28T07:17:17Z",
    interaction_transcript: [{ role: "user", en_text: "private" }], metadata: { a: 1 }, ...over,
  });
  const known = (e164: string) => (e164 === PHONE ? { personId: "p1" } : null);
  it("accepts the configured deployment and a registered caller", async () => {
    const ev = await parseSarvamInboundWebhook(payload(), dep, known);
    expect(ev).toMatchObject({ personId: "p1", deploymentId: "dep-1", durationSeconds: 51.58 });
    expect(JSON.stringify(ev)).not.toContain("private");
  });
  it("fails closed for unknown caller, deployment, app or agent number", async () => {
    for (const bad of [payload({ user_phone_number: "+919000000099" }), payload({ deployment_id: "d2" }), payload({ app_id: "a2" }), payload({ agent_phone_number: "+918000000001" })]) {
      expect(await code(parseSarvamInboundWebhook(bad, dep, known))).toBe("unknown_identity");
    }
  });
  it("rejects malformed payloads and an outbound-shaped body", async () => {
    for (const bad of [null, {}, payload({ interaction_id: "nope" }), payload({ duration: "x" }), payload({ user_phone_number: "123" })]) {
      expect(await code(parseSarvamInboundWebhook(bad, dep, known))).toBe("invalid_payload");
    }
    expect(await code(parseSarvamInboundWebhook({ attempt_id: "att-1", status: "connected", app_id: "app-1" }, dep, known))).toBe("invalid_payload");
  });
});
