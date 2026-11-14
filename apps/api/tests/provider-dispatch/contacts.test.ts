import { describe, expect, it, vi } from "vitest";
import { contactAad, contactDigits, createContactResolver, registerContactIdentity, revokeContactIdentity, type ContactDb } from "../../src/lib/provider-dispatch";
import { encryptWebhook, identityHash } from "../../src/lib/webhook-security";

const KEY = "cd".repeat(32), SECRET = "synthetic-identity-secret-0123456789abcdef";
const F = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222", Q = "33333333-3333-4333-8333-333333333333";
const PNID = "1234567890", APP = "app-1", AC = "AC" + "a".repeat(32), PHONE = "+919000000001";
const accounts = { whatsapp: PNID, sarvam: APP, twilio: AC };

function row(o: Partial<Record<string, unknown>> = {}, e164 = PHONE, who = { f: F, p: P, s: "whatsapp", a: PNID }) {
  const hash = identityHash(who.s, who.a, contactDigits(e164), SECRET);
  return { id: "44444444-4444-4444-8444-444444444444", family_id: who.f, person_id: who.p, source: who.s, account_id: who.a, external_id_hash: hash, binding_kind: "contact",
    contact_ciphertext: encryptWebhook(Buffer.from(e164), KEY, contactAad(who.f, who.p, who.s as never, who.a, hash)), enabled: true, revoked_at: null, ...o };
}
/** Records filters; returns scripted rows. */
function fakeDb(rows: unknown[] | Error, rpc?: { data?: unknown; error?: { code?: string; message?: string } | null }) {
  const filters: string[] = []; const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db: ContactDb = {
    from: (t: string) => { filters.push(`table=${t}`); const q: any = { // eslint-disable-line @typescript-eslint/no-explicit-any
      select: () => q, limit: (n: number) => { filters.push(`limit=${n}`); return q; },
      eq: (c: string, v: unknown) => { filters.push(`${c}=${v}`); return q; }, is: (c: string, v: unknown) => { filters.push(`${c} is ${v}`); return q; },
      then: (res: (v: unknown) => unknown) => res(rows instanceof Error ? { data: null, error: { message: "boom +919000000001" } } : { data: rows, error: null }) }; return q; },
    rpc: async (name, args) => { calls.push({ name, args }); return { data: rpc?.data ?? null, error: rpc?.error ?? null }; },
  };
  return { db, filters, calls };
}
const resolver = (db: ContactDb, cfg = {}) => createContactResolver(db, { encryptionKeyHex: KEY, identitySecret: SECRET, accounts, ...cfg });

describe("createContactResolver", () => {
  it("returns the E.164 number for exactly one matching row, filtering family, person, source, account, kind, enabled, revoked", async () => {
    const f = fakeDb([row()]);
    expect(await resolver(f.db)(F, P, "whatsapp")).toBe(PHONE);
    expect(f.filters).toEqual(expect.arrayContaining(["table=provider_identities", `family_id=${F}`, `person_id=${P}`, "source=whatsapp", `account_id=${PNID}`,
      "binding_kind=contact", "enabled=true", "revoked_at is null", "limit=2"]));
  });
  it("uses the configured account per provider and returns null when that provider has no configured account", async () => {
    const sarvamRow = row({}, PHONE, { f: F, p: P, s: "sarvam", a: APP });
    const f = fakeDb([sarvamRow]);
    expect(await resolver(f.db)(F, P, "sarvam")).toBe(PHONE);
    expect(f.filters).toContain(`account_id=${APP}`);
    expect(await resolver(fakeDb([sarvamRow]).db, { accounts: { whatsapp: PNID } })(F, P, "sarvam")).toBeNull();
  });
  it("is null for missing or ambiguous rows", async () => {
    expect(await resolver(fakeDb([]).db)(F, P, "whatsapp")).toBeNull();
    expect(await resolver(fakeDb([row(), row({}, "+919000000002")]).db)(F, P, "whatsapp")).toBeNull();
  });
  it("is null when the returned row is not exactly this context (defence against a wrong query)", async () => {
    for (const o of [{ family_id: "x" }, { person_id: Q }, { source: "sarvam" }, { account_id: "999" }, { binding_kind: "message" }, { enabled: false }, { revoked_at: "2026-01-01" }]) {
      expect(await resolver(fakeDb([row(o)]).db)(F, P, "whatsapp")).toBeNull();
    }
  });
  it("is null for tampered, moved or copied ciphertext and hash mismatches", async () => {
    const other = row({}, PHONE, { f: F, p: Q, s: "whatsapp", a: PNID }); // valid ciphertext for Q copied onto P's row
    expect(await resolver(fakeDb([row({ contact_ciphertext: other.contact_ciphertext })]).db)(F, P, "whatsapp")).toBeNull();
    const ct = row().contact_ciphertext as string;
    expect(await resolver(fakeDb([row({ contact_ciphertext: ct.slice(0, -2) + (ct.endsWith("A") ? "BB" : "AA") })]).db)(F, P, "whatsapp")).toBeNull();
    expect(await resolver(fakeDb([row({ external_id_hash: "f".repeat(64) })]).db)(F, P, "whatsapp")).toBeNull(); // AAD binds the hash
    // valid AAD but the plaintext number does not match the stored hash
    const h = identityHash("whatsapp", PNID, contactDigits("+919000000009"), SECRET);
    const mismatch = { ...row(), external_id_hash: h, contact_ciphertext: encryptWebhook(Buffer.from(PHONE), KEY, contactAad(F, P, "whatsapp", PNID, h)) };
    expect(await resolver(fakeDb([mismatch]).db)(F, P, "whatsapp")).toBeNull();
    // valid AAD and hash but not E.164
    const bad = "919000000001"; const hb = identityHash("whatsapp", PNID, bad.slice(1), SECRET);
    expect(await resolver(fakeDb([{ ...row(), external_id_hash: hb, contact_ciphertext: encryptWebhook(Buffer.from(bad), KEY, contactAad(F, P, "whatsapp", PNID, hb)) }]).db)(F, P, "whatsapp")).toBeNull();
    expect(await resolver(fakeDb([row({ contact_ciphertext: null })]).db)(F, P, "whatsapp")).toBeNull();
  });
  it("resolveIdentity returns the exact registry row id, account and hash bound into the dispatch claim", async () => {
    const r = row();
    const res = resolver(fakeDb([r]).db);
    expect(await res.resolveIdentity(F, P, "whatsapp")).toEqual({ e164: PHONE, identityId: r.id, accountId: PNID, identityHash: r.external_id_hash });
    expect(await res.resolveIdentity(F, P, "whatsapp").then((x) => JSON.stringify(x))).not.toContain("contact_ciphertext");
    expect(await resolver(fakeDb([row({ id: "not-a-uuid" })]).db).resolveIdentity(F, P, "whatsapp")).toBeNull();
  });
  it("rejects malformed ids before querying, and a database error throws a code-only error", async () => {
    const f = fakeDb([row()]);
    expect(await resolver(f.db)("not-a-uuid", P, "whatsapp")).toBeNull(); expect(f.filters).toHaveLength(0);
    const err = await resolver(fakeDb(new Error("x")).db)(F, P, "whatsapp").catch((e) => e);
    expect(err).toMatchObject({ name: "ContactError", code: "contact_lookup_failed" }); expect(String(err.message)).not.toContain("9190");
  });
});

