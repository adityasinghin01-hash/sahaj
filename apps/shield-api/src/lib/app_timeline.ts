import type { Sql } from "postgres";
import { type ShieldRuntimePorts, maskDigits } from "@sahaj/shield";
import { computeChainHash } from "../ports/sign";

export function createAppTimelinePort(
  sql: Sql,
): NonNullable<ShieldRuntimePorts["timeline"]> {
  async function incidentRows(eventIds: string[]) {
    if (!eventIds.length) throw new Error("Evidence has no events");
    return sql`select t.created_at::text, t.step, t.status, t.entry, t.prev_hash, t.hash from public.dev_timeline t
      where exists (select 1 from public.shield_events e where e.id=any(${eventIds}::uuid[]) and e.family_id=t.family_id
        and (t.event_key=e.id::text or t.event_key=e.idempotency_key or t.verdict_id in
          (select v.id from public.shield_verdicts v where v.family_id=e.family_id and e.id=any(v.event_ids)))) order by t.seq`;
  }
  return {
    async entriesFor(eventIds) {
      return (await incidentRows(eventIds)).map((r) => ({
        at: r.created_at,
        step: maskDigits(r.step),
        status: ["ok", "denied", "failed", "skipped"].includes(r.status)
          ? r.status
          : "skipped",
        ...(typeof r.entry.action === "string"
          ? { action: maskDigits(r.entry.action) }
          : {}),
        ...(r.entry.details
          ? { details: maskDigits(JSON.stringify(r.entry.details)) }
          : {}),
        ...(typeof r.entry.data?.money_sent === "boolean"
          ? { money_sent: r.entry.data.money_sent }
          : {}),
      }));
    },
    async chainHashFor(eventIds) {
      const rows = await incidentRows(eventIds);
      const last = rows.at(-1);
      if (!last) throw new Error("No signed evidence checkpoint");
      // Check the full prefix up to this checkpoint; interleaved families are part of the global chain.
      const chain =
        await sql`select entry, prev_hash, hash from public.dev_timeline where seq <=
        (select seq from public.dev_timeline where hash=${last.hash} limit 1) order by seq`;
      let previous = "0".repeat(64);
      for (const row of chain) {
        if (
          row.prev_hash !== previous ||
          computeChainHash(previous, row.entry) !== row.hash
        )
          throw new Error("Evidence chain invalid");
        previous = row.hash;
      }
      return previous;
    },
  };
}
