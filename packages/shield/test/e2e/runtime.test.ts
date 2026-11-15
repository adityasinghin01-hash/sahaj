import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRouter, type Provider } from "@sahaj/adapters";
import { SHIELD_HEADERS, ShieldEvent } from "@sahaj/shared";
import { createShieldRuntime } from "../../src/runtime";
import type { ShieldTimelineEntry, ShieldRuntimeTestPorts } from "../../src/runtime/types";
import { storage } from "./storage";
import { sha256Hex } from "../../src/tools/check_code_word";

const now = new Date("2026-11-14T10:00:00.000Z");
const secret = "runtime-e2e-pairing-secret-long-enough";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

async function fixture() {
  const store = await storage(); cleanups.push(store.close);
  const pending: Promise<unknown>[] = [];
  const rows: { entry: ShieldTimelineEntry; signature: string }[] = [];
  const jobs: { delay: number; name: string; payload: Record<string, unknown> }[] = [];
  const claimed = new Set<string>();
  const provider: Provider = vi.fn(async request => ({ kind: "text" as const, text: JSON.stringify({
    is_scam: request.input.includes("police"), scam_type: request.input.includes("police") ? "digital_arrest" : "unknown",
    pressure_signals: [], asks_for: [], confidence: 0.95, hindi_reason: "Police ki dhamki par rukiye.",
  }) }));
  const router = createRouter({ claude: provider, muse: provider, gemini: provider });
  const ports: ShieldRuntimeTestPorts = {
    db: store.db, router,
    whatsapp: { sendShieldAlert: vi.fn(async () => undefined), sendFamilyCheckCard: vi.fn(async () => undefined) },
    push: { childCard: vi.fn(async () => undefined) },
    calls: { getParentLine: vi.fn(async () => "parent-line"), callParent: vi.fn(async () => ({ status: "answered" as const })),
      startResponderCall: vi.fn(async () => undefined), startCallback: vi.fn(async () => undefined) },
    scheduler: {
      after: vi.fn(async (delay, name, payload) => { jobs.push({ delay, name, payload }); }),
      claim: vi.fn(async key => { if (claimed.has(key)) return false; claimed.add(key); return true; }),
    },
    atlas: { bridgeChild: vi.fn(async () => undefined), startCircleChain: vi.fn(async () => undefined) },
    gate: { check: vi.fn(async () => ({ allowed: true })) },
    sign: vi.fn(async entry => { rows.push({ entry: structuredClone(entry), signature: createHmac("sha256", "timeline-test-key").update(JSON.stringify(entry)).digest("hex") }); }),
    waitUntil(promise) { pending.push(promise); },
    env: { SHIELD_DEVICE_PAIRING_SECRET: secret, DEMO_TIMER_SCALE: "60" }, clock: { now: () => now },
    cache: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    log: { error: vi.fn() },
  };
  const runtime = store.sql ? createShieldRuntime({ ...ports, sql: store.sql }) : createShieldRuntime(ports);
  async function flush() { while (pending.length) await Promise.all(pending.splice(0)); }
  async function pair() {
    const code = await runtime.createPairingCode({ familyId: store.ctx.familyId, userId: store.userId });
    if (!code.ok) throw new Error("Pairing fixture failed");
    const response = await runtime.handleShieldPair(new Request("https://test/api/shield/pair", { method: "POST", body: JSON.stringify({
      code: code.code, parent_person_id: store.ctx.parentId, platform: "android", protections: { sms: true },
    }) }));
    expect(response.status).toBe(200);
    const device = await response.json() as { device_id: string; device_secret: string };
    // Independent Node HMAC, not the server's signing helper.
    expect(device.device_secret).toBe(createHmac("sha256", secret).update(device.device_id).digest("hex"));
    return device;
  }
  function event(deviceId: string, changes: Partial<ShieldEvent> = {}) {
    return ShieldEvent.parse({ idempotency_key: crypto.randomUUID(), family_id: store.ctx.familyId,
      parent_id: store.ctx.parentId, device_id: deviceId, channel: "device", kind: "sms", occurred_at: now.toISOString(),
      sender_type: "mobile_10", masked_text: "SBI KYC expire ho raha hai, update karein: <URL:sbi-kyc-update.in>", ...changes });
  }
  function request(device: { device_id: string; device_secret: string }, payload: ShieldEvent, tamper = false) {
    const body = JSON.stringify(payload), ts = String(now.getTime());
    return new Request("https://test/api/shield/event", { method: "POST", body: tamper ? body + " " : body,
      headers: { [SHIELD_HEADERS.device]: device.device_id, [SHIELD_HEADERS.ts]: ts,
        [SHIELD_HEADERS.sig]: createHmac("sha256", device.device_secret).update(`${ts}.${body}`).digest("hex") } });
  }
  return { ...store, runtime, ports, provider, pending, rows, jobs, flush, pair, event, request };
}

