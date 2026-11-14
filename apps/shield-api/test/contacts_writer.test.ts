import { describe, it, expect, vi } from "vitest";
import type { ISql, Sql } from "postgres";
import { createContactWriter, createContactsPort } from "../src/ports/contacts";

const F = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222221";
const env = { WEBHOOK_ENCRYPTION_KEY: "ab".repeat(32), IDENTITY_HASH_SECRET: "synthetic-contact-index-secret-32-chars", SARVAM_APP_ID: "synthetic-sarvam-app" };
const phone = "+919000000009";

/** Fake tagged-template sql with `begin`; the insert's values become the stored row. */
function fake(insertResult: (values: unknown[]) => unknown[] = () => [{ id: "row-1" }]) {
  const queries: { text: string; values: unknown[] }[] = [];
  const tx = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    queries.push({ text, values });
    return text.includes("insert into public.provider_identities") ? insertResult(values) : [];
  });
  const sql = Object.assign(tx, { begin: async (fn: (t: typeof tx) => unknown) => fn(tx) }) as unknown as Sql;
  return { sql, queries };
}

describe("contact writer", () => {
  it("stores only ciphertext + HMAC index, and the contacts port resolves it back", async () => {
    const { sql, queries } = fake();
    expect(await createContactWriter(sql, env).bind({ familyId: F, personId: P, source: "sarvam", phoneE164: phone })).toBe("bound");
    expect(JSON.stringify(queries)).not.toContain(phone);
    expect(JSON.stringify(queries)).not.toContain(phone.slice(1));
    const insert = queries.find((q) => q.text.includes("insert into"))!;
    const [family_id, person_id, source, account_id, external_id_hash, contact_ciphertext, enabled] = insert.values;
    expect(enabled).toBe(true);
    expect(queries.some((q) => q.text.includes("set enabled = false"))).toBe(true);
    const read = vi.fn(async () => [{ family_id, person_id, source, account_id, external_id_hash, contact_ciphertext }]) as unknown as ISql;
    expect(await createContactsPort(read, env).resolve({ familyId: F, personId: P, source: "sarvam" })).toBe(phone);
  });

  it("secondary numbers are stored disabled and never disable the primary", async () => {
    const { sql, queries } = fake();
    expect(await createContactWriter(sql, env).bind({ familyId: F, personId: P, source: "sarvam", phoneE164: phone, primary: false })).toBe("bound");
    expect(queries.find((q) => q.text.includes("insert into"))!.values[6]).toBe(false);
    expect(queries.some((q) => q.text.includes("set enabled = false"))).toBe(false);
  });

  it("refuses invalid input, missing keys or account, and numbers bound to another person", async () => {
    const w = (e: Record<string, string>, rows?: () => unknown[]) => createContactWriter(fake(rows).sql, e);
    expect(await w(env).bind({ familyId: F, personId: P, source: "sarvam", phoneE164: "9000000009" })).toBe("invalid");
    expect(await w(env).bind({ familyId: "x", personId: P, source: "sarvam", phoneE164: phone })).toBe("invalid");
    expect(await w({ ...env, SARVAM_APP_ID: "" }).bind({ familyId: F, personId: P, source: "sarvam", phoneE164: phone })).toBe("account_not_configured");
    expect(await w({ ...env, WEBHOOK_ENCRYPTION_KEY: "short" }).bind({ familyId: F, personId: P, source: "sarvam", phoneE164: phone })).toBe("keys_not_configured");
    expect(await w(env, () => []).bind({ familyId: F, personId: P, source: "sarvam", phoneE164: phone })).toBe("conflict");
  });
});
