import { existsSync, readFileSync } from "node:fs";
import { createAtlas } from "@sahaj/atlas";
import { MemorySaver } from "@sahaj/atlas/testing";
import { describe, expect, it } from "vitest";
import { buildProviderBridge, type Phase2Entrypoints, type ProviderBridge, type ProviderRuntimeConfig } from "../../src/lib/atlas-runtime/bridge";
import type { RpcDb } from "../../src/lib/atlas-runtime/db";
import { phase2Entrypoints } from "../../src/lib/atlas-runtime/phase2-modules";
import { providerConfigFromEnv } from "../../src/lib/atlas-runtime/providers";
import { createAtlasPorts } from "../../src/lib/atlas-runtime/repository";
import { claimableKinds, routeEventKind, runWorkflowJobs } from "../../src/lib/atlas-runtime/runner";
import { encryptWebhook } from "../../src/lib/webhook-security";

/**
 * Merged-path acceptance. STAGED: Phase 2 modules are found at their stable repository paths with `import.meta.glob`, so
 * this file runs unchanged on a fresh checkout of this branch (Phase 2 suites skip) and after the parent merges Phase 2
 * (they run against the real modules). It never reads sibling worktrees. The SQL is modelled in memory; the real SQL
 * producer -> consumer path is infra/supabase/tests/phase3_combined_acceptance.sql.
 */
declare global { interface ImportMeta { glob(pattern: string, options?: { eager?: boolean }): Record<string, unknown> } }
const dispatchModule = Object.values(import.meta.glob("../../src/lib/provider-dispatch/index.ts", { eager: true }))[0] as Record<string, never> | undefined;
const recordingModule = Object.values(import.meta.glob("../../src/lib/recording-worker/index.ts", { eager: true }))[0] as Record<string, never> | undefined;
const phase2Helpers = Object.values(import.meta.glob("../provider-dispatch/helpers.ts", { eager: true }))[0] as Record<string, never> | undefined;
const PHASE2 = Boolean(dispatchModule && recordingModule && phase2Helpers);

/** Same shape the integration seam (phase2-modules.ts) documents. */
function realEntrypoints(): Phase2Entrypoints {
  const d = dispatchModule as unknown as Record<string, (...a: unknown[]) => never>, r = recordingModule as unknown as Record<string, (...a: unknown[]) => never>;
  return {
    dispatchStore: db => d.dispatchStore(db), runOutboxDispatchTick: deps => d.runOutboxDispatchTick(deps),
    runStatusNormalizationJob: (deps, id) => d.runStatusNormalizationJob(deps, id),
    recordingStore: db => r.recordingStore(db), recordingStorage: db => r.recordingStorage(db),
    runRecordingJob: (deps, db, id) => r.runRecordingJob(deps, db, id),
  };
}

const KEY = "ab".repeat(32);
const F = "b3000000-0000-4000-8000-000000000001", PERSON = "c3000000-0000-4000-8000-000000000001";
const JOB = "d3000000-0000-4000-8000-000000000001", EVENT = "e3000000-0000-4000-8000-000000000001", TOKEN = "99000000-0000-4000-8000-000000000001";
const PRINCIPAL = "a6000000-0000-4000-8000-000000000001", OUTBOX = "a5000000-0000-4000-8000-000000000001", CALL = "ca000000-0000-4000-8000-000000000001";
const lease = { familyId: F, jobId: JOB, token: TOKEN };
const NOW = "2026-11-14T10:00:00.000Z";
const ok = (data: unknown) => ({ data, error: null });
const fail = (code: string, message = code) => ({ data: null, error: { code, message } });

