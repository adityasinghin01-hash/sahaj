/**
 * Postgres lookups for the call gateway. Reads public.people.phone (core table) and compares
 * numberFingerprint() = hex(SHA-256(last 10 digits)) inside Postgres, so no raw number is returned.
 */
import type { ISql } from "postgres";
import { isUuid } from "../db/pg";
import type { CallGateDeps } from "./index";

const HASH_RE = /^[0-9a-f]{64}$/;

export function createCallGatePg(sql: ISql): CallGateDeps["db"] {
  return {
    async getParent({ familyId, parentId }) {
      if (!isUuid(familyId) || !isUuid(parentId)) return false;
      const rows = await sql`select 1 from public.people where id = ${parentId} and family_id = ${familyId} limit 1`;
      return rows.length > 0;
    },
    async isFamilyNumber({ familyId, phoneHash }) {
      if (!isUuid(familyId) || !HASH_RE.test(phoneHash)) return false;
      // Devanagari digits are read as ASCII, as numberFingerprint() does.
      const rows = await sql`
        select 1 from (
          select regexp_replace(translate(phone, '०१२३४५६७८९', '0123456789'), '[^0-9]', '', 'g') as digits
          from public.people where family_id = ${familyId} and phone is not null
        ) p
        where length(p.digits) >= 10
          and encode(sha256(convert_to(right(p.digits, 10), 'UTF8')), 'hex') = ${phoneHash}
        limit 1`;
      return rows.length > 0;
    },
  };
}