describe("registerContactIdentity", () => {
  const input = { familyId: F, personId: P, source: "whatsapp" as const, accountId: PNID, e164: PHONE };
  const crypto = { encryptionKeyHex: KEY, identitySecret: SECRET };
  it("sends only the canonical-digit hash and AAD-bound ciphertext, never the plaintext", async () => {
    const f = fakeDb([], { data: "registered" });
    expect(await registerContactIdentity(f.db, crypto, input)).toBe("registered");
    const args = f.calls[0]!.args;
    expect(f.calls[0]!.name).toBe("register_contact_identity");
    expect(args.p_identity_hash).toBe(identityHash("whatsapp", PNID, "919000000001", SECRET)); // the same hash inbound WhatsApp lookups use
    expect(JSON.stringify(args)).not.toContain("9000000001");
    // the stored ciphertext resolves back through the resolver
    const stored = { ...row(), external_id_hash: args.p_identity_hash, contact_ciphertext: args.p_contact_ciphertext };
    expect(await resolver(fakeDb([stored]).db)(F, P, "whatsapp")).toBe(PHONE);
  });
  it("refuses invalid numbers and ids before any database call", async () => {
    const f = fakeDb([], { data: "registered" });
    for (const e164 of ["919000000001", "+0919000000001", "+91 9000000001", "+1234567", "+1234567890123456", ""]) {
      await expect(registerContactIdentity(f.db, crypto, { ...input, e164 })).rejects.toMatchObject({ code: "invalid_contact" });
    }
    await expect(registerContactIdentity(f.db, crypto, { ...input, source: "email" as never })).rejects.toMatchObject({ code: "invalid_contact" });
    await expect(registerContactIdentity(f.db, crypto, { ...input, accountId: "a/b" })).rejects.toMatchObject({ code: "invalid_contact" });
    expect(f.calls).toHaveLength(0);
  });
  it("maps SQL refusals to fixed codes and never echoes database text", async () => {
    for (const m of ["identity_owned_elsewhere", "identity_revoked", "contact_already_registered", "person_not_in_family"]) {
      await expect(registerContactIdentity(fakeDb([], { error: { code: "23505", message: m } }).db, crypto, input)).rejects.toMatchObject({ code: m });
    }
    const e = await registerContactIdentity(fakeDb([], { error: { code: "XX000", message: "secret +919000000001" } }).db, crypto, input).catch((x) => x);
    expect(e.code).toBe("contact_registration_failed"); expect(String(e.message)).not.toContain("9190");
    await expect(registerContactIdentity(fakeDb([], { data: "weird" }).db, crypto, input)).rejects.toMatchObject({ code: "contact_registration_failed" });
  });
  it("revocation goes through the service RPC", async () => {
    const f = fakeDb([], { data: 1 });
    expect(await revokeContactIdentity(f.db, { familyId: F, personId: P, source: "whatsapp", accountId: PNID })).toBe(1);
    expect(f.calls[0]).toEqual({ name: "revoke_contact_identity", args: { p_family_id: F, p_person_id: P, p_source: "whatsapp", p_account_id: PNID } });
    expect(vi.isMockFunction(f.db.rpc)).toBe(false);
  });
});
