/**
 * Postgres implementation of the busy-line and shared-warning interfaces (card K-B5).
 *
 *   const busyDb = createBusyPg(sql);         // BusyDeps["db"]
 *   const warningsDb = createWarningsPg(sql); // WarningsDeps["db"]
 *
 * Tables: infra/supabase/migrations/20261114160300_shield_busy_warnings.sql. Service role connection.
 * Every query is a tagged template (bound parameters). Times come from the caller.
 */
import type { ISql } from "postgres";
import type { BusyDb, BusyStreak } from "../busy/busy_watch";
import type { FeedbackVerdict, IndicatorRecord, RecordIndicatorInput, TopIndicator, WarningsDb } from "../warnings/feedback";
import { isUuid } from "./pg";

interface StreakRow {
  id: string;
  family_id: string;
  parent_id: string;
  started_at: Date;
  last_busy_at: Date;
  busy_count: number;
  ended_at: Date | null;
  alerted_at: Date | null;
  child_replied_at: Date | null;
  circled_at: Date | null;
}

function toStreak(r: StreakRow): BusyStreak {
  return {
    id: r.id,
    familyId: r.family_id,
    parentId: r.parent_id,
    startedAt: r.started_at,
    lastBusyAt: r.last_busy_at,
    busyCount: r.busy_count,
    endedAt: r.ended_at,
    alertedAt: r.alerted_at,
    childRepliedAt: r.child_replied_at,
    circledAt: r.circled_at,
  };
}

export function createBusyPg(sql: ISql): BusyDb {
  const cols = sql`id, family_id, parent_id, started_at, last_busy_at, busy_count, ended_at, alerted_at, child_replied_at, circled_at`;

  const getOpen = async (familyId: string, parentId: string): Promise<BusyStreak | null> => {
    if (!isUuid(familyId) || !isUuid(parentId)) return null;
    const [row] = await sql<StreakRow[]>`
      select ${cols} from public.busy_streaks
      where family_id = ${familyId} and parent_id = ${parentId} and ended_at is null`;
    return row ? toStreak(row) : null;
  };

  return {
    getOpenBusyStreak: getOpen,

    async getBusyStreak(id) {
      if (!isUuid(id)) return null;
      const [row] = await sql<StreakRow[]>`select ${cols} from public.busy_streaks where id = ${id}`;
      return row ? toStreak(row) : null;
    },

    async startBusyStreak({ familyId, parentId, at }) {
      // The partial unique index (one open streak per parent) turns a concurrent start into a no-op.
      const [row] = await sql<StreakRow[]>`
        insert into public.busy_streaks (family_id, parent_id, started_at, last_busy_at, busy_count)
        values (${familyId}, ${parentId}, ${at}::timestamptz, ${at}::timestamptz, 1)
        on conflict (parent_id) where ended_at is null do nothing
        returning ${cols}`;
      if (row) return { streak: toStreak(row), created: true };
      const open = await getOpen(familyId, parentId);
      if (!open) throw new Error("busy_streaks: start conflicted but no open streak found");
      return { streak: open, created: false };
    },

    async extendBusyStreak(id, at) {
      if (!isUuid(id)) return null;
      const [row] = await sql<StreakRow[]>`
        update public.busy_streaks
        set last_busy_at = ${at}::timestamptz, busy_count = busy_count + 1
        where id = ${id} and ended_at is null and last_busy_at < ${at}::timestamptz
        returning ${cols}`;
      return row ? toStreak(row) : null;
    },

    async closeBusyStreak(id, endedAt, reason) {
      if (!isUuid(id)) return false;
      const rows = await sql`
        update public.busy_streaks
        set ended_at = greatest(${endedAt}::timestamptz, last_busy_at), end_reason = ${reason}
        where id = ${id} and ended_at is null
        returning id`;
      return rows.length > 0;
    },

    async busyStreakDurationsMs(familyId, parentId, since, until) {
      if (!isUuid(familyId) || !isUuid(parentId)) return [];
      const rows = await sql<{ ms: number }[]>`
        select (extract(epoch from (ended_at - started_at)) * 1000)::float8 as ms
        from public.busy_streaks
        where family_id = ${familyId} and parent_id = ${parentId} and ended_at is not null
          and started_at >= ${since}::timestamptz and started_at < ${until}::timestamptz
        order by started_at`;
      return rows.map((r) => Number(r.ms));
    },

    async claimBusyAlert(id, at, minutes) {
      if (!isUuid(id)) return false;
      const rows = await sql`
        update public.busy_streaks
        set alerted_at = ${at}::timestamptz, alert_minutes = ${Math.max(0, Math.floor(minutes))}::int
        where id = ${id} and alerted_at is null
        returning id`;
      return rows.length > 0;
    },

    async markBusyAlertReplied(id, familyId, at) {
      if (!isUuid(id) || !isUuid(familyId)) return false;
      const rows = await sql`
        update public.busy_streaks
        set child_replied_at = ${at}::timestamptz
        where id = ${id} and family_id = ${familyId} and alerted_at is not null and child_replied_at is null
        returning id`;
      return rows.length > 0;
    },

    async claimBusyCircle(id, at) {
      if (!isUuid(id)) return false;
      const rows = await sql`
        update public.busy_streaks
        set circled_at = ${at}::timestamptz
        where id = ${id} and circled_at is null and child_replied_at is null
        returning id`;
      return rows.length > 0;
    },
  };
}

