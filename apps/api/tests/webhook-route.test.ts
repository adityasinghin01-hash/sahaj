import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { POST } from "../src/app/api/whatsapp/route";

afterEach(() => vi.unstubAllEnvs());

it("fails closed with missing provider signature configuration", async () => {
  vi.stubEnv("WHATSAPP_APP_SECRET", "");
  const response = await POST(new Request("https://example.test/api/whatsapp", { method: "POST", body: "{}" }));
  expect(response.status).toBe(503);
});
it("rejects invalid signatures before parsing untrusted JSON", async () => {
  vi.stubEnv("WHATSAPP_APP_SECRET", "synthetic-test-secret");
  const response = await POST(new Request("https://example.test/api/whatsapp", { method: "POST", body: "invalid json", headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) } }));
  expect(response.status).toBe(401);
});
it("does not acknowledge a valid signed request before storage is configured", async () => {
  const secret = "synthetic-test-secret", body = "{}";
  vi.stubEnv("WHATSAPP_APP_SECRET", secret);
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "demo-account");
  vi.stubEnv("WEBHOOK_ENCRYPTION_KEY", "");
  vi.stubEnv("IDENTITY_HASH_SECRET", "");
  const response = await POST(new Request("https://example.test/api/whatsapp", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex") } }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "event_storage_not_configured" });
});
