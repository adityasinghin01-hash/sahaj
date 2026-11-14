import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_SID, AUTH, CALL_SID, fakeStore, twilioSign } from "./helpers";

const store = fakeStore();
const accept = vi.fn(async () => ({ proofEventId: "p", assignmentId: "a" }));
vi.mock("../../src/lib/provider-ingestion/store", () => ({ providerStore: () => store, gatherStore: () => ({ acceptFromGather: accept }) }));

import { POST } from "../../src/app/api/twilio/gather/route";

const URL_ = "https://api.example.test/api/twilio/gather";
const body = (o: Record<string, string> = {}) => new URLSearchParams({ AccountSid: ACCOUNT_SID, CallSid: CALL_SID, Digits: "1", ...o });
const req = (f: URLSearchParams, sig: string | null = twilioSign(URL_, f)) => new Request(URL_, {
  method: "POST", body: f.toString(), headers: { "content-type": "application/x-www-form-urlencoded", ...(sig ? { "x-twilio-signature": sig } : {}) },
});

beforeEach(() => {
  vi.stubEnv("TWILIO_ACCOUNT_SID", ACCOUNT_SID); vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH); vi.stubEnv("TWILIO_GATHER_CALLBACK_URL", URL_);
  store.ingest.mockClear(); accept.mockClear();
});

describe("POST /api/twilio/gather", () => {
  it("answers TwiML only for a signed explicit 1 that SQL accepted", async () => {
    const res = await POST(req(body()));
    expect(res.status).toBe(200); expect(res.headers.get("content-type")).toContain("text/xml");
    expect(await res.text()).toContain("<Response>"); expect(accept).toHaveBeenCalledTimes(1);
  });
  it("answers an unsigned or wrongly signed request with 401 JSON and no side effects", async () => {
    for (const sig of [null, "AAAAAAAAAAAAAAAAAAAAAAAAAAA="]) {
      const res = await POST(req(body(), sig));
      expect(res.status).toBe(401); expect(res.headers.get("content-type")).toContain("json");
    }
    expect(store.ingest).not.toHaveBeenCalled(); expect(accept).not.toHaveBeenCalled();
  });
  it("is unavailable until the exact callback URL is configured", async () => {
    vi.stubEnv("TWILIO_GATHER_CALLBACK_URL", "");
    expect((await POST(req(body()))).status).toBe(503);
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    expect((await POST(req(body()))).status).toBe(503);
    expect(accept).not.toHaveBeenCalled();
  });
  it("a non-1 digit returns TwiML without acceptance", async () => {
    const res = await POST(req(body({ Digits: "2" })));
    expect(res.status).toBe(200); expect(accept).not.toHaveBeenCalled(); expect(store.ingest).not.toHaveBeenCalled();
  });
});
