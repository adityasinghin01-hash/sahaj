import { generateKeyPairSync } from "node:crypto";
import { createAtlas } from "@sahaj/atlas";
import { MemorySaver } from "@sahaj/atlas/testing";
import { describe, expect, it } from "vitest";
import { loadAtlasConfig } from "../../src/lib/atlas-runtime/config";
import { RuntimeError, type RpcDb } from "../../src/lib/atlas-runtime/db";
import { startLeaseHeartbeat } from "../../src/lib/atlas-runtime/lease-guard";
import { createAtlasPorts, requestIdFor } from "../../src/lib/atlas-runtime/repository";
import { dispatchEvents, interruptRef, routeEventKind, runWorkflowJobs, type AtlasLike, type ClaimedJob } from "../../src/lib/atlas-runtime/runner";
import { createTimelineWriter, type StoredTimelineRow, type TimelineStore } from "../../src/lib/atlas-runtime/timeline-writer";
import { exactCommand, projectUnderstanding } from "../../src/lib/atlas-runtime/understanding";
import { verifyTimelineEvent, type SignedTimelineEvent } from "../../src/lib/timeline";
import { encryptWebhook } from "../../src/lib/webhook-security";

const KEY = "ab".repeat(32);
const FAMILY = "b3000000-0000-4000-8000-000000000001";
const JOB = "d3000000-0000-4000-8000-000000000001";
const PERSON = "c3000000-0000-4000-8000-000000000001";
const EVENT = "e3000000-0000-4000-8000-000000000001";
const PRINCIPAL = "a6000000-0000-4000-8000-000000000001";
const TOKEN = "99000000-0000-4000-8000-000000000001";
const OUTBOX = "a5000000-0000-4000-8000-000000000001";
const lease = { familyId: FAMILY, jobId: JOB, token: TOKEN };
const NOW = "2026-11-14T10:00:00.000Z";

function cipher(payload: unknown, source = "whatsapp", id = "p-1") {
  return encryptWebhook(Buffer.from(JSON.stringify(payload)), KEY, `${source}:${id}`);
}
const text = (body: string, person = PERSON) => ({ person_id: person, account: "a", event: { type: "text", text: { body } } });

interface World {
  payload: unknown; metadataPerson: string; personActive: boolean; permission: Record<string, unknown> | null; requestStatus: string;
  consumed: boolean; principal: string | null; block: "deny" | "ask" | null; outbox: Map<string, string>; used: number; proof: 'none' | 'delivered'; leaseOk: boolean; calls: string[]; request: Record<string, unknown> | null;
  approvals: unknown[];
}
function world(over: Partial<World> = {}): World & { db: RpcDb } {
  const w: World = {
    payload: text("Check in"), metadataPerson: PERSON, personActive: true, requestStatus: "pending", consumed: false,
    principal: PRINCIPAL, block: null, outbox: new Map(), used: 0, proof: "none", leaseOk: true, calls: [], request: null, approvals: [],
    permission: { id: "a4000000-0000-4000-8000-000000000001", familyId: FAMILY, actorId: PRINCIPAL, action: "check_in",
      validFrom: "2026-11-01T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", periodStart: "2026-11-14T00:00:00Z", periodEnd: "2026-11-15T00:00:00Z",
      maxUses: 1, usedCount: 0, maxAmountMinor: 0, vendorIds: [], itemIds: [], targetIds: [PERSON], approvalMode: "setup" },
    ...over,
  };
  const ok = (data: unknown) => ({ data, error: null });
  const db: RpcDb = {
    async rpc(name, a = {}) {
      w.calls.push(name);
      switch (name) {
        case "load_atlas_job": return ok({ eventId: EVENT, source: "whatsapp", providerEventId: "p-1", eventType: "whatsapp.text",
          metadataPersonId: w.metadataPerson, ciphertext: cipher(w.payload), personActive: w.personActive, principalId: w.principal });
        case "ensure_action_request":
          if (!w.principal) return ok(null);
          w.request = { id: a.p_request_id, familyId: FAMILY, action: a.p_action, actorId: w.principal, personId: a.p_person_id, amountMinor: 0, vendorId: null, itemIds: [],
            consentSubjectId: null, targetId: a.p_target_id, fingerprint: a.p_request_fingerprint };
          return ok(a.p_request_id);
        case "load_gate_snapshot": return ok(!w.request ? { found: false } : { found: true, now: NOW, actorActive: true, revision: "rev-1", block: w.block,
          request: { ...w.request, status: w.requestStatus, consumed: w.consumed, expired: false, hasDenial: false },
          permissions: w.permission ? [{ ...w.permission, usedCount: w.used }] : [], approvals: w.approvals, consents: [] });
        case "enqueue_authorized_command": {
          const existing = w.outbox.get(String(a.p_dedupe_key));
          if (existing) return ok({ status: "enqueued", outbox_id: existing, recovered: true });
          w.used += 1; w.consumed = true; w.outbox.set(String(a.p_dedupe_key), OUTBOX);
          return ok({ status: "enqueued", outbox_id: OUTBOX, recovered: false });
        }
        case "observe_delivery": return ok(w.proof === "delivered" ? { verified: true, status: "delivered", responderAccepted: false }
          : { verified: false, status: "pending", responderAccepted: false });
        case "renew_workflow_lease": return ok(w.leaseOk);
        default: return { data: null, error: { code: "XX000", message: "unexpected " + name } };
      }
    },
  };
  return Object.assign(w, { db });
}

