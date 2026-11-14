import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createDefaultRouter } from "@sahaj/adapters";
import { SHIELD_HEADERS } from "@sahaj/shared";
import {
  createShieldRuntime,
  deriveDeviceSecret,
  numberFingerprint,
  signShieldBody,
  type ShieldDeviceRow,
  type ShieldProtections,
  type ShieldRuntimeDb,
  type ShieldRuntimeTestPorts,
} from "@sahaj/shield";
import type { NewGatewayEventRow } from "@sahaj/shield/src/gateway/types";
import type { ShieldApp } from "@/lib/app";
import {
  GatewayParentBodySchema,
  registerGatewayParentWithAdapter,
  type GatewayParentInput,
} from "@/lib/gateway_admin";
import { createCronJobsHandler, createSarvamToolHandler } from "@/lib/handlers";
import { handleShieldHeartbeat } from "@/lib/heartbeat";
import { createPhase2Service, createKeyedAsyncMutex, type VerdictFeedbackRow } from "@/lib/phase2";
import {
  createGatewayParentHandler,
  createHeartbeatHandler,
  createSmsGatewayHandler,
} from "@/lib/phase3_handlers";
import { createGatePort } from "@/ports/gate";

const FAMILY_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_ID = "22222222-2222-4222-8222-222222222221";
const DEVICE_ID = "99999999-9999-4999-8999-999999999991";
const PAIRING_SECRET = "test-pairing-secret-at-least-32-chars";
const GATEWAY_SECRET = "test-sms-gateway-secret-at-least-32-chars";
const DEV_TOKEN = "dev-admin-secret";
const SARVAM_TOKEN = "sarvam-bearer-secret";
const CRON_TOKEN = "cron-secret-value";

