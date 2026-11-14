import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcDb } from "../../src/lib/atlas-runtime/db";
import { dispatchEvents, routeEventKind, runCommandJobs, type CommandEvent } from "../../src/lib/atlas-runtime/runner";
import { createCore1CommandHandler, createCore2EventHandler, runMissedCallNudgePass, type Core1CommandPorts } from "../../src/lib/atlas-runtime/command-handlers";
import { encryptWebhook } from "../../src/lib/webhook-security";
import type { Core1OutboxEnqueueInput, Core1TimelineInput } from "../../src/lib/core1/wiring-common";

const KEY = "cd".repeat(32);
const FAMILY = "b4000000-0000-4000-8000-000000000001";
const JOB = "d4000000-0000-4000-8000-000000000001";
const EVENT = "e4000000-0000-4000-8000-000000000001";
const TOKEN = "94000000-0000-4000-8000-000000000001";
const MAA = "c4000000-0000-4000-8000-000000000001";
const RIYA = "c4000000-0000-4000-8000-000000000002";
const ROHIT = "c4000000-0000-4000-8000-000000000003";
const INCIDENT = "f4000000-0000-4000-8000-000000000001";
const ASSIGNMENT = "f4000000-0000-4000-8000-000000000002";
const PROOF = "f4000000-0000-4000-8000-000000000003";
const SCOPED = "scoped-key-1";
const ok = (data: unknown) => ({ data, error: null });

afterEach(() => vi.restoreAllMocks());

function commandEvent(command: string, body: unknown, over: Partial<CommandEvent> = {}): CommandEvent {
  return { familyId: FAMILY, jobId: JOB, eventId: EVENT, source: "core1_command", providerEventId: SCOPED, eventType: `command.${command}`,
    metadata: { command, actorPersonId: RIYA },
    payloadCiphertext: encryptWebhook(Buffer.from(JSON.stringify(body)), KEY, `core1:${FAMILY}:${SCOPED}`), ...over };
}

function fakePorts(over: Partial<Core1CommandPorts["urgent"]> = {}) {
  const outbox: Core1OutboxEnqueueInput[] = [], timeline: Core1TimelineInput[] = [], alerts: unknown[] = [], offers: unknown[] = [], accepts: unknown[] = [];
  const seenTimeline = new Set<string>();
  const ports: Core1CommandPorts = {
    encryptionKeyHex: KEY,
    outbox: { async enqueue(i) { const dup = outbox.some(o => o.dedupeKey === i.dedupeKey); if (!dup) outbox.push(i); return { outboxId: `ob-${outbox.length}`, deduped: dup }; } },
    timeline: { async append(i) { timeline.push(i); seenTimeline.add(i.dedupeKey); return { sequence: timeline.length, chainHash: "h", deduped: false }; } },
    async hasTimeline(_f, key) { return seenTimeline.has(key); },
    urgent: {
      async createOffer(p) { offers.push(p); return { incidentId: INCIDENT, assignmentId: ASSIGNMENT, state: "offered" }; },
      async acceptVerified(p) { accepts.push(p); return { ok: true }; },
      async listChildren() { return [RIYA, ROHIT]; },
      async recordChildAlert(p) { alerts.push(p); },
      ...over,
    },
  };
  return { ports, outbox, timeline, alerts, offers, accepts };
}

describe("routing Core 1 commands and Core 2 events", () => {
  it("routes every Core 1 command, Maa device command and Core 2 event type; still dead-letters unknown types", () => {
    for (const c of ["check_in", "urgent_help", "voice_message", "refill_proposal", "missed_call_nudge", "family_report"]) expect(routeEventKind(`command.${c}`)).toBe("core1.command");
    for (const t of ["urgent_help", "voice_message"]) expect(routeEventKind(t)).toBe("core1.command");
    for (const t of ["core2.watch.started", "core2.watch.safe", "core2.sos.triggered", "core2.incident.accepted", "core2.device.status", "core2.truth_line.checked"]) {
      expect(routeEventKind(t)).toBe("core2.event");
    }
    for (const bad of ["command.payment", "command.", "core2.", "core2.watch", "core2.Watch.safe", "command.check_in.x"]) expect(routeEventKind(bad)).toBeNull();
  });
  it("logs the reason when it dead-letters, with the event type only", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls: string[] = [];
    const db: RpcDb = { async rpc(n) { calls.push(n); return ok(true); } };
    expect(await dispatchEvents(db, [{ id: EVENT, event_type: "mystery.kind", lease_token: TOKEN }])).toEqual({ dispatched: 0, deadLettered: 1, failed: 0 });
    expect(calls).toEqual(["dead_letter_raw_event"]);
    expect(warn.mock.calls[0][0]).toContain("unknown_event_type event_type=mystery.kind");
  });
});

