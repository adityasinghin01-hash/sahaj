import type { Sql } from "postgres";

/** Durable at-most-once claim: an ambiguous network result requires operator reconciliation, never blind redial. */
export async function claimProvider(
  sql: Sql,
  input: {
    channel: "push" | "calls";
    kind: string;
    familyId: string;
    parentId?: string;
    key: string;
  },
) {
  const rows =
    await sql`insert into public.dev_outbox(channel,kind,family_id,parent_id,dedupe_key,payload)
    values (${input.channel},${input.kind},${input.familyId},${input.parentId ?? null},${input.key},'{"delivery":"claimed"}'::jsonb)
    on conflict(dedupe_key) do nothing returning id`;
  return rows[0]?.id as string | undefined;
}
export async function finishProvider(
  sql: Sql,
  id: string,
  delivery: "accepted" | "failed" | "unknown",
  reference?: string,
) {
  // Fixed statuses only; no provider error bodies or recipient numbers are persisted.
  await sql`update public.dev_outbox set payload=${sql.json({ delivery, ...(reference ? { reference } : {}) })} where id=${id}`;
}