type Raw = { id: string; source: string; type: string; status: string; normalized: boolean; meta: Record<string, unknown> };
/** In-memory model of both lanes' SQL contracts (claim-time authorization trigger included). */
function makeWorld() {
  const w = {
    authorized: true, used: 0, consumed: false, request: null as null | Record<string, unknown>,
    outbox: undefined as undefined | { id: string; status: string; attempt: number; lease?: string; action: string },
    binding: undefined as undefined | { person: string; provider: string; action: string; callId: string | null },
    ledger: undefined as undefined | { key: string; status: string; ref?: string; person: string; action: string; provider: string; callId: string | null },
    calls: new Map<string, { person: string; external?: string }>(), raws: [] as Raw[], accounts: new Map<string, string>(), rpcs: [] as string[], seq: 0,
  };
  const proof = (): "delivered" | "not_sent" | null => {
    const o = w.outbox, l = w.ledger, b = w.binding; if (!o || !l || !b || o.attempt < 1 || o.status === "pending") return null;
    const hit = w.raws.find(e => e.normalized && e.status === "processed" && e.type.startsWith("delivery.") && e.meta.outbox_id === o.id
      && e.meta.action === o.action && e.meta.provider_action === l.action && e.meta.dispatch_key === l.key && e.meta.provider_ref === l.ref
      && e.meta.account_id === w.accounts.get(`${b.person}|${l.provider}|${l.ref}`));
    return hit ? (hit.type === "delivery.confirmed" ? "delivered" : "not_sent") : null;
  };
  const db: RpcDb = {
    async rpc(name, a: Record<string, unknown> = {}) {
      w.rpcs.push(name);
      switch (name) {
        case "renew_workflow_lease": return ok(true);
        case "load_atlas_job": return ok({ eventId: EVENT, source: "whatsapp", providerEventId: "p-1", eventType: "whatsapp.text", metadataPersonId: PERSON,
          ciphertext: encryptWebhook(Buffer.from(JSON.stringify({ person_id: PERSON, event: { text: { body: "check in" } } })), KEY, "whatsapp:p-1"), personActive: true, principalId: PRINCIPAL });
        case "ensure_action_request":
          w.request = { id: a.p_request_id, familyId: F, action: a.p_action, actorId: PRINCIPAL, personId: PERSON, amountMinor: 0, vendorId: null, itemIds: [], consentSubjectId: null, targetId: a.p_target_id, fingerprint: a.p_request_fingerprint };
          return ok(a.p_request_id);
        case "load_gate_snapshot": return ok(!w.request ? { found: false } : { found: true, now: NOW, revision: "r1", actorActive: true, block: null,
          request: { ...w.request, status: w.consumed ? "executed" : "pending", consumed: w.consumed, expired: false, hasDenial: false },
          permissions: [{ id: "a4000000-0000-4000-8000-000000000001", familyId: F, actorId: PRINCIPAL, action: "check_in", validFrom: "2026-11-01T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z",
            periodStart: "2026-11-14T00:00:00Z", periodEnd: "2026-11-15T00:00:00Z", maxUses: 1, usedCount: w.used, maxAmountMinor: 0, vendorIds: [], itemIds: [], targetIds: [PERSON], approvalMode: "setup" }],
          approvals: [], consents: [] });
        case "enqueue_authorized_command":
          if (w.outbox) return ok({ status: "enqueued", outbox_id: w.outbox.id, recovered: true });
          w.used++; w.consumed = true; w.outbox = { id: OUTBOX, status: "pending", attempt: 0, action: String(a.p_action) };
          w.calls.set(CALL, { person: PERSON }); w.binding = { person: PERSON, provider: "sarvam", action: "sarvam.outbound_call", callId: CALL };
          return ok({ status: "enqueued", outbox_id: OUTBOX, recovered: false });
        case "claim_outbox": { const o = w.outbox; if (!o || !["pending", "failed"].includes(o.status)) return ok([]);
          o.status = "processing"; o.attempt++; o.lease = `70000000-0000-4000-8000-00000000000${o.attempt}`;
          return ok([{ id: o.id, family_id: F, lease_token: o.lease, attempt_count: o.attempt }]); }
        case "get_dispatch_binding": { const b = w.binding; return ok(b && a.p_outbox_id === OUTBOX ? { person_id: b.person, provider: b.provider, action: b.action, call_id: b.callId, outbox_action: w.outbox!.action, action_request_id: "ar" } : null); }
        case "finish_outbox": { const o = w.outbox!; if (o.lease !== a.p_lease_token || o.status !== "processing") return ok(false);
          o.status = a.p_success ? "completed" : a.p_error_code === "delivery_unknown" ? "delivery_unknown" : "failed"; return ok(true); }
        case "recheck_dispatch_authorization": { const o = w.outbox, b = w.binding;
          if (!o || !b || o.status !== "processing" || o.lease !== a.p_lease_token) return ok({ ok: false, reason: "stale_outbox_lease" });
          return ok(w.authorized ? { ok: true, personId: b.person, provider: b.provider, providerAction: b.action, callId: b.callId, domainAction: o.action } : { ok: false, reason: "permission_not_live" }); }
        case "claim_dispatch": { const o = w.outbox, b = w.binding;
          if (!o || o.lease !== a.p_outbox_lease || o.status !== "processing") return fail("40001");
          if (!b || b.person !== a.p_person_id || b.provider !== a.p_provider || b.action !== a.p_action || b.callId !== (a.p_call_id ?? null)) return fail("42501");
          if (!w.authorized) return fail("42501", "dispatch_not_authorized:permission_not_live"); // Phase 3 ledger trigger, same transaction
          if (w.ledger && w.ledger.status !== "failed") return ok("duplicate");
          w.ledger = { key: String(a.p_key), status: "claimed", person: b.person, action: b.action, provider: b.provider, callId: b.callId }; return ok("claimed"); }
        case "complete_dispatch": { const l = w.ledger!; l.status = "dispatched"; l.ref = String(a.p_provider_ref); w.calls.get(l.callId!)!.external = l.ref;
          w.accounts.set(`${l.person}|${l.provider}|${l.ref}`, String(a.p_account_id)); return ok("dispatched"); }
        case "mark_dispatch_failed": w.ledger!.status = "failed"; return ok(true);
        case "mark_dispatch_unknown": w.ledger!.status = "delivery_unknown"; if (a.p_provider_ref) w.ledger!.ref = String(a.p_provider_ref); return ok(true);
        case "sweep_stale_dispatch_claims": return ok(0);
        case "record_delivery_proof": { const e = w.raws.find(r => r.id === a.p_source_event_id), l = w.ledger;
          if (!e || e.normalized || e.status !== "processed" || !l) return fail("42501");
          const ref = w.calls.get(String(e.meta.call_id))?.external;
          const notSent = e.source === "sarvam" && ["no_answer", "busy", "failed"].includes(String(e.meta.status));
          if (!ref || ref !== l.ref || l.provider !== e.source || !(notSent && a.p_outcome === "confirmed_not_sent")) return fail("42501");
          const id = `proof-${++w.seq}`;
          w.raws.push({ id, source: e.source, type: "delivery.not_sent", status: "processed", normalized: true, meta: { normalized: true, outcome: a.p_outcome,
            outbox_id: w.outbox!.id, action_request_id: "ar", action: w.outbox!.action, provider_action: l.action, account_id: w.accounts.get(`${l.person}|${l.provider}|${l.ref}`),
            dispatch_key: l.key, provider_ref: l.ref, person_id: l.person } });
          return ok({ proof_event_id: id, dispatch_key: l.key, outbox_id: w.outbox!.id }); }
        case "reconcile_dispatch": { const l = w.ledger!; if (l.status !== "delivery_unknown") return ok(false); l.status = a.p_outcome === "delivered" ? "delivered" : "not_sent"; return ok(true); }
        case "reconcile_outbox": { const o = w.outbox!; if (o.status !== "delivery_unknown") return ok(false); o.status = a.p_outcome === "delivered" ? "completed" : "failed"; return ok(true); }
        case "observe_delivery": { const p = proof();
          return ok(p === "delivered" ? { verified: true, status: "delivered", responderAccepted: false } : p === "not_sent" ? { verified: true, status: "failed", responderAccepted: false }
            : { verified: false, status: "pending", responderAccepted: false }); }
        default: return fail("XX000");
      }
    },
  };
  return Object.assign(w, { db });
}

