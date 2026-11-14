import { describe, expect, it, vi } from "vitest";
import { runOutboxDispatchTick, runStatusNormalizationJob, dispatchOutbound, type ComposePayload, type OutboxTickDeps } from "../../src/lib/provider-dispatch";
import { CALL, CALL_SID, deps, FakeStore, FAMILY, grant, hang, json, KEY1, LEASE, OTHER_FAMILY, OUTBOX, PERSON, sarvamCmd, scripted, twilioCmd } from "./helpers";

const row = { id: OUTBOX, familyId: FAMILY, attempt: 1, lease: LEASE };
const BIND = { familyId: FAMILY, outboxId: OUTBOX, personId: PERSON, provider: "sarvam" as const, action: "sarvam.outbound_call" as const, callId: CALL };
const compose: ComposePayload = vi.fn(async () => ({ payload: { action: "sarvam.outbound_call" as const, language: "Hindi" as const } }));
function tick(store: FakeStore, transport: ReturnType<typeof scripted>["transport"], over: Partial<OutboxTickDeps> = {}) {
  return { ...deps(store, transport), store, enabled: true, compose, workerId: "worker-1", ...over } as OutboxTickDeps;
}

describe("runOutboxDispatchTick", () => {
  it("is gated: disabled claims nothing, composes nothing and contacts no provider", async () => {
    const store = new FakeStore(); store.queue.push(row); const t = scripted(json({ attempt_id: "a" }));
    const s = await runOutboxDispatchTick(tick(store, t.transport, { enabled: false }));
    expect(s).toMatchObject({ enabled: false, claimed: 0 }); expect(store.queue).toHaveLength(1); expect(t.calls).toHaveLength(0); expect(store.ledger.size).toBe(0);
  });
  it("claims, loads the immutable binding, composes, reauthorizes and dispatches once", async () => {
    const store = new FakeStore(); store.bindings.set(OUTBOX, BIND); store.queue.push(row);
    const t = scripted(json({ attempt_id: "att-1" })); const authorize = vi.fn(async (_c, k: string) => grant(k));
    const s = await runOutboxDispatchTick(tick(store, t.transport, { authorize }));
    expect(s).toMatchObject({ claimed: 1, outcomes: { dispatched: 1 } }); expect(t.calls).toHaveLength(1);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ personId: PERSON, callId: CALL, attempt: 1 }), KEY1);
    // the same row coming back (stale queue, duplicate claim) never resends
    store.queue.push(row);
    expect((await runOutboxDispatchTick(tick(store, scripted(json({ attempt_id: "att-2" })).transport))).outcomes.duplicate).toBe(1);
  });
  it("a row without a binding is refused and finished, never claimed in the ledger", async () => {
    const store = new FakeStore(); store.autoBind = false; store.queue.push(row); const t = scripted(json({ attempt_id: "a" }));
    const s = await runOutboxDispatchTick(tick(store, t.transport));
    expect(s.outcomes.refused).toBe(1); expect(store.outbox.get(OUTBOX)?.finished).toEqual({ success: false, code: "binding_missing" });
    expect(store.ledger.size).toBe(0); expect(t.calls).toHaveLength(0);
  });
  it("the composer cannot redirect a row to another operation or provider", async () => {
    for (const payload of [{ action: "whatsapp.send_text" as const, body: "x" }, { action: "twilio.create_call" as const, twimlUrl: "https://api.example.test/x" }]) {
      const store = new FakeStore(); store.bindings.set(OUTBOX, BIND); store.queue.push(row); const t = scripted(json({ attempt_id: "a" }));
      const s = await runOutboxDispatchTick(tick(store, t.transport, { compose: async () => ({ payload }) }));
      expect(s.outcomes.refused).toBe(1); expect(store.outbox.get(OUTBOX)?.finished?.code).toBe("payload_mismatch"); expect(t.calls).toHaveLength(0);
    }
    const store = new FakeStore(); store.bindings.set(OUTBOX, BIND); store.queue.push(row);
    await runOutboxDispatchTick(tick(store, scripted().transport, { compose: async () => { throw new Error("boom"); } }));
    expect(store.outbox.get(OUTBOX)?.finished?.code).toBe("compose_failed");
  });
  it("a denied authorization leaves the ledger untouched; an unknown outcome is never resent by a later tick", async () => {
    const denied = new FakeStore(); denied.bindings.set(OUTBOX, BIND); denied.queue.push(row); const t = scripted(json({ attempt_id: "a" }));
    expect((await runOutboxDispatchTick(tick(denied, t.transport, { authorize: async () => null }))).outcomes.denied).toBe(1);
    expect(denied.ledger.size).toBe(0); expect(t.calls).toHaveLength(0);
    const unk = new FakeStore(); unk.bindings.set(OUTBOX, BIND); unk.queue.push(row); const t2 = scripted(hang() as never, json({ attempt_id: "b" }));
    expect((await runOutboxDispatchTick(tick(unk, t2.transport))).outcomes.delivery_unknown).toBe(1);
    unk.queue.push({ ...row, attempt: 2 });
    expect((await runOutboxDispatchTick(tick(unk, t2.transport))).outcomes.duplicate).toBe(1);
    expect(t2.calls).toHaveLength(1);
  });
  it("an abandoned claim is swept to delivery_unknown at the start of every enabled tick", async () => {
    const store = new FakeStore(); store.ledger.set(`${FAMILY}|${KEY1}`, { familyId: FAMILY, personId: PERSON, provider: "sarvam", action: "sarvam.outbound_call", outboxId: OUTBOX, callId: CALL, status: "claimed" });
    await runOutboxDispatchTick(tick(store, scripted().transport));
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe("delivery_unknown");
  });
});

