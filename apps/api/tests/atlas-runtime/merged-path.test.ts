import { pathToFileURL } from "node:url";
import { createAtlas } from "@sahaj/atlas";
import { MemorySaver } from "@sahaj/atlas/testing";
import { describe, expect, it } from "vitest";
import { createDispatchAuthorizer, runDispatchTick, type ProviderBridge } from "../../src/lib/atlas-runtime/bridge";
import type { RpcDb } from "../../src/lib/atlas-runtime/db";
import { createAtlasPorts } from "../../src/lib/atlas-runtime/repository";
import { claimableKinds, routeEventKind, runWorkflowJobs } from "../../src/lib/atlas-runtime/runner";
import { encryptWebhook } from "../../src/lib/webhook-security";
import { readFileSync } from "node:fs";

/**
 * Merged-path acceptance over an in-memory model of BOTH lanes' SQL contracts, driven by the REAL Phase 2 TypeScript
 * (dispatchOutbound, dispatchStore, normalizeDeliveryOutcome) imported read-only from the sibling worktree.
 * It proves wiring, argument contracts and fail-closed ordering. It does not prove the SQL: that needs scratch PostgreSQL.
 */
const P2 = "D:/Projects/SAHAJ/.worktrees/kiro-phase2/apps/api";
const load = (p: string) => import(/* @vite-ignore */ pathToFileURL(`${P2}/${p}`).href);
const p2 = await load("src/lib/provider-dispatch/index.ts");
const p2help = await load("tests/provider-dispatch/helpers.ts");

const KEY = "ab".repeat(32);
const F = "b3000000-0000-4000-8000-000000000001", PERSON = "c3000000-0000-4000-8000-000000000001", OTHER = "c3000000-0000-4000-8000-000000000009";
const JOB = "d3000000-0000-4000-8000-000000000001", EVENT = "e3000000-0000-4000-8000-000000000001", TOKEN = "99000000-0000-4000-8000-000000000001";
const PRINCIPAL = "a6000000-0000-4000-8000-000000000001", OUTBOX = "a5000000-0000-4000-8000-000000000001", CALL = "ca000000-0000-4000-8000-000000000001";
const lease = { familyId: F, jobId: JOB, token: TOKEN };
const NOW = "2026-11-14T10:00:00.000Z";
const ok = (data: unknown) => ({ data, error: null });
const fail = (code: string) => ({ data: null, error: { code } });