const atlasOf = (w: ReturnType<typeof makeWorld>, timeline: unknown[], saver = new MemorySaver()) =>
  createAtlas(createAtlasPorts({ db: w.db, lease, encryptionKeyHex: KEY, appendTimeline: async x => { timeline.push(x); } }), saver);
const helpers = () => phase2Helpers as unknown as { scripted(...r: unknown[]): { transport: never; calls: unknown[] }; json(b: unknown, s?: number): Response; deps(...a: unknown[]): Record<string, unknown> };
function config(transport: unknown, over: Partial<ProviderRuntimeConfig> = {}): ProviderRuntimeConfig {
  const providers = (helpers().deps({}, transport) as { providers: ProviderRuntimeConfig["providers"] }).providers;
  return { dispatchEnabled: true, transport: transport as never, identitySecret: "synthetic-identity-secret-0123456789abcdef",
    resolveDestination: async () => "+919000000001", providers, ...over };
}

describe("integration seam (always runs)", () => {
  it("on a branch without Phase 2, the production seam is empty and every provider capability is unavailable", () => {
    const bridge = buildProviderBridge(phase2Entrypoints, makeWorld().db, providerConfigFromEnv({}));
    if (!PHASE2) {
      expect(bridge).toEqual({ unavailable: ["phase2_entrypoints"] });
      expect(claimableKinds(bridge)).toEqual(["core1.atlas", "core1.proof"]);
    }
  });
  it("production config never enables dispatch without the explicit flag, contact resolution and provider settings", () => {
    const cfg = providerConfigFromEnv({ TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM_NUMBER: "+910", TWILIO_STATUS_CALLBACK_URL: "https://h.test/s" }, (async () => new Response()) as never);
    expect(cfg.dispatchEnabled).toBe(false); expect(cfg.resolveDestination).toBeUndefined();
    const fake: Phase2Entrypoints = { dispatchStore: () => ({}), runOutboxDispatchTick: async () => { throw new Error("must not run"); },
      runStatusNormalizationJob: async () => ({ action: "complete", code: "x" }), recordingStore: () => ({}), recordingStorage: () => ({}), runRecordingJob: async () => ({ action: "complete", code: "x" }) };
    const b = buildProviderBridge(fake, makeWorld().db, { ...cfg, dispatchEnabled: true });
    expect(b.dispatchTick).toBeUndefined(); expect(b.unavailable).toContain("resolve_destination"); expect(b.unavailable).toContain("recording_config");
    expect(JSON.stringify(b.unavailable)).not.toMatch(/AC1|\+910/);
  });
  it("routes both recording retrieval events to the recording worker and status events to status", () => {
    expect(routeEventKind("twilio.recording.retrieval_requested")).toBe("core1.recording");
    expect(routeEventKind("sarvam.recording.retrieval_requested")).toBe("core1.recording");
    expect(routeEventKind("whatsapp.status")).toBe("core1.provider_status");
    expect(routeEventKind("twilio.gather.response")).toBeNull();
  });
  it("recording jobs map Phase 2 dispositions: complete finishes with a safe code, retry fails with backoff", async () => {
    for (const [disp, state, code] of [[{ action: "complete", code: "rejected:no_consent" }, "completed", "rejected_no_consent"], [{ action: "retry", code: "media_404" }, "failed", "recording_media_404"]] as const) {
      const calls: Array<[string, Record<string, unknown>]> = [];
      const db: RpcDb = { async rpc(n, a = {}) { calls.push([n, a]);
        if (n === "claim_workflow_jobs_for_kinds") return ok([{ id: JOB, family_id: F, workflow_kind: "core1.recording", lease_token: TOKEN, checkpoint_ref: null }]);
        if (n === "load_job_event") return ok({ eventId: EVENT, source: "sarvam", providerEventId: "p", eventType: "sarvam.recording.retrieval_requested", metadata: {} });
        return ok(n === "wake_ready_interrupted_jobs" ? 0 : true); } };
      const bridge: ProviderBridge = { unavailable: [], recordingJob: async () => disp };
      await runWorkflowJobs({ db, workerId: "w", atlasFor: () => { throw new Error("no graph"); }, bridge });
      expect(calls.find(c => c[0] === "finish_workflow_job")![1]).toMatchObject({ p_state: state, p_error_code: code });
    }
  });
  it("a Sarvam outbound event on the Atlas path fails with backoff when status normalization is unavailable (evidence is never skipped)", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const db: RpcDb = { async rpc(n, a = {}) { calls.push([n, a]);
      if (n === "claim_workflow_jobs_for_kinds") return ok([{ id: JOB, family_id: F, workflow_kind: "core1.atlas", lease_token: TOKEN, checkpoint_ref: null }]);
      if (n === "load_job_event") return ok({ eventId: EVENT, source: "sarvam", providerEventId: "p", eventType: "sarvam.outbound", metadata: { status: "no_answer" } });
      return ok(n === "wake_ready_interrupted_jobs" ? 0 : true); } };
    let ran = false;
    await runWorkflowJobs({ db, workerId: "w", atlasFor: () => { ran = true; throw new Error("no"); }, bridge: { unavailable: ["phase2_entrypoints"] } });
    expect(ran).toBe(false);
    expect(calls.find(c => c[0] === "finish_workflow_job")![1]).toMatchObject({ p_state: "failed", p_error_code: "status_normalization_unavailable" });
  });
});

