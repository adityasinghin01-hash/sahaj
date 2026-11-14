import { describe, expect, it } from "vitest";
import { send } from "../src/http";

describe("bounded HTTP transport", () => {
  it.each([true, false])("rejects a stalled response body without returning partial data (readOnly=%s)", async (readOnly) => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"sid":"accepted"}')); } });
    await expect(send("https://provider.example.test/", {}, {
      provider: "twilio", transport: async () => new Response(body), timeoutMs: 10, readOnly,
    })).rejects.toMatchObject({ code: readOnly ? "provider_unavailable" : "delivery_unknown" });
  });

  it("never follows redirects or forwards authorization to another host", async () => {
    let calls = 0;
    await expect(send("https://provider.example.test/", { headers: { Authorization: "synthetic-secret" } }, {
      provider: "whatsapp", readOnly: true,
      transport: async (_url, init) => { calls++; expect(init.redirect).toBe("manual"); return new Response(null, { status: 302, headers: { location: "https://attacker.example.test/" } }); },
    })).rejects.toMatchObject({ code: "provider_rejected" });
    expect(calls).toBe(1);
  });

  it.each([NaN, Infinity, 0, -1])("rejects invalid timeout %s before dispatch", async (timeoutMs) => {
    await expect(send("https://provider.example.test/", {}, { provider: "sarvam", transport: async () => { throw new Error("must not call"); }, readOnly: false, timeoutMs })).rejects.toMatchObject({ code: "invalid_payload" });
  });
});
