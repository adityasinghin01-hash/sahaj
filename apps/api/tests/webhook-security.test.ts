import { describe, expect, it } from "vitest";
import { decryptWebhook, encryptWebhook, identityHash, readWebhookBody } from "../src/lib/webhook-security";

describe("webhook byte boundaries and encrypted persistence", () => {
  const key = "ab".repeat(32);
  it("preserves exact UTF-8 bytes for signature verification", async () => {
    const body = Buffer.from('{"message":"नमस्ते"}\n');
    expect(await readWebhookBody(new Request("https://example.test", { method: "POST", body }))).toEqual(body);
  });
  it("bounds chunked payloads even without content-length", async () => {
    const request = new Request("https://example.test", { method: "POST", body: "0123456789" });
    await expect(readWebhookBody(request, 4)).rejects.toMatchObject({ status: 413 });
  });
  it("rejects a declared oversized payload before reading", async () => {
    const request = new Request("https://example.test", { method: "POST", headers: { "content-length": "500" }, body: "a" });
    await expect(readWebhookBody(request, 4)).rejects.toMatchObject({ status: 413 });
  });
  it("encrypts with a fresh nonce and rejects wrong keys or event context", () => {
    const body = Buffer.from("synthetic event");
    const encrypted = encryptWebhook(body, key, "whatsapp:event-a");
    expect(encryptWebhook(body, key, "whatsapp:event-a")).not.toBe(encrypted);
    expect(decryptWebhook(encrypted, key, "whatsapp:event-a")).toEqual(body);
    expect(() => decryptWebhook(encrypted, key, "whatsapp:event-b")).toThrow();
    expect(() => decryptWebhook(encrypted, "cd".repeat(32), "whatsapp:event-a")).toThrow();
    const parts = encrypted.split(".");
    parts[2] = Buffer.alloc(16).toString("base64url");
    expect(() => decryptWebhook(parts.join("."), key, "whatsapp:event-a")).toThrow();
  });
  it("rejects weak configuration and separates identity namespaces", () => {
    expect(() => encryptWebhook(Buffer.from("a"), "bad", "a")).toThrow();
    expect(() => identityHash("a", "b", "c", "short")).toThrow();
    expect(identityHash("a", "b", "c", key)).not.toBe(identityHash("a", "c", "b", key));
  });
});
