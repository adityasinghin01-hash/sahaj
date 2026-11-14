import { describe, expect, it } from "vitest";
import { dispatchOutbound, normalizeDeliveryOutcome } from "../../src/lib/provider-dispatch";
import { attemptHash, CALL, deps, FakeStore, FAMILY, hang, json, KEY1, OTHER_FAMILY, OUTBOX, sarvamCmd, scripted, twilioCmd, CALL_SID } from "./helpers";

const EVENT = "77777777-7777-4777-8777-777777777777";
const raw = (store: FakeStore, status: string, over: Partial<{ familyId: string; provider: string; callId: string }> = {}) =>
  store.rawEvents.set(EVENT, { familyId: FAMILY, provider: "twilio", callId: CALL, status, ...over });

/** Twilio create-call whose bookkeeping failed after the provider answered, then repaired: delivery_unknown WITH a provider reference. */
async function unknownWithRef() {
  const store = new FakeStore(); store.failComplete = true;
  await dispatchOutbound(deps(store, scripted(json({ sid: CALL_SID })).transport), twilioCmd());
  store.failComplete = false;
  await store.bindIdentity({ familyId: FAMILY, key: KEY1, aiDisclosed: false });
  return store;
}

describe("normalizeDeliveryOutcome", () => {
  it("a not-sent status on a repaired unknown dispatch becomes verified proof and resolves ledger and outbox", async () => {
    const store = await unknownWithRef();
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)).toMatchObject({ status: "delivery_unknown", ref: CALL_SID });
    raw(store, "no-answer");
    const r = await normalizeDeliveryOutcome(store, { familyId: FAMILY, sourceEventId: EVENT, provider: "twilio", status: "no-answer" });
    expect(r).toMatchObject({ status: "proved", outcome: "confirmed_not_sent", dispatchReconciled: true, outboxReconciled: true });
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe("not_sent");
    expect(store.outboxReconciled).toEqual([OUTBOX]);
  });
  it.each(["completed", "in-progress", "ringing", "queued", "answered", "mystery"])("a %s call status is never proof and writes nothing", async (status) => {
    const store = await unknownWithRef(); raw(store, status);
    expect(await normalizeDeliveryOutcome(store, { familyId: FAMILY, sourceEventId: EVENT, provider: "twilio", status })).toEqual({ status: "pending", reason: "unsupported_status" });
    expect(store.proofs.size).toBe(0); expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe("delivery_unknown");
  });
  it("Sarvam connected is not delivery proof; busy and no_answer are not-sent proof", async () => {
    const store = new FakeStore(); store.failComplete = true;
    await dispatchOutbound(deps(store, scripted(json({ attempt_id: "att-1" })).transport), sarvamCmd());
    store.failComplete = false;
    await store.bindIdentity({ familyId: FAMILY, key: KEY1, accountId: "app-1", identityHash: attemptHash("att-1"), aiDisclosed: true });
    raw(store, "connected", { provider: "sarvam" });
    expect(await normalizeDeliveryOutcome(store, { familyId: FAMILY, sourceEventId: EVENT, provider: "sarvam", status: "connected" })).toMatchObject({ status: "pending" });
    raw(store, "no_answer", { provider: "sarvam" });
    expect(await normalizeDeliveryOutcome(store, { familyId: FAMILY, sourceEventId: EVENT, provider: "sarvam", status: "no_answer" })).toMatchObject({ status: "proved", dispatchReconciled: true });
  });
  it("a timeout-unknown dispatch has no provider reference, so no callback can be linked to it and it stays unknown", async () => {
    const store = new FakeStore();
    await dispatchOutbound(deps(store, scripted(hang() as never).transport), twilioCmd());
    raw(store, "failed");
    expect(await normalizeDeliveryOutcome(store, { familyId: FAMILY, sourceEventId: EVENT, provider: "twilio", status: "failed" })).toEqual({ status: "pending", reason: "unprovable" });
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe("delivery_unknown");
  });
  it("another family's event, another provider's event or a different call is unprovable", async () => {
    const store = await unknownWithRef();
    raw(store, "failed", { familyId: OTHER_FAMILY });
    expect(await normalizeDeliveryOutcome(store, { familyId: FAMILY, sourceEventId: EVENT, provider: "twilio", status: "failed" })).toMatchObject({ status: "pending" });
    raw(store, "failed", { provider: "sarvam" });
    expect(await normalizeDeliveryOutcome(store, { familyId: FAMILY, sourceEventId: EVENT, provider: "twilio", status: "failed" })).toMatchObject({ status: "pending" });
    store.calls.set("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { familyId: FAMILY, personId: "x", external: "CA" + "9".repeat(32), ai: false });
    raw(store, "failed", { callId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(await normalizeDeliveryOutcome(store, { familyId: FAMILY, sourceEventId: EVENT, provider: "twilio", status: "failed" })).toMatchObject({ status: "pending" });
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe("delivery_unknown");
  });
  it("a dispatched (known-delivered-to-provider) row is not rewritten by a not-sent callback", async () => {
    const store = new FakeStore();
    await dispatchOutbound(deps(store, scripted(json({ sid: CALL_SID })).transport), twilioCmd());
    raw(store, "busy");
    const r = await normalizeDeliveryOutcome(store, { familyId: FAMILY, sourceEventId: EVENT, provider: "twilio", status: "busy" });
    expect(r).toMatchObject({ status: "proved", dispatchReconciled: false, outboxReconciled: false });
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe("dispatched");
  });
  it("proof ids are bound to the dispatch: a proof cannot reconcile another key or outcome", async () => {
    const store = await unknownWithRef(); raw(store, "failed");
    const r = await normalizeDeliveryOutcome(store, { familyId: FAMILY, sourceEventId: EVENT, provider: "twilio", status: "failed" });
    if (r.status !== "proved") throw new Error("expected proof");
    expect(await store.reconcile(FAMILY, "dispatch:other:a1", r.proofEventId, "confirmed_not_sent")).toBe(false);
    expect(await store.reconcile(FAMILY, KEY1, r.proofEventId, "delivered")).toBe(false);
    expect(await store.reconcile(OTHER_FAMILY, KEY1, r.proofEventId, "confirmed_not_sent")).toBe(false);
  });
});
