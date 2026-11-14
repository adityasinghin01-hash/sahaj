import type { Sql } from "postgres";
import { isUuid } from "../db/pg";
import type { StartExperienceResult } from "./experience";
import type { DrillCheckinVariables, PickedDrill } from "./index";
import { maskPrivate } from "./privacy";
import type { DrillContext } from "./types";

const CHECKIN_DRILL_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const CHECKIN_DRILL_CACHE_PREFIX = "shield.checkin_drill.v1";

export interface ScheduledParent {
  familyId: string;
  parentId: string;
}

export interface WeeklyDrillPlanResult {
  helper_planned: number;
  experience_started: number;
  experience_refused: Record<string, number>;
}

export interface DrillScheduleStore {
  listParents(): Promise<ScheduledParent[]>;
  hasExperienceEligibility(ctx: DrillContext): Promise<boolean>;
  saveCheckinVariables?(input: {
    familyId: string;
    parentId: string;
    variables: DrillCheckinVariables;
    now: Date;
  }): Promise<void>;
}

export interface ScheduleDrillsDeps {
  schedule: DrillScheduleStore;
  pickDrill: (input: DrillContext & { now: Date }) => Promise<PickedDrill | null>;
  startExperienceDrill: (input: DrillContext) => Promise<StartExperienceResult>;
  sign?: (input: {
    familyId: string;
    parentId: string;
    type: string;
    line: string;
    data?: Record<string, string | number | boolean>;
  }) => Promise<unknown>;
}

export function checkinDrillCacheKey(ctx: DrillContext): string {
  return `${CHECKIN_DRILL_CACHE_PREFIX}:${ctx.familyId}:${ctx.parentId}`;
}

export function createSchedulePg(sql: Sql): DrillScheduleStore {
  let hasCacheTable: boolean | null = null;

  return {
    async listParents() {
      const rows = await sql<{ family_id: string; parent_id: string }[]>`
        select p.family_id, p.id as parent_id
        from public.people p
        join public.families f on f.id = p.family_id
        where p.role = 'parent' and p.family_id is not null
        order by p.family_id, p.id`;
      return rows.map((row) => ({ familyId: row.family_id, parentId: row.parent_id }));
    },

    async hasExperienceEligibility({ familyId, parentId }) {
      if (!isUuid(familyId) || !isUuid(parentId)) return false;
      const rows = await sql<{ eligible: boolean }[]>`
        select (
          exists (
            select 1
            from public.shield_drill_consents c
            where c.family_id = ${familyId}
              and c.parent_id = ${parentId}
              and c.kind = 'experience_drill'
              and c.revoked_at is null
          )
          and exists (
            select 1
            from public.shield_experience_settings s
            where s.family_id = ${familyId}
              and s.parent_id = ${parentId}
              and s.experience_drills_enabled = true
          )
        ) as eligible`;
      return rows[0]?.eligible === true;
    },

    async saveCheckinVariables({ familyId, parentId, variables, now }) {
      if (!isUuid(familyId) || !isUuid(parentId)) return;
      if (hasCacheTable === null) {
        const [reg] = await sql<{ present: string | null }[]>`
          select to_regclass('public.dev_cache')::text as present`;
        hasCacheTable = Boolean(reg?.present);
      }
      if (!hasCacheTable) return;
      const key = checkinDrillCacheKey({ familyId, parentId });
      const expiresAt = new Date(now.getTime() + CHECKIN_DRILL_CACHE_TTL_SECONDS * 1000);
      const payload = {
        drill_id: variables.drill_id,
        drill_story: maskPrivate(variables.drill_story),
      };
      await sql`
        insert into public.dev_cache (key, value, expires_at, updated_at)
        values (${key}, ${sql.json(payload)}, ${expiresAt}::timestamptz, ${now}::timestamptz)
        on conflict (key) do update
          set value = excluded.value,
              expires_at = excluded.expires_at,
              updated_at = excluded.updated_at`;
    },
  };
}

export async function readCheckinDrillVariablesPg(
  sql: Sql,
  ctx: DrillContext,
  now: Date = new Date(),
): Promise<DrillCheckinVariables | null> {
  if (!isUuid(ctx.familyId) || !isUuid(ctx.parentId)) return null;
  const [reg] = await sql<{ present: string | null }[]>`
    select to_regclass('public.dev_cache')::text as present`;
  if (!reg?.present) return null;
  const [row] = await sql<{ value: DrillCheckinVariables }[]>`
    select value
    from public.dev_cache
    where key = ${checkinDrillCacheKey(ctx)}
      and expires_at > ${now}::timestamptz
    limit 1`;
  return row?.value ?? null;
}

/**
 * Plans weekly drills across every parent with a family:
 * 1) Helper drill: if none asked in the last 7 days, pick with `pickDrill` and store check-in variables.
 * 2) Experience drill: only when Maa's consent and Riya's switch are both active, call `startExperienceDrill`
 *    (which enforces cooldown and quiet hours) and count refusals by reason.
 */
export async function planWeeklyDrills(
  deps: ScheduleDrillsDeps,
  input: { now?: Date } = {},
): Promise<WeeklyDrillPlanResult> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid drill schedule time");

  const parents = await deps.schedule.listParents();
  let helper_planned = 0;
  let experience_started = 0;
  const experience_refused: Record<string, number> = {};

  for (const parent of parents) {
    const ctx: DrillContext = { familyId: parent.familyId, parentId: parent.parentId };
    const picked = await deps.pickDrill({ ...ctx, now });
    if (picked) {
      await deps.schedule.saveCheckinVariables?.({
        ...ctx,
        variables: picked.checkin_variables,
        now,
      });
      await deps.sign?.({
        familyId: ctx.familyId,
        parentId: ctx.parentId,
        type: "shield.drill.helper.planned",
        line: "Weekly helper drill planned for next check-in.",
        data: { parent_id: ctx.parentId, drill_id: picked.drill_id },
      });
      helper_planned += 1;
    }

    if (await deps.schedule.hasExperienceEligibility(ctx)) {
      const started = await deps.startExperienceDrill(ctx);
      if (started.ok) {
        experience_started += 1;
      } else {
        experience_refused[started.reason] = (experience_refused[started.reason] ?? 0) + 1;
      }
    }
  }

  return { helper_planned, experience_started, experience_refused };
}