function memoryTimeline() {
  const rows = new Map<string, StoredTimelineRow>();
  const events: SignedTimelineEvent[] = [];
  let loseResponse = false, conflictOnce = false, staleLease = false; const fences: string[] = [];
  const store: TimelineStore = {
    async head(familyId) { const last = events.filter(e => e.envelope.familyId === familyId).at(-1);
      return { familyId, sequence: last?.envelope.sequence ?? 0, chainHash: last?.chainHash ?? null }; },
    async findByDedupe(_f, key) { return rows.get(key) ?? null; },
    async append(event, _payload, fence) {
      fences.push(fence.token); if (staleLease) throw Object.assign(new Error("sj"), { code: "SJ001" });
      if (conflictOnce) { conflictOnce = false; throw Object.assign(new Error("x"), { code: "40001" }); }
      rows.set(event.envelope.dedupeKey, { envelopeCanonical: JSON.stringify(event.envelope), chainHash: event.chainHash, signature: event.signature });
      events.push(event);
      if (loseResponse) { loseResponse = false; throw Object.assign(new Error("lost"), { code: "08006" }); }
    },
  };
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const append = createTimelineWriter({ store, privateKey, publicKey, keyId: "k1", now: () => new Date(NOW) });
  return { append, rows, events, publicKey, fences, lose() { loseResponse = true; }, conflict() { conflictOnce = true; }, expireLease() { staleLease = true; } };
}

function atlasFor(w: World & { db: RpcDb }, tl = memoryTimeline(), saver = new MemorySaver()) {
  const ports = createAtlasPorts({ db: w.db, lease, encryptionKeyHex: KEY, appendTimeline: tl.append });
  return { atlas: createAtlas(ports, saver), tl, saver };
}

describe("event routing", () => {
  it("routes known kinds and dead-letters everything else", async () => {
    expect(routeEventKind("whatsapp.text")).toBe("core1.atlas");
    expect(routeEventKind("delivery.confirmed")).toBe("core1.proof");
    expect(routeEventKind("twilio.call_status")).toBe("core1.provider_status");
    for (const k of ["sarvam.outbound", "sarvam.inbound", "telecmi.missed_call"]) expect(routeEventKind(k)).toBe("core1.atlas");
    expect(routeEventKind("twilio.recording.retrieval_requested")).toBe("core1.recording");
    for (const bad of ["", "whatsapp.", "payment.approved", "WHATSAPP.text", "twilio.call_status.x"]) expect(routeEventKind(bad)).toBeNull();
    const calls: Array<[string, Record<string, unknown>]> = [];
    const db: RpcDb = { async rpc(n, a = {}) { calls.push([n, a]); return { data: null, error: null }; } };
    const out = await dispatchEvents(db, [{ id: "1", event_type: "mystery.event", lease_token: "t" }, { id: "2", event_type: "whatsapp.text", lease_token: "t" }]);
    expect(out).toEqual({ dispatched: 1, deadLettered: 1, failed: 0 });
    expect(calls[0][0]).toBe("dead_letter_raw_event");
    expect(calls[1][1]).toMatchObject({ p_workflow_kind: "core1.atlas" });
  });
  it("continues past a failed dispatch and marks only that event failed", async () => {
    const calls: string[] = [];
    const db: RpcDb = { async rpc(n, a = {}) { calls.push(n + ":" + a.p_event_id); return { data: null, error: n === "dispatch_raw_event" && a.p_event_id === "1" ? { code: "XX" } : null }; } };
    const out = await dispatchEvents(db, [{ id: "1", event_type: "whatsapp.text", lease_token: "t" }, { id: "2", event_type: "whatsapp.text", lease_token: "t" }]);
    expect(out).toEqual({ dispatched: 1, deadLettered: 0, failed: 1 });
    expect(calls).toContain("finish_raw_event:1");
  });
});

