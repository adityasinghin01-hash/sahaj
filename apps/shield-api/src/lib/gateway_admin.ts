import type { Sql } from "postgres";
import { z } from "zod";
import { numberFingerprint } from "@sahaj/shield";

export const GatewayParentBodySchema = z.object({
  family_id: z.string().uuid(),
  parent_id: z.string().uuid(),
  phone: z.string().min(1).max(64),
});

export type GatewayParentInput = z.infer<typeof GatewayParentBodySchema>;

export type GatewayParentResult =
  | { ok: true; family_id: string; parent_id: string; registered: true }
  | { ok: false; status: 400; error: "invalid_phone" }
  | { ok: false; status: 404; error: "parent_not_found" };

export interface GatewayAdminStore {
  hasParentInFamily: (familyId: string, parentId: string) => Promise<boolean>;
  upsertGatewayParent: (input: {
    phoneHash: string;
    familyId: string;
    parentId: string;
  }) => Promise<void>;
}

export function createPgGatewayAdminStore(auxSql: Sql): GatewayAdminStore {
  return {
    async hasParentInFamily(familyId, parentId) {
      const rows = await auxSql<{ ok: number }[]>`
        select 1 as ok
        from public.people
        where id = ${parentId} and family_id = ${familyId} and role = 'parent'
        limit 1`;
      return rows.length > 0;
    },
    async upsertGatewayParent({ phoneHash, familyId, parentId }) {
      await auxSql`
        insert into public.shield_gateway_parents (phone_hash, family_id, parent_id)
        values (${phoneHash}, ${familyId}, ${parentId})
        on conflict (phone_hash) do update
          set family_id = excluded.family_id,
              parent_id = excluded.parent_id`;
    },
  };
}

export async function registerGatewayParentWithAdapter(opts: {
  store: GatewayAdminStore;
  runtimeRegister?: (input: {
    familyId: string;
    parentId: string;
    phone: string;
  }) => Promise<unknown>;
  input: GatewayParentInput;
}): Promise<GatewayParentResult> {
  const { store, runtimeRegister, input } = opts;

  const phoneHash = await numberFingerprint(input.phone);
  if (!phoneHash) {
    return { ok: false, status: 400, error: "invalid_phone" };
  }

  const exists = await store.hasParentInFamily(input.family_id, input.parent_id);
  if (!exists) {
    return { ok: false, status: 404, error: "parent_not_found" };
  }

  // Prefer Kiro B's runtime.registerGatewayParent when present; fallback to direct auxSql adapter until merged.
  if (runtimeRegister) {
    await runtimeRegister({
      familyId: input.family_id,
      parentId: input.parent_id,
      phone: input.phone,
    });
  } else {
    await store.upsertGatewayParent({
      phoneHash,
      familyId: input.family_id,
      parentId: input.parent_id,
    });
  }

  return {
    ok: true,
    family_id: input.family_id,
    parent_id: input.parent_id,
    registered: true,
  };
}