describe("runCommandJobs", () => {
  const job = (kind: string) => ({ id: JOB, family_id: FAMILY, workflow_kind: kind, lease_token: TOKEN, checkpoint_ref: null });
  function db(kind: string, ev: Record<string, unknown>) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const d: RpcDb = { async rpc(n, a = {}) { calls.push([n, a]);
      if (n === "claim_workflow_jobs_for_kinds") return ok([job(kind)]);
      if (n === "load_job_event") return ok(ev);
      return ok(true); } };
    return { d, calls };
  }
  const ev = { eventId: EVENT, source: "core1_command", providerEventId: SCOPED, eventType: "command.check_in", metadata: { command: "check_in" }, payloadCiphertext: "c" };

  it("claims nothing without handlers", async () => {
    const calls: string[] = [];
    expect(await runCommandJobs({ db: { async rpc(n) { calls.push(n); return ok([]); } }, workerId: "w", handlers: {} })).toMatchObject({ status: "unavailable" });
    expect(calls).toEqual([]);
  });
  it("claims only kinds with a handler and passes the stored event, ciphertext included", async () => {
    const { d, calls } = db("core1.command", ev);
    const seen: CommandEvent[] = [];
    const out = await runCommandJobs({ db: d, workerId: "w", handlers: { core1: async e => { seen.push(e); return { action: "done", code: "check_in_queued" }; } } });
    expect(calls[0][1].p_kinds).toEqual(["core1.command"]);
    expect(seen[0]).toMatchObject({ familyId: FAMILY, jobId: JOB, eventId: EVENT, eventType: "command.check_in", payloadCiphertext: "c" });
    expect(calls.find(c => c[0] === "finish_workflow_job")![1]).toMatchObject({ p_state: "completed", p_error_code: "check_in_queued" });
    expect(out).toMatchObject({ claimed: 1, done: 1, failed: 0 });
  });
  it("records rejections as completed with the code, and retries as failed with backoff", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const [action, state] of [["rejected", "completed"], ["retry", "failed"]] as const) {
      const { d, calls } = db("core2.event", { ...ev, source: "core2", eventType: "core2.watch.safe" });
      await runCommandJobs({ db: d, workerId: "w", handlers: { core2: async () => ({ action, code: "some_code" }) } });
      expect(calls.find(c => c[0] === "finish_workflow_job")![1]).toMatchObject({ p_state: state, p_error_code: "some_code" });
    }
  });
});