describe("understanding", () => {
  it("maps only exact commands and never guesses", async () => {
    expect(exactCommand("  CHECK   in ")).toBe("check_in");
    expect(exactCommand("please check in tomorrow")).toBeNull();
    expect(await projectUnderstanding({ eventType: "whatsapp.text", text: "call my son" })).toEqual({ action: "unknown", certainty: "uncertain" });
  });
  it("ignores model results without provenance or with unknown actions, and downgrades throws", async () => {
    const mk = (r: unknown) => ({ understand: async () => r as never });
    expect(await projectUnderstanding({ eventType: "x", text: "hi" }, mk({ action: "urgent_responder", certainty: "ready" }))).toEqual({ action: "unknown", certainty: "uncertain" });
    expect(await projectUnderstanding({ eventType: "x", text: "hi" }, mk({ action: "wire_money", certainty: "ready", evidence: "model" }))).toEqual({ action: "unknown", certainty: "uncertain" });
    expect(await projectUnderstanding({ eventType: "x", text: "hi" }, { understand: async () => { throw new Error("secret"); } })).toEqual({ action: "unknown", certainty: "uncertain" });
    expect(await projectUnderstanding({ eventType: "x", text: "hi" }, mk({ action: "send_alert", certainty: "ready", evidence: "model", transcript: "leak" })))
      .toEqual({ action: "send_alert", certainty: "ready" });
  });
});

describe("Atlas repository wiring", () => {
  it("runs exact command to enqueue, waits without proof, then signs delivery once proof exists", async () => {
    const w = world();
    const { atlas, tl, saver } = atlasFor(w);
    const first = await atlas.start({ familyId: FAMILY, jobId: JOB });
    expect(first.values.status).toBe("waiting");
    expect(w.outbox.size).toBe(1); expect(w.used).toBe(1); expect(tl.events).toHaveLength(0);
    expect(JSON.stringify(first.values)).not.toMatch(/Check in|text/);
    expect(interruptRef(first as never)?.interrupt).toMatch(/^delivery_pending:[0-9a-f]{32}$/);
    w.proof = "delivered";
    const done = await createAtlas(createAtlasPorts({ db: w.db, lease, encryptionKeyHex: KEY, appendTimeline: tl.append }), saver).resume({ familyId: FAMILY, jobId: JOB });
    expect(done.values.status).toBe("delivered");
    expect(tl.events).toHaveLength(1);
    expect(verifyTimelineEvent(tl.events[0], tl.publicKey)).toBe(true);
    expect(tl.events[0].envelope.humanLine).not.toMatch(/Check/);
  });
  it("uncertain text creates no request and no outbox; it interrupts for review", async () => {
    const w = world({ payload: text("something unclear") });
    const { atlas } = atlasFor(w);
    const s = await atlas.start({ familyId: FAMILY, jobId: JOB });
    expect(s.values.status).toBe("review"); expect(s.next).toEqual(["review"]);
    expect(w.calls).not.toContain("ensure_action_request"); expect(w.outbox.size).toBe(0);
  });
  it("does not call the enqueue RPC when Cedar says ask or deny", async () => {
    const wrongTarget = { ...world().permission, targetIds: ["c3000000-0000-4000-8000-0000000000ff"] };
    for (const [permission, used] of [[null, 0], [world().permission, 1], [wrongTarget, 0]] as const) {
      const w = world({ permission: permission as never, used });
      const { atlas } = atlasFor(w);
      await atlas.start({ familyId: FAMILY, jobId: JOB });
      expect(w.calls).not.toContain("enqueue_authorized_command");
      expect(w.outbox.size).toBe(0);
    }
  });
  it("blocks two-person actions with one approval at the Cedar layer", async () => {
    const w = world({ payload: text("Check in") });
    (w.permission as Record<string, unknown>).approvalMode = "two_person";
    w.approvals = [{ id: "x1", approverId: "c3000000-0000-4000-8000-000000000002", approverActive: true, approverCanApprove: true, createdAt: "2026-11-14T09:00:00Z", expiresAt: "2026-11-15T09:00:00Z" }];
    const { atlas } = atlasFor(w);
    const s = await atlas.start({ familyId: FAMILY, jobId: JOB });
    expect(s.values.status).toBe("review"); expect(w.calls).not.toContain("enqueue_authorized_command");
  });
  it("rejects identity mismatch between the hashed envelope and row metadata, inactive people, and tampered ciphertext", async () => {
    for (const w of [world({ metadataPerson: "c3000000-0000-4000-8000-0000000000aa" }), world({ personActive: false }), world({ payload: text("Check in", "not-a-uuid") })]) {
      const { atlas } = atlasFor(w);
      await expect(atlas.start({ familyId: FAMILY, jobId: JOB })).rejects.toThrow();
      expect(w.outbox.size).toBe(0);
    }
  });
  it("refuses scopes other than the claimed lease and a lost lease", async () => {
    const w = world();
    const ports = createAtlasPorts({ db: w.db, lease, encryptionKeyHex: KEY, appendTimeline: async () => undefined });
    await expect(ports.loadJob({ familyId: "b3000000-0000-4000-8000-000000000002", jobId: JOB })).rejects.toThrow("scope_mismatch");
    w.leaseOk = false;
    await expect(ports.withJobLock({ familyId: FAMILY, jobId: JOB }, async () => "ran")).rejects.toThrow("stale_lease");
    // Timeline appends are fenced inside the database transaction (see the timeline fencing tests).
  });
  it("recovers a committed enqueue after a crash without charging usage twice", async () => {
    const w = world();
    const { atlas, tl, saver } = atlasFor(w);
    let crash = true; const real = w.db.rpc.bind(w.db);
    const flaky: RpcDb = { async rpc(n, a) { const r = await real(n, a); if (n === "enqueue_authorized_command" && crash) { crash = false; return { data: null, error: { code: "08006" } }; } return r; } };
    const crashing = createAtlas(createAtlasPorts({ db: flaky, lease, encryptionKeyHex: KEY, appendTimeline: tl.append }), saver);
    await expect(crashing.start({ familyId: FAMILY, jobId: JOB })).rejects.toThrow();
    expect(w.used).toBe(1);
    const resumed = await crashing.resume({ familyId: FAMILY, jobId: JOB });
    expect(w.used).toBe(1); expect(w.outbox.size).toBe(1); expect(resumed.values.status).toBe("waiting");
    void atlas;
  });
  it("derives a stable request id", () => { expect(requestIdFor({ familyId: FAMILY, jobId: JOB })).toBe(requestIdFor({ familyId: FAMILY, jobId: JOB })); });
});

