import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeStore, ACCOUNT_SID, AUTH, CALL_SID, inbound, missed, outbound, RECORDING_URL, STATUS_URL, twilioSign } from "./helpers";

const store = fakeStore();
vi.mock("../../src/lib/provider-ingestion/store", () => ({ providerStore: () => store }));

import { POST as sarvamPost } from "../../src/app/api/sarvam/post-call/[secret]/route";
import { POST as missedPost } from "../../src/app/api/missed-call/[secret]/route";
import { POST as statusPost } from "../../src/app/api/twilio/status/route";
import { POST as recordingPost } from "../../src/app/api/twilio/recording/route";

const SECRET = "synthetic-hook-secret-value-0123456789";
const ctx = (secret: string) => ({ params: Promise.resolve({ secret }) });
const jsonReq = (body: unknown, extra: Record<string, string> = {}) =>
  new Request("https://api.example.test/x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...extra } });

beforeEach(() => {
  vi.stubEnv("SARVAM_HOOK_SECRET", SECRET);
  vi.stubEnv("MISSEDCALL_HOOK_SECRET", SECRET);
  vi.stubEnv("SARVAM_APP_ID", "app-1");
  vi.stubEnv("SARVAM_AGENT_NUMBER", "+918000000000");
  vi.stubEnv("SARVAM_DEPLOYMENT_ID", "dep-1");
  vi.stubEnv("CALL_CONSENT_VERSION", "consent-v1");
  vi.stubEnv("TELECMI_APP_ID", "123");
  vi.stubEnv("TELECMI_VIRTUAL_NUMBER", "918000000001");
  vi.stubEnv("TWILIO_ACCOUNT_SID", ACCOUNT_SID);
  vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH);
  vi.stubEnv("TWILIO_STATUS_CALLBACK_URL", STATUS_URL);
  vi.stubEnv("TWILIO_RECORDING_CALLBACK_URL", RECORDING_URL);
  store.ingest.mockClear(); store.findSarvamAttempt.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("secret URL routes", () => {
  it("wrong secret returns 404 and never touches the body or store", async () => {
    for (const post of [sarvamPost, missedPost]) {
      const r = await post(jsonReq(outbound()), ctx("wrong"));
      expect(r.status).toBe(404);
    }
    expect(store.ingest).not.toHaveBeenCalled();
  });
  it("unconfigured secret returns 404", async () => {
    vi.stubEnv("SARVAM_HOOK_SECRET", "");
    expect((await sarvamPost(jsonReq(outbound()), ctx(""))).status).toBe(404);
  });
  it("503 when provider account config is missing", async () => {
    vi.stubEnv("SARVAM_APP_ID", "");
    expect((await sarvamPost(jsonReq(outbound()), ctx(SECRET))).status).toBe(503);
    vi.stubEnv("TELECMI_APP_ID", "");
    expect((await missedPost(jsonReq(missed()), ctx(SECRET))).status).toBe(503);
  });
  it("sarvam accepts a valid callback only after ingest", async () => {
    const r = await sarvamPost(jsonReq(outbound()), ctx(SECRET));
    expect(r.status).toBe(200);
    expect(store.ingest).toHaveBeenCalledTimes(1);
  });
  it("sarvam inbound and telecmi routes work end to end", async () => {
    expect((await sarvamPost(jsonReq(inbound()), ctx(SECRET))).status).toBe(200);
    expect((await missedPost(jsonReq(missed({ time: Date.now() })), ctx(SECRET))).status).toBe(200);
  });
  it("maps persistence failure to 503 with a safe error code", async () => {
    store.ingest.mockRejectedValueOnce(new Error("db password=hunter2"));
    const r = await sarvamPost(jsonReq(outbound()), ctx(SECRET));
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).not.toContain("hunter2");
  });
  it("enforces body limits via content-length and streaming", async () => {
    const big = "x".repeat(20_000);
    const r1 = await missedPost(jsonReq(big, { "content-length": "20000" }), ctx(SECRET));
    expect(r1.status).toBe(413);
    const r2 = await missedPost(new Request("https://api.example.test/x", { method: "POST", body: big }), ctx(SECRET));
    expect(r2.status).toBe(413);
    const r3 = await sarvamPost(jsonReq("x".repeat(600_000)), ctx(SECRET));
    expect(r3.status).toBe(413);
  });
});

describe("twilio routes", () => {
  const form = new URLSearchParams({ AccountSid: ACCOUNT_SID, CallSid: CALL_SID, CallStatus: "ringing" });
  const req = (url: string, f: URLSearchParams, sig: string) =>
    new Request(url, { method: "POST", body: f.toString(), headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": sig } });
  it("accepts a correctly signed callback and uses the configured URL, not the request Host", async () => {
    const r = await statusPost(req("http://internal-proxy.local/api/twilio/status", form, twilioSign(STATUS_URL, form)));
    expect(r.status).toBe(200);
  });
  it("rejects a bad signature with 401", async () => {
    expect((await statusPost(req(STATUS_URL, form, "bad"))).status).toBe(401);
    expect((await recordingPost(req(RECORDING_URL, form, twilioSign(STATUS_URL, form)))).status).toBe(401);
  });
  it("rejects oversize bodies", async () => {
    const r = await statusPost(new Request(STATUS_URL, { method: "POST", body: "a=" + "x".repeat(70_000), headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect(r.status).toBe(413);
  });
  it("503 when Twilio credentials are not configured", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    expect((await statusPost(req(STATUS_URL, form, "x"))).status).toBe(503);
  });
});
