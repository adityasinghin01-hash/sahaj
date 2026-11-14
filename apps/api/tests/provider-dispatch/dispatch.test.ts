import { describe, expect, it, vi } from "vitest";
import { classifyProviderStatus, dispatchKey, dispatchOutbound, sweepStaleClaims } from "../../src/lib/provider-dispatch";
import {
  attemptHash, CALL, CALL_SID, deps, FakeStore, FAMILY, grant, hang, json, KEY1, LEASE, OTHER_FAMILY, OTHER_PERSON, OUTBOX, PERSON,
  PHONE, sarvamCmd, scripted, twilioCmd,
} from "./helpers";

const ok = () => json({ attempt_id: "att-1" });
const noNetwork = (t: ReturnType<typeof scripted>) => expect(t.calls).toHaveLength(0);

describe("dispatch happy path", () => {
  it("claims before the network, binds call and attempt identity, finishes the outbox", async () => {
    const store = new FakeStore();
    const t = scripted(async () => {
      expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe("claimed"); // claim is durable before any provider contact
      return ok();
    });
    const out = await dispatchOutbound(deps(store, t.transport), sarvamCmd());
    expect(out).toEqual({ status: "dispatched", providerRef: "att-1", key: KEY1 });
    expect(t.calls).toHaveLength(1);
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)).toMatchObject({ status: "dispatched", ref: "att-1" });
    expect(store.calls.get(CALL)).toMatchObject({ external: "att-1", ai: true });
    expect(store.identities.get(`app-1|${attemptHash("att-1")}`)).toEqual({ familyId: FAMILY, personId: PERSON, attempt: "att-1" });
    expect(store.outbox.get(OUTBOX)?.finished).toEqual({ success: true, code: undefined });
  });
  it("twilio binds the call sid and sets AI disclosure only when the trusted caller attests it", async () => {
    for (const attest of [true, undefined]) {
      const store = new FakeStore();
      const t = scripted(json({ sid: CALL_SID }));
      const out = await dispatchOutbound(deps(store, t.transport), twilioCmd({ aiDisclosureAttested: attest }));
      expect(out.status).toBe("dispatched");
      expect(store.calls.get(CALL)).toMatchObject({ external: CALL_SID, ai: attest === true });
      expect([...store.identities.keys()]).toEqual([expect.stringMatching(/^AC[a-f0-9]{32}\|[0-9a-f]{64}$/)]); // account comes from server config
    }
  });
  it("whatsapp text needs no call and sends the resolved destination", async () => {
    const store = new FakeStore();
    const t = scripted(json({ messages: [{ id: "wamid.1" }] }));
    const out = await dispatchOutbound(deps(store, t.transport), { ...sarvamCmd({ callId: undefined }), payload: { action: "whatsapp.send_text", body: "hello" } });
    expect(out).toMatchObject({ status: "dispatched", providerRef: "wamid.1" });
  });
  it("outcomes never contain the destination number", async () => {
    const store = new FakeStore();
    const out = await dispatchOutbound(deps(store, scripted(ok()).transport), sarvamCmd());
    expect(JSON.stringify(out)).not.toContain(PHONE.slice(1));
  });
});

describe("claim races and replays", () => {
  it("two workers racing for the same outbox row produce exactly one provider call", async () => {
    const store = new FakeStore();
    const t = scripted(ok(), ok());
    const [a, b] = await Promise.all([dispatchOutbound(deps(store, t.transport), sarvamCmd()), dispatchOutbound(deps(store, t.transport), sarvamCmd())]);
    expect(t.calls).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual(["dispatched", "duplicate"]);
  });
  it("a replay of a dispatched key does not call the provider again", async () => {
    const store = new FakeStore();
    const t = scripted(ok(), ok());
    await dispatchOutbound(deps(store, t.transport), sarvamCmd());
    expect((await dispatchOutbound(deps(store, t.transport), sarvamCmd())).status).toBe("duplicate");
    expect(t.calls).toHaveLength(1);
  });
  it("a duplicate does not touch the outbox row (lease expiry makes it delivery_unknown, never a resend)", async () => {
    const store = new FakeStore();
    store.ledger.set(`${FAMILY}|${KEY1}`, { familyId: FAMILY, personId: PERSON, provider: "sarvam", action: "sarvam.outbound_call", outboxId: OUTBOX, callId: CALL, status: "dispatched", ref: "att-0" });
    const t = scripted();
    const out = await dispatchOutbound(deps(store, t.transport), sarvamCmd());
    expect(out.status).toBe("duplicate");
    expect(store.outbox.get(OUTBOX)?.finished).toBeUndefined();
    noNetwork(t);
  });
  it("derives the same key for the same outbox attempt and a new key for the next one", () => {
    expect(dispatchKey(OUTBOX, 1)).toBe(dispatchKey(OUTBOX, 1));
    expect(dispatchKey(OUTBOX, 2)).not.toBe(dispatchKey(OUTBOX, 1));
  });
});

