/** K-B8 Part B: gateway registration + KEYPAD ladder for gateway_sms. Memory store, or Postgres with DATABASE_URL. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayPg, numberFingerprint, SMS_GATEWAY_SECRET_HEADER, type GatewayRegistryDb, type NewGatewayEventRow } from "../../src";
import { storage } from "../e2e/storage";
import { aiReply, GATEWAY_SECRET, makeRuntime } from "../runtime/ports";

const MAA_PHONE = "+91 90000 00003";
const now = new Date("2026-11-14T06:00:00.000Z");
/** A link to a website registered 5 days ago (RDAP fake below) → yellow, and the AI fake says "not a scam". */
const YELLOW = "Kal ki photos yahan dekhiye https://photos-share.in/album";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

async function fixture(provider = aiReply({ is_scam: false, scam_type: "unknown", pressure_signals: [], asks_for: [], confidence: 0.3, hindi_reason: "Shayad theek." })) {
  const store = await storage(); cleanups.push(store.close);
  if (store.sql) {
    const sql = store.sql;
    cleanups.unshift(async () => { await sql`delete from public.shield_gateway_parents where family_id = ${store.ctx.familyId}`; });
    store.db.gateway = createGatewayPg(sql);
  } else {
    const registered = new Map<string, { family_id: string; parent_id: string }>();
    const registry: GatewayRegistryDb = {
      async registerParent({ phoneHash, familyId, parentId }) {
        if (!await store.db.brain.getParent({ familyId, parentId })) return false;
        registered.set(phoneHash, { family_id: familyId, parent_id: parentId }); return true;
      },
      async unregisterParent({ familyId, parentId }) {
        let removed = 0;
        for (const [hash, row] of registered) if (row.family_id === familyId && row.parent_id === parentId) { registered.delete(hash); removed++; }
        return removed;
      },
    };
    store.db.gateway = { ...registry,
      async findParentByPhoneHash(hash) { return registered.get(hash) ?? null; },
      insertGatewayEvent: (row: NewGatewayEventRow) => store.db.server.insertEvent({ ...row, device_id: "",
        sender_type: null, caller_type: null, matched_rules: [], local_level: null }),
    };
  }
  // Key-free link checks with fakes: empty OpenPhish feed, and RDAP says the domain is 5 days old.
  const linkIntelFetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://rdap.org/domain/")) {
      return Response.json({ events: [{ eventAction: "registration", eventDate: new Date(now.getTime() - 5 * 86_400_000).toISOString() }] });
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;
  return { store, ...makeRuntime(store.db, { provider, now: () => now, linkIntelFetch }) };
}

function forward(body: string, at = now) {
  return new Request("https://test/api/sms/gateway", { method: "POST",
    headers: { "content-type": "application/json", [SMS_GATEWAY_SECRET_HEADER]: GATEWAY_SECRET },
    body: JSON.stringify({ from: MAA_PHONE, body, received_at: at.toISOString(), gateway_id: "gw-k-b8" }) });
}

describe(`gateway registration + keypad ladder (${process.env.DATABASE_URL ? "Postgres" : "memory"})`, () => {
  it("registerGatewayParent stores only the fingerprint; unregister stops forwarding", async () => {
    const f = await fixture();
    expect(await f.runtime.registerGatewayParent({ ...f.store.ctx, phone: MAA_PHONE })).toEqual({ ok: true });
    // Re-registering the same number is an upsert, not an error.
    expect(await f.runtime.registerGatewayParent({ ...f.store.ctx, phone: "9000000003" })).toEqual({ ok: true });
    if (f.store.sql) {
      const rows = await f.store.sql`select phone_hash from public.shield_gateway_parents where family_id = ${f.store.ctx.familyId}`;
      expect(rows.map(row => row.phone_hash)).toEqual([await numberFingerprint(MAA_PHONE)]);
    }
    const res = await f.runtime.handleSmsGateway(forward("Namaste, kal milte hain."));
    expect(await res.json()).toMatchObject({ ok: true });
    expect(await f.runtime.unregisterGatewayParent(f.store.ctx)).toEqual({ ok: true, removed: 1 });
    const after = await f.runtime.handleSmsGateway(forward("Doosra message.", new Date(now.getTime() + 1000)));
    expect(await after.json()).toEqual({ ignored: true });
    await f.flush();
    expect(JSON.stringify(vi.mocked(f.ports.sign).mock.calls)).not.toMatch(/90000|00003/);
  });

  it("refuses a parent outside the family and a number with fewer than 10 digits", async () => {
    const f = await fixture();
    await expect(f.runtime.registerGatewayParent({ familyId: f.store.ctx.familyId, parentId: crypto.randomUUID(), phone: MAA_PHONE }))
      .rejects.toThrow("Shield gateway parent not found");
    await expect(f.runtime.registerGatewayParent({ ...f.store.ctx, phone: "12345" })).rejects.toThrow("Invalid gateway phone number");
  });

  it("yellow gateway_sms → Aasha Didi calls Maa with the verdict (attempt 1) + Riya's quiet card", async () => {
    const f = await fixture();
    await f.runtime.registerGatewayParent({ ...f.store.ctx, phone: MAA_PHONE });
    const res = await f.runtime.handleSmsGateway(forward(YELLOW));
    expect(res.status).toBe(200);
    const started = Date.now();
    await f.flush();
    const [verdict] = await f.store.verdicts();
    expect(verdict!.verdict.level).toBe("yellow");
    expect(f.ports.calls.callParent).toHaveBeenCalledOnce();
    expect(f.ports.calls.callParent).toHaveBeenCalledWith({ ...f.store.ctx, lineId: "aasha-line", verdictId: verdict!.id, attempt: 1 });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(f.ports.push.childCard).toHaveBeenCalledWith(expect.objectContaining({ verdictId: verdict!.id, quiet: true }));
    expect(f.ports.sign).toHaveBeenCalledWith(expect.objectContaining({ step: "call_parent", status: "ok", verdictId: verdict!.id,
      details: expect.objectContaining({ level: "yellow", attempt: 1 }) }));
  });

  it("red gateway_sms → exactly one call from the brain + WhatsApp alert; a denied gate means no yellow call", async () => {
    const f = await fixture(aiReply({ is_scam: true, scam_type: "kyc_block", pressure_signals: [], asks_for: [], confidence: 0.95, hindi_reason: "Fraud." }));
    await f.runtime.registerGatewayParent({ ...f.store.ctx, phone: MAA_PHONE });
    await f.runtime.handleSmsGateway(forward("SBI: aapka KYC aaj band ho jayega. OTP 482913 kisi ko na batayein. Turant update karein https://sbi-kyc-update.in/login"));
    await f.flush();
    const [verdict] = await f.store.verdicts();
    expect(verdict!.verdict.level).toBe("red");
    expect(f.ports.calls.callParent).toHaveBeenCalledOnce();
    expect(f.ports.whatsapp.sendShieldAlert).toHaveBeenCalledOnce();

    const denied = await fixture();
    vi.mocked(denied.ports.gate.check).mockImplementation(async ({ action }) => ({ allowed: action !== "speak_clip" }));
    await denied.runtime.registerGatewayParent({ ...denied.store.ctx, phone: MAA_PHONE });
    await denied.runtime.handleSmsGateway(forward(YELLOW));
    await denied.flush();
    expect(denied.ports.calls.callParent).not.toHaveBeenCalled();
    expect(denied.ports.push.childCard).toHaveBeenCalledOnce();
  });
});