describe("timeline writer", () => {
  const base = { familyId: FAMILY, eventType: "atlas.outcome.delivered", entityId: JOB, humanLine: "A care action was delivered.", payload: { a: 1 }, dedupeKey: "k1", fence: { jobId: JOB, token: TOKEN } };
  it("returns the stored row after a lost response and never signs a second variant", async () => {
    const tl = memoryTimeline(); tl.lose();
    const a = await tl.append(base);
    expect(a.sequence).toBe(1); expect(tl.events).toHaveLength(1);
    expect(await tl.append(base)).toEqual(a); expect(tl.events).toHaveLength(1);
  });
  it("re-reads the head after a CAS conflict and chains events", async () => {
    const tl = memoryTimeline(); await tl.append(base); tl.conflict();
    const b = await tl.append({ ...base, dedupeKey: "k2" });
    expect(b.sequence).toBe(2); expect(tl.events[1].envelope.previousHash).toBe(tl.events[0].chainHash);
  });
  it("rejects a stored row that fails signature verification", async () => {
    const tl = memoryTimeline(); await tl.append(base);
    const row = tl.rows.get("k1")!; tl.rows.set("k1", { ...row, signature: row.signature.replace(/^./, c => (c === "A" ? "B" : "A")) });
    await expect(tl.append(base)).rejects.toThrow("timeline_dedupe_conflict");
  });
});

