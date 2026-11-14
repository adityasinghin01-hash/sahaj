import { vi } from "vitest";
import type { ActionAuthorization, FetchTransport } from "@sahaj/adapters";
import { identityHash } from "../../src/lib/webhook-security";
import {
  DispatchError, dispatchKey, type BindInput, type ClaimedOutbox, type ClaimInput, type StoredBinding, type CompleteInput, type DeliveryProof, type DispatchCommand, type DispatchDeps,
  type DispatchStore, type ReconcileOutcome,
} from "../../src/lib/provider-dispatch";

export const FAMILY = "11111111-1111-4111-8111-111111111111";
export const OTHER_FAMILY = "99999999-9999-4999-8999-999999999999";
export const PERSON = "22222222-2222-4222-8222-222222222222";
export const OTHER_PERSON = "88888888-8888-4888-8888-888888888888";
export const CALL = "33333333-3333-4333-8333-333333333333";
export const OUTBOX = "55555555-5555-4555-8555-555555555555";
export const LEASE = "66666666-6666-4666-8666-666666666666";
export const SECRET = "synthetic-identity-secret-0123456789abcdef";
export const PHONE = "+919000000001"; // synthetic
export const CALL_SID = "CA" + "b".repeat(32);

type Status = "claimed" | "dispatched" | "failed" | "delivery_unknown" | "delivered" | "not_sent";
export interface Row {
  familyId: string; personId: string; provider: string; action: string; outboxId: string; callId?: string;
  status: Status; ref?: string; code?: string;
}
/**
 * In-memory model of the SQL functions' observable rules (claim identity checks, one live row per outbox,
 * claimed-only transitions). It exists to exercise the TypeScript flow; the SQL itself is covered by
 * infra/supabase/tests/phase2_dispatch_recording.sql, which needs a Postgres to run.
 */