export function createWarningsPg(sql: ISql): WarningsDb {
  return {
    async getVerdictForFeedback(verdictId): Promise<FeedbackVerdict | null> {
      if (!isUuid(verdictId)) return null;
      // Only the verdict's own family's events are read.
      const [row] = await sql<
        {
          id: string;
          family_id: string;
          scam_type: string;
          child_feedback: "safe" | "fraud" | null;
          link_domains: string[];
          masked_texts: string[];
          number_fingerprints: string[];
        }[]
      >`
        select v.id, v.family_id, v.scam_type, v.child_feedback,
          coalesce((select array_agg(distinct d order by d)
                    from public.shield_events e, unnest(e.link_domains) as d
                    where e.id = any(v.event_ids) and e.family_id = v.family_id), '{}') as link_domains,
          coalesce((select array_agg(e.masked_text order by e.occurred_at, e.id)
                    from public.shield_events e
                    where e.id = any(v.event_ids) and e.family_id = v.family_id
                      and e.masked_text is not null), '{}') as masked_texts,
          coalesce((select array_agg(distinct e.context->>'number_fingerprint')
                    from public.shield_events e
                    where e.id = any(v.event_ids) and e.family_id = v.family_id
                      and jsonb_typeof(e.context->'number_fingerprint') = 'string'), '{}') as number_fingerprints
        from public.shield_verdicts v
        where v.id = ${verdictId}`;
      if (!row) return null;
      return {
        id: row.id,
        familyId: row.family_id,
        scamType: row.scam_type,
        childFeedback: row.child_feedback,
        linkDomains: row.link_domains,
        maskedTexts: row.masked_texts,
        numberFingerprints: row.number_fingerprints,
      };
    },

    async recordScamIndicator(input: RecordIndicatorInput): Promise<IndicatorRecord> {
      const [row] = await sql<
        { r_id: string; r_times_seen: number; r_families_affected: number; r_confirmed: boolean; r_counted: boolean }[]
      >`
        select * from public.shield_record_scam_indicator(
          ${input.kind}, ${input.fingerprint}, ${input.scamType}, ${input.summaryHi}, ${input.summaryEn},
          ${input.familyId}::uuid, ${input.verdictId}::uuid, ${input.seenAt}::timestamptz, ${input.confirmMinFamilies}::int)`;
      if (!row) throw new Error("shield_record_scam_indicator returned no row");
      return {
        id: row.r_id,
        timesSeen: row.r_times_seen,
        familiesAffected: row.r_families_affected,
        confirmed: row.r_confirmed,
        counted: row.r_counted,
      };
    },

    async topConfirmedIndicator(since, until): Promise<TopIndicator | null> {
      const [row] = await sql<{ scam_type: string; summary_hi: string; summary_en: string; recent: number }[]>`
        select i.scam_type, i.summary_hi, i.summary_en, count(*)::int as recent
        from public.scam_indicators i
        join public.scam_indicator_sightings s on s.indicator_id = i.id
        where i.confirmed and s.seen_at > ${since}::timestamptz and s.seen_at <= ${until}::timestamptz
        group by i.id
        order by recent desc, i.families_affected desc, i.last_seen_at desc, i.id
        limit 1`;
      if (!row) return null;
      return { scamType: row.scam_type, summaryHi: row.summary_hi, summaryEn: row.summary_en, recentSightings: row.recent };
    },
  };
}
