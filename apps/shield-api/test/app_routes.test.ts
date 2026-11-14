import { createHmac } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  createAppHandler,
  type AppDependencies,
  type AppOperation,
} from "../src/lib/app_handlers";
import {
  verifyAppToken,
  requireAppMember,
  type AppMember,
} from "../src/lib/app_auth";
import { computeChainHash } from "../src/ports/sign";
import {
  decodeAlertCursor,
  encodeAlertCursor,
  verifyTimeline,
  type TimelineRecord,
} from "../src/lib/app_store";
import { readAppHarness } from "../src/lib/app_context";
const F = "11111111-1111-4111-8111-111111111111",
  U = "33333333-3333-4333-8333-333333333332",
  P = "22222222-2222-4222-8222-222222222221",
  V = "55555555-5555-4555-8555-555555555551";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secret = "test-only-app-jwt-secret-longer-than-32";
function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const b64 = (x: unknown) =>
    Buffer.from(JSON.stringify(x)).toString("base64url");
  const data = `${b64({ alg: "HS256", typ: "JWT", ...header })}.${b64({ sub: U, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}
function req(
  path = "",
  body?: unknown,
  access = token(),
  headers: Record<string, string> = {},
) {
  return new Request(`http://localhost/api/app/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "Idempotency-Key": "test-pair-request",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const member: AppMember = {
  family_id: F,
  user_id: U,
  person_id: P,
  role: "child",
};
const alert = {
  id: V,
  parent_id: P,
  created_at: "2026-11-14T00:00:00.000Z",
  level: "red" as const,
  scam_type: "kyc_block" as const,
  reasons: [{ rule_id: "x", en: "Fake request", hi: "Nakli request" }],
  checks_fired: ["pattern.P5"],
  masked_snippet: "Bank KYC <NUM>",
  channel: "device",
  child_feedback: null,
};
function fixture() {
  const entry = {
    familyId: F,
    parentId: P,
    eventKey: "test-key",
    step: "alert",
    status: "ok",
  };
  const row: TimelineRecord = {
    id: V,
    seq: "1",
    created_at: alert.created_at,
    step: "alert",
    status: "ok",
    entry,
    prev_hash: "0".repeat(64),
    hash: computeChainHash("0".repeat(64), entry),
    family_id: F,
  };
  const deps: AppDependencies = {
    app: {
      env: { SUPABASE_JWT_SECRET: secret },
      runtime: {
        scamSense: vi.fn(async () => ({
          score_out_of_5: 2.5,
          trend: "up",
          drills_this_month: 1,
        })),
        createPairingCode: vi.fn(async () => ({
          ok: true,
          code: "123456",
          expires_at: alert.created_at,
        })),
        buildEvidencePack: vi.fn(async () => ({
          summary_en: "Child-only original +919000000001",
          summary_hi: "Masked record",
          copy_for_1930: "For 1930",
          cybercrime_url: "https://cybercrime.gov.in",
          chain_hash: "hex-ap:" + "a".repeat(64),
          created_at: "Saturday, 14-Nov-26 00:00:00 GMT",
        })),
      } as unknown as AppDependencies["app"]["runtime"],
      recordChildFeedback: vi.fn(async () => ({
        ok: true,
        verdict_id: V,
        family_id: F,
        parent_id: P,
        feedback: "fraud",
        feedback_at: alert.created_at,
        repeated: false,
        result: {},
      })) as unknown as AppDependencies["app"]["recordChildFeedback"],
      recordBusyReply: vi.fn(async () => ({
        ok: true as const,
        streak_id: V,
        family_id: F,
        parent_id: P,
        replied: true,
      })),
    },
    store: {
      memberships: vi.fn(async () => [member]),
      devices: vi.fn(async () => []),
      parents: vi.fn(async () => [{ id: P, name: "Maa" }]),
      counts: vi.fn(async () => ({ checks_this_week: 1, frauds_stopped: 1 })),
      alerts: vi.fn(async () => [alert]),
      alert: vi.fn(async () => alert),
      timeline: vi.fn(async () => [row]),
      chain: vi.fn(async () => [row]),
      pushToken: vi.fn(async () => {}),
    },
    harness: vi.fn(async () => ({
      available: true,
      mode: "rules_only",
      summary: { scam_caught: 30 },
      ai: { executed: false },
    })),
  };
  return {
    deps,
    row,
    run: (op: AppOperation, request = req(), id = V) =>
      createAppHandler(op, () => deps)(request, id),
  };
}
describe("app JWT fail-closed authentication", () => {
  it.each([
    ["missing", "", 401],
    ["expired", token({ exp: 1 }), 401],
    ["wrong role", token({ role: "service_role" }), 401],
    ["no exp", token({ exp: undefined }), 401],
    ["no sub", token({ sub: undefined }), 401],
    ["future nbf", token({ nbf: Date.now() / 1000 + 1000 }), 401],
    ["wrong algorithm", token({}, { alg: "none" }), 401],
    ["bad signature", token().slice(0, -8) + "aaaaaaaa", 401],
  ] as const)("%s", async (_name, access, status) => {
    const { run } = fixture();
    expect((await run("summary", req("", undefined, access))).status).toBe(
      status,
    );
  });
  it("short secret is 500 before reading membership", async () => {
    const { deps, run } = fixture();
    deps.app.env = { SUPABASE_JWT_SECRET: "short" };
    expect((await run("summary")).status).toBe(500);
    expect(deps.store.memberships).not.toHaveBeenCalled();
  });
  it("accepts correct signature", () =>
    expect(verifyAppToken(req(), secret)).toBe(U));
  it("wrong family is 403, no reads", async () => {
    const { run, deps } = fixture();
    expect((await run("summary", req("?family_id=" + OTHER))).status).toBe(403);
    expect(deps.store.counts).not.toHaveBeenCalled();
  });
  it("unregistered subject is 403", async () => {
    const { deps, run } = fixture();
    deps.store.memberships = async () => [];
    expect((await run("summary")).status).toBe(403);
  });
  it("multi-family requires explicit choice", async () => {
    await expect(
      requireAppMember(req(), secret, async () => [
        member,
        { ...member, family_id: OTHER },
      ]),
    ).rejects.toMatchObject({ status: 403 });
  });
});
const bodies: Partial<Record<AppOperation, unknown>> = {
  feedback: { answer: "fraud" },
  pair: {},
  busy: { streak_id: V },
  drills: { parent_id: P, enabled: true },
  push: { expo_token: "ExpoPushToken[test-token]" },
};
describe("app routes", () => {
  it.each([
    "summary",
    "alerts",
    "alert",
    "feedback",
    "pair",
    "busy",
    "timeline",
    "verify",
    "evidence",
    "harness",
    "push",
  ] as AppOperation[])("%s happy path and unauthorized failure", async (op) => {
    const { run } = fixture();
    const response = await run(op, req("", bodies[op]));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await run(op, req("", bodies[op], ""))).status).toBe(401);
  });
  it("summary counts, protections, scam sense and harness are real dependencies", async () => {
    const { run } = fixture();
    const data = await (await run("summary")).json();
    expect(data.checks_this_week).toBe(1);
    expect(data.parents[0].scam_sense.score_out_of_5).toBe(2.5);
    expect(data.harness.summary.scam_caught).toBe(30);
  });
  it("detail is family-scoped and bilingual", async () => {
    const { deps, run } = fixture();
    const data = await (await run("alert")).json();
    expect(deps.store.alert).toHaveBeenCalledWith(F, V);
    expect(data.reasons[0]).toMatchObject({
      en: "Fake request",
      hi: "Nakli request",
    });
    expect(data.timeline).toHaveLength(1);
  });
  it("unknown alert and evidence are 404", async () => {
    const { deps, run } = fixture();
    deps.store.alert = async () => null;
    expect((await run("alert")).status).toBe(404);
    expect((await run("evidence")).status).toBe(404);
    expect(deps.app.runtime.buildEvidencePack).not.toHaveBeenCalled();
  });
  it("feedback calls the existing locked service and propagates 409", async () => {
    const { deps, run } = fixture();
    deps.app.recordChildFeedback = vi.fn(async () => ({
      ok: false as const,
      status: 409 as const,
      error: "feedback_conflict" as const,
      verdict_id: V,
      family_id: F,
      parent_id: P,
      persisted_feedback: "safe" as const,
      feedback_at: null,
    }));
    expect((await run("feedback", req("", { answer: "fraud" }))).status).toBe(
      409,
    );
    expect(deps.app.recordChildFeedback).toHaveBeenCalledWith({
      family_id: F,
      verdict_id: V,
      feedback: "fraud",
    });
  });
  it("feedback rejects arbitrary family id injection", async () => {
    const { run } = fixture();
    expect(
      (await run("feedback", req("", { answer: "fraud", family_id: OTHER })))
        .status,
    ).toBe(400);
  });
  it("pair lock becomes 429", async () => {
    const { deps, run } = fixture();
    deps.app.runtime.createPairingCode = async () => ({
      ok: false,
      reason: "locked",
    });
    expect((await run("pair", req("", {}))).status).toBe(429);
  });
  it("busy family mismatch becomes 403", async () => {
    const { deps, run } = fixture();
    deps.app.recordBusyReply = async () => ({
      ok: false,
      status: 403,
      error: "family_mismatch",
    });
    expect((await run("busy", req("", { streak_id: V }))).status).toBe(403);
  });
  it("501 for absent experience runtime", async () => {
    const { run } = fixture();
    const response = await run("drills", req("", bodies.drills));
    expect(response.status).toBe(501);
    expect((await response.json()).message).toContain("recorded consent");
  });
  it("experience runtime happy path is scoped and child-authored", async () => {
    const { deps, run } = fixture();
    const method = vi.fn(async () => {});
    Object.assign(deps.app.runtime, { setExperienceDrills: method });
    expect((await run("drills", req("", bodies.drills))).status).toBe(200);
    expect(method).toHaveBeenCalledWith({
      familyId: F,
      parentId: P,
      enabled: true,
      byUserId: U,
    });
  });
  it("wrong parent for drills is 403", async () => {
    const { run } = fixture();
    expect(
      (await run("drills", req("", { parent_id: OTHER, enabled: true })))
        .status,
    ).toBe(403);
  });
  it("push rejects invalid token without writing", async () => {
    const { deps, run } = fixture();
    expect(
      (await run("push", req("", { expo_token: "not-a-token" }))).status,
    ).toBe(400);
    expect(deps.store.pushToken).not.toHaveBeenCalled();
  });
  it("non-child cannot read original evidence or write feedback/pair/push", async () => {
    const { deps, run } = fixture();
    deps.store.memberships = async () => [{ ...member, role: "circle" }];
    for (const op of [
      "evidence",
      "feedback",
      "pair",
      "push",
      "busy",
      "drills",
    ] as AppOperation[])
      expect((await run(op, req("", bodies[op]))).status).toBe(403);
    expect(deps.app.runtime.buildEvidencePack).not.toHaveBeenCalled();
  });
  it("only child can receive an original number if a future runtime supplies it", async () => {
    const { run } = fixture();
    expect((await (await run("evidence")).json()).summary_en).toContain(
      "+919000000001",
    );
  });
  it("non-red incident cannot produce evidence", async () => {
    const { deps, run } = fixture();
    deps.store.alert = async () => ({ ...alert, level: "yellow" });
    expect((await run("evidence")).status).toBe(400);
  });
  it("cursor validation, round-trip and empty poll preservation", async () => {
    expect(decodeAlertCursor(encodeAlertCursor(alert))).toEqual({
      at: alert.created_at,
      id: V,
    });
    const { deps, run } = fixture();
    expect((await run("alerts", req("?since=invalid"))).status).toBe(400);
    deps.store.alerts = async () => [];
    const cursor = encodeAlertCursor(alert);
    expect(
      (await (await run("alerts", req("?since=" + cursor))).json()).next_cursor,
    ).toBe(cursor);
  });
  it("detects content tampering and interleaved-family predecessor tampering", () => {
    const { row } = fixture();
    expect(verifyTimeline([row], F)).toEqual({
      valid: true,
      checked: 1,
      broken_at: null,
    });
    expect(
      verifyTimeline([{ ...row, entry: { changed: true } }], F).valid,
    ).toBe(false);
    expect(
      verifyTimeline([{ ...row, family_id: OTHER, hash: "a".repeat(64) }], F),
    ).toEqual({ valid: false, checked: 0, broken_at: null });
  });
  it("harness reads repository results defensively", async () => {
    const data = await readAppHarness();
    expect(data).toHaveProperty("available");
    expect(data.summary).toBeTypeOf("object");
  });
  it("failed dependency is a sanitized 500", async () => {
    const { deps, run } = fixture();
    deps.store.timeline = async () => {
      throw new Error("private raw message +919000000001");
    };
    const response = await run("timeline");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private");
  });
  it("CORS only allows configured origins", async () => {
    const { deps, run } = fixture();
    deps.app.env = {
      SUPABASE_JWT_SECRET: secret,
      APP_ALLOWED_ORIGINS: "http://localhost:8081",
    };
    const response = await run(
      "summary",
      req("", undefined, token(), { Origin: "http://localhost:8081" }),
    );
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:8081",
    );
    const preflight = await run(
      "summary",
      new Request("http://localhost/api/app/shield/summary", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:8081" },
      }),
    );
    expect(preflight.status).toBe(204);
  });
});