describe("unknown delivery is never retried", () => {
  it.each([
    ["timeout", () => hang()],
    ["network error", () => new Error("socket reset")],
    ["5xx", () => json({ error: "x" }, 503)],
    ["2xx without an attempt id", () => json({ ok: true })],
    ["2xx with malformed JSON", () => new Response("<html>", { status: 200 })],
  ])("%s becomes delivery_unknown and blocks every later attempt", async (_name, make) => {
    const store = new FakeStore();
    const t = scripted(make() as never, ok(), ok());
    const out = await dispatchOutbound(deps(store, t.transport), sarvamCmd());
    expect(out).toMatchObject({ status: "delivery_unknown", key: KEY1 });
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe("delivery_unknown");
    expect(store.outbox.get(OUTBOX)?.finished).toEqual({ success: false, code: "delivery_unknown" });
    // same attempt, and a worker that mistakenly bumps the attempt number, both stop before the network
    expect((await dispatchOutbound(deps(store, t.transport), sarvamCmd())).status).toBe("duplicate");
    expect((await dispatchOutbound(deps(store, t.transport), sarvamCmd({ attempt: 2 }))).status).toBe("duplicate");
    expect(t.calls).toHaveLength(1);
  });
  it("a provider answer followed by a bookkeeping failure keeps the provider reference and is not a clean success", async () => {
    const store = new FakeStore();
    store.failComplete = true;
    const t = scripted(ok(), ok());
    const out = await dispatchOutbound(deps(store, t.transport), sarvamCmd());
    expect(out).toMatchObject({ status: "delivery_unknown", code: "post_claim_failure" });
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)).toMatchObject({ status: "delivery_unknown", ref: "att-1", code: "bookkeeping_failed" });
    expect(store.outbox.get(OUTBOX)?.finished?.success).toBe(false);
    // repair binds the identity so Sarvam callbacks can be matched, without changing delivery status or resending
    store.failComplete = false;
    expect(await store.bindIdentity({ familyId: FAMILY, key: KEY1, accountId: "app-1", identityHash: attemptHash("att-1"), aiDisclosed: true })).toBe(true);
    expect(store.identities.has(`app-1|${attemptHash("att-1")}`)).toBe(true);
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe("delivery_unknown");
    expect((await dispatchOutbound(deps(store, t.transport), sarvamCmd())).status).toBe("duplicate");
    expect(t.calls).toHaveLength(1);
  });
  it("if even the unknown marker cannot be written the row stays claimed, which blocks resend and is swept to unknown", async () => {
    const store = new FakeStore();
    store.failComplete = true; store.failUnknown = true;
    const t = scripted(ok(), ok());
    const out = await dispatchOutbound(deps(store, t.transport), sarvamCmd());
    expect(out.status).toBe("delivery_unknown");
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe("claimed");
    expect((await dispatchOutbound(deps(store, t.transport), sarvamCmd({ attempt: 2 }))).status).toBe("duplicate");
    expect(await sweepStaleClaims(store)).toBe(1);
    expect(store.ledger.get(`${FAMILY}|${KEY1}`)?.status).toBe("delivery_unknown");
    expect(t.calls).toHaveLength(1);
  });
  it("a worker crash after claim (row left claimed) cannot be resent by the next attempt", async () => {
    const store = new FakeStore();
    store.ledger.set(`${FAMILY}|${KEY1}`, { familyId: FAMILY, personId: PERSON, provider: "sarvam", action: "sarvam.outbound_call", outboxId: OUTBOX, callId: CALL, status: "claimed" });
    const t = scripted(ok());
    expect((await dispatchOutbound(deps(store, t.transport), sarvamCmd({ attempt: 2 }))).status).toBe("duplicate");
    noNetwork(t);
  });
});

