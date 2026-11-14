import { encryptWebhook, identityHash } from "@sahaj/adapters";
import { contactContext } from "@/ports/contacts";
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRouter, type Provider } from "@sahaj/adapters";
import { ShieldAction, SHIELD_HEADERS, ShieldEvent } from "@sahaj/shared";
import { createShieldRuntime, type ShieldRuntimeDb, type ShieldRuntimeTestPorts } from "@sahaj/shield";
import type { StoredVerdict } from "@sahaj/shield/src/brain/types.js";
import type {
  NewPairingCode,
  NewShieldDevice,
  NewShieldEventRow,
  ShieldDeviceRow,
} from "@sahaj/shield/src/server/types";
import type { CreateFamilyCheckInput, FamilyCheckStateValue } from "@sahaj/shield/src/tools/types";
import type { ShieldApp, OutboxRow } from "@/lib/app";
import {
  createCronJobsHandler,
  createEventHandler,
  createHealthHandler,
  createOutboxHandler,
  createPairCodeHandler,
  createPairHandler,
  createSarvamToolHandler,
} from "@/lib/handlers";
import { createGatePort } from "@/ports/gate";
import { canonicalJson, computeChainHash } from "@/ports/sign";
import { createWhatsappPort } from "@/ports/whatsapp";

const FAMILY_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_ID = "22222222-2222-4222-8222-222222222221";
const USER_ID = "33333333-3333-4333-8333-333333333332";
const PAIRING_SECRET = "test-pairing-secret-at-least-32-chars";

interface FakeJob {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  runAt: Date;
  status: "pending" | "done" | "failed";
}