describe("runStatusNormalizationJob", () => {
  const EVENT = "77777777-7777-4777-8777-777777777777";
  async function unknownRepaired() {
    const store = new FakeStore(); store.failComplete = true;
    await dispatchOutbound(deps(store, scripted(json({ sid: CALL_SID })).transport), twilioCmd());
    store.failComplete = false; await store.bindIdentity({ familyId: FAMILY, key: KEY1, aiDisclosed: false });
    return store;
  }
  const readRaw = (over: Record<string, unknown> = {}) => async () => ({ familyId: FAMILY, source: "twilio", eventType: "twilio.call_status", metadata: { status: "no-answer" }, ...over } as never);
  it("normalizes a supported not-sent status into reconciled proof", async () => {
    const store = await unknownRepaired(); store.rawEvents.set(EVENT, { familyId: FAMILY, provider: "twilio", callId: CALL, status: "no-answer" });
    expect(await runStatusNormalizationJob({ store, readRaw: readRaw() }, EVENT)).toEqual({ action: "complete", code: "proved_reconciled" });
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe("not_sent");
  });
  it("completed/connected statuses and unsupported or foreign events change nothing", async () => {
    const store = await unknownRepaired(); store.rawEvents.set(EVENT, { familyId: FAMILY, provider: "twilio", callId: CALL, status: "completed" });
    expect(await runStatusNormalizationJob({ store, readRaw: readRaw({ metadata: { status: "completed" } }) }, EVENT)).toEqual({ action: "complete", code: "unsupported_status" });
    expect(await runStatusNormalizationJob({ store, readRaw: readRaw({ eventType: "whatsapp.text" }) }, EVENT)).toEqual({ action: "complete", code: "unsupported_event" });
    expect(await runStatusNormalizationJob({ store, readRaw: async () => null }, EVENT)).toEqual({ action: "complete", code: "event_not_found" });
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe("delivery_unknown");
  });
  it("a callback for another family stays unprovable; infrastructure failures ask for a retry", async () => {
    const store = await unknownRepaired(); store.rawEvents.set(EVENT, { familyId: FAMILY, provider: "twilio", callId: CALL, status: "no-answer" });
    expect(await runStatusNormalizationJob({ store, readRaw: readRaw({ familyId: OTHER_FAMILY }) }, EVENT)).toEqual({ action: "complete", code: "unprovable" });
    expect(await runStatusNormalizationJob({ store, readRaw: async () => { throw new Error("db"); } }, EVENT)).toEqual({ action: "retry", code: "store_unavailable" });
    store.recordDeliveryProof = async () => { throw new Error("db"); };
    expect(await runStatusNormalizationJob({ store, readRaw: readRaw() }, EVENT)).toEqual({ action: "retry", code: "store_unavailable" });
  });
});
