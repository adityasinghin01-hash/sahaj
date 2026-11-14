import type { Sql } from "postgres";

export type OutboxChannel = "whatsapp" | "push" | "calls" | "atlas";

export interface OutboxEntry {
  channel: OutboxChannel;
  kind: string;
  familyId?: string | null;
  parentId?: string | null;
  dedupeKey?: string | null;
  payload: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asUuidOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

export async function writeOutbox(sql: Sql, entry: OutboxEntry): Promise<void> {
  const familyId = asUuidOrNull(entry.familyId);
  const parentId = asUuidOrNull(entry.parentId);
  const dedupeKey = entry.dedupeKey ?? null;
  const payload = entry.payload as postgresJson;

  if (dedupeKey) {
    await sql`
      insert into public.dev_outbox (channel, kind, family_id, parent_id, dedupe_key, payload)
      values (${entry.channel}, ${entry.kind}, ${familyId}, ${parentId}, ${dedupeKey}, ${sql.json(payload)})
      on conflict (dedupe_key) do nothing`;
    return;
  }
  await sql`
    insert into public.dev_outbox (channel, kind, family_id, parent_id, payload)
    values (${entry.channel}, ${entry.kind}, ${familyId}, ${parentId}, ${sql.json(payload)})`;
}

// postgres.js JSONValue helper type without importing internal types
type postgresJson = Parameters<Sql["json"]>[0];

