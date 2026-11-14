import type { Sql } from "postgres";
import type { LinkResult, ShieldRuntimePorts } from "@sahaj/shield";

type JsonParam = Parameters<Sql["json"]>[0];

export function createCachePort(sql: Sql, clock: { now(): Date }): ShieldRuntimePorts["cache"] {
  return {
    async get(key: string): Promise<LinkResult | null> {
      const now = clock.now();
      const [row] = await sql<{ value: LinkResult }[]>`
        select value from public.dev_cache
        where key = ${key} and expires_at > ${now}::timestamptz`;
      return row?.value ?? null;
    },
    async set(key: string, value: LinkResult, ttlSeconds: number): Promise<void> {
      const now = clock.now();
      const ttlMs = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds * 1000 : 0;
      const expiresAt = new Date(now.getTime() + ttlMs);
      await sql`
        insert into public.dev_cache (key, value, expires_at, updated_at)
        values (${key}, ${sql.json(value as unknown as JsonParam)}, ${expiresAt}::timestamptz, ${now}::timestamptz)
        on conflict (key) do update
          set value = excluded.value,
              expires_at = excluded.expires_at,
              updated_at = excluded.updated_at`;
    },
  };
}

