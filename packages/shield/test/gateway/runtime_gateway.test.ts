import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter, type Provider } from "@sahaj/adapters";
import { createShieldRuntime } from "../../src/runtime";
import type { ShieldRuntimeTestPorts } from "../../src/runtime/types";
import { createGatewayPg, SMS_GATEWAY_SECRET_HEADER, type NewGatewayEventRow } from "../../src";
import { sha256Hex } from "../../src/server/crypto";
import { storage } from "../e2e/storage";

const now = new Date("2026-11-14T10:00:00.000Z");
const GATEWAY_SECRET = "runtime-gateway-secret-0123456789abcdef";
const MAA_PHONE = "9876543210";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

/** Memory store, or Postgres when DATABASE_URL is set and migration 20261114000500 is applied. */
async function fixture() {
  const store = await storage(); cleanups.push(store.close);
  const phoneHash = await sha256Hex(MAA_PHONE);
  if (store.sql) {
    const [t] = await store.sql<{ t: string | null }[]>`select to_regclass('public.shield_gateway_parents')::text as t`;
    if (!t?.t) return null;
    const sql = store.sql;
    await sql`insert into public.shield_gateway_parents (phone_hash, family_id, parent_id)
      values (${phoneHash}, ${store.ctx.familyId}, ${store.ctx.parentId})`;
    // Runs before store.close (afterEach drains in order; this is pushed first).
    cleanups.unshift(async () => { await sql`delete from public.shield_gateway_parents where family_id = ${store.ctx.familyId}`; });
    store.db.gateway = createGatewayPg(sql);
  } else {
    store.db.gateway = {
      async findParentByPhoneHash(hash) {
        return hash === phoneHash ? { family_id: store.ctx.familyId, parent_id: store.ctx.parentId } : null;
      },
      insertGatewayEvent: (row: NewGatewayEventRow) => store.db.server.insertEvent({ ...row, device_id: "",
        sender_type: null, caller_type: null, matched_rules: [], local_level: null }),
    };
  }
  const pending: Promise<unknown>[] = [];
  const provider: Provider = vi.fn(async () => ({ kind: "text" as const, text: JSON.stringify({
    is_scam: true, scam_type: "kyc_block", pressure_signals: [], asks_for: [], confidence: 0.95,
    hindi_reason: "KYC ke naam par link mat kholiye.",
  }) }));
  const ports: ShieldRuntimeTestPorts = {
    db: store.db, router: createRouter({ claude: provider, muse: provider, gemini: provider }),
    whatsapp: { sendShieldAlert: vi.fn(async () => undefined), sendFamilyCheckCard: vi.fn(async () => undefined) },
    push: { childCard: vi.fn(async () => undefined) },
    calls: { getParentLine: vi.fn(async () => "parent-line"), callParent: vi.fn(async () => ({ status: "answered" as const })),
      startResponderCall: vi.fn(async () => undefined), startCallback: vi.fn(async () => undefined) },
    scheduler: { after: vi.fn(async () => undefined), claim: vi.fn(async () => true) },
    atlas: { bridgeChild: vi.fn(async () => undefined), startCircleChain: vi.fn(async () => undefined) },
    gate: { check: vi.fn(async () => ({ allowed: true })) },
    sign: vi.fn(async () => undefined),
    waitUntil(promise) { pending.push(promise); },
    env: { SHIELD_DEVICE_PAIRING_SECRET: "runtime-gateway-pairing-secret-long-enough", SMS_GATEWAY_SECRET: GATEWAY_SECRET,
      DEMO_TIMER_SCALE: "60" },
    clock: { now: () => now },
    cache: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    log: { error: vi.fn() },
  };
  const runtime = createShieldRuntime(ports);
  const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return { ...store, runtime, ports, provider, flush };
}

function forward(body: string, secret = GATEWAY_SECRET) {
  return new Request("https://test/api/sms/gateway", { method: "POST",
    headers: { "content-type": "application/json", [SMS_GATEWAY_SECRET_HEADER]: secret },
    body: JSON.stringify({ from: `+91 ${MAA_PHONE}`, body, received_at: now.toISOString(), gateway_id: "gw-1" }) });
}

const KYC = "SBI: aapka KYC aaj band ho jayega. OTP 482913 kisi ko na batayein. Turant update karein https://sbi-kyc-update.in/login";

describe(`runtime.handleSmsGateway (${process.env.DATABASE_URL ? "Postgres" : "memory"})`, () => {
  it("valid forward → masked gateway_sms event, brain verdict persisted; replay → duplicate", async ctx => {
    const f = await fixture();
    if (!f) return ctx.skip();
    const res = await f.runtime.handleSmsGateway(forward(KYC));
    expect(res.status).toBe(200);
    const { event_id } = await res.json() as { event_id: string };
    await f.flush();

    const event = await f.db.getEvent(event_id);
    expect(event).toMatchObject({ channel: "gateway_sms", kind: "sms", family_id: f.ctx.familyId, parent_id: f.ctx.parentId });
    expect(event!.masked_text).not.toContain("482913");
    expect(event!.masked_text).toContain("<URL:sbi-kyc-update.in>");

    const verdicts = await f.verdicts();
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.event.idempotency_key).toBe(event!.idempotency_key);
    expect(verdicts[0]!.verdict.level).not.toBe("green");
    // No AI request ever carried the OTP or the phone number.
    expect(JSON.stringify(vi.mocked(f.provider).mock.calls)).not.toMatch(/482913|9876543210/);

    const replay = await f.runtime.handleSmsGateway(forward(KYC));
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
    await f.flush();
    expect(await f.verdicts()).toHaveLength(1);
  });

  it("wrong secret → 401 and unknown sender → ignored, nothing stored", async ctx => {
    const f = await fixture();
    if (!f) return ctx.skip();
    expect((await f.runtime.handleSmsGateway(forward(KYC, "wrong"))).status).toBe(401);
    const stranger = new Request("https://test/api/sms/gateway", { method: "POST",
      headers: { [SMS_GATEWAY_SECRET_HEADER]: GATEWAY_SECRET },
      body: JSON.stringify({ from: "9000000001", body: KYC, received_at: now.toISOString(), gateway_id: "gw-1" }) });
    expect(await (await f.runtime.handleSmsGateway(stranger)).json()).toEqual({ ignored: true });
    await f.flush();
    expect(await f.verdicts()).toHaveLength(0);
    expect(await f.db.brain.getRecentEvents({ familyId: f.ctx.familyId, parentId: f.ctx.parentId,
      since: "2026-01-01T00:00:00.000Z", until: "2027-01-01T00:00:00.000Z" })).toHaveLength(0);
  });
});
