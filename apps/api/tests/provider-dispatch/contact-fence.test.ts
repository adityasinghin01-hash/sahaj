import { describe, expect, it } from "vitest";
import { dispatchOutbound } from "../../src/lib/provider-dispatch";
import { deps, FakeStore, FAMILY, json, OTHER_FAMILY, PERSON, sarvamCmd, scripted, storeResolver, CALL_SID, twilioCmd, fixedResolver, ACCOUNTS } from "./helpers";

const ok = () => json({ attempt_id: "att-1" });

/**
 * The dispatcher resolves the destination BEFORE the durable claim. These tests mutate the registry in exactly that window
 * (deterministically, from inside the resolver) and require: no ledger claim, no provider request, outbox finished failed.
 * The SQL fence that enforces the same rule is tested on real PostgreSQL in whatsapp-scratch.test.ts and sql-concurrency.ps1.
 */
describe("contact revocation between resolve and claim", () => {
  it("resolve-then-revoke: the cached number is never contacted", async () => {
    const store = new FakeStore(); const t = scripted(ok());
    const resolveDestination = storeResolver(store, () => store.revokeContact(FAMILY, PERSON, "sarvam"));
    const out = await dispatchOutbound(deps(store, t.transport, { resolveDestination }), sarvamCmd());
    expect(out).toMatchObject({ status: "failed", code: "contact_not_current", reachedProvider: false });
    expect(t.calls).toHaveLength(0); expect(store.ledger.size).toBe(0);
    expect(store.outbox.get(sarvamCmd().outboxId)?.finished).toEqual({ success: false, code: "contact_not_current" });
  });
  it("resolve-then-replace: a new number registered for the same person does not let the old one through", async () => {
    const store = new FakeStore(); const t = scripted(json({ sid: CALL_SID }));
    const resolveDestination = storeResolver(store, () => { store.revokeContact(FAMILY, PERSON, "twilio"); store.addContact(FAMILY, PERSON, "twilio", "+919000000777"); });
    const out = await dispatchOutbound(deps(store, t.transport, { resolveDestination }), twilioCmd());
    expect(out).toMatchObject({ status: "failed", code: "contact_not_current", reachedProvider: false });
    expect(t.calls).toHaveLength(0); expect(store.ledger.size).toBe(0);
    // the next attempt resolves the NEW number and is allowed
    const t2 = scripted(json({ sid: CALL_SID }));
    expect(await dispatchOutbound(deps(store, t2.transport), twilioCmd({ attempt: 2 }))).toMatchObject({ status: "dispatched" });
    expect(new URLSearchParams(String(t2.calls[0]!.init.body)).get("To")).toBe("+919000000777");
  });
  it("a contact disabled (not revoked) or edited to a different number in the window is refused", async () => {
    const store = new FakeStore(); const t = scripted(ok());
    const disable = storeResolver(store, (r) => { store.contacts.get(r!.identityId)!.enabled = false; });
    expect(await dispatchOutbound(deps(store, t.transport, { resolveDestination: disable }), sarvamCmd())).toMatchObject({ code: "contact_not_current" });
    const s2 = new FakeStore();
    const edit = storeResolver(s2, (r) => { s2.contacts.get(r!.identityId)!.hash = "f".repeat(64); });
    expect(await dispatchOutbound(deps(s2, t.transport, { resolveDestination: edit }), sarvamCmd())).toMatchObject({ code: "contact_not_current" });
    expect(t.calls).toHaveLength(0);
  });
  it("an identity of another family, another person or another provider account is refused at claim", async () => {
    for (const mutate of [
      (s: FakeStore, id: string) => { s.contacts.get(id)!.familyId = OTHER_FAMILY; },
      (s: FakeStore, id: string) => { s.contacts.get(id)!.personId = "88888888-8888-4888-8888-888888888888"; },
      (s: FakeStore, id: string) => { s.contacts.get(id)!.source = "whatsapp"; },
    ]) {
      const store = new FakeStore(); const t = scripted(ok());
      const r = storeResolver(store, (x) => mutate(store, x!.identityId));
      expect(await dispatchOutbound(deps(store, t.transport, { resolveDestination: r }), sarvamCmd())).toMatchObject({ code: "contact_not_current", reachedProvider: false });
      expect(t.calls).toHaveLength(0);
    }
  });
  it("a resolver whose identity belongs to a different provider account than the one sending is refused before claim", async () => {
    const store = new FakeStore(); const t = scripted(ok());
    const good = (await storeResolver(store).resolveIdentity(FAMILY, PERSON, "sarvam"))!;
    const out = await dispatchOutbound(deps(store, t.transport, { resolveDestination: fixedResolver(async () => ({ ...good, accountId: "app-OTHER" })) }), sarvamCmd());
    expect(out).toMatchObject({ status: "failed", code: "contact_account_mismatch" });
    expect(store.ledger.size).toBe(0); expect(t.calls).toHaveLength(0);
    expect(ACCOUNTS.sarvam).toBe("app-1");
  });
  it("a string-only resolver (no exact identity) is refused before any claim", async () => {
    const store = new FakeStore(); const t = scripted(ok());
    const out = await dispatchOutbound(deps(store, t.transport, { resolveDestination: (async () => "+919000000001") as never }), sarvamCmd());
    expect(out).toMatchObject({ status: "failed", code: "contact_identity_unbound" });
    expect(store.ledger.size).toBe(0); expect(t.calls).toHaveLength(0);
  });
  it("revocation AFTER the claim committed does not undo an authorized send (documented boundary)", async () => {
    const store = new FakeStore();
    const t = scripted(async () => { store.revokeContact(FAMILY, PERSON, "sarvam"); return ok(); });
    expect(await dispatchOutbound(deps(store, t.transport), sarvamCmd())).toMatchObject({ status: "dispatched" });
    expect(t.calls).toHaveLength(1);
    // and nothing further can be sent to the revoked contact
    const t2 = scripted(ok());
    expect(await dispatchOutbound(deps(store, t2.transport), sarvamCmd({ attempt: 2 }))).toMatchObject({ status: "failed", code: "unknown_identity" });
    expect(t2.calls).toHaveLength(0);
  });
});