describe("clean provider refusal", () => {
  it("a 4xx marks the ledger failed and a later outbox attempt may dispatch under a new key", async () => {
    const store = new FakeStore();
    const t = scripted(json({ error: "bad" }, 400), ok());
    const first = await dispatchOutbound(deps(store, t.transport), sarvamCmd());
    expect(first).toMatchObject({ status: "failed", code: "provider_rejected", reachedProvider: true });
    expect(store.outbox.get(OUTBOX)?.finished).toEqual({ success: false, code: "provider_rejected" });
    const second = await dispatchOutbound(deps(store, t.transport), sarvamCmd({ attempt: 2 }));
    expect(second).toMatchObject({ status: "dispatched" });
    expect(t.calls).toHaveLength(2);
  });
});

describe("authorization is rechecked and trusted", () => {
  const cases: Array<[string, (key: string) => ReturnType<typeof grant> | null]> = [
    ["none", () => null],
    ["deny", (k) => grant(k, { decision: "deny" })],
    ["ask", (k) => grant(k, { decision: "ask" })],
    ["no consent", (k) => grant(k, { consent: false })],
    ["other person", (k) => grant(k, { personId: OTHER_PERSON })],
    ["other action", (k) => grant(k, {}, "twilio.create_call")],
    ["other key", () => grant("dispatch:other:a1")],
    ["expired", (k) => grant(k, { expiresAt: Date.now() - 1 })],
  ];
  it.each(cases)("%s denies before claim and before the network", async (_n, make) => {
    const store = new FakeStore();
    const t = scripted(ok());
    const d = deps(store, t.transport, { authorize: async (_c, key) => make(key) });
    const out = await dispatchOutbound(d, sarvamCmd());
    expect(out).toMatchObject({ status: "denied", code: "authorization_denied" });
    expect(store.ledger.size).toBe(0);
    noNetwork(t);
  });
  it("a throwing authorizer denies", async () => {
    const store = new FakeStore(); const t = scripted(ok());
    const out = await dispatchOutbound(deps(store, t.transport, { authorize: async () => { throw new Error("cedar down"); } }), sarvamCmd());
    expect(out).toMatchObject({ status: "denied", code: "authorization_unavailable" });
    noNetwork(t);
  });
  it("the authorizer receives the stable key and the command, not provider payloads", async () => {
    const store = new FakeStore(); const authorize = vi.fn(async (_c, key: string) => grant(key));
    await dispatchOutbound(deps(store, scripted(ok()).transport, { authorize }), sarvamCmd());
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ outboxId: OUTBOX }), KEY1);
  });
});

