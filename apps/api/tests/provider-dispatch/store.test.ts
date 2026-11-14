import { describe, expect, it } from "vitest";
import { acceptResponderFromVerifiedEvent, dispatchStore, type RpcClient } from "../../src/lib/provider-dispatch";
import { CALL, FAMILY, KEY1, LEASE, OUTBOX, PERSON } from "./helpers";

function client(result: { data?: unknown; error?: { code?: string; message?: string } | null } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc: RpcClient = { rpc: async (name, args) => { calls.push({ name, args }); return { data: result.data ?? null, error: result.error ?? null }; } };
  return { rpc, calls };
}
const claim = { familyId: FAMILY, personId: PERSON, key: KEY1, provider: "sarvam" as const, action: "sarvam.outbound_call" as const, outboxId: OUTBOX, outboxLease: LEASE, callId: CALL,
  contact: { identityId: "99999999-9999-4999-8999-999999999991", accountId: "app-1", identityHash: "e".repeat(64) } };

describe("supabase dispatch store", () => {
  it("maps each operation to exactly one SQL function with explicit tenant arguments", async () => {
    const c = client({ data: "claimed" });
    expect(await dispatchStore(c.rpc).claim(claim)).toBe("claimed");
    expect(c.calls[0]).toEqual({ name: "claim_dispatch_contact", args: {
      p_family_id: FAMILY, p_person_id: PERSON, p_key: KEY1, p_provider: "sarvam", p_action: "sarvam.outbound_call",
      p_outbox_id: OUTBOX, p_outbox_lease: LEASE, p_call_id: CALL,
      p_contact_identity_id: "99999999-9999-4999-8999-999999999991", p_contact_account_id: "app-1", p_contact_identity_hash: "e".repeat(64) } });
    const d = client({ data: "dispatched" });
    await dispatchStore(d.rpc).complete({ familyId: FAMILY, key: KEY1, providerRef: "att-1", accountId: "app-1", identityHash: "a".repeat(64), aiDisclosed: true });
    expect(d.calls[0]!.name).toBe("complete_dispatch");
    expect(d.calls[0]!.args).toMatchObject({ p_family_id: FAMILY, p_provider_ref: "att-1", p_ai_disclosed: true });
    const t = client({ data: true });
    const store = dispatchStore(t.rpc);
    expect(await store.fail(FAMILY, KEY1, "provider_rejected")).toBe(true);
    expect(await store.unknown(FAMILY, KEY1, "bookkeeping_failed", "att-1")).toBe(true);
    expect(await store.reconcile(FAMILY, KEY1, "99999999-9999-4999-8999-999999999999", "delivered")).toBe(true);
    expect(await store.finishOutbox(OUTBOX, LEASE, false, "delivery_unknown")).toBe(true);
    expect(t.calls.map((x) => x.name)).toEqual(["mark_dispatch_failed", "mark_dispatch_unknown", "reconcile_dispatch", "finish_outbox"]);
  });
  it("database errors surface as code-only DispatchErrors with no database text", async () => {
    const cases: Array<[string, string]> = [["23505", "dispatch_conflict"], ["40001", "stale_lease"], ["42501", "identity_mismatch"], ["22023", "invalid_dispatch"], ["XX000", "dispatch_store_unavailable"]];
    for (const [code, expected] of cases) {
      const c = client({ error: { code, message: "relation dispatch_ledger secret detail +919000000001" } });
      const error = await dispatchStore(c.rpc).claim(claim).catch((e) => e);
      expect(error).toMatchObject({ name: "DispatchError", code: expected });
      expect(String(error.message)).not.toContain("919000000001");
    }
  });
  it("an unexpected claim or complete result fails closed", async () => {
    await expect(dispatchStore(client({ data: "maybe" }).rpc).claim(claim)).rejects.toMatchObject({ code: "dispatch_store_unavailable" });
    await expect(dispatchStore(client({ data: true }).rpc).complete({ familyId: FAMILY, key: KEY1, providerRef: "x", aiDisclosed: false })).rejects.toMatchObject({ code: "dispatch_store_unavailable" });
    expect(await dispatchStore(client({ data: "true" }).rpc).fail(FAMILY, KEY1, "provider_rejected")).toBe(false);
  });
  it("responder acceptance takes only a persisted provider event id, and a gateway claim cannot produce true", async () => {
    const c = client({ data: false });
    const store = dispatchStore(c.rpc);
    expect(await acceptResponderFromVerifiedEvent(store, FAMILY, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBe(false);
    expect(c.calls[0]).toEqual({ name: "accept_assignment_verified", args: {
      p_family_id: FAMILY, p_assignment_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", p_provider_event_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
  });
});
