/**
 * Postgres ExperienceStore (Step 3.5). Needs migrations 20261114000400 (drills) and
 * 20261114000800 (consents, child switch, check-in lines). Service-role connection; bound parameters only.
 */
import type { ISql, Sql } from "postgres";
import { isUuid } from "../db/pg";
import { maskExperienceAnswer, type ExperienceStore } from "./experience";
import type { DrillRecord } from "./types";

function record(row: Record<string, unknown>): DrillRecord {
  return { ...row, asked_at: new Date(row.asked_at as string | Date).toISOString() } as DrillRecord;
}
const valid = (familyId: string, parentId: string) => isUuid(familyId) && isUuid(parentId);

export function createExperiencePg(sql: Sql): ExperienceStore {
  const build = (query: ISql, inTransaction = false): ExperienceStore => ({
    async withParentLock(ctx, work) {
      if (!valid(ctx.familyId, ctx.parentId)) throw new Error("Invalid drill context");
      if (inTransaction) return work(build(query, true));
      // Same key as createDrillPg: helper and experience drills of one parent never interleave.
      return sql.begin(async tx => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`shield.drill:${ctx.familyId.toLowerCase()}:${ctx.parentId.toLowerCase()}`}, 0))`;
        return work(build(tx, true));
      }) as Promise<Awaited<ReturnType<typeof work>>>;
    },
    async getParent({ familyId, parentId }) {
      if (!valid(familyId, parentId)) return false;
      const rows = await query`select id from public.people where id = ${parentId} and family_id = ${familyId} and role = 'parent'`;
      return rows.length > 0;
    },
    async recordConsent({ familyId, parentId, clipRef, givenAt }) {
      if (!valid(familyId, parentId)) return null;
      // A new recorded yes replaces the active one (one active consent per parent).
      await query`update public.shield_drill_consents set revoked_at = ${givenAt}::timestamptz
        where family_id = ${familyId} and parent_id = ${parentId} and kind = 'experience_drill' and revoked_at is null`;
      const [row] = await query<{ id: string }[]>`
        insert into public.shield_drill_consents (family_id, parent_id, kind, clip_ref, given_at)
        select ${familyId}, p.id, 'experience_drill', ${clipRef}, ${givenAt}::timestamptz from public.people p
        where p.id = ${parentId} and p.family_id = ${familyId} and p.role = 'parent'
        returning id`;
      return row ?? null;
    },
    async revokeConsent({ familyId, parentId, at }) {
      if (!valid(familyId, parentId)) return 0;
      const rows = await query`update public.shield_drill_consents set revoked_at = ${at}::timestamptz
        where family_id = ${familyId} and parent_id = ${parentId} and kind = 'experience_drill' and revoked_at is null returning id`;
      return rows.length;
    },
    async hasConsent({ familyId, parentId }) {
      if (!valid(familyId, parentId)) return false;
      const rows = await query`select 1 from public.shield_drill_consents where family_id = ${familyId}
        and parent_id = ${parentId} and kind = 'experience_drill' and revoked_at is null limit 1`;
      return rows.length > 0;
    },
    async setEnabled({ familyId, parentId, enabled, byUserId, at }) {
      if (!valid(familyId, parentId) || !isUuid(byUserId)) return false;
      const rows = await query`
        insert into public.shield_experience_settings (family_id, parent_id, experience_drills_enabled, enabled_by, enabled_at)
        select ${familyId}, p.id, ${enabled}, ${byUserId}, ${at}::timestamptz from public.people p
        where p.id = ${parentId} and p.family_id = ${familyId} and p.role = 'parent'
          and exists (select 1 from public.family_members m where m.family_id = ${familyId} and m.user_id = ${byUserId} and m.role = 'child')
        on conflict (parent_id) do update set experience_drills_enabled = excluded.experience_drills_enabled,
          enabled_by = excluded.enabled_by, enabled_at = excluded.enabled_at
          where shield_experience_settings.family_id = excluded.family_id
        returning parent_id`;
      return rows.length > 0;
    },
    async isEnabled({ familyId, parentId }) {
      if (!valid(familyId, parentId)) return false;
      const [row] = await query<{ enabled: boolean }[]>`select experience_drills_enabled as enabled from public.shield_experience_settings
        where family_id = ${familyId} and parent_id = ${parentId}`;
      return row?.enabled === true;
    },
    async lastExperienceAt({ familyId, parentId }) {
      if (!valid(familyId, parentId)) return null;
      const [row] = await query<{ asked_at: Date }[]>`select asked_at from public.drills where family_id = ${familyId}
        and parent_id = ${parentId} and type = 'experience' order by asked_at desc, id desc limit 1`;
      return row ? new Date(row.asked_at).toISOString() : null;
    },
    async insertExperience({ familyId, parentId, drillId, askedAt }) {
      await query`insert into public.drills (family_id, parent_id, drill_id, type, asked_at)
        values (${familyId}, ${parentId}, ${drillId}, 'experience', ${askedAt}::timestamptz)`;
    },
    async getExperience({ familyId, parentId, drillId }) {
      if (!valid(familyId, parentId)) return null;
      const [row] = await query`select * from public.drills where family_id = ${familyId} and parent_id = ${parentId}
        and drill_id = ${drillId} and type = 'experience' order by asked_at desc, id desc limit 1`;
      return row ? record(row) : null;
    },
    async saveExperienceResult({ familyId, parentId, drillId, answerMasked, score }) {
      const rows = await query`update public.drills set answer_masked = ${maskExperienceAnswer(answerMasked)}, score = ${score},
        teach_line_played = ${score < 2}
        where family_id = ${familyId} and parent_id = ${parentId} and drill_id = ${drillId} and type = 'experience' and score is null
        returning id`;
      return rows.length > 0;
    },
    async queueCheckinLine({ familyId, parentId, line, at }) {
      await query`insert into public.shield_checkin_lines (family_id, parent_id, kind, line, created_at)
        values (${familyId}, ${parentId}, 'experience_praise', ${line}, ${at}::timestamptz)`;
    },
    async takeCheckinLine({ familyId, parentId, at }) {
      if (!valid(familyId, parentId)) return null;
      const [row] = await query<{ line: string }[]>`update public.shield_checkin_lines set delivered_at = ${at}::timestamptz
        where id = (select id from public.shield_checkin_lines where family_id = ${familyId} and parent_id = ${parentId}
          and delivered_at is null order by created_at, id limit 1 for update skip locked)
        returning line`;
      return row?.line ?? null;
    },
  });
  return build(sql);
}