export class FakeStore implements DispatchStore {
  ledger = new Map<string, Row>();
  calls = new Map<string, { familyId: string; personId: string; external?: string; ai: boolean }>();
  identities = new Map<string, { familyId: string; personId: string; attempt: string }>();
  outbox = new Map<string, { familyId: string; lease: string; finished?: { success: boolean; code?: string } }>();
  failComplete = false; failUnknown = false; failClaim = false; failFinish = false;
  events: string[] = [];
  /** immutable outbox bindings (SQL: dispatch_bindings). autoBind models the enqueue transaction having bound the row. */
  bindings = new Map<string, BindInput>();
  autoBind = true;
  queue: ClaimedOutbox[] = [];
  async claimOutbox(_w: string, limit: number) { return this.queue.splice(0, limit); }
  async getBinding(familyId: string, outboxId: string): Promise<StoredBinding | null> {
    const b = this.bindings.get(outboxId);
    return b && b.familyId === familyId ? { ...b, actionRequestId: null, outboxAction: "check_in" } : null;
  }
  /** raw provider callbacks already durably processed: id -> {provider, family, call, status} */
  rawEvents = new Map<string, { familyId: string; provider: string; callId: string; status: string }>();
  proofs = new Map<string, { familyId: string; key: string; outcome: ReconcileOutcome; outboxId: string; source: string }>();
  constructor() {
    this.calls.set(CALL, { familyId: FAMILY, personId: PERSON, ai: false });
    this.outbox.set(OUTBOX, { familyId: FAMILY, lease: LEASE });
  }
  private k = (familyId: string, key: string) => `${familyId}|${key}`;
  async bindOutbox(i: BindInput) {
    const have = this.bindings.get(i.outboxId);
    if (have && JSON.stringify(have) !== JSON.stringify(i)) throw new DispatchError("dispatch_conflict");
    if (!have && i.callId) {
      // SQL: the call must be this recipient's call in this family and not yet bound to a provider reference
      const c = this.calls.get(i.callId);
      if (!c || c.familyId !== i.familyId || c.personId !== i.personId || c.external) throw new DispatchError("identity_mismatch");
    }
    this.bindings.set(i.outboxId, i); return true;
  }
  async claim(i: ClaimInput) {
    if (this.failClaim) throw new DispatchError("dispatch_store_unavailable");
    const o = this.outbox.get(i.outboxId);
    if (!o || o.familyId !== i.familyId || o.lease !== i.outboxLease) throw new DispatchError("stale_lease");
    if (!this.bindings.has(i.outboxId) && this.autoBind) this.bindings.set(i.outboxId, { familyId: i.familyId, outboxId: i.outboxId, personId: i.personId, provider: i.provider, action: i.action, callId: i.callId });
    const b = this.bindings.get(i.outboxId);
    if (!b || b.familyId !== i.familyId || b.personId !== i.personId || b.provider !== i.provider || b.action !== i.action || b.callId !== i.callId) throw new DispatchError("identity_mismatch");
    // SQL: the bound call is re-validated against the BOUND recipient before any ledger write
    if (b.callId) { const bc = this.calls.get(b.callId); if (!bc || bc.familyId !== b.familyId || bc.personId !== b.personId) throw new DispatchError("identity_mismatch"); }
    if (i.callId) {
      const c = this.calls.get(i.callId);
      if (!c || c.familyId !== i.familyId || c.personId !== i.personId) throw new DispatchError("identity_mismatch");
    }
    const existing = this.ledger.get(this.k(i.familyId, i.key));
    if (existing) {
      if (existing.personId !== i.personId || existing.provider !== i.provider || existing.action !== i.action) throw new DispatchError("dispatch_conflict");
      return "duplicate" as const;
    }
    for (const r of this.ledger.values()) if (r.familyId === i.familyId && r.outboxId === i.outboxId && r.status !== "failed" && r.status !== "not_sent") return "duplicate" as const;
    if (i.callId && this.calls.get(i.callId)!.external) throw new DispatchError("dispatch_conflict");
    this.ledger.set(this.k(i.familyId, i.key), { familyId: i.familyId, personId: i.personId, provider: i.provider, action: i.action, outboxId: i.outboxId, callId: i.callId, status: "claimed" });
    this.events.push("claim");
    return "claimed" as const;
  }
  async complete(i: CompleteInput) {
    if (this.failComplete) throw new DispatchError("dispatch_store_unavailable");
    const r = this.ledger.get(this.k(i.familyId, i.key));
    if (!r || r.status !== "claimed") throw new DispatchError("stale_lease");
    this.bind(r, i.providerRef, i.accountId, i.identityHash, i.aiDisclosed);
    r.status = "dispatched"; r.ref = i.providerRef;
  }
  private bind(r: Row, ref: string, accountId?: string, hash?: string, ai?: boolean) {
    if (!r.callId) return;
    const c = this.calls.get(r.callId)!;
    c.external = ref; c.ai = c.ai || !!ai;
    {
      const key = `${accountId}|${hash}`;
      const have = this.identities.get(key);
      if (have && (have.familyId !== r.familyId || have.personId !== r.personId)) throw new DispatchError("dispatch_conflict");
      this.identities.set(key, { familyId: r.familyId, personId: r.personId, attempt: ref });
    }
  }
  async bindIdentity(i: Omit<CompleteInput, "providerRef">) {
    const r = this.ledger.get(this.k(i.familyId, i.key));
    if (!r || !r.ref || !["delivery_unknown", "dispatched", "delivered"].includes(r.status)) return false;
    this.bind(r, r.ref, i.accountId, i.identityHash, i.aiDisclosed);
    return true;
  }
  async fail(familyId: string, key: string, code: string) {
    const r = this.ledger.get(this.k(familyId, key));
    if (!r || r.status !== "claimed") return false;
    r.status = "failed"; r.code = code; return true;
  }
  async unknown(familyId: string, key: string, code: string, ref?: string) {
    if (this.failUnknown) throw new DispatchError("dispatch_store_unavailable");
    const r = this.ledger.get(this.k(familyId, key));
    if (!r || r.status !== "claimed") return false;
    r.status = "delivery_unknown"; r.code = code; r.ref = r.ref ?? ref; return true;
  }
  async sweepStale() { let n = 0; for (const r of this.ledger.values()) if (r.status === "claimed") { r.status = "delivery_unknown"; r.code = "claim_expired"; n++; } return n; }
  async recordDeliveryProof(familyId: string, sourceEventId: string, outcome: ReconcileOutcome): Promise<DeliveryProof | null> {
    const e = this.rawEvents.get(sourceEventId);
    if (!e || e.familyId !== familyId) return null;
    const call = this.calls.get(e.callId);
    if (!call || !call.external || call.familyId !== familyId) return null;
    const row = [...this.ledger.entries()].find(([, r]) => r.familyId === familyId && r.provider === e.provider && r.ref === call.external);
    if (!row || !(["dispatched", "delivery_unknown"] as string[]).includes(row[1].status)) return null;
    const ok = outcome === "confirmed_not_sent" && (e.provider === "twilio" ? ["busy", "no-answer", "failed", "canceled"] : ["no_answer", "busy", "failed"]).includes(e.status);
    if (!ok) return null;
    const key = row[0].split("|")[1]!;
    const id = `proof:${key}:${outcome}`;
    this.proofs.set(id, { familyId, key, outcome, outboxId: row[1].outboxId, source: e.provider });
    return { proofEventId: id, dispatchKey: key, outboxId: row[1].outboxId, outcome };
  }
  async reconcile(familyId: string, key: string, eventId: string, outcome: ReconcileOutcome) {
    const p = this.proofs.get(eventId), r = this.ledger.get(this.k(familyId, key));
    if (!p || !r || p.familyId !== familyId || p.key !== key || p.outcome !== outcome || r.status !== "delivery_unknown" || r.outboxId !== p.outboxId) return false;
    r.status = outcome === "delivered" ? "delivered" : "not_sent"; return true;
  }
  outboxReconciled: string[] = [];
  async reconcileOutbox(outboxId: string, eventId: string) { const p = this.proofs.get(eventId); if (!p || p.outboxId !== outboxId) return false; this.outboxReconciled.push(outboxId); return true; }
  async acceptAssignment() { return false; }
  async finishOutbox(outboxId: string, lease: string, success: boolean, code?: string) {
    if (this.failFinish) throw new DispatchError("dispatch_store_unavailable");
    const o = this.outbox.get(outboxId);
    if (!o || o.lease !== lease) return false;
    o.finished = { success, code }; return true;
  }
}