describe(`joined Shield runtime (${process.env.DATABASE_URL ? "Postgres" : "memory"})`, () => {
  it("Scene A: paired signed KYC event persists red, alerts, schedules and signs under four seconds", async () => {
    const f = await fixture(); const started = performance.now(); const device = await f.pair();
    const persistedBeforeAlert: boolean[] = [];
    vi.mocked(f.ports.whatsapp.sendShieldAlert).mockImplementation(async card => {
      persistedBeforeAlert.push((await f.db.brain.getVerdict(card.verdictId))?.verdict.level === "red");
    });
    vi.mocked(f.ports.push.childCard).mockImplementation(async card => {
      persistedBeforeAlert.push((await f.db.brain.getVerdict(card.verdictId))?.verdict.level === "red");
    });
    const response = await f.runtime.handleShieldEvent(f.request(device, f.event(device.device_id)));
    expect(response.status).toBe(200);
    const body = await response.json();
    await f.flush();
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(4000);
    const record = (await f.verdicts())[0]!;
    expect(record.verdict.level).toBe("red");
    expect(record.verdict.reasons.length).toBeGreaterThanOrEqual(3);
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.ports.whatsapp.sendShieldAlert).toHaveBeenCalledOnce();
    expect(f.ports.push.childCard).toHaveBeenCalledOnce();
    expect(persistedBeforeAlert).toEqual([true, true]);
    expect(f.jobs).toContainEqual({ delay: 2000, name: "shield.no_reaction_check", payload: { verdictId: record.id } });
    expect(f.rows.map(row => "step" in row.entry ? row.entry.step : row.entry.type)).toEqual(expect.arrayContaining([
      "load", "rules", "links", "ai", "verdict", "gate", "respond", "sign", "child_card_push", "whatsapp_alert",
    ]));
    for (const row of f.rows) expect(row.signature).toBe(createHmac("sha256", "timeline-test-key").update(JSON.stringify(row.entry)).digest("hex"));
    expect(JSON.stringify(vi.mocked(f.ports.push.childCard).mock.calls)).not.toContain("masked_text");
    expect(f.ports.log!.error).not.toHaveBeenCalled();
    expect(await f.db.getVerdictForEvent(body.event_id)).toMatchObject({ id: record.id });
    console.info(`C-03 Scene A: ${elapsed.toFixed(1)} ms (${process.env.DATABASE_URL ? "Postgres" : "memory"})`);
  });

  it("Scene B: active unknown-number context plus OTP SMS fires P1 red", async () => {
    const f = await fixture(); const device = await f.pair();
    await f.runtime.handleShieldEvent(f.request(device, f.event(device.device_id, {
      masked_text: "Your bank OTP is ******. Do not share.", sender_type: "business_header",
      context: { on_call_with_unsaved: true, call_started_at: "2026-11-14T09:59:00.000Z" },
    })));
    await f.flush();
    expect((await f.verdicts())[0]!.verdict).toMatchObject({ level: "red", checks_fired: expect.arrayContaining(["pattern.P1"]) });
  });

  it("Scene C: family card → Nahi tap → red fixed line, persisted verdict and child alert", async () => {
    const f = await fixture();
    const check = await f.runtime.shieldTools.run("family_check", f.ctx, { claimed_name: "Aman", asked_for: "paise" });
    expect(check.status).toBe("checking"); expect(check.check_id).toBeTruthy();
    expect(f.ports.whatsapp.sendFamilyCheckCard).toHaveBeenCalledOnce();
    await f.answer(check.check_id!, "denied");
    const result = await f.runtime.shieldTools.run("family_check_result", f.ctx, { check_id: check.check_id! });
    await f.flush();
    expect(result).toMatchObject({ status: "denied", level: "red", line_hi: "Ye Aman nahi the. Paise mat bhejiye." });
    expect((await f.verdicts())[0]!.verdict).toMatchObject({ level: "red", scam_type: "family_in_trouble" });
    expect(f.ports.whatsapp.sendShieldAlert).toHaveBeenCalledOnce(); expect(f.ports.push.childCard).toHaveBeenCalledOnce();
  });

  it("Scene D: real rules plus fake AI classify police video-call arrest, select clip four and bridge", async () => {
    const f = await fixture();
    const result = await f.runtime.shieldTools.run("classify_scam", f.ctx, { said: "police wale arrest bol rahe hain video call pe" });
    await f.flush();
    expect(result).toMatchObject({ level: "red", scam_type: "digital_arrest", stop_script_id: 4 });
    expect(f.ports.atlas.bridgeChild).toHaveBeenCalledOnce();
    expect(f.provider).toHaveBeenCalledOnce();
    expect((await f.verdicts())[0]!.verdict.level).toBe("red");
  });

  it("clean business-header bank OTP stays green with zero AI and alerts", async () => {
    const f = await fixture(); const device = await f.pair();
    await f.runtime.handleShieldEvent(f.request(device, f.event(device.device_id, {
      masked_text: "Your bank OTP is ******. Do not share.", sender_type: "business_header",
    })));
    await f.flush();
    expect((await f.verdicts())[0]!.verdict.level).toBe("green");
    expect(f.provider).not.toHaveBeenCalled(); expect(f.ports.push.childCard).not.toHaveBeenCalled();
    expect(f.ports.whatsapp.sendShieldAlert).not.toHaveBeenCalled(); expect(f.jobs).toHaveLength(0);
  });

  it("replay and concurrent brain entry run the graph once, even across runtime instances", async () => {
    const f = await fixture(); const device = await f.pair(), event = f.event(device.device_id);
    const first = await f.runtime.handleShieldEvent(f.request(device, event));
    const body = await first.json();
    const replay = await f.runtime.handleShieldEvent(f.request(device, event));
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });
    const other = f.sql ? createShieldRuntime({ ...f.ports, sql: f.sql }) : createShieldRuntime(f.ports);
    await Promise.all([f.runtime.runBrainForEvent(body.event_id), other.runBrainForEvent(body.event_id), f.flush()]);
    expect(await f.verdicts()).toHaveLength(1);
    expect(f.rows.filter(row => "step" in row.entry && row.entry.step === "load")).toHaveLength(1);
    expect(f.ports.whatsapp.sendShieldAlert).toHaveBeenCalledOnce();
  });

  it("tampered phone body is rejected before brain or persistence", async () => {
    const f = await fixture(); const device = await f.pair();
    const response = await f.runtime.handleShieldEvent(f.request(device, f.event(device.device_id), true));
    await f.flush(); expect(response.status).toBe(401); expect(await f.verdicts()).toHaveLength(0); expect(f.rows).toHaveLength(0);
  });

  it("routes no-reaction brain jobs and recognizes any recorded tap", async () => {
    const f = await fixture(); const device = await f.pair();
    await f.runtime.handleShieldEvent(f.request(device, f.event(device.device_id))); await f.flush();
    const job = f.jobs.find(job => job.name === "shield.no_reaction_check")!;
    await f.runtime.handleScheduledJob(job.name, job.payload);
    expect(f.ports.atlas.startCircleChain).toHaveBeenCalledOnce();
    await f.feedback(String(job.payload.verdictId));
    await f.runtime.handleScheduledJob(job.name, job.payload);
    expect(f.ports.atlas.startCircleChain).toHaveBeenCalledOnce();
  });

  it("routes family escalation and callback jobs with durable claims and scaled delays", async () => {
    const f = await fixture();
    const check = await f.runtime.shieldTools.run("family_check", f.ctx, { claimed_name: "Aman", asked_for: "paise" });
    const escalation = f.jobs.find(job => job.name === "shield.family_check.escalate")!;
    expect(escalation.delay).toBe(1000);
    expect(await f.runtime.handleScheduledJob(escalation.name, escalation.payload)).toMatchObject({ outcome: "escalated" });
    expect(await f.runtime.handleScheduledJob(escalation.name, escalation.payload)).toMatchObject({ outcome: "duplicate" });
    expect(f.ports.calls.startResponderCall).toHaveBeenCalledOnce();
    for (let i = 0; i < 2; i++) await f.runtime.shieldTools.run("family_check_result", f.ctx, { check_id: check.check_id! });
    const callback = f.jobs.find(job => job.name === "shield.family_check.callback")!;
    expect(callback.delay).toBe(90_000); // human floor: waits for a person on a real call
    expect(await f.runtime.handleScheduledJob(callback.name, callback.payload)).toMatchObject({ outcome: "callback_no_answer" });
    expect(await f.runtime.handleScheduledJob(callback.name, callback.payload)).toMatchObject({ outcome: "duplicate" });
    expect(f.ports.calls.startCallback).toHaveBeenCalledOnce();
    expect(await f.db.tools.getFamilyCheck(check.check_id!)).toMatchObject({ state: "no_answer" });
    expect((await f.verdicts())[0]!.verdict.level).toBe("yellow");
    expect(f.ports.push.childCard).toHaveBeenCalledOnce();
    await f.flush();
  });

  it("routes parent retry brain jobs and stops at three attempts", async () => {
    const f = await fixture();
    vi.mocked(f.ports.calls.callParent).mockResolvedValue({ status: "busy" });
    const source = ShieldEvent.parse({ ...f.event(""), device_id: undefined, channel: "keypad_voice", kind: "voice_report" });
    const { id } = await f.db.insertVoiceEvent(source);
    await f.runtime.runBrainForEvent(id);
    const second = f.jobs.find(job => job.name === "retryCallParent" && job.payload.attempt === 2)!;
    await f.runtime.handleScheduledJob(second.name, second.payload);
    const third = f.jobs.find(job => job.name === "retryCallParent" && job.payload.attempt === 3)!;
    await f.runtime.handleScheduledJob(third.name, third.payload);
    expect(f.ports.calls.callParent).toHaveBeenCalledTimes(3);
    expect(f.jobs.filter(job => job.name === "retryCallParent")).toHaveLength(2);
    await f.flush();
  });

  it("still alerts the child when parent-line lookup fails", async () => {
    const f = await fixture();
    vi.mocked(f.ports.calls.getParentLine).mockRejectedValue(new Error("provider secret error"));
    const source = ShieldEvent.parse({ ...f.event(""), device_id: undefined, channel: "keypad_voice", kind: "voice_report" });
    const { id } = await f.db.insertVoiceEvent(source);
    await f.runtime.runBrainForEvent(id); await f.flush();
    expect(f.ports.whatsapp.sendShieldAlert).toHaveBeenCalledOnce(); expect(f.ports.push.childCard).toHaveBeenCalledOnce();
    expect(f.ports.calls.callParent).not.toHaveBeenCalled();
    expect(f.rows.some(row => "step" in row.entry && row.entry.step === "call_parent" && row.entry.status === "skipped")).toBe(true);
    expect(JSON.stringify(vi.mocked(f.ports.log!.error).mock.calls)).not.toContain("provider secret error");
  });

  it("uses the supplied two-lock router for an ambiguous phone event", async () => {
    const f = await fixture(); const device = await f.pair();
    await f.runtime.handleShieldEvent(f.request(device, f.event(device.device_id, {
      masked_text: "KYC update", sender_type: "business_header", context: { private_marker: "Maa-only-context" },
    })));
    await f.flush();
    expect(f.provider).toHaveBeenCalledTimes(2);
    const record = (await f.verdicts())[0]!;
    expect(record.verdict.ai_used).toBe(true);
    expect(record.verdict.models_agreed).toEqual(["claude", "muse"]);
    for (const [request] of vi.mocked(f.provider).mock.calls) {
      expect(request.task).toBe("shield.judge"); expect(request.input).toBe("KYC update");
      expect(JSON.stringify(request)).not.toContain("Maa-only-context");
    }
  });

  it("uses persisted call history for P1, without trusting local red or matched_rules", async () => {
    const f = await fixture(); const device = await f.pair();
    await f.runtime.handleShieldEvent(f.request(device, f.event(device.device_id, {
      kind: "call_in", caller_type: "mobile_10", masked_text: undefined, occurred_at: "2026-11-14T09:59:00.000Z",
    })));
    await f.flush();
    await f.runtime.handleShieldEvent(f.request(device, f.event(device.device_id, {
      masked_text: "OTP ******", sender_type: "business_header",
    })));
    await f.flush();
    expect((await f.verdicts()).find(row => row.event.kind === "sms")!.verdict).toMatchObject({ level: "red", checks_fired: expect.arrayContaining(["pattern.P1"]) });
    const independent = await fixture(); const paired = await independent.pair();
    await independent.runtime.handleShieldEvent(independent.request(paired, independent.event(paired.device_id, {
      masked_text: "Hello", local_level: "red", matched_rules: ["pattern.P1"], sender_type: "business_header",
    })));
    await independent.flush();
    expect((await independent.verdicts())[0]!.verdict.level).toBe("green");
  });

  it("binds check_message, check_code_word and money_sent with real persistence and effects", async () => {
    const f = await fixture();
    expect(await f.runtime.shieldTools.run("check_message", f.ctx, { from_kind: "unknown_number", mentions: ["bank", "sbi-kyc-update.in"] })).toMatchObject({ level: "red" });
    await f.setCodeWord(await sha256Hex("gulab"));
    expect(await f.runtime.shieldTools.run("check_code_word", f.ctx, { heard: "Gulab" })).toEqual({ ok: true });
    expect(await f.runtime.shieldTools.run("check_code_word", f.ctx, { heard: "wrong" })).toMatchObject({ ok: false, level: "red" });
    expect(await f.runtime.shieldTools.run("money_sent", f.ctx, { amount_said: "50000", how: "UPI" })).toMatchObject({ level: "red", line_id: 7 });
    await f.flush();
    expect(await f.verdicts()).toHaveLength(3);
    expect(f.ports.atlas.startCircleChain).toHaveBeenCalledOnce();
    expect(f.ports.whatsapp.sendShieldAlert).toHaveBeenCalledTimes(3);
  });

  it("rechecks consent for brain jobs and gates tool alert/bridge effects", async () => {
    const f = await fixture(); const device = await f.pair();
    await f.runtime.handleShieldEvent(f.request(device, f.event(device.device_id))); await f.flush();
    const job = f.jobs.find(job => job.name === "shield.no_reaction_check")!;
    vi.mocked(f.ports.gate.check).mockResolvedValue({ allowed: false });
    await f.runtime.handleScheduledJob(job.name, job.payload);
    expect(f.ports.atlas.startCircleChain).not.toHaveBeenCalled();
    await f.runtime.shieldTools.run("classify_scam", f.ctx, { said: "police wale arrest bol rahe hain video call pe" });
    await f.flush();
    expect(f.ports.atlas.bridgeChild).not.toHaveBeenCalled();
    expect(f.ports.push.childCard).toHaveBeenCalledOnce();
    expect(f.rows.some(row => "status" in row.entry && row.entry.status === "denied")).toBe(true);
  });

  it("rejects unknown jobs, invalid brain jobs, missing events and wrong tool families", async () => {
    const f = await fixture();
    await expect(f.runtime.handleScheduledJob("unknown", {})).rejects.toThrow("Unknown Shield scheduled job");
    await expect(f.runtime.handleScheduledJob("retryCallParent", { verdictId: "missing", attempt: 4 })).rejects.toThrow();
    expect(await f.runtime.handleScheduledJob("shield.family_check.callback", {})).toMatchObject({ outcome: "invalid_payload" });
    await expect(f.runtime.runBrainForEvent(crypto.randomUUID())).rejects.toThrow("Shield event not found");
    await expect(f.runtime.shieldTools.run("family_check", { ...f.ctx, familyId: crypto.randomUUID() }, { claimed_name: "Aman", asked_for: "paise" })).rejects.toThrow("Shield tool parent not found");
  });
});