describe.skipIf(!PHASE2)("merged path with the real Phase 2 modules (runs after integration)", () => {
  it("authorize -> atomic binding -> claim -> scripted dispatch -> verified callback -> normalized proof -> Atlas outcome", async () => {
    const w = makeWorld(), timeline: unknown[] = [], saver = new MemorySaver();
    expect((await atlasOf(w, timeline, saver).start({ familyId: F, jobId: JOB })).values.status).toBe("waiting");
    expect(w.binding).toEqual({ person: PERSON, provider: "sarvam", action: "sarvam.outbound_call", callId: CALL });
    const t = helpers().scripted(helpers().json({ attempt_id: "att-1" }));
    const bridge = buildProviderBridge(realEntrypoints(), w.db, config(t.transport));
    expect(bridge.dispatchTick).toBeDefined();
    const tick = await bridge.dispatchTick!("worker-1");
    expect(tick.outcomes.dispatched).toBe(1); expect(t.calls).toHaveLength(1); expect(w.ledger?.status).toBe("dispatched");
    expect((await atlasOf(w, timeline, saver).resume({ familyId: F, jobId: JOB })).values.status).toBe("waiting"); // dispatched is not delivered
    const cb: Raw = { id: "raw-cb", source: "sarvam", type: "sarvam.outbound", status: "processed", normalized: false, meta: { status: "no_answer", call_id: CALL } };
    w.raws.push(cb);
    const runnerDb: RpcDb = { async rpc(n, a = {}) {
      if (n === "claim_workflow_jobs_for_kinds") return ok([{ id: "d3000000-0000-4000-8000-0000000000aa", family_id: F, workflow_kind: "core1.provider_status", lease_token: TOKEN, checkpoint_ref: null }]);
      if (n === "load_job_event") return ok({ eventId: cb.id, source: cb.source, providerEventId: "x", eventType: cb.type, metadata: cb.meta });
      if (n === "wake_ready_interrupted_jobs") return ok(0);
      if (n === "finish_workflow_job") return ok(true);
      return w.db.rpc(n, a); } };
    const run = await runWorkflowJobs({ db: runnerDb, workerId: "w", atlasFor: () => { throw new Error("no graph"); }, bridge });
    expect(run.completed).toBe(1);
    expect(w.raws.filter(r => r.normalized).map(r => r.type)).toEqual(["delivery.not_sent"]);
    const done = await atlasOf(w, timeline, saver).resume({ familyId: F, jobId: JOB });
    expect(done.values.status).toBe("failed"); expect(timeline).toHaveLength(1);
  });
  it("forged generic raw proof does not change the outcome", async () => {
    const w = makeWorld(), saver = new MemorySaver();
    await atlasOf(w, [], saver).start({ familyId: F, jobId: JOB });
    await buildProviderBridge(realEntrypoints(), w.db, config(helpers().scripted(helpers().json({ attempt_id: "att-1" })).transport)).dispatchTick!("w");
    w.raws.push({ id: "forged", source: "sarvam", type: "delivery.not_sent", status: "processed", normalized: false, meta: { outbox_id: OUTBOX, action: "check_in",
      provider_action: "sarvam.outbound_call", dispatch_key: w.ledger!.key, provider_ref: w.ledger!.ref, account_id: "app-1", outcome: "confirmed_not_sent" } });
    expect((await atlasOf(w, [], saver).resume({ familyId: F, jobId: JOB })).values.status).toBe("waiting");
  });
  it("substituted account, care action, provider action or key in normalized proof is ignored", async () => {
    for (const patch of [{ account_id: "other-app" }, { action: "family_report" }, { provider_action: "twilio.create_call" }, { dispatch_key: "dispatch:other:a1" }]) {
      const w = makeWorld(), saver = new MemorySaver();
      await atlasOf(w, [], saver).start({ familyId: F, jobId: JOB });
      await buildProviderBridge(realEntrypoints(), w.db, config(helpers().scripted(helpers().json({ attempt_id: "att-1" })).transport)).dispatchTick!("w");
      w.raws.push({ id: "p", source: "sarvam", type: "delivery.not_sent", status: "processed", normalized: true, meta: { outbox_id: OUTBOX, action: "check_in",
        provider_action: "sarvam.outbound_call", dispatch_key: w.ledger!.key, provider_ref: w.ledger!.ref, account_id: w.accounts.get(`${PERSON}|sarvam|${w.ledger!.ref}`), ...patch } });
      expect((await atlasOf(w, [], saver).resume({ familyId: F, jobId: JOB })).values.status).toBe("waiting");
    }
  });
  it("revocation between enqueue and claim is refused at the claim; no provider call happens", async () => {
    const w = makeWorld(); await atlasOf(w, []).start({ familyId: F, jobId: JOB }); w.authorized = false;
    const t = helpers().scripted(helpers().json({ attempt_id: "att-1" }));
    const tick = await buildProviderBridge(realEntrypoints(), w.db, config(t.transport)).dispatchTick!("w");
    expect(tick.outcomes.dispatched).toBe(0); expect(t.calls).toHaveLength(0); expect(w.ledger).toBeUndefined();
  });
  it("an unknown delivery is never retried or resent", async () => {
    const w = makeWorld(); await atlasOf(w, []).start({ familyId: F, jobId: JOB });
    const t = helpers().scripted(new Error("socket reset"), helpers().json({ attempt_id: "att-2" }));
    const bridge = buildProviderBridge(realEntrypoints(), w.db, config(t.transport));
    expect((await bridge.dispatchTick!("w")).outcomes.delivery_unknown).toBe(1);
    expect(w.outbox?.status).toBe("delivery_unknown");
    expect((await bridge.dispatchTick!("w")).claimed).toBe(0); expect(t.calls).toHaveLength(1);
  });
});

