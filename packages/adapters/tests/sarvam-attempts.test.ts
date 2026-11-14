import { describe, expect, it } from "vitest";
import { verifySarvamAttemptInteraction } from "../src/sarvam-attempts";
import { auth, code, json, req, scripted } from "./helpers";

const cfg = (transport: Parameters<typeof verifySarvamAttemptInteraction>[0]["transport"]) => ({ transport, apiKey: "synthetic-key", orgId: "org-1", workspaceId: "ws-1", timeoutMs: 50 });
const payload = (over = {}) => ({ appId: "app-1", attemptId: "att-1", interactionId: "20261114/abc-1", windowStart: new Date("2026-11-13T00:00:00Z"), windowEnd: new Date("2026-11-15T00:00:00Z"), ...over });
const request = (p = payload(), over = {}) => req("sarvam.attempts.read", p, over);
const item = (attempt: string, interaction: string) => ({ attempt_id: attempt, interaction_id: interaction, user_contact: "+919000000001" });

describe("verifySarvamAttemptInteraction", () => {
  it("confirms a matching attempt and interaction on the first page", async () => {
    const t = scripted(json({ items: [item("att-0", "20261114/zzz"), item("att-1", "20261114/abc-1")], total: 2 }));
    expect(await verifySarvamAttemptInteraction(cfg(t.transport), request())).toEqual({ confirmed: true });
    const url = new URL(t.calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://apps.sarvam.ai/api/analytics/v1/org-1/ws-1/app-1/attempts");
    expect(url.searchParams.get("start_datetime")).toBe("2026-11-13T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("200");
    expect((t.calls[0]!.init.headers as Record<string, string>)["X-API-Key"]).toBe("synthetic-key");
  });
  it("does not confirm when the attempt maps to a different interaction (swapped identifier)", async () => {
    const t = scripted(json({ items: [item("att-1", "20261114/someone-elses")], total: 1 }));
    expect(await verifySarvamAttemptInteraction(cfg(t.transport), request())).toEqual({ confirmed: false });
  });
  it("does not confirm an interaction that exists only under another attempt", async () => {
    const t = scripted(json({ items: [item("att-9", "20261114/abc-1")], total: 1 }));
    expect(await verifySarvamAttemptInteraction(cfg(t.transport), request())).toEqual({ confirmed: false });
  });
  it("pages until found, and gives up after a bounded number of pages", async () => {
    const full = Array.from({ length: 200 }, (_, i) => item(`x${i}`, `20261114/x${i}`));
    const found = scripted(json({ items: full, total: 300 }), json({ items: [item("att-1", "20261114/abc-1")], total: 300 }));
    expect(await verifySarvamAttemptInteraction(cfg(found.transport), request())).toEqual({ confirmed: true });
    expect(found.calls).toHaveLength(2);
    const never = scripted(...Array.from({ length: 6 }, () => json({ items: full, total: 100000 })));
    expect(await verifySarvamAttemptInteraction(cfg(never.transport), request())).toEqual({ confirmed: false });
    expect(never.calls).toHaveLength(5);
  });
  it("refuses unsafe identifiers and bad windows before any network call", async () => {
    const t = scripted();
    for (const p of [payload({ attemptId: "../x" }), payload({ appId: "a/b" }), payload({ interactionId: "../../etc" }), payload({ windowEnd: new Date("2026-11-12T00:00:00Z") })]) {
      expect(await code(verifySarvamAttemptInteraction(cfg(t.transport), request(p)))).toBe("invalid_payload");
    }
    expect(await code(verifySarvamAttemptInteraction(cfg(t.transport), request(payload(), { authorization: auth("sarvam.recording.read") })))).toBe("authorization_denied");
    expect(t.calls).toHaveLength(0);
  });
  it("outages are retryable reads and malformed bodies are rejected", async () => {
    expect(await code(verifySarvamAttemptInteraction(cfg(scripted(json({}, 503)).transport), request()))).toBe("provider_unavailable");
    expect(await code(verifySarvamAttemptInteraction(cfg(scripted(json({ nope: true })).transport), request()))).toBe("provider_rejected");
    expect(await code(verifySarvamAttemptInteraction(cfg(scripted(new Response("<html>", { status: 200 })).transport), request()))).toBe("provider_rejected");
  });
});