describe("workflow runner", () => {
  const claimed = (over: Partial<ClaimedJob> = {}): ClaimedJob => ({ id: JOB, family_id: FAMILY, workflow_kind: "core1.atlas", lease_token: TOKEN, checkpoint_ref: null, ...over });
  function harness(jobs: ClaimedJob[], atlas: AtlasLike, finishOk = true) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const db: RpcDb = { async rpc(n, a = {}) { calls.push([n, a]);
      if (n === "claim_workflow_jobs_for_kinds") return { data: jobs, error: null };
      if (n === "wake_ready_interrupted_jobs") return { data: 0, error: null };
      return { data: finishOk, error: null }; } };
    return { calls, deps: { db, workerId: "w", atlasFor: () => atlas } };
  }
  const snap = (over: object) => ({ next: [], tasks: [], ...over }) as never;
  it("completes, interrupts with checkpoint refs, and fails safely with backoff", async () => {
    const waiting = snap({ next: ["wait"], config: { configurable: { checkpoint_id: "cp1" } }, tasks: [{ interrupts: [{ value: { kind: "delivery_pending", outboxId: "x" } }] }] });
    let h = harness([claimed()], { start: async () => waiting, resume: async () => waiting });
    expect(await runWorkflowJobs(h.deps)).toMatchObject({ interrupted: 1 });
    expect(h.calls.at(-1)![1]).toMatchObject({ p_state: "interrupted", p_checkpoint_ref: "cp1" });
    h = harness([claimed()], { start: async () => snap({}), resume: async () => snap({}) });
    expect(await runWorkflowJobs(h.deps)).toMatchObject({ completed: 1 });
    h = harness([claimed({ checkpoint_ref: "cp1" })], { start: async () => { throw new Error("SECRET payload"); }, resume: async () => { throw new Error("SECRET payload"); } });
    expect(await runWorkflowJobs(h.deps)).toMatchObject({ failed: 1 });
    const last = h.calls.at(-1)![1];
    expect(last).toMatchObject({ p_state: "failed", p_error_code: "atlas_failed", p_checkpoint_ref: "cp1" });
    expect(JSON.stringify(h.calls)).not.toContain("SECRET");
  });
  it("resumes interrupted jobs and continues a started thread that has no interrupt", async () => {
    const calls: string[] = [];
    const paused = snap({ next: ["enqueue"] });
    const h = harness([claimed()], { start: async () => { calls.push("start"); return paused; }, resume: async () => { calls.push("resume"); return snap({}); } });
    expect(await runWorkflowJobs(h.deps)).toMatchObject({ completed: 1 });
    expect(calls).toEqual(["start", "resume"]);
    const r = harness([claimed({ checkpoint_ref: "cp" })], { start: async () => snap({}), resume: async () => { calls.push("only-resume"); return snap({}); } });
    await runWorkflowJobs(r.deps); expect(calls.at(-1)).toBe("only-resume");
  });
  it("executes only Atlas jobs; proof/status jobs are completed as facts, and a lost lease is not counted as completion", async () => {
    let touched = false;
    const h = harness([claimed({ workflow_kind: "core1.proof" })], { start: async () => { touched = true; return snap({}); }, resume: async () => snap({}) });
    expect(await runWorkflowJobs(h.deps)).toMatchObject({ completed: 1 }); expect(touched).toBe(false);
    const lost = harness([claimed()], { start: async () => snap({}), resume: async () => snap({}) }, false);
    expect(await runWorkflowJobs(lost.deps)).toMatchObject({ completed: 0, leaseLost: 1 });
  });
  it("fails jobs that pause without a known interrupt", async () => {
    const h = harness([claimed({ checkpoint_ref: "cp" })], { start: async () => snap({}), resume: async () => snap({ next: ["x"] }) });
    expect(await runWorkflowJobs(h.deps)).toMatchObject({ failed: 1 });
  });
});