describe("SQL source contracts (static; the SQL itself runs only on scratch PostgreSQL)", () => {
  const repo = new URL("../../../../", import.meta.url);
  const read = (p: string) => readFileSync(new URL(p, repo), "utf8");
  const sql = read("infra/supabase/core1-import/migrations/20261114213000_phase3_bridge.sql");
  it("enqueue binds dispatch after the outbox insert inside the same function", () => {
    const fn = sql.slice(sql.indexOf("create function public.enqueue_authorized_command"));
    const insert = fn.indexOf("insert into public.outbox"), bind = fn.indexOf("perform public.bind_outbox_dispatch(");
    expect(insert).toBeGreaterThan(0); expect(bind).toBeGreaterThan(insert);
    expect(fn.indexOf("'recovered',false)")).toBeGreaterThan(bind);
  });
  it("request_consent consumes the table-valued Phase 2 function and the ledger trigger authorizes every claim", () => {
    expect(sql).toMatch(/select c\.granted_at into granted from sahaj_private\.call_recording_consent\(/);
    expect(sql).toMatch(/create trigger dispatch_ledger_authorize before insert on public\.dispatch_ledger/);
    expect(sql).toMatch(/if o\.action='urgent_responder' and sahaj_private\.outbox_acceptance\(o\.id\) then/);
  });
  it("claim-time authorization rechecks the permission's current scope against the stored request, without rechecking usage", () => {
    const fn = sql.slice(sql.indexOf("function sahaj_private.dispatch_authorization_problem"), sql.indexOf("function public.recheck_dispatch_authorization"));
    for (const needle of ["q.principal_id is distinct from r.principal_id", "q.person_id<>r.person_id", "q.action<>r.action", "r.target_id=any(q.target_ids)",
      "r.amount_minor>q.max_amount_minor", "r.vendor_id=any(q.vendor_ids)", "r.item_ids<@q.item_ids", "'permission_scope_changed'"]) expect(fn).toContain(needle);
    expect(fn.split("\n").filter(l => !l.trim().startsWith("--")).join("\n")).not.toMatch(/used_count|max_uses/);
  });
  const p2 = "infra/supabase/core1-import/migrations/20261114201600_phase2_dispatch_recording.sql";
  it.skipIf(!existsSync(new URL(p2, repo)))("Phase 2 producers emit the fields Phase 3 consumes (after integration)", () => {
    const rec = read(p2);
    for (const f of ["'provider_action'", "'account_id'", "'subject_person_id'", "returns table(id uuid,granted_at timestamptz)"]) expect(rec).toContain(f);
  });
});
