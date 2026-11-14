import type { ISql } from "postgres";
import { isUuid } from "../db/pg";
import type { CallGateDeps } from "./index";

const HASH_RE = /^[0-9a-f]{64}$/;

export function createCallGatePg(sql: ISql, contacts?: Pick<CallGateDeps["db"], "isFamilyNumber">): CallGateDeps["db"] {
  return {
    async getParent({ familyId, parentId }) {
      if (!isUuid(familyId) || !isUuid(parentId)) return false;
      const rows = await sql`select 1 from public.people where id = ${parentId} and family_id = ${familyId} and role = 'parent' limit 1`;
      return rows.length > 0;
    },
    async isFamilyNumber({ familyId, phoneHash }) {
      if (!isUuid(familyId) || !HASH_RE.test(phoneHash)) return false;
      // Host owns decryption; missing routing configuration always forwards safely.
      return contacts ? contacts.isFamilyNumber({ familyId, phoneHash }) : false;
    },
  };
}
