import type { ISql, Sql } from "postgres";
import { isUuid } from "../db/pg";
import { maskPrivate } from "./privacy";
import type { DrillRecord, DrillStore } from "./types";

function record(row: Record<string, unknown>): DrillRecord {
  return { ...row, asked_at: new Date(row.asked_at as string | Date).toISOString() } as DrillRecord;
}
export function createDrillPg(sql: Sql): DrillStore {
  const build = (query: ISql, inTransaction = false): DrillStore => ({
    async withParentLock(ctx, work) {
      if (!isUuid(ctx.familyId) || !isUuid(ctx.parentId)) throw new Error("Invalid drill context");
      if (inTransaction) return work(build(query, true));
      return sql.begin(async tx => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${`shield.drill:${ctx.familyId.toLowerCase()}:${ctx.parentId.toLowerCase()}`}, 0))`;
        return work(build(tx, true));
      }) as Promise<Awaited<ReturnType<typeof work>>>;
    },
    async getParent({ familyId, parentId }) {
      if (!isUuid(familyId) || !isUuid(parentId)) return false;
      const rows = await query`select id from public.people where id = ${parentId} and family_id = ${familyId} and role = 'parent'`;
      return rows.length > 0;
    },
    async recent({ familyId, parentId }) {
      const rows = await query`select * from public.drills where family_id = ${familyId} and parent_id = ${parentId} and type = 'helper' order by asked_at desc, id desc limit 10`;
      return rows.map(record);
    },
    async insert(row) {
      await query`insert into public.drills (family_id, parent_id, drill_id, type, asked_at)
        values (${row.family_id}, ${row.parent_id}, ${row.drill_id}, ${row.type}, ${row.asked_at}::timestamptz)`;
    },
    async getAsked({ familyId, parentId, drillId }) {
      const [row] = await query`select * from public.drills where family_id = ${familyId} and parent_id = ${parentId}
        and drill_id = ${drillId} and type = 'helper' order by asked_at desc, id desc limit 1`;
      return row ? record(row) : null;
    },
    async saveAnswer({ familyId, parentId, drillId, answerMasked, score, teachLinePlayed = true }) {
      await query`update public.drills set answer_masked = ${maskPrivate(answerMasked)}, score = ${score}, teach_line_played = ${teachLinePlayed}
        where id = (select id from public.drills where family_id = ${familyId} and parent_id = ${parentId}
          and drill_id = ${drillId} and type = 'helper' order by asked_at desc, id desc limit 1) and score is null`;
    },
    async between({ familyId, parentId, since, until }) {
      const rows = await query`select * from public.drills where family_id = ${familyId} and parent_id = ${parentId}
        and asked_at >= ${since}::timestamptz and asked_at < ${until}::timestamptz order by asked_at, id`;
      return rows.map(record);
    },
  });
  return build(sql);
}