describe("principal, snapshot revision and overlapping decisions", () => {
  it("pauses for review and creates nothing when the family has no active principal", async () => {
    const w = world({ principal: null });
    const s = await atlasFor(w).atlas.start({ familyId: FAMILY, jobId: JOB });
    expect(s.values.status).toBe("review");
    expect(w.request).toBeNull(); expect(w.calls).not.toContain("enqueue_authorized_command");
  });
  it("uses the principal, not the subject, as the Cedar actor", async () => {
    const w = world(); (w.permission as Record<string, unknown>).actorId = PERSON; // permission granted to the subject instead
    const s = await atlasFor(w).atlas.start({ familyId: FAMILY, jobId: JOB });
    expect(s.values.status).toBe("review"); expect(w.outbox.size).toBe(0);
  });
  it("does not commit when a deny or ask row overlaps an allow", async () => {
    for (const block of ["deny", "ask"] as const) {
      const w = world({ block });
      await atlasFor(w).atlas.start({ familyId: FAMILY, jobId: JOB });
      expect(w.calls).not.toContain("enqueue_authorized_command"); expect(w.outbox.size).toBe(0);
    }
  });
  it("sends the snapshot revision and a plaintext payload hash, and surfaces a stale snapshot as a failure", async () => {
    const w = world(); const seen: Array<Record<string, unknown>> = []; const real = w.db.rpc.bind(w.db);
    const spy: RpcDb = { async rpc(n, a = {}) { if (n === "enqueue_authorized_command") { seen.push(a); return { data: null, error: { code: "40001" } }; } return real(n, a); } };
    const atlas = createAtlas(createAtlasPorts({ db: spy, lease, encryptionKeyHex: KEY, appendTimeline: async () => undefined }), new MemorySaver());
    await expect(atlas.start({ familyId: FAMILY, jobId: JOB })).rejects.toThrow();
    expect(seen[0]).toMatchObject({ p_revision: "rev-1", p_incident_id: null });
    expect(String(seen[0].p_payload_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(w.outbox.size).toBe(0);
  });
  it("rejects a stored request whose fingerprint no longer matches its fields", async () => {
    const w = world(); const real = w.db.rpc.bind(w.db);
    const tampered: RpcDb = { async rpc(n, a = {}) { const r = await real(n, a);
      if (n === "load_gate_snapshot" && r.data) (r.data as { request: { amountMinor: number } }).request.amountMinor = 500; return r; } };
    const atlas = createAtlas(createAtlasPorts({ db: tampered, lease, encryptionKeyHex: KEY, appendTimeline: async () => undefined }), new MemorySaver());
    await expect(atlas.start({ familyId: FAMILY, jobId: JOB })).rejects.toThrow();
    expect(w.outbox.size).toBe(0);
  });
});

describe("timeline replay and fencing", () => {
  const base = { familyId: FAMILY, eventType: "atlas.outcome.delivered", entityId: JOB, humanLine: "A care action was delivered.", payload: { a: 1 }, dedupeKey: "rk", fence: { jobId: JOB, token: TOKEN } };
  it("a valid replay returns the stored row even though head and clock differ now", async () => {
    const tl = memoryTimeline(); const first = await tl.append(base); await tl.append({ ...base, dedupeKey: "other" });
    expect(await tl.append(base)).toEqual(first); expect(tl.events).toHaveLength(2);
  });
  it("conflicts when payload, entity or human line changes under an existing dedupe key", async () => {
    const tl = memoryTimeline(); await tl.append(base);
    await expect(tl.append({ ...base, payload: { a: 2 } })).rejects.toThrow("timeline_dedupe_conflict");
    await expect(tl.append({ ...base, entityId: "d3000000-0000-4000-8000-0000000000aa" })).rejects.toThrow("timeline_dedupe_conflict");
    await expect(tl.append({ ...base, humanLine: "A care action could not be delivered." })).rejects.toThrow("timeline_dedupe_conflict");
    await expect(tl.append({ ...base, eventType: "atlas.outcome.failed" })).rejects.toThrow("timeline_dedupe_conflict");
  });
  it("sends the lease fence with every append and stops at once when the lease is gone", async () => {
    const tl = memoryTimeline(); await tl.append(base); expect(tl.fences).toEqual([TOKEN]);
    tl.expireLease();
    await expect(tl.append({ ...base, dedupeKey: "late" })).rejects.toThrow("stale_lease");
    expect(tl.fences).toHaveLength(2); // exactly one attempt, no retry loop
    expect(tl.events).toHaveLength(1);
  });
});

describe("Sarvam and missed-call content", () => {
  const sarvamWorld = (payload: unknown, eventType = "sarvam.outbound") => {
    const w = world({ payload }); const real = w.db.rpc.bind(w.db);
    w.db.rpc = async (n, a) => { const r = await real(n, a); if (n === "load_atlas_job" && r.data) { (r.data as Record<string, unknown>).eventType = eventType; (r.data as Record<string, unknown>).source = "whatsapp"; } return r; };
    return w;
  };
  const withPerson = (p: Record<string, unknown>) => ({ person_id: PERSON, ...p });
  it("routes consent-missing, status-only and missed-call events to durable review, not success", async () => {
    for (const [payload, type] of [[withPerson({ review_required: "consent_missing", status: "completed" }), "sarvam.outbound"], [withPerson({ status: "completed" }), "sarvam.outbound"], [withPerson({ app_id: "x" }), "telecmi.missed_call"]] as const) {
      const w = sarvamWorld(payload, type);
      const s = await atlasFor(w).atlas.start({ familyId: FAMILY, jobId: JOB });
      expect(s.values.status).toBe("review"); expect(s.next).toEqual(["review"]);
      expect(w.calls).not.toContain("enqueue_authorized_command"); expect(w.calls).not.toContain("ensure_action_request");
    }
  });
  it("hands consented transcript content only to the injected port; without a port it stays in review", async () => {
    const payload = withPerson({ interaction_transcript: [{ role: "user", text: "check in" }], final_agent_variables: { mood: "ok" } });
    const w = sarvamWorld(payload);
    expect((await atlasFor(w).atlas.start({ familyId: FAMILY, jobId: JOB })).values.status).toBe("review");
    const seen: unknown[] = [];
    const w2 = sarvamWorld(payload); const saver = new MemorySaver();
    const ports = createAtlasPorts({ db: w2.db, lease, encryptionKeyHex: KEY, appendTimeline: async () => undefined,
      understanding: { async understand(i) { seen.push(i); return { action: "check_in", certainty: "ready", evidence: "model" }; } } });
    const s = await createAtlas(ports, saver).start({ familyId: FAMILY, jobId: JOB });
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ eventType: "sarvam.outbound", text: null, content: { transcript: [{ role: "user", text: "check in" }] } });
    expect(w2.outbox.size).toBe(1); expect(JSON.stringify(s.values)).not.toContain("check in");
  });
  it("never treats a transcript saying 'check in' as an exact command", async () => {
    const w = sarvamWorld(withPerson({ interaction_transcript: [{ role: "user", text: "check in" }] }));
    const s = await atlasFor(w).atlas.start({ familyId: FAMILY, jobId: JOB });
    expect(s.values.status).toBe("review"); expect(w.outbox.size).toBe(0);
  });
});