type Raw = { id: string; source: string; type: string; status: string; normalized: boolean; meta: Record<string, unknown> };
function makeWorld() {
  const w = {
    contact: true, permissionLive: true, used: 0, request: null as null | Record<string, unknown>, consumed: false,
    outbox: undefined as undefined | { id: string; status: string; attempt: number; lease?: string; action: string; dedupe: string },
    binding: undefined as undefined | { person: string; provider: string; action: string; callId: string | null },
    ledger: undefined as undefined | { key: string; status: string; ref?: string; person: string; action: string; provider: string; callId: string | null },
    calls: new Map<string, { person: string; external?: string }>(), raws: [] as Raw[], identities: [{ person: PERSON, source: "sarvam", account: "app-1" }],
    calledRpcs: [] as string[], leaseOk: true, seq: 0,
  };
  const classify = (src: string, st: string) => (src === "sarvam" && ["no_answer", "busy", "failed"].includes(st) ? "confirmed_not_sent" : null);
  const accountBound = (person: string, src: string, acct: unknown) => w.identities.some(i => i.person === person && i.source === src && i.account === acct);
  const proof = (): "delivered" | "not_sent" | "conflict" | null => {
    const o = w.outbox, b = w.binding, l = w.ledger; if (!o || !b || !l || o.status === "pending" || o.attempt < 1) return null;
    const kinds = new Set(w.raws.filter(e => e.normalized && e.status === "processed" && ["delivery.confirmed", "delivery.not_sent"].includes(e.type)
      && e.meta.outbox_id === o.id && e.meta.action === o.action && e.meta.provider_action === l.action && e.meta.dispatch_key === l.key
      && e.meta.provider_ref === l.ref && l.provider === e.source && b.action === l.action && b.person === l.person
      && accountBound(b.person, e.source, e.meta.account_id)).map(e => (e.type === "delivery.confirmed" ? "delivered" : "not_sent")));
    return kinds.size > 1 ? "conflict" : kinds.size ? ([...kinds][0] as "delivered" | "not_sent") : null;
  };
  const db: RpcDb = {
    async rpc(name, a: Record<string, unknown> = {}) {
      w.calledRpcs.push(name);
      switch (name) {
        case "renew_workflow_lease": return ok(w.leaseOk);
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
        case "enqueue_authorized_command": {
          if (w.outbox) return ok({ status: "enqueued", outbox_id: w.outbox.id, recovered: true });
          if (!w.contact) return ok({ status: "denied", reason: "no_provider_identity" }); // nothing is written: no outbox, usage, or binding
          // One transaction: usage, consumption, outbox, call row AND immutable binding together.
          w.used++; w.consumed = true;
          w.outbox = { id: OUTBOX, status: "pending", attempt: 0, action: String(a.p_action), dedupe: String(a.p_dedupe_key) };
          w.calls.set(CALL, { person: PERSON });
          w.binding = { person: PERSON, provider: "sarvam", action: "sarvam.outbound_call", callId: CALL };
          return ok({ status: "enqueued", outbox_id: OUTBOX, recovered: false });
        }
        case "claim_outbox": {
          const o = w.outbox;
          if (!o || !["pending", "failed"].includes(o.status)) return ok([]);
          o.status = "processing"; o.attempt++; o.lease = `70000000-0000-4000-8000-00000000000${o.attempt}`;
          return ok([{ id: o.id, family_id: F, lease_token: o.lease, attempt_count: o.attempt }]);
        }
        case "finish_outbox": {
          const o = w.outbox!; if (o.lease !== a.p_lease_token || o.status !== "processing") return ok(false);
          o.status = a.p_success ? "completed" : a.p_error_code === "delivery_unknown" ? "delivery_unknown" : "failed"; return ok(true);
        }
        case "recheck_dispatch_authorization": {
          const o = w.outbox, b = w.binding;
          if (!o || !b || o.status !== "processing" || o.lease !== a.p_lease_token) return ok({ ok: false, reason: "stale_outbox_lease" });
          if (!w.permissionLive) return ok({ ok: false, reason: "permission_not_live" });
          return ok({ ok: true, personId: b.person, provider: b.provider, providerAction: b.action, callId: b.callId, domainAction: o.action });
        }
        case "claim_dispatch": {
          const o = w.outbox, b = w.binding;
          if (!o || o.lease !== a.p_outbox_lease || o.status !== "processing") return fail("40001");
          if (!b || b.person !== a.p_person_id || b.provider !== a.p_provider || b.action !== a.p_action || b.callId !== (a.p_call_id ?? null)) return fail("42501");
          if (w.ledger && w.ledger.status !== "failed") return ok("duplicate");
          w.ledger = { key: String(a.p_key), status: "claimed", person: b.person, action: b.action, provider: b.provider, callId: b.callId }; return ok("claimed");
        }
        case "complete_dispatch": { const l = w.ledger!; l.status = "dispatched"; l.ref = String(a.p_provider_ref); w.calls.get(l.callId!)!.external = l.ref; return ok("dispatched"); }
        case "mark_dispatch_failed": { w.ledger!.status = "failed"; return ok(true); }
        case "mark_dispatch_unknown": { w.ledger!.status = "delivery_unknown"; if (a.p_provider_ref) w.ledger!.ref = String(a.p_provider_ref); return ok(true); }
        case "sweep_stale_dispatch_claims": return ok(0);
        case "record_delivery_proof": {
          const e = w.raws.find(r => r.id === a.p_source_event_id); const l = w.ledger;
          if (!e || e.normalized || e.status !== "processed" || !l) return fail("42501");
          const ref = w.calls.get(String(e.meta.call_id))?.external; if (!ref || ref !== l.ref || l.provider !== e.source || classify(e.source, String(e.meta.status)) !== a.p_outcome) return fail("42501");
          const id = `proof-${++w.seq}`;
          w.raws.push({ id, source: e.source, type: a.p_outcome === "delivered" ? "delivery.confirmed" : "delivery.not_sent", status: "processed", normalized: true,
            meta: { normalized: true, outcome: a.p_outcome, outbox_id: l.callId && w.outbox!.id, action_request_id: "ar", action: w.outbox!.action, provider_action: l.action, dispatch_key: l.key,
              provider_ref: l.ref, person_id: l.person, call_id: l.callId, account_id: "app-1" } });
          return ok({ proof_event_id: id, dispatch_key: l.key, outbox_id: w.outbox!.id });
        }
        case "reconcile_dispatch": { const l = w.ledger!; if (l.status !== "delivery_unknown" && l.status !== "dispatched") return ok(false); l.status = a.p_outcome === "delivered" ? "delivered" : "not_sent"; return ok(true); }
        case "reconcile_outbox": { const o = w.outbox!; if (o.status !== "delivery_unknown") return ok(false); o.status = a.p_outcome === "delivered" ? "completed" : "failed"; return ok(true); }
        case "observe_delivery": {
          const p = proof();
          return ok(p === "delivered" ? { verified: true, status: "delivered", responderAccepted: false } : p === "not_sent" || w.outbox?.status === "dead"
            ? { verified: true, status: "failed", responderAccepted: false } : { verified: false, status: "pending", responderAccepted: false });
        }
        default: return fail("XX000");
      }
    },
  };
  return Object.assign(w, { db, proof });
}

