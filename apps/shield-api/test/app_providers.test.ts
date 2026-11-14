import { encryptWebhook, identityHash } from "@sahaj/adapters";
import { contactContext } from "../src/ports/contacts";
import { describe, it, expect, vi } from "vitest";
import type { Sql } from "postgres";
import { createPushPort } from "../src/ports/push";
import { createCallsPort } from "../src/ports/calls";
const F = "11111111-1111-4111-8111-111111111111",
  P = "22222222-2222-4222-8222-222222222221",
  V = "55555555-5555-4555-8555-555555555551";
function fakeSql(phone: string | null = "+919000000001") {
  const claims = new Set<string>(),
    writes: { query: string; values: unknown[] }[] = [];
  const fn = vi.fn(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      writes.push({ query, values });
      if (query.includes("select distinct t.expo_token"))
        return [{ expo_token: "ExpoPushToken[synthetic]" }];
      if (query.includes("public.provider_identities")) {
        if (!phone) return [];
        const row = { family_id: F, person_id: P, source: "sarvam", account_id: "checkin",
          external_id_hash: identityHash("sarvam", "checkin", phone.slice(1), env.IDENTITY_HASH_SECRET) };
        return [{ ...row, contact_ciphertext: encryptWebhook(Buffer.from(phone), env.WEBHOOK_ENCRYPTION_KEY, contactContext(row)) }];
      }
      if (query.includes("returning id")) {
        const key = String(values[4]);
        if (claims.has(key)) return [];
        claims.add(key);
        return [{ id: "receipt-" + claims.size }];
      }
      return [];
    },
  );
  Object.assign(fn, { json: (x: unknown) => x });
  return { sql: fn as unknown as Sql, writes };
}
const card = {
  verdictId: V,
  familyId: F,
  parentId: P,
  quiet: false,
  push: true as const,
  offer1930: false,
  verdict: {
    level: "red" as const,
    scam_type: "kyc_block" as const,
    reasons: [{ rule_id: "x", en: "Share OTP 123456", hi: "Code 123456" }],
    checks_fired: [],
    ai_used: false,
    models_agreed: [],
    confidence: 1,
    actions: ["alert_child" as const],
  },
};
const env = {
  WEBHOOK_ENCRYPTION_KEY: "19".repeat(32),
  IDENTITY_HASH_SECRET: "synthetic-identity-hash-secret-32-chars",
  SARVAM_OUTBOUND_ENABLED: "1",
  SARVAM_API_KEY: "fake-key",
  SARVAM_ORG_ID: "org",
  SARVAM_WORKSPACE_ID: "workspace",
  SARVAM_AGENT_ID_CHECKIN: "checkin",
  SARVAM_AGENT_ID_CALLBACK: "callback",
  SARVAM_AGENT_ID_RESPONDER: "responder",
  SARVAM_CONNECTION_ID: "connection",
  SARVAM_AGENT_PHONE_NUMBER: "+919000000002",
  SARVAM_WEBHOOK_URL: "https://synthetic.example/webhook",
};
describe("app real-provider ports (mock fetch only)", () => {
  it("Expo missing env stays in outbox", async () => {
    const { sql, writes } = fakeSql();
    const fetchFn = vi.fn();
    await createPushPort(sql, {}, fetchFn).childCard(card);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(writes[0]!.query).toContain("dev_outbox");
  });
  it("Expo sends masked, high priority red to stored child tokens once", async () => {
    const { sql } = fakeSql();
    const fetchFn = vi.fn(async () =>
      Response.json({ data: { status: "ok", id: "ticket" } }),
    );
    const port = createPushPort(sql, { EXPO_PUSH_ENABLED: "1" }, fetchFn);
    await port.childCard(card);
    await port.childCard(card);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const args = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(args[0]).toBe("https://exp.host/--/api/v2/push/send");
    const body = JSON.parse(args[1].body as string);
    expect(body.priority).toBe("high");
    expect(body.body).not.toContain("123456");
  });
  it("yellow Expo stays quiet", async () => {
    const { sql } = fakeSql();
    const fetchFn = vi.fn(async () =>
      Response.json({ data: { status: "ok", id: "ticket" } }),
    );
    await createPushPort(sql, { EXPO_PUSH_ENABLED: "1" }, fetchFn).childCard({
      ...card,
      quiet: true,
      verdict: { ...card.verdict, level: "yellow" },
    });
    const body = JSON.parse(
      (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.sound).toBeNull();
    expect(body.priority).toBe("normal");
  });
  it("Expo handles ticket error and unregisters invalid destination", async () => {
    const { sql, writes } = fakeSql();
    const fetchFn = vi.fn(async () =>
      Response.json({
        data: { status: "error", details: { error: "DeviceNotRegistered" } },
      }),
    );
    await createPushPort(sql, { EXPO_PUSH_ENABLED: "1" }, fetchFn).childCard(
      card,
    );
    expect(
      writes.some((x) =>
        x.query.includes("delete from public.app_push_tokens"),
      ),
    ).toBe(true);
    expect(
      writes.find((x) => x.query.includes("update public.dev_outbox"))?.values,
    ).toContainEqual({ delivery: "failed" });
  });
  it("Expo network uncertainty is recorded without raw error", async () => {
    const { sql, writes } = fakeSql();
    const fetchFn = vi.fn(async () => {
      throw new Error("SECRET raw text");
    });
    await createPushPort(sql, { EXPO_PUSH_ENABLED: "1" }, fetchFn).childCard(
      card,
    );
    expect(JSON.stringify(writes)).not.toContain("SECRET");
    expect(JSON.stringify(writes)).toContain("unknown");
  });
  it("Sarvam missing env stays in outbox and never pretends answered", async () => {
    const { sql } = fakeSql();
    const fetchFn = vi.fn();
    expect(
      await createCallsPort(sql, {}, fetchFn).callParent({
        familyId: F,
        parentId: P,
        lineId: "line",
        verdictId: V,
        attempt: 1,
      }),
    ).toEqual({ status: "no_answer" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("all three Sarvam purposes follow official shape; no private digits in agent variables", async () => {
    const { sql, writes } = fakeSql();
    const fetchFn = vi.fn(async () => Response.json({ attempt_id: "attempt" }));
    const port = createCallsPort(sql, env, fetchFn);
    await port.callParent({
      familyId: F,
      parentId: P,
      lineId: "line",
      verdictId: V,
      attempt: 1,
    });
    await port.startResponderCall({ familyId: F, toPersonId: P, checkId: V });
    await port.startCallback({
      familyId: F,
      parentId: P,
      line: "Never share 123456 or +919000000001",
    });
    expect(fetchFn).toHaveBeenCalledTimes(3);
    const payloads = fetchFn.mock.calls.map((c) =>
      JSON.parse((c as unknown as [string, RequestInit])[1].body as string),
    );
    expect(payloads.map((x) => x.app_config.app_id)).toEqual([
      "checkin",
      "responder",
      "callback",
    ]);
    for (const payload of payloads) {
      expect(payload.user_config.user_phone_number).toBe("+919000000001");
      expect(payload.app_config.connection_config.connection_id).toBe(
        "connection",
      );
      expect(payload.webhook_config.url).toBe(env.SARVAM_WEBHOOK_URL);
      // Ids (UUIDs) are allowed; phone numbers, OTPs and any other 4+ digit run are not.
      const vars = payload.app_config.agent_variables;
      expect(vars.family_id).toBe(F);
      expect(JSON.stringify(vars).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")).not.toMatch(
        /\d{4}/,
      );
      expect(payload.app_config.app_overrides.initial_bot_message).toContain(
        "AI",
      );
    }
    expect(
      JSON.stringify(
        writes.filter(
          (x) => x.query.includes("insert") || x.query.includes("update"),
        ),
      ),
    ).not.toContain("+919000000001");
  });
  it("Sarvam does not redial a duplicate attempt", async () => {
    const { sql } = fakeSql();
    const fetchFn = vi.fn(async () => Response.json({ attempt_id: "attempt" }));
    const port = createCallsPort(sql, env, fetchFn);
    const input = { familyId: F, toPersonId: P, checkId: V };
    await port.startResponderCall(input);
    await port.startResponderCall(input);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
  it("Sarvam invalid destination never sends", async () => {
    const { sql } = fakeSql(null);
    const fetchFn = vi.fn();
    await createCallsPort(sql, env, fetchFn).startResponderCall({
      familyId: F,
      toPersonId: P,
      checkId: V,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("Sarvam rejected/uncertain requests are recorded safely", async () => {
    for (const mode of ["reject", "timeout"]) {
      const { sql, writes } = fakeSql();
      const fetchFn = vi.fn(async () => {
        if (mode === "timeout") throw new Error("RAW_PRIVATE");
        return Response.json({ error: "PRIVATE" }, { status: 422 });
      });
      await createCallsPort(sql, env, fetchFn).startResponderCall({
        familyId: F,
        toPersonId: P,
        checkId: V,
      });
      expect(JSON.stringify(writes)).not.toContain("PRIVATE");
      expect(JSON.stringify(writes)).toContain(
        mode === "reject" ? "failed" : "unknown",
      );
    }
  });
  it("busy-watch retry: real check-in call carries webhook metadata; not configured → not placed, no outbox row", async () => {
    const { sql } = fakeSql();
    const fetchFn = vi.fn(async () => Response.json({ attempt_id: "attempt" }));
    const placed = await createCallsPort(sql, env, fetchFn).placeCheckinRetry({ familyId: F, parentId: P, streakId: V, jobId: "job-1" });
    expect(placed).toEqual({ placed: true });
    const payload = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(payload.app_config.app_id).toBe("checkin");
    expect(payload.webhook_config.metadata).toMatchObject({ family_id: F, person_id: P, purpose: "checkin", in_checkin_window: true, streak_id: V });

    const off = fakeSql();
    const offFetch = vi.fn();
    expect(await createCallsPort(off.sql, {}, offFetch as never).placeCheckinRetry({ familyId: F, parentId: P, streakId: V, jobId: "job-2" }))
      .toEqual({ placed: false });
    expect(offFetch).not.toHaveBeenCalled();
    expect(off.writes.filter(w => w.query.includes("insert"))).toHaveLength(0);
  });
  it("Sarvam agents get the context their prompts read: responder @incident_id, drill script, @callback_line", async () => {
    const { sql } = fakeSql();
    const fetchFn = vi.fn(async () => Response.json({ attempt_id: "attempt" }));
    const port = createCallsPort(sql, { ...env, SARVAM_AGENT_ID_EXPERIENCE: "experience" }, fetchFn);
    await port.startResponderCall({ familyId: F, toPersonId: P, checkId: V });
    await port.startResponderCall({ familyId: F, toPersonId: P, checkId: "exp.kyc.1", purpose: "experience_drill",
      script: { id: "kyc", opening_hi: "Namaste ji", ask_hi: "KYC update karna hai", nudge_hi: "Jaldi kijiye" } });
    await port.startCallback({ familyId: F, parentId: P, line: "Ye Rohit nahi tha" });
    const bodies = fetchFn.mock.calls.map(c => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0].app_config.agent_variables).toMatchObject({ incident_id: V, family_id: F, person_id: P });
    expect(bodies[1].app_config.app_id).toBe("experience");
    expect(bodies[1].app_config.agent_variables).toMatchObject({ drill_id: "exp.kyc.1", opening: "Namaste ji", ask: "KYC update karna hai", nudge: "Jaldi kijiye" });
    expect(bodies[2].app_config.agent_variables).toMatchObject({ callback_line: "Ye Rohit nahi tha", line: "Ye Rohit nahi tha", parent_id: P });
  });
});
