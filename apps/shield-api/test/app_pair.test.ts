import { describe, it, expect, vi } from "vitest";
import type { Sql } from "postgres";
import { idempotentAppPair } from "../src/lib/app_pair";
const member = {
  family_id: "11111111-1111-4111-8111-111111111111",
  user_id: "33333333-3333-4333-8333-333333333332",
  person_id: null,
  role: "child",
};
const pair = {
  ok: true as const,
  code: "123456",
  expires_at: "2026-11-14T01:00:00Z",
  family_id: member.family_id,
};
function storage() {
  const rows = new Map<string, unknown>(),
    writes: unknown[] = [];
  const conn = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("select value"))
        return rows.has(String(values[0]))
          ? [{ value: rows.get(String(values[0])) }]
          : [];
      if (query.includes("insert into public.dev_cache")) {
        rows.set(String(values[0]), values[1]);
        writes.push(values[1]);
      }
      return [];
    },
    { json: (x: unknown) => x, release: vi.fn() },
  );
  return { sql: { reserve: async () => conn } as unknown as Sql, conn, writes };
}
describe("pair request replay encryption", () => {
  it("replays one runtime code without storing plaintext", async () => {
    const { sql, writes, conn } = storage();
    const create = vi.fn(async () => pair);
    const secret = "pair-cache-test-secret-at-least-thirty-two";
    expect(
      await idempotentAppPair(sql, secret, member, "request-key", create),
    ).toEqual(pair);
    expect(
      await idempotentAppPair(sql, secret, member, "request-key", create),
    ).toEqual(pair);
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(writes)).not.toContain("123456");
    expect(conn.release).toHaveBeenCalledTimes(2);
  });
  it("isolates users and request keys", async () => {
    const { sql } = storage();
    const create = vi.fn(async () => pair);
    const secret = "pair-cache-test-secret-at-least-thirty-two";
    await idempotentAppPair(sql, secret, member, "first-key", create);
    await idempotentAppPair(sql, secret, member, "second-key", create);
    await idempotentAppPair(
      sql,
      secret,
      { ...member, user_id: "33333333-3333-4333-8333-333333333333" },
      "first-key",
      create,
    );
    expect(create).toHaveBeenCalledTimes(3);
  });
  it("rejects cached ciphertext with another signing secret and releases connection", async () => {
    const { sql, conn } = storage();
    const create = vi.fn(async () => pair);
    await idempotentAppPair(sql, "first-secret", member, "request-key", create);
    await expect(
      idempotentAppPair(sql, "other-secret", member, "request-key", create),
    ).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
    expect(conn.release).toHaveBeenCalledTimes(2);
  });
});