const scripted = p2help.scripted as (...r: unknown[]) => { transport: unknown; calls: unknown[] };
const json = p2help.json as (b: unknown, s?: number) => Response;
function bridgeFor(w: ReturnType<typeof makeWorld>, transport: unknown, over: Record<string, unknown> = {}): ProviderBridge {
  const store = p2.dispatchStore(w.db);
  const base = p2help.deps(new p2help.FakeStore(), transport, { store, authorize: createDispatchAuthorizer(w.db), resolveDestination: async () => "+919000000001", ...over });
  return {
    dispatch: cmd => p2.dispatchOutbound(base, cmd),
    sweepStale: () => p2.sweepStaleClaims(store),
    normalize: input => p2.normalizeDeliveryOutcome(store, input),
  };
}
const atlasOf = (w: ReturnType<typeof makeWorld>, timeline: unknown[], saver = new MemorySaver()) =>
  createAtlas(createAtlasPorts({ db: w.db, lease, encryptionKeyHex: KEY, appendTimeline: async x => { timeline.push(x); } }), saver);
const raw = (w: ReturnType<typeof makeWorld>, r: Partial<Raw> & { meta: Record<string, unknown> }) => { const e: Raw = { id: `raw-${++w.seq}`, source: "sarvam", type: "sarvam.outbound", status: "processed", normalized: false, ...r }; w.raws.push(e); return e; };