function makeFakeApp(envOverrides: Record<string, string | undefined> = {}) {
  const now = new Date("2026-11-14T10:00:00.000Z");
  let writeCount = 0;

  const devices = new Map<string, ShieldDeviceRow & NewShieldDevice>();
  const events = new Map<string, NewShieldEventRow & { id: string }>();
  const codes = new Map<string, NewPairingCode & { id: string; used_at: Date | null }>();
  const failures: { family_id: string; attempted_at: Date }[] = [];
  const locks = new Map<string, Date>();
  const checks = new Map<string, Omit<CreateFamilyCheckInput, "state"> & { state: FamilyCheckStateValue }>();
  const verdicts = new Map<string, StoredVerdict>();
  const reactions = new Set<string>();
  const claimed = new Set<string>();
  const outbox: OutboxRow[] = [];
  const jobs: FakeJob[] = [];
  const timeline: unknown[] = [];

  const db: ShieldRuntimeDb = {
    server: {
      async getDevice(id) {
        return devices.get(id) ?? null;
      },
      async insertDevice(row) {
        writeCount++;
        devices.set(row.id, { ...row });
      },
      async insertEvent(row) {
        writeCount++;
        for (const existing of events.values()) {
          if (existing.idempotency_key === row.idempotency_key) return { duplicate: true };
        }
        const id = crypto.randomUUID();
        events.set(id, { ...row, id });
        return { id };
      },
      async touchHeartbeat() {
        writeCount++;
      },
      async getPerson(personId) {
        return personId === PARENT_ID ? { id: PARENT_ID, family_id: FAMILY_ID } : null;
      },
      async countActivePairingCodes(familyId, at) {
        return [...codes.values()].filter((c) => c.family_id === familyId && !c.used_at && c.expires_at > at).length;
      },
      async insertPairingCode(row) {
        writeCount++;
        const id = crypto.randomUUID();
        codes.set(id, { ...row, id, used_at: null });
      },
      async claimPairingCode({ familyId, codeHash, now: at }) {
        writeCount++;
        for (const c of codes.values()) {
          if (c.family_id === familyId && c.code_hash === codeHash && !c.used_at && c.expires_at > at) {
            c.used_at = at;
            return { id: c.id };
          }
        }
        return null;
      },
      async expireActivePairingCodes(familyId, at) {
        writeCount++;
        for (const c of codes.values()) {
          if (c.family_id === familyId && !c.used_at && c.expires_at > at) c.expires_at = at;
        }
      },
      async recordPairingFailure(familyId, at) {
        writeCount++;
        failures.push({ family_id: familyId, attempted_at: at });
      },
      async countPairingFailures(familyId, since) {
        return failures.filter((f) => f.family_id === familyId && f.attempted_at >= since).length;
      },
      async getPairingLockedUntil(familyId) {
        return locks.get(familyId) ?? null;
      },
      async setPairingLockedUntil(familyId, until) {
        writeCount++;
        locks.set(familyId, until);
      },
    },
    tools: {
      async createFamilyCheck(input) {
        writeCount++;
        const id = crypto.randomUUID();
        checks.set(id, { ...input });
        return { id };
      },
      async getFamilyCheck(id) {
        const c = checks.get(id);
        return c ? { familyId: c.familyId, claimedName: c.claimedName, toPersonId: c.toPersonId, state: c.state } : null;
      },
      async findPersonByName(familyId, name) {
        if (familyId === FAMILY_ID && name.trim().toLowerCase() === "riya") {
          return { id: "22222222-2222-4222-8222-222222222222", name: "Riya" };
        }
        return null;
      },
      async getCodeWordHash(familyId) {
        // sha256("gulab")
        return familyId === FAMILY_ID ? "33b2dc44201d3b1c10ef3a8f1cd0a3c5c7f0d339ee96d88aecdf2583a116b34a" : null;
      },
      async markFamilyCheckNoAnswer(id) {
        writeCount++;
        const c = checks.get(id);
        if (!c || c.state !== "asked") return false;
        c.state = "no_answer";
        return true;
      },
    },
    async getEvent(id) {
      const row = events.get(id);
      if (!row) return null;
      return ShieldEvent.parse({
        ...row,
        device_id: row.device_id || undefined,
        masked_text: row.masked_text ?? undefined,
        sender_type: row.sender_type ?? undefined,
        caller_type: row.caller_type ?? undefined,
        local_level: row.local_level ?? undefined,
      });
    },
    async insertVoiceEvent(event) {
      writeCount++;
      const id = crypto.randomUUID();
      events.set(id, {
        ...event,
        id,
        device_id: event.device_id ?? "",
        masked_text: event.masked_text ?? null,
        sender_type: event.sender_type ?? null,
        caller_type: event.caller_type ?? null,
        local_level: event.local_level ?? null,
      });
      return { id };
    },
    async getVerdictForEvent(eventId) {
      const ev = events.get(eventId);
      if (!ev) return null;
      return [...verdicts.values()].find((v) => v.event.idempotency_key === ev.idempotency_key) ?? null;
    },
    brain: {
      async getParent({ familyId, parentId }) {
        return familyId === FAMILY_ID && parentId === PARENT_ID ? { id: PARENT_ID, family_id: FAMILY_ID } : null;
      },
      async getRecentEvents() {
        return [];
      },
      async insertVerdict(input) {
        writeCount++;
        const id = crypto.randomUUID();
        verdicts.set(id, { ...input, id });
        return { id };
      },
      async getVerdict(id) {
        return verdicts.get(id) ?? null;
      },
      async hasChildReaction({ verdictId }) {
        return reactions.has(verdictId);
      },
    },
    async withEventLock(_id, work) {
      return work(db);
    },
  };

  const pending: Promise<unknown>[] = [];
  const provider: Provider = vi.fn(async () => ({
    kind: "text" as const,
    text: JSON.stringify({
      is_scam: false,
      scam_type: "unknown",
      pressure_signals: [],
      asks_for: [],
      confidence: 0.9,
      hindi_reason: "Sab theek lag raha hai.",
    }),
  }));
  const router = createRouter({ claude: provider, muse: provider, gemini: provider });

  const sign: ShieldRuntimeTestPorts["sign"] = async (entry) => {
    writeCount++;
    timeline.push(entry);
  };

  const ports: ShieldRuntimeTestPorts = {
    db,
    router,
    whatsapp: {
      async sendShieldAlert(card) {
        writeCount++;
        outbox.push({
          id: crypto.randomUUID(),
          created_at: now.toISOString(),
          channel: "whatsapp",
          kind: "send_shield_alert",
          family_id: card.familyId,
          parent_id: card.parentId,
          dedupe_key: `whatsapp:shield_alert:${card.verdictId}`,
          payload: { verdict_id: card.verdictId, level: card.verdict.level },
        });
      },
      async sendFamilyCheckCard(input) {
        writeCount++;
        outbox.push({
          id: crypto.randomUUID(),
          created_at: now.toISOString(),
          channel: "whatsapp",
          kind: "send_family_check_card",
          family_id: input.familyId,
          parent_id: null,
          dedupe_key: `whatsapp:family_check:${input.checkId}`,
          payload: { check_id: input.checkId },
        });
      },
    },
    push: {
      async childCard(card) {
        writeCount++;
        outbox.push({
          id: crypto.randomUUID(),
          created_at: now.toISOString(),
          channel: "push",
          kind: "child_card",
          family_id: card.familyId,
          parent_id: card.parentId,
          dedupe_key: `push:child_card:${card.verdictId}`,
          payload: { verdict_id: card.verdictId, level: card.verdict.level },
        });
      },
    },
    calls: {
      async getParentLine() {
        return "dev-outbox-line";
      },
      async callParent(input) {
        writeCount++;
        outbox.push({
          id: crypto.randomUUID(),
          created_at: now.toISOString(),
          channel: "calls",
          kind: "call_parent",
          family_id: input.familyId,
          parent_id: input.parentId,
          dedupe_key: `calls:call_parent:${input.verdictId}:${input.attempt}`,
          payload: { verdict_id: input.verdictId, attempt: input.attempt },
        });
        return { status: "answered" };
      },
      async startResponderCall() {
        writeCount++;
      },
      async startCallback() {
        writeCount++;
      },
    },
    scheduler: {
      async after(delayMs, name, payload) {
        writeCount++;
        jobs.push({
          id: crypto.randomUUID(),
          name,
          payload,
          runAt: new Date(now.getTime() + delayMs),
          status: "pending",
        });
      },
      async claim(key) {
        writeCount++;
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
    },
    atlas: {
      async bridgeChild() {
        writeCount++;
      },
      async startCircleChain(input) {
        writeCount++;
        outbox.push({
          id: crypto.randomUUID(),
          created_at: now.toISOString(),
          channel: "atlas",
          kind: "start_circle_chain",
          family_id: input.familyId,
          parent_id: input.parentId,
          dedupe_key: "verdictId" in input ? `atlas:circle_chain:${input.verdictId}` : null,
          payload: "verdictId" in input ? { verdict_id: input.verdictId } : { reason: input.reason },
        });
      },
    },
    gate: createGatePort(sign),
    sign,
    waitUntil(p) {
      pending.push(p);
    },
    env: {
      SHIELD_DEVICE_PAIRING_SECRET: PAIRING_SECRET,
      DEMO_TIMER_SCALE: "60",
    },
    clock: { now: () => now },
    cache: {
      async get() {
        return null;
      },
      async set() {},
    },
  };

  const runtime = createShieldRuntime(ports);

  const env: Record<string, string | undefined> = {
    DEV_ADMIN_TOKEN: "dev-admin-secret",
    SARVAM_TOOL_TOKEN: "sarvam-bearer-secret",
    CRON_SECRET: "cron-secret-value",
    SHIELD_DEVICE_PAIRING_SECRET: PAIRING_SECRET,
    ...envOverrides,
  };

  const app: ShieldApp = {
    env,
    portsStatus: {
      sql: "real",
      router: "unconfigured",
      whatsapp: "outbox",
      push: "outbox",
      calls: "outbox",
      atlas: "outbox",
      scheduler: "real",
      gate: "real",
      sign: "dev_timeline_sha256",
      cache: "real",
    },
    runtime,
    async recordBusyCallStatus() {
      return { ok: false, status: 404, error: "parent_not_found" };
    },
    async recordBusyReply() {
      return { ok: false, status: 404, error: "streak_not_found" };
    },
    async recordChildFeedback() {
      return { ok: false, status: 404, error: "verdict_not_found" };
    },
    async getWeeklyTip() {
      return { ok: false, status: 404, error: "family_not_found" };
    },
    async registerGatewayParent() {
      return { ok: false, status: 404, error: "parent_not_found" };
    },
    async recordDeviceHeartbeat() {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    },
    async runDueJobs() {
      const results: { id: string; name: string; status: "done" | "failed"; result?: unknown }[] = [];
      for (const job of jobs) {
        if (job.status === "pending" && job.runAt <= now) {
          try {
            const result = await runtime.handleScheduledJob(job.name, job.payload);
            job.status = "done";
            results.push({ id: job.id, name: job.name, status: "done", result });
          } catch {
            job.status = "failed";
            results.push({ id: job.id, name: job.name, status: "failed" });
          }
        }
      }
      return { processed: results.length, results };
    },
    async checkDb() {
      return true;
    },
    async listOutbox(limit = 50) {
      return outbox.slice(0, limit);
    },
  };

  return {
    app,
    jobs,
    outbox,
    timeline,
    verdicts,
    pending,
    getWriteCount: () => writeCount,
    resetWriteCount: () => {
      writeCount = 0;
    },
    advanceMs: (ms: number) => {
      now.setTime(now.getTime() + ms);
    },
    async flush() {
      while (pending.length) {
        await Promise.all(pending.splice(0));
      }
    },
  };
}

describe("shield-api route handlers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects auth failures with 401/404 and zero writes", async () => {
    const f = makeFakeApp();
    const pairCode = createPairCodeHandler(() => f.app);
    const outboxGet = createOutboxHandler(() => f.app);
    const cronGet = createCronJobsHandler(() => f.app);
    const eventPost = createEventHandler(() => f.app);

    // 1. /api/shield/pair/code without/wrong x-dev-admin-token
    const r1 = await pairCode(
      new Request("http://localhost/api/shield/pair/code", {
        method: "POST",
        body: JSON.stringify({ family_id: FAMILY_ID, user_id: USER_ID }),
      }),
    );
    expect(r1.status).toBe(401);

    const r2 = await pairCode(
      new Request("http://localhost/api/shield/pair/code", {
        method: "POST",
        headers: { "x-dev-admin-token": "wrong-token" },
        body: JSON.stringify({ family_id: FAMILY_ID, user_id: USER_ID }),
      }),
    );
    expect(r2.status).toBe(401);

    // 2. /api/dev/outbox without/wrong token
    const r3 = await outboxGet(new Request("http://localhost/api/dev/outbox"));
    expect(r3.status).toBe(401);

    // 3. /api/cron/shield-jobs without/wrong x-cron-secret
    const r4 = await cronGet(
      new Request("http://localhost/api/cron/shield-jobs", {
        headers: { "x-cron-secret": "bad" },
      }),
    );
    expect(r4.status).toBe(401);

    // 4. /api/shield/event without HMAC headers
    const r5 = await eventPost(
      new Request("http://localhost/api/shield/event", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(r5.status).toBe(401);

    expect(f.getWriteCount()).toBe(0);
  });

  it("tool route rejects wrong token, disallowed IP, unknown tool (404), and unknown parent (404) with no writes", async () => {
    const f = makeFakeApp();
    const toolPost = createSarvamToolHandler(() => f.app);
    const route = (name: string) => ({ params: Promise.resolve({ name }) });

    // Wrong bearer token (even from allowed IP)
    const badToken = await toolPost(
      new Request("http://localhost/api/sarvam/tool/check_code_word", {
        method: "POST",
        headers: {
          authorization: "Bearer wrong",
          "x-forwarded-for": "4.213.167.70",
        },
        body: JSON.stringify({ family_id: FAMILY_ID, parent_id: PARENT_ID, heard: "gulab" }),
      }),
      route("check_code_word"),
    );
    expect(badToken.status).toBe(401);

    // Disallowed IP (valid bearer token, ALLOW_ANY_TOOL_IP not set)
    const badIp = await toolPost(
      new Request("http://localhost/api/sarvam/tool/check_code_word", {
        method: "POST",
        headers: {
          authorization: "Bearer sarvam-bearer-secret",
          "x-forwarded-for": "1.2.3.4",
        },
        body: JSON.stringify({ family_id: FAMILY_ID, parent_id: PARENT_ID, heard: "gulab" }),
      }),
      route("check_code_word"),
    );
    expect(badIp.status).toBe(401);

    // Unknown tool name -> 404
    const unknownTool = await toolPost(
      new Request("http://localhost/api/sarvam/tool/nonexistent_tool", {
        method: "POST",
        headers: {
          authorization: "Bearer sarvam-bearer-secret",
          "x-real-ip": "35.154.84.150",
        },
        body: JSON.stringify({ family_id: FAMILY_ID, parent_id: PARENT_ID }),
      }),
      route("nonexistent_tool"),
    );
    expect(unknownTool.status).toBe(404);

    // Unknown parent -> 404
    const unknownParent = await toolPost(
      new Request("http://localhost/api/sarvam/tool/check_code_word", {
        method: "POST",
        headers: {
          authorization: "Bearer sarvam-bearer-secret",
          "x-real-ip": "35.154.84.150",
        },
        body: JSON.stringify({
          variables: { family_id: FAMILY_ID, parent_id: "99999999-9999-4999-8999-999999999999" },
          heard: "gulab",
        }),
      }),
      route("check_code_word"),
    );
    expect(unknownParent.status).toBe(404);
    expect(f.getWriteCount()).toBe(0);

    // Valid token + allowed Sarvam IP + Sarvam variables -> 200
    const okRes = await toolPost(
      new Request("http://localhost/api/sarvam/tool/check_code_word", {
        method: "POST",
        headers: {
          authorization: "Bearer sarvam-bearer-secret",
          "x-forwarded-for": "::ffff:4.213.167.70",
        },
        body: JSON.stringify({
          variables: { family_id: FAMILY_ID, parent_id: PARENT_ID },
          heard: "gulab",
        }),
      }),
      route("check_code_word"),
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ ok: true });

    // ALLOW_ANY_TOOL_IP=1 bypasses IP check for local dev
    const fAnyIp = makeFakeApp({ ALLOW_ANY_TOOL_IP: "1" });
    const toolAnyIp = createSarvamToolHandler(() => fAnyIp.app);
    const localRes = await toolAnyIp(
      new Request("http://localhost/api/sarvam/tool/check_code_word", {
        method: "POST",
        headers: { authorization: "Bearer sarvam-bearer-secret" },
        body: JSON.stringify({ family_id: FAMILY_ID, parent_id: PARENT_ID, heard: "gulab" }),
      }),
      route("check_code_word"),
    );
    expect(localRes.status).toBe(200);
  });

  it("pairs a device, processes a red KYC event, and cron runs the due job once", async () => {
    const f = makeFakeApp();
    const pairCode = createPairCodeHandler(() => f.app);
    const pair = createPairHandler(() => f.app);
    const eventPost = createEventHandler(() => f.app);
    const cronGet = createCronJobsHandler(() => f.app);
    const outboxGet = createOutboxHandler(() => f.app);
    const healthGet = createHealthHandler(() => f.app);

    const hRes = await healthGet();
    expect(hRes.status).toBe(200);
    expect(await hRes.json()).toMatchObject({ ok: true, db: "ok", ports: { push: "outbox", whatsapp: "outbox" } });

    const codeRes = await pairCode(
      new Request("http://localhost/api/shield/pair/code", {
        method: "POST",
        headers: { "x-dev-admin-token": "dev-admin-secret" },
        body: JSON.stringify({ family_id: FAMILY_ID, user_id: USER_ID }),
      }),
    );
    expect(codeRes.status).toBe(200);
    const { code } = (await codeRes.json()) as { ok: true; code: string };

    const pairRes = await pair(
      new Request("http://localhost/api/shield/pair", {
        method: "POST",
        body: JSON.stringify({
          code,
          parent_person_id: PARENT_ID,
          platform: "android",
          protections: { sms: true },
        }),
      }),
    );
    expect(pairRes.status).toBe(200);
    const device = (await pairRes.json()) as { device_id: string; device_secret: string };

    const payload = ShieldEvent.parse({
      idempotency_key: "kyc-scam-test-001",
      family_id: FAMILY_ID,
      parent_id: PARENT_ID,
      device_id: device.device_id,
      channel: "device",
      kind: "sms",
      occurred_at: "2026-11-14T10:00:00.000Z",
      sender_type: "mobile_10",
      masked_text: "SBI KYC expire ho raha hai, update karein: <URL:sbi-kyc-update.in>",
    });
    const rawBody = JSON.stringify(payload);
    const ts = String(Date.parse("2026-11-14T10:00:00.000Z"));
    const sig = createHmac("sha256", device.device_secret).update(`${ts}.${rawBody}`).digest("hex");

    const evRes = await eventPost(
      new Request("http://localhost/api/shield/event", {
        method: "POST",
        headers: {
          [SHIELD_HEADERS.device]: device.device_id,
          [SHIELD_HEADERS.ts]: ts,
          [SHIELD_HEADERS.sig]: sig,
        },
        body: rawBody,
      }),
    );
    expect(evRes.status).toBe(200);
    await f.flush();

    expect([...f.verdicts.values()][0]?.verdict.level).toBe("red");
    expect(f.jobs.length).toBe(1);
    expect(f.jobs[0]?.name).toBe("shield.no_reaction_check");

    // Before due time -> 0 processed
    const earlyCron = await cronGet(
      new Request("http://localhost/api/cron/shield-jobs", {
        headers: { "x-cron-secret": "cron-secret-value" },
      }),
    );
    expect(earlyCron.status).toBe(200);
    expect(await earlyCron.json()).toMatchObject({ ok: true, processed: 0 });

    // Advance past DEMO_TIMER_SCALE=60 (120000 / 60 = 2000 ms) -> runs once
    f.advanceMs(3000);
    const dueCron1 = await cronGet(
      new Request("http://localhost/api/cron/shield-jobs", {
        headers: { "x-cron-secret": "cron-secret-value" },
      }),
    );
    expect(dueCron1.status).toBe(200);
    expect(await dueCron1.json()).toMatchObject({ ok: true, processed: 1 });

    // Second cron run -> 0 processed (idempotent)
    const dueCron2 = await cronGet(
      new Request("http://localhost/api/cron/shield-jobs", {
        headers: { "x-cron-secret": "cron-secret-value" },
      }),
    );
    expect(dueCron2.status).toBe(200);
    expect(await dueCron2.json()).toMatchObject({ ok: true, processed: 0 });

    const outboxRes = await outboxGet(
      new Request("http://localhost/api/dev/outbox", {
        headers: { "x-dev-admin-token": "dev-admin-secret" },
      }),
    );
    expect(outboxRes.status).toBe(200);
    const outboxBody = (await outboxRes.json()) as { ok: true; rows: OutboxRow[] };
    expect(outboxBody.rows.map((r) => `${r.channel}:${r.kind}`)).toEqual(
      expect.arrayContaining([
        "push:child_card",
        "whatsapp:send_shield_alert",
        "atlas:start_circle_chain",
      ]),
    );
  });

  it("gate allows only Shield actions and denies others (signed)", async () => {
    const signed: unknown[] = [];
    const gate = createGatePort(async (entry) => {
      signed.push(entry);
    });

    for (const action of ShieldAction.options) {
      expect(await gate.check({ familyId: FAMILY_ID, action })).toEqual({ allowed: true });
    }
    expect(await gate.check({ familyId: FAMILY_ID, action: "delete_sms" as never })).toEqual({ allowed: false });
    expect(signed.length).toBe(ShieldAction.options.length + 1);
  });

  it("canonicalJson and computeChainHash produce deterministic SHA-256 chain", () => {
    const a = { b: 2, a: 1, nested: { z: true, a: "x" }, omitted: undefined };
    const b = { nested: { a: "x", z: true }, a: 1, b: 2 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    const h1 = computeChainHash("0".repeat(64), a);
    const h2 = computeChainHash("0".repeat(64), b);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("whatsapp port uses Meta Cloud API when configured with real phone, else falls back to dev_outbox", async () => {
    const queries: string[] = [];
    const key = "19".repeat(32), identitySecret = "synthetic-identity-hash-secret-32-chars";
    const childId = "22222222-2222-4222-8222-222222222222";
    const row = { family_id: FAMILY_ID, person_id: childId, source: "whatsapp", account_id: "1234567890",
      external_id_hash: identityHash("whatsapp", "1234567890", "919000000002", identitySecret) };
    const contact = { ...row, contact_ciphertext: encryptWebhook(Buffer.from("+919000000002"), key, contactContext(row)) };
    const fakeSql = Object.assign(
      async (strings: TemplateStringsArray) => {
        const sqlText = strings.join("?");
        queries.push(sqlText);
        if (sqlText.includes("from public.people where id =")) {
          return [{ name: "Meena", phone: "+919000000001" }];
        }
        if (sqlText.includes("role='child'")) return [{ id: childId, name: "Riya" }];
        if (sqlText.includes("public.provider_identities")) return [contact];
        return [];
      },
      { json: (v: unknown) => v },
    ) as unknown as Parameters<typeof createWhatsappPort>[0];

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }));
    const wa = createWhatsappPort(
      fakeSql,
      { WHATSAPP_TOKEN: "wa-token", WHATSAPP_PHONE_NUMBER_ID: "1234567890", WHATSAPP_GRAPH_VERSION: "v27.0", WEBHOOK_ENCRYPTION_KEY: key, IDENTITY_HASH_SECRET: identitySecret },
      fetchMock as unknown as typeof fetch,
    );

    const res = await wa.sendShieldAlert({
      verdictId: "v-1",
      familyId: FAMILY_ID,
      parentId: PARENT_ID,
      quiet: false,
      push: true,
      offer1930: false,
      callToAction: "📞 Call Maa now",
      verdict: {
        level: "red",
        scam_type: "kyc_block",
        reasons: [{ rule_id: "r1", hi: "Fake KYC", en: "Fake KYC alert" }],
        checks_fired: ["r1"],
        ai_used: false,
        models_agreed: [],
        confidence: 1,
        actions: ["alert_child", "show_red_screen"],
      },
    });
    expect(res).toEqual({ delivered: "whatsapp_cloud_api", verdictId: "v-1" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v27.0/1234567890/messages");
    expect(JSON.parse(String(init.body))).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919000000002",
      type: "text",
    });
  });
});