async function makePhase3App(envOverrides: Record<string, string | undefined> = {}) {
  const now = new Date("2026-11-14T10:00:00.000Z");
  let writeCount = 0;

  const deviceSecret = await deriveDeviceSecret(PAIRING_SECRET, DEVICE_ID);
  const deviceSecretHash = createHash("sha256").update(deviceSecret, "utf8").digest("hex");

  const devices = new Map<
    string,
    ShieldDeviceRow & {
      protections: ShieldProtections;
      android_version: string | null;
      app_version: string | null;
      last_heartbeat_at: Date | null;
    }
  >([
    [
      DEVICE_ID,
      {
        id: DEVICE_ID,
        family_id: FAMILY_ID,
        person_id: PARENT_ID,
        device_secret_hash: deviceSecretHash,
        protections: {
          sms: false,
          screening: false,
          redirection: false,
          usage: false,
          notifications: false,
          overlay: false,
        },
        android_version: "14",
        app_version: "0.9.0",
        last_heartbeat_at: null,
      },
    ],
  ]);

  const gatewayParents = new Map<string, { family_id: string; parent_id: string }>();
  const gatewayEvents = new Map<string, NewGatewayEventRow & { id: string }>();
  const verdictsByEvent = new Map<string, { id: string; level: string }>();
  const jobs: { id: string; name: string; payload: Record<string, unknown>; runAt: Date; status: "pending" | "done" | "failed" }[] = [];
  const pending: Promise<unknown>[] = [];
  const toolCalls: { name: string; input: unknown }[] = [];
  const scheduledJobCalls: { name: string; payload: unknown }[] = [];
  const mutex = createKeyedAsyncMutex();

  const router = createDefaultRouter({ env: {} });
  const sign: ShieldRuntimeTestPorts["sign"] = async () => {
    writeCount++;
  };

  const env: Record<string, string | undefined> = {
    DEV_ADMIN_TOKEN: DEV_TOKEN,
    SARVAM_TOOL_TOKEN: SARVAM_TOKEN,
    CRON_SECRET: CRON_TOKEN,
    SHIELD_DEVICE_PAIRING_SECRET: PAIRING_SECRET,
    SMS_GATEWAY_SECRET: GATEWAY_SECRET,
    ALLOW_ANY_TOOL_IP: "1",
    ...envOverrides,
  };

  const db: ShieldRuntimeDb = {
    server: {
      async getDevice(id) {
        return devices.get(id) ?? null;
      },
      async insertDevice() {},
      async insertEvent() {
        return { id: crypto.randomUUID() };
      },
      async touchHeartbeat() {},
      async getPerson(id) {
        return id === PARENT_ID ? { id: PARENT_ID, family_id: FAMILY_ID } : null;
      },
      async countActivePairingCodes() {
        return 0;
      },
      async insertPairingCode() {},
      async claimPairingCode() {
        return null;
      },
      async expireActivePairingCodes() {},
      async recordPairingFailure() {},
      async countPairingFailures() {
        return 0;
      },
      async getPairingLockedUntil() {
        return null;
      },
      async setPairingLockedUntil() {},
    },
    gateway: {
      async findParentByPhoneHash(hash) {
        return gatewayParents.get(hash) ?? null;
      },
      async insertGatewayEvent(row) {
        writeCount++;
        for (const ev of gatewayEvents.values()) {
          if (ev.idempotency_key === row.idempotency_key) return { duplicate: true };
        }
        const id = crypto.randomUUID();
        gatewayEvents.set(id, { ...row, id });
        return { id };
      },
    },
    tools: {
      async createFamilyCheck() {
        return { id: crypto.randomUUID() };
      },
      async getFamilyCheck() {
        return null;
      },
      async findPersonByName() {
        return null;
      },
      async getCodeWordHash() {
        return null;
      },
      async markFamilyCheckNoAnswer() {
        return false;
      },
    },
    brain: {
      async getParent({ familyId, parentId }) {
        return familyId === FAMILY_ID && parentId === PARENT_ID ? { id: PARENT_ID, family_id: FAMILY_ID } : null;
      },
      async getRecentEvents() {
        return [];
      },
      async insertVerdict({ event, verdict }) {
        writeCount++;
        const id = crypto.randomUUID();
        verdictsByEvent.set(event.idempotency_key, { id, level: verdict.level });
        return { id };
      },
      async getVerdict() {
        return null;
      },
      async hasChildReaction() {
        return false;
      },
    },
    async getEvent(id) {
      const ev = gatewayEvents.get(id);
      if (!ev) return null;
      return {
        idempotency_key: ev.idempotency_key,
        family_id: ev.family_id,
        parent_id: ev.parent_id,
        channel: "gateway_sms",
        kind: "sms",
        occurred_at: ev.occurred_at,
        masked_text: ev.masked_text ?? undefined,
        link_domains: ev.link_domains,
        matched_rules: [],
        context: ev.context,
      };
    },
    async insertVoiceEvent() {
      return { id: crypto.randomUUID() };
    },
    async getVerdictForEvent() {
      return null;
    },
    async withEventLock(id, work) {
      return mutex(id, () => work(db));
    },
  };

  const ports: ShieldRuntimeTestPorts = {
    db,
    router: { understand: router.understand, twoLock: router.twoLock },
    whatsapp: { sendShieldAlert: async () => undefined, sendFamilyCheckCard: async () => undefined },
    push: { childCard: async () => undefined },
    calls: {
      getParentLine: async () => "dev-outbox-line",
      callParent: async () => ({ status: "answered" }),
      startResponderCall: async () => undefined,
      startCallback: async () => undefined,
    },
    scheduler: {
      async after() {},
      async claim() {
        return true;
      },
    },
    atlas: { bridgeChild: async () => undefined, startCircleChain: async () => undefined },
    gate: createGatePort(sign),
    sign,
    waitUntil(p) {
      pending.push(p);
    },
    env: {
      SHIELD_DEVICE_PAIRING_SECRET: PAIRING_SECRET,
      SMS_GATEWAY_SECRET: env.SMS_GATEWAY_SECRET,
    },
    clock: { now: () => now },
    cache: { get: async () => null, set: async () => undefined },
  };

  const runtime = createShieldRuntime(ports);

  const phase2 = createPhase2Service({
    store: {
      async hasParentInFamily() {
        return false;
      },
      async hasFamily() {
        return false;
      },
      async withVerdictFeedbackLock(id, fn) {
        return mutex(id, fn);
      },
      async getVerdictRow(): Promise<VerdictFeedbackRow | null> {
        return null;
      },
      async setVerdictFeedbackIfUnset() {
        return null;
      },
      async recordBusyRetryOutbox() {},
    },
    busyDeps: {
      db: {
        getOpenBusyStreak: async () => null,
        getBusyStreak: async () => null,
        startBusyStreak: async () => {
          throw new Error("unused");
        },
        extendBusyStreak: async () => null,
        closeBusyStreak: async () => false,
        busyStreakDurationsMs: async () => [],
        claimBusyAlert: async () => false,
        markBusyAlertReplied: async () => false,
        claimBusyCircle: async () => false,
      },
      scheduler: { after: async () => undefined },
      alerts: { sendBusyAlert: async () => undefined },
      atlas: { startCircleChain: async () => undefined },
      sign,
      clock: { now: () => now },
    },
    warningsDeps: {
      db: {
        getVerdictForFeedback: async () => null,
        recordScamIndicator: async () => {
          throw new Error("unused");
        },
        topConfirmedIndicator: async () => null,
      },
      llm: { understand: async () => ({ ok: false, reason: "offline" }) },
      clock: { now: () => now },
    },
    clock: { now: () => now },
    async fallbackHandleScheduledJob(name, payload) {
      scheduledJobCalls.push({ name, payload });
      if (name === "shield.drill.experience") {
        return { job: name, outcome: "dispatched" };
      }
      return runtime.handleScheduledJob(name, payload);
    },
  });

  // Wrap shieldTools.run when testing Phase 3 pending tools so we verify routing independently of Kiro B's registration
  const wrappedRuntime = {
    ...runtime,
    shieldTools: {
      async run(name: string, ctx: { familyId: string; parentId: string }, input: unknown) {
        toolCalls.push({ name, input });
        if (name === "experience_turn" || name === "call_screen") {
          return { ok: true, routedTool: name, ctx, input };
        }
        return runtime.shieldTools.run(name as Parameters<typeof runtime.shieldTools.run>[0], ctx, input as never);
      },
    } as typeof runtime.shieldTools,
  };

  const gatewayStore = {
    async hasParentInFamily(familyId: string, parentId: string) {
      return familyId === FAMILY_ID && parentId === PARENT_ID;
    },
    async upsertGatewayParent(input: { phoneHash: string; familyId: string; parentId: string }) {
      writeCount++;
      gatewayParents.set(input.phoneHash, { family_id: input.familyId, parent_id: input.parentId });
    },
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
    runtime: wrappedRuntime,
    recordBusyCallStatus: phase2.submitCallStatus,
    recordBusyReply: phase2.submitBusyReply,
    recordChildFeedback: phase2.submitChildFeedback,
    getWeeklyTip: phase2.fetchWeeklyTip,
    registerGatewayParent: (input: GatewayParentInput) =>
      registerGatewayParentWithAdapter({ store: gatewayStore, input }),
    recordDeviceHeartbeat: (req: Request) =>
      handleShieldHeartbeat(req, {
        store: {
          async getDevice(id) {
            return devices.get(id) ?? null;
          },
          async updateDeviceHeartbeat(input) {
            writeCount++;
            const row = devices.get(input.deviceId);
            if (!row) return null;
            if (row.last_heartbeat_at && row.last_heartbeat_at > input.sentAt) {
              return null;
            }
            row.protections = input.protections;
            row.android_version = input.androidVersion;
            row.app_version = input.appVersion;
            row.last_heartbeat_at = input.sentAt;
            return {
              id: row.id,
              protections: row.protections,
              android_version: row.android_version,
              app_version: row.app_version,
              last_heartbeat_at: row.last_heartbeat_at.toISOString(),
            };
          },
        },
        pairingSecret: env.SHIELD_DEVICE_PAIRING_SECRET,
        clock: { now: () => now },
      }),
    async runDueJobs() {
      const results: { id: string; name: string; status: "done" | "failed"; result?: unknown; error?: string }[] = [];
      for (const job of jobs) {
        if (job.status === "pending" && job.runAt <= now) {
          try {
            const result = await phase2.dispatchScheduledJob(job.name, job.payload, job.id);
            job.status = "done";
            results.push({ id: job.id, name: job.name, status: "done", result });
          } catch (err) {
            const msg = err instanceof Error ? err.message.slice(0, 200) : "job_failed";
            job.status = "failed";
            results.push({ id: job.id, name: job.name, status: "failed", error: msg });
          }
        }
      }
      return { processed: results.length, results };
    },
    async checkDb() {
      return true;
    },
    async listOutbox() {
      return [];
    },
  };

  return {
    app,
    now,
    deviceSecret,
    devices,
    gatewayParents,
    gatewayEvents,
    verdictsByEvent,
    jobs,
    toolCalls,
    scheduledJobCalls,
    get writeCount() {
      return writeCount;
    },
    async flush() {
      while (pending.length) {
        await Promise.all(pending.splice(0));
      }
    },
  };
}