describe("merged path: authorize -> atomic binding -> claim -> dispatch -> callback -> proof -> Atlas outcome", () => {
  it("runs end to end and reports not-sent only from normalized proof", async () => {
    const w = makeWorld(), timeline: unknown[] = [], saver = new MemorySaver();
    // 1. Atlas authorizes and enqueues; the binding was written by the same transaction.
    const first = await atlasOf(w, timeline, saver).start({ familyId: F, jobId: JOB });
    expect(first.values.status).toBe("waiting");
    expect(w.outbox?.status).toBe("pending"); expect(w.binding).toEqual({ person: PERSON, provider: "sarvam", action: "sarvam.outbound_call", callId: CALL });
    // 2. Worker tick: claim -> recheck -> Phase 2 claim -> scripted provider -> dispatched.
    const t = scripted(json({ attempt_id: "att-1" }));
    const tick = await runDispatchTick(w.db, bridgeFor(w, t.transport), "worker-1");
    expect(tick).toMatchObject({ status: "ok", claimed: 1, dispatched: 1 });
    expect(t.calls).toHaveLength(1); expect(w.outbox?.status).toBe("completed"); expect(w.ledger?.status).toBe("dispatched");
    // 3. Dispatch alone is not delivery.
    const waiting = await atlasOf(w, timeline, saver).resume({ familyId: F, jobId: JOB });
    expect(waiting.values.status).toBe("waiting"); expect(timeline).toHaveLength(0);
    // 4. Verified provider callback persisted raw. A status job runs Phase 2 normalization through the real runner.
    const cb = raw(w, { meta: { status: "no_answer", call_id: CALL } });
    const calls: Array<[string, Record<string, unknown>]> = [];
    const runnerDb: RpcDb = { async rpc(n, a = {}) { calls.push([n, a]);
      if (n === "claim_workflow_jobs_for_kinds") return ok([{ id: "d3000000-0000-4000-8000-0000000000aa", family_id: F, workflow_kind: "core1.provider_status", lease_token: TOKEN, checkpoint_ref: null }]);
      if (n === "load_job_event") return ok({ eventId: cb.id, source: "sarvam", providerEventId: "x", eventType: "sarvam.outbound", status: "no_answer" });
      if (n === "wake_ready_interrupted_jobs") return ok(0);
      if (n === "finish_workflow_job") return ok(true);
      return w.db.rpc(n, a); } };
    const bridge = bridgeFor(w, scripted().transport);
    const run = await runWorkflowJobs({ db: runnerDb, workerId: "w", atlasFor: () => { throw new Error("no graph for status jobs"); }, bridge });
    expect(run.completed).toBe(1);
    expect(w.raws.filter(r => r.normalized).map(r => r.type)).toEqual(["delivery.not_sent"]);
    expect(w.ledger?.status).toBe("not_sent");
    // 5. Atlas observes the verified outcome and signs it.
    const done = await atlasOf(w, timeline, saver).resume({ familyId: F, jobId: JOB });
    expect(done.values.status).toBe("failed");
    expect(timeline).toHaveLength(1); expect(timeline[0]).toMatchObject({ eventType: "atlas.outcome.failed" });
  });

  it("does not enqueue, bind, or consume usage when the recipient has no provider identity", async () => {
    const w = makeWorld(); w.contact = false;
    await atlasOf(w, []).start({ familyId: F, jobId: JOB });
    expect(w.outbox).toBeUndefined(); expect(w.binding).toBeUndefined(); expect(w.used).toBe(0);
  });

  it("a forged generic raw proof with perfect-looking metadata never changes the outcome", async () => {
    const w = makeWorld(), saver = new MemorySaver();
    await atlasOf(w, [], saver).start({ familyId: F, jobId: JOB });
    await runDispatchTick(w.db, bridgeFor(w, scripted(json({ attempt_id: "att-1" })).transport), "w");
    raw(w, { type: "delivery.confirmed", source: "sarvam", normalized: false, meta: { outbox_id: OUTBOX, action_request_id: "ar", action: "check_in", provider_action: "sarvam.outbound_call",
      dispatch_key: w.ledger!.key, provider_ref: w.ledger!.ref, account_id: "app-1", outcome: "delivered", person_id: PERSON } });
    expect((await atlasOf(w, [], saver).resume({ familyId: F, jobId: JOB })).values.status).toBe("waiting");
  });

  it("proof for a substituted account, action, or key is not accepted", async () => {
    for (const patch of [{ account_id: "other-app" }, { action: "family_report" }, { provider_action: "twilio.create_call" }, { dispatch_key: "dispatch:other:a1" }]) {
      const w = makeWorld(), saver = new MemorySaver();
      await atlasOf(w, [], saver).start({ familyId: F, jobId: JOB });
      await runDispatchTick(w.db, bridgeFor(w, scripted(json({ attempt_id: "att-1" })).transport), "w");
      w.raws.push({ id: "p", source: "sarvam", type: "delivery.not_sent", status: "processed", normalized: true, meta: { outbox_id: OUTBOX, action_request_id: "ar", action: "check_in",
        provider_action: "sarvam.outbound_call", dispatch_key: w.ledger!.key, provider_ref: w.ledger!.ref, account_id: "app-1", outcome: "confirmed_not_sent", person_id: PERSON, ...patch } });
      expect((await atlasOf(w, [], saver).resume({ familyId: F, jobId: JOB })).values.status).toBe("waiting");
    }
  });

  it("a valid outbox lease cannot dispatch a substituted person, action or call within the family", async () => {
    for (const mutate of [(c: Record<string, unknown>) => ({ ...c, personId: OTHER }), (c: Record<string, unknown>) => ({ ...c, payload: { action: "whatsapp.send_text", body: "x" }, callId: undefined }),
      (c: Record<string, unknown>) => ({ ...c, callId: "ca000000-0000-4000-8000-0000000000ff" })]) {
      const w = makeWorld(); await atlasOf(w, []).start({ familyId: F, jobId: JOB });
      const t = scripted(json({ attempt_id: "att-x" }));
      const claimed = await w.db.rpc("claim_outbox", { p_worker_id: "w", p_limit: 1, p_lease_seconds: 60 }) as { data: Array<{ lease_token: string }> };
      const base = { familyId: F, personId: PERSON, outboxId: OUTBOX, outboxLease: claimed.data[0].lease_token, attempt: 1, callId: CALL, payload: { action: "sarvam.outbound_call", language: "Hindi" } };
      const bridge = bridgeFor(w, t.transport);
      const out = await bridge.dispatch!(mutate(base) as never);
      expect(["denied", "failed"]).toContain(out.status);
      expect(t.calls).toHaveLength(0); expect(w.ledger).toBeUndefined();
      // Even a permissive authorizer cannot get past the immutable binding at claim time.
      const loose = bridgeFor(w, t.transport, { authorize: async (c: { personId: string; payload: { action: string } }, key: string) => ({ decision: "allow", consent: true, personId: c.personId, action: c.payload.action, idempotencyKey: key, expiresAt: Date.now() + 60_000 }) });
      expect(["denied", "failed"]).toContain((await loose.dispatch!(mutate(base) as never)).status);
      expect(t.calls).toHaveLength(0); expect(w.ledger).toBeUndefined();
    }
  });

  it("an unknown delivery is never retried or resent, and unconfigured providers stay unavailable", async () => {
    const w = makeWorld(); await atlasOf(w, []).start({ familyId: F, jobId: JOB });
    const t = scripted(new Error("socket reset"), json({ attempt_id: "att-2" }));
    const first = await runDispatchTick(w.db, bridgeFor(w, t.transport), "w");
    expect(first).toMatchObject({ claimed: 1, unknown: 1, dispatched: 0 });
    expect(w.outbox?.status).toBe("delivery_unknown"); expect(w.ledger?.status).toBe("delivery_unknown");
    const second = await runDispatchTick(w.db, bridgeFor(w, t.transport), "w");
    expect(second.claimed).toBe(0); expect(t.calls).toHaveLength(1);
    expect(await runDispatchTick(w.db, {}, "w")).toMatchObject({ status: "unavailable", claimed: 0 });
    expect(w.calledRpcs.filter(n => n === "claim_outbox")).toHaveLength(2); // the unavailable tick claimed nothing
  });

  it("revoked permission after commit stops a fresh attempt before any claim or network call", async () => {
    const w = makeWorld(); await atlasOf(w, []).start({ familyId: F, jobId: JOB }); w.permissionLive = false;
    const t = scripted(json({ attempt_id: "att-1" }));
    const tick = await runDispatchTick(w.db, bridgeFor(w, t.transport), "w");
    expect(tick).toMatchObject({ claimed: 1, denied: 1, dispatched: 0 }); expect(t.calls).toHaveLength(0); expect(w.ledger).toBeUndefined();
  });
});

