import type { ISql } from "postgres";
import { ShieldEvent, Verdict } from "@sahaj/shared";
import { isUuid } from "../db/pg";
import type { EvidenceStore } from "./types";

export function createEvidencePg(sql: ISql): EvidenceStore {
  return {
    async isChild({ familyId, viewerUserId }) {
      if (!isUuid(familyId) || !isUuid(viewerUserId)) return false;
      const rows = await sql`select 1 from public.family_members where family_id = ${familyId} and user_id = ${viewerUserId} and role = 'child' limit 1`;
      return rows.length > 0;
    },
    async getIncident({ familyId, verdictId }) {
      if (!isUuid(familyId) || !isUuid(verdictId)) return null;
      const [row] = await sql`select * from public.shield_verdicts where id = ${verdictId} and family_id = ${familyId}`;
      if (!row) return null;
      const eventIds = row.event_ids as string[];
      const events = await sql`select * from public.shield_events where id = any(${eventIds}::uuid[])
        and family_id = ${familyId} and parent_id = ${row.parent_id} order by occurred_at, id`;
      return {
        familyId, parentId: row.parent_id, verdictId, createdAt: new Date(row.created_at).toISOString(), eventIds,
        verdict: Verdict.parse({ ...row, confidence: Number(row.confidence) }),
        events: events.map(event => {
          const value: Record<string, unknown> = { ...event, occurred_at: new Date(event.occurred_at).toISOString() };
          for (const key of ["device_id", "masked_text", "sender_type", "caller_type", "local_level"] as const) {
            if (value[key] === null) delete value[key];
          }
          return { id: event.id as string, event: ShieldEvent.parse(value) };
        }),
      };
    },
    async savePack({ familyId, verdictId, viewerUserId, contentsHash, chainHash, createdAt }) {
      // Recheck membership and incident family at the write, including service-role callers.
      const rows = await sql`insert into public.evidence_packs (family_id, verdict_id, created_for, contents_hash, chain_hash, created_at)
        select ${familyId}, v.id, ${viewerUserId}, ${contentsHash}, ${chainHash}, ${createdAt}::timestamptz
        from public.shield_verdicts v where v.id = ${verdictId} and v.family_id = ${familyId} and v.level = 'red'
          and exists (select 1 from public.family_members m where m.family_id = ${familyId} and m.user_id = ${viewerUserId} and m.role = 'child')
        returning id`;
      if (!rows.length) throw new Error("Evidence child access required");
      return { id: rows[0]!.id as string };
    },
    async getPack({ familyId, packId }) {
      if (!isUuid(familyId) || !isUuid(packId)) return null;
      const [row] = await sql`select id, family_id, verdict_id, created_for, contents_hash, chain_hash, created_at
        from public.evidence_packs where id = ${packId} and family_id = ${familyId}`;
      if (!row) return null;
      return { id: row.id, familyId: row.family_id, verdictId: row.verdict_id, createdFor: row.created_for,
        contentsHash: row.contents_hash, chainHash: row.chain_hash, createdAt: new Date(row.created_at).toISOString() };
    },
  };
}
