import { describe, expect, it, vi } from "vitest";
import { handleSmsGateway, SMS_GATEWAY_SECRET_HEADER } from "../../src/gateway";
import type { NewGatewayEventRow, SmsGatewayDeps } from "../../src/gateway";
import { hasUnmaskedDigits } from "../../src/server";
import { sha256Hex } from "../../src/server/crypto";

const SECRET = "sms-gateway-test-secret-0123456789abcdef";
const MAA_PHONE = "9876543210";
const FAMILY = "fam_1";
const PARENT = "maa_1";

async function fakes(opts: { brain?: () => Promise<unknown>; secret?: string } = {}) {
  const parents = new Map([[await sha256Hex(MAA_PHONE), { family_id: FAMILY, parent_id: PARENT }]]);
  const events = new Map<string, NewGatewayEventRow & { id: string }>();
  const pending: Promise<unknown>[] = [];
  let seq = 0;
  const db = {
    findParentByPhoneHash: vi.fn(async (hash: string) => parents.get(hash) ?? null),
    insertGatewayEvent: vi.fn(async (row: NewGatewayEventRow) => {
      if (events.has(row.idempotency_key)) return { duplicate: true as const };
      const id = `evt_${++seq}`;
      events.set(row.idempotency_key, { ...structuredClone(row), id });
      return { id };
    }),
  };
  const brain = { runForEvent: vi.fn(opts.brain ?? (async () => ({ verdict: "ok" }))) };
  const log = { error: vi.fn() };
  const deps: SmsGatewayDeps = {
    db, brain, log,
    waitUntil: vi.fn((p: Promise<unknown>) => { pending.push(p); }),
    env: { SMS_GATEWAY_SECRET: "secret" in opts ? opts.secret : SECRET },
  };
  const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return { deps, db, brain, log, events, pending, flush };
}

function forward(payload: Record<string, unknown>, secret: string | null = SECRET) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers[SMS_GATEWAY_SECRET_HEADER] = secret;
  return new Request("https://test/api/sms/gateway", { method: "POST", headers, body: JSON.stringify(payload) });
}

const kyc = {
  from: "+91 98765 43210",
  body: "Dear customer your SBI KYC expires today, update now: https://sbi-kyc-update.in/login",
  received_at: "2026-11-14T10:00:00+05:30",
  gateway_id: "gw-pixel-1",
};