describe("lease heartbeat, thread lock and cancellation", () => {
  it("heartbeat renews during long work and flags a lost lease, which cancels at the next port call", async () => {
    const calls: number[] = []; let ok = true;
    const db: RpcDb = { async rpc() { calls.push(Date.now()); return { data: ok, error: null }; } };
    const guard = startLeaseHeartbeat(db, lease, { intervalMs: 5, seconds: 120 });
    await new Promise(r => setTimeout(r, 200)); expect(calls.length).toBeGreaterThanOrEqual(2); expect(guard.lost).toBe(false); guard.assertLive();
    ok = false; await new Promise(r => setTimeout(r, 200));
    expect(guard.lost).toBe(true); expect(() => guard.assertLive()).toThrow("stale_lease"); guard.stop();
    const w = world(); const ports = createAtlasPorts({ db: w.db, lease, encryptionKeyHex: KEY, appendTimeline: async () => undefined, guard });
    await expect(ports.loadJob({ familyId: FAMILY, jobId: JOB })).rejects.toThrow("stale_lease");
    await expect(ports.enqueueAuthorized({ familyId: FAMILY, jobId: JOB, eventId: EVENT, action: "check_in", idempotencyKey: "k" })).rejects.toThrow("stale_lease");
    expect(w.outbox.size).toBe(0);
  });
  it("runner aborts the in-flight graph run when the lease or the thread lock is lost mid-run", async () => {
    for (const which of ["lease", "lock"] as const) {
      const calls: Array<[string, Record<string, unknown>]> = [];
      const db: RpcDb = { async rpc(n, a = {}) { calls.push([n, a]);
        if (n === "claim_workflow_jobs_for_kinds") return { data: [{ id: JOB, family_id: FAMILY, workflow_kind: "core1.atlas", lease_token: TOKEN, checkpoint_ref: null }], error: null };
        return { data: n === "wake_ready_interrupted_jobs" ? 0 : true, error: null }; } };
      const leaseListeners: Array<() => void> = [], lockListeners: Array<() => void> = [];
      let leaseLost = false, lockHeld = true, lockLoseCalled = false, sawAbort = false;
      const guard = { get lost() { return leaseLost; }, assertLive() { if (leaseLost) throw new RuntimeError("stale_lease"); }, stop() {}, onLost(l: () => void) { leaseListeners.push(l); } };
      const lock = { get held() { return lockHeld; }, assertHeld() { if (!lockHeld) throw new RuntimeError("thread_lock_lost"); }, onLost(l: () => void) { lockListeners.push(l); },
        lose() { lockLoseCalled = true; lockHeld = false; }, release: async () => undefined };
      const atlas: AtlasLike = { async start(_s, o) {
        await new Promise<void>((resolve, reject) => {
          o?.signal?.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")); });
          setTimeout(() => { if (which === "lease") { leaseLost = true; leaseListeners.forEach(l => l()); } else { lockHeld = false; lockListeners.forEach(l => l()); } }, 10);
          setTimeout(resolve, 1000);
        });
        return { next: [], tasks: [] } as never; }, resume: async () => ({ next: [], tasks: [] }) as never };
      const r = await runWorkflowJobs({ db, workerId: "w", atlasFor: () => atlas, heartbeat: () => guard, lockThread: async () => lock });
      expect(sawAbort).toBe(true);
      expect(r.leaseLost).toBe(1);
      expect(calls.some(c => c[0] === "finish_workflow_job")).toBe(false);
      if (which === "lease") expect(lockLoseCalled).toBe(true); // lease loss also fences checkpoint writes
    }
  });  it("runner does not run Atlas when the thread is busy, and discards a run whose lock or lease was lost", async () => {
    const calls: Array<[string, Record<string, unknown>]> = []; let started = false;
    const mk = (extra: Partial<Parameters<typeof runWorkflowJobs>[0]>) => ({ db: { async rpc(n: string, a: Record<string, unknown> = {}) { calls.push([n, a]);
      if (n === "claim_workflow_jobs_for_kinds") return { data: [{ id: JOB, family_id: FAMILY, workflow_kind: "core1.atlas", lease_token: TOKEN, checkpoint_ref: null }], error: null };
      return { data: n === "wake_ready_interrupted_jobs" ? 0 : true, error: null }; } } as RpcDb, workerId: "w",
      atlasFor: () => ({ start: async () => { started = true; return { next: [], tasks: [] } as never; }, resume: async () => ({ next: [], tasks: [] }) as never }), ...extra });
    const busy = await runWorkflowJobs(mk({ lockThread: async () => null }));
    expect(started).toBe(false); expect(busy.failed).toBe(1); expect(calls.at(-1)![1]).toMatchObject({ p_state: "failed", p_error_code: "thread_busy" });
    calls.length = 0;
    const lostLock = { held: true, assertHeld() { throw new RuntimeError("thread_lock_lost"); }, release: async () => undefined };
    const r = await runWorkflowJobs(mk({ lockThread: async () => lostLock }));
    expect(r.completed).toBe(0); expect(calls.some(c => c[0] === "finish_workflow_job" && c[1].p_state === "completed")).toBe(false);
    calls.length = 0;
    const lostLease: ReturnType<typeof startLeaseHeartbeat> = { lost: true, assertLive() { throw new RuntimeError("stale_lease"); }, stop() {} };
    const l = await runWorkflowJobs(mk({ heartbeat: () => lostLease }));
    expect(l.leaseLost).toBe(1); expect(calls.some(c => c[0] === "finish_workflow_job")).toBe(false);
  });
});