describe("routing and claim kinds", () => {
  it("routes both recording retrieval events to the recording worker and status events to status", () => {
    expect(routeEventKind("twilio.recording.retrieval_requested")).toBe("core1.recording");
    expect(routeEventKind("sarvam.recording.retrieval_requested")).toBe("core1.recording");
    expect(routeEventKind("whatsapp.status")).toBe("core1.provider_status");
    expect(routeEventKind("twilio.gather.response")).toBeNull();
  });
  it("claims status and recording jobs only when their entrypoints exist", () => {
    expect(claimableKinds()).toEqual(["core1.atlas", "core1.proof"]);
    expect(claimableKinds({ normalize: async () => ({ status: "pending" }), recording: async () => ({ status: "stored" }) })).toEqual(["core1.atlas", "core1.proof", "core1.provider_status", "core1.recording"]);
  });
  it("recording jobs map Phase 2 outcomes: stored completes, retry fails with backoff, rejected completes with its code", async () => {
    for (const [outcome, expected] of [[{ status: "stored" }, "completed"], [{ status: "retry", code: "x" }, "failed"], [{ status: "rejected", code: "no_consent" }, "completed"]] as const) {
      const calls: Array<[string, Record<string, unknown>]> = [];
      const db: RpcDb = { async rpc(n, a = {}) { calls.push([n, a]);
        if (n === "claim_workflow_jobs_for_kinds") return ok([{ id: JOB, family_id: F, workflow_kind: "core1.recording", lease_token: TOKEN, checkpoint_ref: null }]);
        if (n === "load_job_event") return ok({ eventId: EVENT, source: "sarvam", providerEventId: "p", eventType: "sarvam.recording.retrieval_requested", status: null });
        return ok(n === "wake_ready_interrupted_jobs" ? 0 : true); } };
      await runWorkflowJobs({ db, workerId: "w", atlasFor: () => { throw new Error("no"); }, bridge: { recording: async () => outcome } });
      const fin = calls.find(c => c[0] === "finish_workflow_job")![1];
      expect(fin.p_state).toBe(expected);
      if (outcome.status === "rejected") expect(fin.p_error_code).toBe("no_consent");
    }
  });
});

