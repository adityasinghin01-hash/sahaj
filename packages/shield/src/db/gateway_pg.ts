/**
 * Postgres implementation of SmsGatewayDb (card K-B6). Needs migration 20261114160500_shield_gateway.sql.
 * Service-role connection; every value is a bound parameter.
 */
import type { ISql } from "postgres";
import type { GatewayRegistryDb, NewGatewayEventRow, SmsGatewayDb } from "../gateway/types";
import { isUuid } from "./pg";

const HASH_RE = /^[0-9a-f]{64}$/;

export function createGatewayPg(sql: ISql): SmsGatewayDb & GatewayRegistryDb {
  return {
    async registerParent({ phoneHash, familyId, parentId }) {
      if (!HASH_RE.test(phoneHash) || !isUuid(familyId) || !isUuid(parentId)) return false;
      // One statement: the insert happens only when the parent belongs to the family. A number
      // registered before (even by another family) moves to this parent: one phone, one owner.
      const rows = await sql`
        insert into public.shield_gateway_parents (phone_hash, family_id, parent_id)
        select ${phoneHash}, p.family_id, p.id from public.people p
        where p.id = ${parentId} and p.family_id = ${familyId}
        on conflict (phone_hash) do update set family_id = excluded.family_id, parent_id = excluded.parent_id
        returning phone_hash`;
      return rows.length > 0;
    },

    async unregisterParent({ familyId, parentId }) {
      if (!isUuid(familyId) || !isUuid(parentId)) return 0;
      const rows = await sql`
        delete from public.shield_gateway_parents where family_id = ${familyId} and parent_id = ${parentId}
        returning phone_hash`;
      return rows.length;
    },

    async findParentByPhoneHash(phoneHash: string) {
      if (!HASH_RE.test(phoneHash)) return null;
      // The parent must still exist in the same family.
      const [row] = await sql<{ family_id: string; parent_id: string }[]>`
        select g.family_id, g.parent_id
        from public.shield_gateway_parents g
        join public.people p on p.id = g.parent_id and p.family_id = g.family_id
        where g.phone_hash = ${phoneHash}`;
      return row ?? null;
    },

    async insertGatewayEvent(row: NewGatewayEventRow) {
      if (!isUuid(row.family_id) || !isUuid(row.parent_id)) throw new Error("Invalid Shield gateway ids");
      const [inserted] = await sql<{ id: string }[]>`
        insert into public.shield_events
          (idempotency_key, family_id, parent_id, device_id, channel, kind, occurred_at, masked_text,
           link_domains, matched_rules, context)
        values
          (${row.idempotency_key}, ${row.family_id}, ${row.parent_id}, null, 'gateway_sms', 'sms',
           ${row.occurred_at}::timestamptz, ${row.masked_text}, ${row.link_domains}::text[], '{}'::text[],
           ${sql.json(row.context)})
        on conflict (idempotency_key) do nothing
        returning id`;
      return inserted ? { id: inserted.id } : { duplicate: true as const };
    },
  };
}