describe("identity and reference substitution", () => {
  it("another family's call, person or outbox lease cannot be used", async () => {
    const t = scripted(ok());
    const s1 = new FakeStore(); // call belongs to FAMILY; command claims it under another family
    s1.outbox.set(OUTBOX, { familyId: OTHER_FAMILY, lease: LEASE });
    expect(await dispatchOutbound(deps(s1, t.transport), sarvamCmd({ familyId: OTHER_FAMILY }))).toMatchObject({ status: "failed", code: "identity_mismatch" });
    const s2 = new FakeStore(); // person differs from the call's person
    expect(await dispatchOutbound(deps(s2, t.transport, { authorize: async (_c, k) => grant(k, { personId: OTHER_PERSON }) }), sarvamCmd({ personId: OTHER_PERSON }))).toMatchObject({ status: "failed", code: "identity_mismatch" });
    const s3 = new FakeStore(); // stale or foreign lease
    expect(await dispatchOutbound(deps(s3, t.transport), sarvamCmd({ outboxLease: "77777777-7777-4777-8777-777777777777" }))).toMatchObject({ status: "failed", code: "stale_lease" });
    noNetwork(t);
  });
  it("a call that already has a provider reference is not rebound", async () => {
    const store = new FakeStore(); store.calls.get(CALL)!.external = "att-old";
    const t = scripted(ok());
    expect(await dispatchOutbound(deps(store, t.transport), sarvamCmd())).toMatchObject({ status: "failed", code: "dispatch_conflict" });
    noNetwork(t);
  });
  it("the same attempt id from another family cannot take over an identity binding", async () => {
    const store = new FakeStore();
    store.identities.set(`app-1|${attemptHash("att-1")}`, { familyId: OTHER_FAMILY, personId: OTHER_PERSON, attempt: "att-1" });
    const out = await dispatchOutbound(deps(store, scripted(ok()).transport), sarvamCmd());
    expect(out.status).toBe("delivery_unknown"); // provider placed the call, binding refused, nothing resent
    expect(store.identities.get(`app-1|${attemptHash("att-1")}`)?.familyId).toBe(OTHER_FAMILY);
  });
  it("a valid lease cannot redirect the row to another person, provider, action or call in the same family", async () => {
    const claim = { familyId: FAMILY, personId: PERSON, key: KEY1, provider: "sarvam" as const, action: "sarvam.outbound_call" as const, outboxId: OUTBOX, outboxLease: LEASE, callId: CALL };
    for (const over of [{ personId: OTHER_PERSON }, { provider: "twilio" as const, action: "twilio.create_call" as const }, { action: "whatsapp.send_text" as const }, { callId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, { callId: undefined }]) {
      const store = new FakeStore(); store.autoBind = false;
      await store.bindOutbox({ familyId: FAMILY, outboxId: OUTBOX, personId: PERSON, provider: "sarvam", action: "sarvam.outbound_call", callId: CALL });
      await expect(store.claim({ ...claim, ...over })).rejects.toMatchObject({ code: "identity_mismatch" });
      expect(store.ledger.size).toBe(0);
    }
  });
  it("an outbox row with no binding cannot be claimed", async () => {
    const store = new FakeStore(); store.autoBind = false; const t = scripted(ok());
    expect(await dispatchOutbound(deps(store, t.transport), sarvamCmd())).toMatchObject({ status: "failed", code: "identity_mismatch" });
    noNetwork(t);
  });
  it("binding a call that belongs to another person, another family or nobody is refused and records nothing", async () => {
    const store = new FakeStore(); store.autoBind = false;
    store.calls.set("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { familyId: FAMILY, personId: OTHER_PERSON, ai: false });
    store.calls.set("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { familyId: OTHER_FAMILY, personId: PERSON, ai: false });
    store.calls.set("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { familyId: FAMILY, personId: PERSON, external: "att-old", ai: false });
    for (const callId of ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"]) {
      await expect(store.bindOutbox({ familyId: FAMILY, outboxId: OUTBOX, personId: PERSON, provider: "sarvam", action: "sarvam.outbound_call", callId })).rejects.toMatchObject({ code: "identity_mismatch" });
    }
    expect(store.bindings.size).toBe(0);
    // an identical replay after the call was bound at dispatch stays a no-op
    const b = { familyId: FAMILY, outboxId: OUTBOX, personId: PERSON, provider: "sarvam" as const, action: "sarvam.outbound_call" as const, callId: CALL };
    await store.bindOutbox(b); store.calls.get(CALL)!.external = "att-1";
    expect(await store.bindOutbox(b)).toBe(true);
  });
  it("a call swapped to another person after binding is refused at claim: nothing is claimed and no provider is contacted", async () => {
    const store = new FakeStore(); store.autoBind = false;
    await store.bindOutbox({ familyId: FAMILY, outboxId: OUTBOX, personId: PERSON, provider: "sarvam", action: "sarvam.outbound_call", callId: CALL });
    store.calls.get(CALL)!.personId = OTHER_PERSON; // same family, different recipient
    const t = scripted(ok());
    expect(await dispatchOutbound(deps(store, t.transport), sarvamCmd())).toMatchObject({ status: "failed", code: "identity_mismatch", reachedProvider: false });
    expect(store.ledger.size).toBe(0); noNetwork(t);
    expect(store.calls.get(CALL)!.external).toBeUndefined(); expect(store.identities.size).toBe(0);
  });  it("bindings are immutable: a conflicting rebind is refused", async () => {
    const store = new FakeStore();
    const b = { familyId: FAMILY, outboxId: OUTBOX, personId: PERSON, provider: "sarvam" as const, action: "sarvam.outbound_call" as const, callId: CALL };
    await store.bindOutbox(b);
    expect(await store.bindOutbox(b)).toBe(true);
    await expect(store.bindOutbox({ ...b, personId: OTHER_PERSON })).rejects.toMatchObject({ code: "dispatch_conflict" });
  });});

describe("failures before the external boundary send nothing", () => {
  it("unresolvable destination, missing provider config, ledger down, bad command", async () => {
    const t = scripted(ok());
    const store = new FakeStore();
    expect(await dispatchOutbound(deps(store, t.transport, { resolveDestination: async () => null }), sarvamCmd())).toMatchObject({ status: "failed", code: "unknown_identity" });
    expect(await dispatchOutbound(deps(store, t.transport, { resolveDestination: async () => { throw new Error("db"); } }), sarvamCmd())).toMatchObject({ code: "identity_lookup_failed" });
    expect(await dispatchOutbound(deps(store, t.transport, { providers: {} }), sarvamCmd())).toMatchObject({ code: "provider_not_configured" });
    store.failClaim = true;
    expect(await dispatchOutbound(deps(store, t.transport), sarvamCmd())).toMatchObject({ status: "failed", code: "dispatch_store_unavailable", reachedProvider: false });
    for (const bad of [sarvamCmd({ callId: undefined }), sarvamCmd({ attempt: 0 }), sarvamCmd({ familyId: "x" }), { ...sarvamCmd(), payload: { action: "nope" } as never }]) {
      await expect(dispatchOutbound(deps(store, t.transport), bad)).rejects.toMatchObject({ name: "DispatchError" });
    }
    noNetwork(t);
  });
  it("adapter validation (unsafe TwiML host, bad number) fails before claim", async () => {
    const store = new FakeStore(); const t = scripted(json({ sid: CALL_SID }));
    const out = await dispatchOutbound(deps(store, t.transport), twilioCmd({ payload: { action: "twilio.create_call", twimlUrl: "https://evil.test/x" } }));
    expect(out).toMatchObject({ status: "failed", code: "unsafe_url", reachedProvider: false });
    expect(store.ledger.size).toBe(0);
    const out2 = await dispatchOutbound(deps(store, t.transport, { resolveDestination: async () => "not-a-number" }), sarvamCmd());
    expect(out2).toMatchObject({ status: "failed", code: "invalid_payload" });
    noNetwork(t);
  });
  it("a failing finishOutbox never turns a recorded dispatch into a resend", async () => {
    const store = new FakeStore(); store.failFinish = true;
    const t = scripted(ok(), ok());
    expect((await dispatchOutbound(deps(store, t.transport), sarvamCmd())).status).toBe("dispatched");
    expect((await dispatchOutbound(deps(store, t.transport), sarvamCmd())).status).toBe("duplicate");
    expect(t.calls).toHaveLength(1);
  });
});

describe("provider status evidence", () => {
  it("only clear not-sent or recipient-delivered statuses resolve; a connected call does not prove a person was reached", () => {
    expect(classifyProviderStatus("twilio", "completed")).toBeNull();
    expect(classifyProviderStatus("twilio", "in-progress")).toBeNull();
    expect(classifyProviderStatus("sarvam", "connected")).toBeNull();
    for (const s of ["busy", "no-answer", "failed", "canceled"]) expect(classifyProviderStatus("twilio", s)).toBe("confirmed_not_sent");
    for (const s of ["no_answer", "busy", "failed"]) expect(classifyProviderStatus("sarvam", s)).toBe("confirmed_not_sent");
    expect(classifyProviderStatus("whatsapp", "delivered")).toBe("delivered");
    expect(classifyProviderStatus("whatsapp", "sent")).toBeNull();
    expect(classifyProviderStatus("whatsapp", "mystery")).toBeNull();
  });
});