describe("@sahaj/shield-api Phase 3 host routes", () => {
  let ctx: Awaited<ReturnType<typeof makePhase3App>>;

  beforeEach(async () => {
    ctx = await makePhase3App();
  });

  it("Part A & B: registers gateway parent hashed, handles valid SMS, rejects wrong secret, deduplicates replay, and ignores unknown sender", async () => {
    const regHandler = createGatewayParentHandler(() => ctx.app);
    const smsHandler = createSmsGatewayHandler(() => ctx.app);

    // 401 on missing dev admin token
    const unauthReg = await regHandler(
      new Request("http://localhost/api/dev/shield/gateway-parent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ family_id: FAMILY_ID, parent_id: PARENT_ID, phone: "+919000000001" }),
      }),
    );
    expect(unauthReg.status).toBe(401);

    // Valid schema check
    expect(GatewayParentBodySchema.safeParse({ family_id: FAMILY_ID, parent_id: PARENT_ID, phone: "+919000000001" }).success).toBe(true);

    const okReg = await regHandler(
      new Request("http://localhost/api/dev/shield/gateway-parent", {
        method: "POST",
        headers: { "content-type": "application/json", "x-dev-admin-token": DEV_TOKEN },
        body: JSON.stringify({ family_id: FAMILY_ID, parent_id: PARENT_ID, phone: "+919000000001" }),
      }),
    );
    expect(okReg.status).toBe(200);
    const expectedHash = await numberFingerprint("+919000000001");
    expect(expectedHash).toBeTruthy();
    expect(ctx.gatewayParents.has(expectedHash!)).toBe(true);

    // Wrong gateway secret -> 401
    const badSms = await smsHandler(
      new Request("http://localhost/api/sms/gateway", {
        method: "POST",
        headers: { "content-type": "application/json", "x-sahaj-gateway-secret": "wrong" },
        body: JSON.stringify({
          from: "+919000000001",
          body: "KYC blocked share OTP 482910 now https://kyc-fake.example",
          received_at: ctx.now.toISOString(),
          gateway_id: "gw-1",
        }),
      }),
    );
    expect(badSms.status).toBe(401);

    // Unknown sender -> 200 { ignored: true }
    const unknownSms = await smsHandler(
      new Request("http://localhost/api/sms/gateway", {
        method: "POST",
        headers: { "content-type": "application/json", "x-sahaj-gateway-secret": GATEWAY_SECRET },
        body: JSON.stringify({
          from: "+919000000009",
          body: "Hello test message",
          received_at: ctx.now.toISOString(),
          gateway_id: "gw-1",
        }),
      }),
    );
    expect(unknownSms.status).toBe(200);
    expect(await unknownSms.json()).toEqual({ ignored: true });
    expect(ctx.gatewayEvents.size).toBe(0);

    // Registered sender -> stored masked + verdict created in background
    const payload = JSON.stringify({
      from: "+919000000001",
      body: "URGENT KYC blocked OTP 482910 click https://kyc-fake.example",
      received_at: ctx.now.toISOString(),
      gateway_id: "gw-1",
    });
    const okSms = await smsHandler(
      new Request("http://localhost/api/sms/gateway", {
        method: "POST",
        headers: { "content-type": "application/json", "x-sahaj-gateway-secret": GATEWAY_SECRET },
        body: payload,
      }),
    );
    expect(okSms.status).toBe(200);
    const okData = await okSms.json();
    expect(okData.ok).toBe(true);
    await ctx.flush();

    const stored = [...ctx.gatewayEvents.values()][0];
    expect(stored).toBeDefined();
    expect(stored!.masked_text).not.toContain("482910");
    expect(ctx.verdictsByEvent.size).toBe(1);

    // Replay -> duplicate
    const replaySms = await smsHandler(
      new Request("http://localhost/api/sms/gateway", {
        method: "POST",
        headers: { "content-type": "application/json", "x-sahaj-gateway-secret": GATEWAY_SECRET },
        body: payload,
      }),
    );
    expect(replaySms.status).toBe(200);
    expect(await replaySms.json()).toEqual({ ok: true, duplicate: true });
  });

  it("Part C: verifies device HMAC + timestamp skew on /api/shield/heartbeat and updates protections", async () => {
    const heartbeat = createHeartbeatHandler(() => ctx.app);
    const rawBody = JSON.stringify({
      device_id: DEVICE_ID,
      protections: {
        sms: true,
        screening: true,
        redirection: false,
        usage: true,
        notifications: true,
        overlay: false,
      },
      android_version: "15",
      app_version: "1.0.3",
      sent_at: ctx.now.toISOString(),
    });
    const ts = String(ctx.now.getTime());
    const sig = await signShieldBody(ctx.deviceSecret, ts, rawBody);

    // Bad sig -> 401
    const badSig = await heartbeat(
      new Request("http://localhost/api/shield/heartbeat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SHIELD_HEADERS.device]: DEVICE_ID,
          [SHIELD_HEADERS.ts]: ts,
          [SHIELD_HEADERS.sig]: "0".repeat(64),
        },
        body: rawBody,
      }),
    );
    expect(badSig.status).toBe(401);

    // Stale ts -> 401
    const oldTs = String(ctx.now.getTime() - 10 * 60_000);
    const oldSig = await signShieldBody(ctx.deviceSecret, oldTs, rawBody);
    const staleRes = await heartbeat(
      new Request("http://localhost/api/shield/heartbeat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SHIELD_HEADERS.device]: DEVICE_ID,
          [SHIELD_HEADERS.ts]: oldTs,
          [SHIELD_HEADERS.sig]: oldSig,
        },
        body: rawBody,
      }),
    );
    expect(staleRes.status).toBe(401);

    // Valid signed heartbeat -> 200 and updates row
    const okRes = await heartbeat(
      new Request("http://localhost/api/shield/heartbeat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SHIELD_HEADERS.device]: DEVICE_ID,
          [SHIELD_HEADERS.ts]: ts,
          [SHIELD_HEADERS.sig]: sig,
        },
        body: rawBody,
      }),
    );
    expect(okRes.status).toBe(200);
    const body = await okRes.json();
    expect(body.ok).toBe(true);
    expect(body.app_version).toBe("1.0.3");
    expect(ctx.devices.get(DEVICE_ID)?.protections.sms).toBe(true);
    expect(ctx.devices.get(DEVICE_ID)?.android_version).toBe("15");
    expect(ctx.devices.get(DEVICE_ID)?.last_heartbeat_at?.toISOString()).toBe(ctx.now.toISOString());
  });

  it("Part D: gates call_screen by CALL_GATEWAY_ENABLED, routes Phase 3 tools, and passes shield.drill.experience through runtime.handleScheduledJob", async () => {
    const sarvam = createSarvamToolHandler(() => ctx.app);
    const cron = createCronJobsHandler(() => ctx.app);

    // Disabled by default -> 404 { enabled: false }
    const disabledCallScreen = await sarvam(
      new Request("http://localhost/api/sarvam/tool/call_screen", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${SARVAM_TOKEN}` },
        body: JSON.stringify({ variables: { family_id: FAMILY_ID, parent_id: PARENT_ID }, from: "+919000000002" }),
      }),
      { params: Promise.resolve({ name: "call_screen" }) },
    );
    expect(disabledCallScreen.status).toBe(404);
    expect(await disabledCallScreen.json()).toEqual({ enabled: false });

    // Enable CALL_GATEWAY_ENABLED=1 -> routes through runtime.shieldTools.run
    const enabledCtx = await makePhase3App({ CALL_GATEWAY_ENABLED: "1" });
    const enabledSarvam = createSarvamToolHandler(() => enabledCtx.app);
    for (const toolName of ["experience_turn", "call_screen"]) {
      const res = await enabledSarvam(
        new Request(`http://localhost/api/sarvam/tool/${toolName}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${SARVAM_TOKEN}` },
          body: JSON.stringify({ variables: { family_id: FAMILY_ID, parent_id: PARENT_ID }, said: "hello" }),
        }),
        { params: Promise.resolve({ name: toolName }) },
      );
      expect(res.status).toBe(200);
    }
    expect(enabledCtx.toolCalls.map((c) => c.name)).toEqual(["experience_turn", "call_screen"]);

    // Cron dispatches shield.drill.experience via runtime.handleScheduledJob while unknown fails explicitly
    ctx.jobs.push(
      { id: "job-drill", name: "shield.drill.experience", payload: { family_id: FAMILY_ID, parent_id: PARENT_ID }, runAt: ctx.now, status: "pending" },
      { id: "job-unknown", name: "shield.invalid.unknown", payload: {}, runAt: ctx.now, status: "pending" },
    );
    const cronRes = await cron(
      new Request("http://localhost/api/cron/shield-jobs", {
        method: "GET",
        headers: { "x-cron-secret": CRON_TOKEN },
      }),
    );
    expect(cronRes.status).toBe(200);
    const cronData = await cronRes.json();
    expect(cronData.results).toEqual([
      { id: "job-drill", name: "shield.drill.experience", status: "done", result: { job: "shield.drill.experience", outcome: "dispatched" } },
      { id: "job-unknown", name: "shield.invalid.unknown", status: "failed", error: "Unknown Shield scheduled job" },
    ]);
  });
});