describe("SQL source contracts (static; the SQL itself is unexecuted)", () => {
  const sql = readFileSync(new URL("../../../../infra/supabase/migrations/20261114213000_phase3_bridge.sql", import.meta.url), "utf8");
  const enqueue = sql.slice(sql.indexOf("create function public.enqueue_authorized_command"), sql.indexOf("-- ----", sql.indexOf("create function public.enqueue_authorized_command")));
  it("enqueue binds dispatch in the same function, after the outbox insert, with no deferred path", () => {
    const insert = enqueue.indexOf("insert into public.outbox"), bind = enqueue.indexOf("perform public.bind_outbox_dispatch(");
    expect(insert).toBeGreaterThan(0); expect(bind).toBeGreaterThan(insert);
    expect(enqueue.indexOf("return jsonb_build_object('status','enqueued','outbox_id',o.id,'recovered',false)")).toBeGreaterThan(bind);
    expect(sql).not.toMatch(/pg_notify|dblink|insert into public\.dispatch_bindings/);
  });
  it("proof functions require normalized proof joined to the real ledger and binding with account verification", () => {
    const proofFn = sql.slice(sql.indexOf("function sahaj_private.outbox_proof"), sql.indexOf("function sahaj_private.outbox_acceptance"));
    for (const needle of ["e.normalized_proof", "join public.dispatch_ledger l", "join public.dispatch_bindings b", "e.metadata->>'action'=o.action",
      "e.metadata->>'provider_action'=l.action", "l.provider_ref=e.metadata->>'provider_ref'", "sahaj_private.dispatch_account("]) expect(proofFn).toContain(needle);
    const acc = sql.slice(sql.indexOf("function sahaj_private.outbox_acceptance"), sql.indexOf("-- ----", sql.indexOf("function sahaj_private.outbox_acceptance")));
    for (const needle of ["e.normalized_proof", "join public.dispatch_ledger l", "join public.dispatch_bindings b", "e.metadata->>'person_id'=a.person_id::text", "subject_person_id", "sahaj_private.dispatch_account("]) expect(acc).toContain(needle);
  });
  it("Phase 2 working tree emits the common contract fields (reads the sibling worktree; fails if it regresses)", () => {
    const p2sql = readFileSync(`${P2}/../../infra/supabase/migrations/20261114201600_phase2_dispatch_recording.sql`, "utf8");
    const rec = p2sql.slice(p2sql.indexOf("function public.record_delivery_proof"), p2sql.indexOf("function public.reconcile_dispatch"));
    expect(rec).toContain("'provider_action'");
    expect(rec).toContain("'account_id'");
  });
});