export const grant = (key: string, over: Partial<ActionAuthorization> = {}, action = "sarvam.outbound_call"): ActionAuthorization =>
  ({ decision: "allow", consent: true, personId: PERSON, action, idempotencyKey: key, expiresAt: Date.now() + 60_000, ...over });

export interface Script { url: string; init: RequestInit }
export function scripted(...responses: Array<Response | Error | ((init: RequestInit) => Promise<Response>)>) {
  const calls: Script[] = [];
  const queue = [...responses];
  const transport: FetchTransport = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra call");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(init);
    return next;
  };
  return { transport, calls };
}
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const hang = () => (init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));

export function deps(store: FakeStore, transport: FetchTransport, over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    store, transport, identitySecret: SECRET,
    authorize: vi.fn(async (cmd: DispatchCommand, key: string) => grant(key, {}, cmd.payload.action)),
    resolveDestination: vi.fn(async () => PHONE),
    providers: {
      sarvam: { apiKey: "synthetic-key", orgId: "org-1", workspaceId: "ws-1", appId: "app-1", appVersion: 2, connectionId: "conn-1", agentPhoneNumber: "+918000000000", webhookUrl: "https://api.example.test/api/sarvam/post-call/s", timeoutMs: 40 },
      twilio: { accountSid: "AC" + "a".repeat(32), authToken: "synthetic-token", fromNumber: "+918000000000", statusCallbackUrl: "https://api.example.test/api/twilio/status", allowedWebhookHosts: ["api.example.test"], timeoutMs: 40 },
      whatsapp: { accessToken: "synthetic", phoneNumberId: "1234567890", graphVersion: "v23.0", timeoutMs: 40 },
    },
    ...over,
  };
}

export const sarvamCmd = (over: Partial<DispatchCommand> = {}): DispatchCommand => ({
  familyId: FAMILY, personId: PERSON, outboxId: OUTBOX, outboxLease: LEASE, attempt: 1, callId: CALL,
  payload: { action: "sarvam.outbound_call", language: "Hindi" }, ...over,
});
export const twilioCmd = (over: Partial<DispatchCommand> = {}): DispatchCommand => ({
  ...sarvamCmd(), payload: { action: "twilio.create_call", twimlUrl: "https://api.example.test/api/twilio/voice/relay" }, ...over,
});
export const KEY1 = dispatchKey(OUTBOX, 1);
export const attemptHash = (attempt: string) => identityHash("sarvam", "app-1", attempt, SECRET);