describe("Core 1 command handler", () => {
  it("check_in: decrypts the stored command and queues one outbox row plus a signed timeline line", async () => {
    const f = fakePorts();
    const handler = createCore1CommandHandler(f.ports);
    const ev = commandEvent("check_in", { command: "check_in", person_id: MAA, preferred_time: "09:30", timezone: "Asia/Kolkata" });
    expect(await handler(ev)).toEqual({ action: "done", code: "check_in_queued" });
    expect(f.outbox).toHaveLength(1);
    expect(f.outbox[0]).toMatchObject({ familyId: FAMILY, kind: "core1.check_in", action: "check_in", dedupeKey: `core1:check_in:${EVENT}`,
      payload: { personId: MAA, requestedBy: RIYA, preferredTime: "09:30", aiDisclose: true } });
    expect(f.timeline[0]).toMatchObject({ eventType: "core1.check_in.queued", humanLine: "A check-in call was queued." });
    // A retried job reuses the same outbox row.
    await handler(ev);
    expect(f.outbox).toHaveLength(1);
  });
  it("refuses a payload encrypted for another key/AAD, a mismatched command and generic-route commands with explicit codes", async () => {
    const handler = createCore1CommandHandler(fakePorts().ports);
    expect(await handler(commandEvent("check_in", { person_id: MAA }, { providerEventId: "other" }))).toEqual({ action: "rejected", code: "command_decrypt_failed" });
    expect(await handler(commandEvent("check_in", { person_id: MAA }, { metadata: { command: "urgent_help", actorPersonId: RIYA } }))).toMatchObject({ code: "command_metadata_mismatch" });
    expect(await handler(commandEvent("family_report", { periodStart: "a", periodEnd: "b" }))).toEqual({ action: "rejected", code: "family_report_requires_dedicated_route" });
    expect(await handler(commandEvent("voice_message", {}))).toEqual({ action: "done", code: "voice_message_finalized_at_route" });
    expect(await handler(commandEvent("check_in", { person_id: "nope" }))).toMatchObject({ action: "rejected" });
    expect(await handler(commandEvent("urgent_help", {}, { source: "core1_maa_device", eventType: "urgent_help" }))).toEqual({ action: "done", code: "applied_at_device_route" });
  });
  it("retries when the encryption key is not configured", async () => {
    const f = fakePorts();
    expect(await createCore1CommandHandler({ ...f.ports, encryptionKeyHex: undefined })(commandEvent("check_in", { person_id: MAA }))).toEqual({ action: "retry", code: "encryption_not_configured" });
  });
  it("urgent_help initiate: creates the offer once and signs it", async () => {
    const f = fakePorts();
    const handler = createCore1CommandHandler(f.ports);
    const ev = commandEvent("urgent_help", { subject_person_id: MAA, severity: "urgent" });
    expect(await handler(ev)).toEqual({ action: "done", code: "urgent_offered" });
    expect(await handler(ev)).toEqual({ action: "done", code: "urgent_offer_exists" });
    expect(f.offers).toEqual([{ familyId: FAMILY, subjectPersonId: MAA, severity: "urgent", offerTimeoutMinutes: 3 }]);
    expect(f.timeline[0]).toMatchObject({ eventType: "core1.urgent.offered", entityId: INCIDENT });
  });
  it("urgent_help accept: verified acceptance, then a push row + child alert for every other adult child", async () => {
    const f = fakePorts();
    const ev = commandEvent("urgent_help", { subject_person_id: MAA, action: "accept", incident_id: INCIDENT, assignment_id: ASSIGNMENT, raw_event_id: PROOF },
      { metadata: { command: "urgent_help", actorPersonId: ROHIT } });
    expect(await createCore1CommandHandler(f.ports)(ev)).toEqual({ action: "done", code: "urgent_accepted" });
    expect(f.accepts).toEqual([{ familyId: FAMILY, incidentId: INCIDENT, assignmentId: ASSIGNMENT, responderPersonId: ROHIT, rawEventId: PROOF, promiseMinutes: 15 }]);
    expect(f.outbox.map(o => [o.kind, (o.payload as { recipientPersonId: string }).recipientPersonId])).toEqual([["core1.urgent_accepted_push", RIYA]]);
    expect(f.alerts).toEqual([expect.objectContaining({ personId: RIYA, incidentId: INCIDENT, kind: "urgent_accepted" })]);
  });
  it("urgent_help accept: an unprovable acceptance is rejected and nobody is told", async () => {
    const f = fakePorts({ async acceptVerified() { return { ok: false, code: "invalid_acceptance_proof", permanent: true }; } });
    const ev = commandEvent("urgent_help", { subject_person_id: MAA, action: "accept", incident_id: INCIDENT, assignment_id: ASSIGNMENT, raw_event_id: PROOF });
    expect(await createCore1CommandHandler(f.ports)(ev)).toEqual({ action: "rejected", code: "urgent_accept_invalid_acceptance_proof" });
    expect(f.outbox).toEqual([]);
    expect(f.alerts).toEqual([]);
  });
});

describe("Core 2 event handler and the missed-call pass", () => {
  it("confirms Core 2 inputs that were applied in the request", async () => {
    const h = createCore2EventHandler();
    const base = { familyId: FAMILY, jobId: JOB, eventId: EVENT, providerEventId: "p", metadata: {}, payloadCiphertext: "c" };
    expect(await h({ ...base, source: "core2", eventType: "core2.watch.safe" })).toEqual({ action: "done", code: "core2_applied_inline" });
    expect(await h({ ...base, source: "telecmi", eventType: "core2.watch.safe" })).toMatchObject({ action: "rejected" });
    expect(await h({ ...base, source: "core2", eventType: "core2.watch.safe", payloadCiphertext: null })).toMatchObject({ action: "rejected" });
  });
  it("runs the Core 1 nudge pass once per family with pending TeleCMI missed calls", async () => {
    const filters: Array<[string, unknown]> = [];
    const chain = { select: () => chain, eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
      limit: async () => ok([{ family_id: FAMILY }, { family_id: FAMILY }, { family_id: "not-a-uuid" }]) };
    const db = { from: (t: string) => { filters.push(["table", t]); return chain; } };
    const seen: string[] = [];
    const out = await runMissedCallNudgePass(db as never, async f => { seen.push(f); return { processed: 2, clusters: [{}] }; });
    expect(seen).toEqual([FAMILY]);
    expect(out).toEqual({ status: "ok", families: 1, processed: 2, clusters: 1, failedFamilies: 0 });
    expect(filters).toEqual([["table", "raw_events"], ["source", "telecmi"], ["event_type", "telecmi.missed_call"], ["status", "pending"]]);
  });
});