describe("handleSmsGateway", () => {
  it("valid forward → one masked gateway_sms event, brain run through waitUntil", async () => {
    const f = await fakes();
    const res = await handleSmsGateway(forward(kyc), f.deps);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; event_id: string };
    expect(body).toEqual({ ok: true, event_id: "evt_1" });

    const [row] = [...f.events.values()];
    expect(row).toMatchObject({ family_id: FAMILY, parent_id: PARENT, channel: "gateway_sms", kind: "sms",
      occurred_at: "2026-11-14T04:30:00.000Z", link_domains: ["sbi-kyc-update.in"] });
    expect(row!.masked_text).toContain("<URL:sbi-kyc-update.in>");
    expect(row!.idempotency_key).toBe(await sha256Hex(`gw-pixel-1\n2026-11-14T04:30:00.000Z\n${row!.masked_text}`));
    // Lookup was by hash of the last 10 digits, never by the number.
    expect(f.db.findParentByPhoneHash).toHaveBeenCalledWith(await sha256Hex(MAA_PHONE));
    expect(JSON.stringify(row)).not.toContain("98765");

    expect(f.deps.waitUntil).toHaveBeenCalledTimes(1);
    await f.flush();
    expect(f.brain.runForEvent).toHaveBeenCalledExactlyOnceWith("evt_1");
  });

  it("replay of the same forward → duplicate, no second row, no second brain run", async () => {
    const f = await fakes();
    expect((await handleSmsGateway(forward(kyc), f.deps)).status).toBe(200);
    // Same moment written in another format is still the same SMS.
    const replay = await handleSmsGateway(forward({ ...kyc, received_at: Date.parse(kyc.received_at) }), f.deps);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
    await f.flush();
    expect(f.events.size).toBe(1);
    expect(f.brain.runForEvent).toHaveBeenCalledTimes(1);
  });

  it("another SMS at another time from the same gateway is a new event", async () => {
    const f = await fakes();
    await handleSmsGateway(forward(kyc), f.deps);
    await handleSmsGateway(forward({ ...kyc, received_at: "2026-11-14T10:05:00+05:30" }), f.deps);
    expect(f.events.size).toBe(2);
  });

  it("wrong or missing secret → 401, nothing read or stored", async () => {
    const f = await fakes();
    for (const secret of ["wrong-secret", `${SECRET}x`, SECRET.slice(0, -1), "", null]) {
      const res = await handleSmsGateway(forward(kyc, secret), f.deps);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(f.db.findParentByPhoneHash).not.toHaveBeenCalled();
    expect(f.db.insertGatewayEvent).not.toHaveBeenCalled();
    expect(f.brain.runForEvent).not.toHaveBeenCalled();
  });

  it("unknown sender → 200 {ignored:true}, nothing stored, no brain", async () => {
    const f = await fakes();
    for (const from of ["9123456789", "12345", "Sahaj"]) {
      const res = await handleSmsGateway(forward({ ...kyc, from }), f.deps);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ignored: true });
    }
    await f.flush();
    expect(f.db.insertGatewayEvent).not.toHaveBeenCalled();
    expect(f.brain.runForEvent).not.toHaveBeenCalled();
    expect(f.deps.waitUntil).not.toHaveBeenCalled();
  });

  it("an OTP (and any number) in the body is masked before storage", async () => {
    const f = await fakes();
    const body = "Your OTP is 482913 for login. Do not share. Bank officer will call from 9123456789, ref ८८७७६६.";
    expect((await handleSmsGateway(forward({ ...kyc, body }), f.deps)).status).toBe(200);
    const [row] = [...f.db.insertGatewayEvent.mock.calls[0]!];
    expect(row.masked_text).not.toContain("482913");
    expect(row.masked_text).not.toContain("9123456789");
    expect(row.masked_text).not.toContain("८८७७६६");
    expect(row.masked_text).toContain("******");
    expect(row.masked_text).toContain("<MOBILE_10>");
    expect(hasUnmaskedDigits(row.masked_text)).toBe(false);
    expect(row.masked_text).not.toMatch(/\d{4,}/);
    expect(JSON.stringify(row)).not.toMatch(/482913|9123456789/);
  });

  it("responds in under a second even when the brain is slow", async () => {
    const f = await fakes({ brain: () => new Promise(resolve => setTimeout(resolve, 3_000)) });
    const started = performance.now();
    const res = await handleSmsGateway(forward(kyc), f.deps);
    expect(res.status).toBe(200);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(f.brain.runForEvent).toHaveBeenCalledTimes(1);
  });

  it("a failing brain run is logged without text or numbers, response already sent", async () => {
    const f = await fakes({ brain: async () => { throw new Error("boom"); } });
    expect((await handleSmsGateway(forward(kyc), f.deps)).status).toBe(200);
    await f.flush();
    expect(f.log.error).toHaveBeenCalledWith("shield.gateway.brain_failed", { eventId: "evt_1", error: "boom" });
    expect(JSON.stringify(f.log.error.mock.calls)).not.toMatch(/98765|KYC/);
  });

  it("invalid body → 400; wrong method → 405; nothing stored", async () => {
    const f = await fakes();
    for (const payload of [{ ...kyc, body: "" }, { ...kyc, received_at: "yesterday" }, { ...kyc, gateway_id: "bad id!" },
      { from: kyc.from, body: kyc.body }]) {
      expect((await handleSmsGateway(forward(payload), f.deps)).status).toBe(400);
    }
    const notJson = new Request("https://test/api/sms/gateway", { method: "POST",
      headers: { [SMS_GATEWAY_SECRET_HEADER]: SECRET }, body: "{not json" });
    expect((await handleSmsGateway(notJson, f.deps)).status).toBe(400);
    const get = new Request("https://test/api/sms/gateway", { headers: { [SMS_GATEWAY_SECRET_HEADER]: SECRET } });
    expect((await handleSmsGateway(get, f.deps)).status).toBe(405);
    expect(f.db.insertGatewayEvent).not.toHaveBeenCalled();
  });

  it("body over 16 KB → 413", async () => {
    const f = await fakes();
    const res = await handleSmsGateway(forward({ ...kyc, body: "a".repeat(17 * 1024) }), f.deps);
    expect(res.status).toBe(413);
  });

  it("missing or short SMS_GATEWAY_SECRET → 500 and nothing accepted", async () => {
    for (const secret of [undefined, "short"]) {
      const f = await fakes({ secret });
      const res = await handleSmsGateway(forward(kyc, secret ?? SECRET), f.deps);
      expect(res.status).toBe(500);
      expect(f.db.insertGatewayEvent).not.toHaveBeenCalled();
    }
  });
});