describe("configuration contract", () => {
  const pair = generateKeyPairSync("ed25519");
  const pem = (k: { export(o: object): string | Buffer }, type: string) => String(k.export({ type, format: "pem" }));
  const good = () => ({ WEBHOOK_ENCRYPTION_KEY: KEY, DATABASE_URL: "postgres://u:p@h/db", SIGNING_KEY_ID: "k1",
    SIGNING_PRIVATE_KEY: pem(pair.privateKey, "pkcs8"), SIGNING_PUBLIC_KEY: pem(pair.publicKey, "spki") });
  it("accepts the documented names in PEM, escaped-newline and base64 DER forms", () => {
    expect(loadAtlasConfig(good()).ok).toBe(true);
    expect(loadAtlasConfig({ ...good(), SIGNING_PRIVATE_KEY: good().SIGNING_PRIVATE_KEY.replace(/\n/g, "\\n") }).ok).toBe(true);
    const der = (k: { export(o: object): string | Buffer }, t: string) => (k.export({ type: t, format: "der" }) as Buffer).toString("base64");
    expect(loadAtlasConfig({ ...good(), SIGNING_PRIVATE_KEY: der(pair.privateKey, "pkcs8"), SIGNING_PUBLIC_KEY: der(pair.publicKey, "spki") }).ok).toBe(true);
  });
  it("reports names only, never values, for missing, malformed or mismatched settings", () => {
    const other = generateKeyPairSync("ed25519");
    const r1 = loadAtlasConfig({}); expect(r1).toMatchObject({ ok: false });
    expect(JSON.stringify(r1)).toContain("SIGNING_PRIVATE_KEY:missing");
    const r2 = loadAtlasConfig({ ...good(), SIGNING_PUBLIC_KEY: pem(other.publicKey, "spki") });
    expect(r2).toEqual({ ok: false, problems: ["SIGNING_KEYS:mismatch"] });
    const r3 = loadAtlasConfig({ ...good(), SIGNING_PRIVATE_KEY: "SECRET-VALUE-garbage", WEBHOOK_ENCRYPTION_KEY: "short" });
    expect(JSON.stringify(r3)).not.toContain("SECRET-VALUE"); expect(JSON.stringify(r3)).toContain("WEBHOOK_ENCRYPTION_KEY:invalid");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(JSON.stringify(loadAtlasConfig({ ...good(), SIGNING_PRIVATE_KEY: pem(rsa.privateKey, "pkcs8") }))).toContain("SIGNING_PRIVATE_KEY:invalid");
  });
});