import type { Sql } from "postgres";
import { AppAlert, AppTimelineRow, type AppSummary } from "@sahaj/shared";
import type { AppMember } from "./app_auth";
import { AppHttpError } from "./app_auth";
import { computeChainHash } from "../ports/sign";
import { z } from "zod";

export type TimelineRecord = z.infer<typeof AppTimelineRow> & {
  family_id: string;
  verdict_id?: string | null;
  event_key?: string | null;
};
export type AlertRecord = z.infer<typeof AppAlert>;
export interface AppStore {
  memberships(userId: string): Promise<AppMember[]>;
  devices(familyId: string): Promise<AppSummary["devices"]>;
  parents(familyId: string): Promise<{ id: string; name: string }[]>;
  counts(
    familyId: string,
  ): Promise<{ checks_this_week: number; frauds_stopped: number }>;
  alerts(
    familyId: string,
    cursor?: { at: string; id: string },
  ): Promise<AlertRecord[]>;
  alert(familyId: string, id: string): Promise<AlertRecord | null>;
  timeline(familyId: string, verdictId?: string): Promise<TimelineRecord[]>;
  chain(): Promise<TimelineRecord[]>;
  pushToken(member: AppMember, token: string): Promise<void>;
}
export function encodeAlertCursor(row: AlertRecord) {
  return Buffer.from(
    JSON.stringify({ at: row.created_at, id: row.id }),
  ).toString("base64url");
}
export function decodeAlertCursor(cursor?: string) {
  if (!cursor) return undefined;
  try {
    return z
      .object({
        at: z.string().datetime({ offset: true }),
        id: z.string().uuid(),
      })
      .parse(JSON.parse(Buffer.from(cursor, "base64url").toString()));
  } catch {
    throw new AppHttpError(400, "invalid_cursor");
  }
}
export function verifyTimeline(rows: TimelineRecord[], familyId: string) {
  let prev = "0".repeat(64),
    broken: TimelineRecord | undefined,
    checked = 0;
  for (const row of rows) {
    if (row.family_id === familyId) checked++;
    if (
      row.prev_hash !== prev ||
      computeChainHash(prev, row.entry) !== row.hash
    ) {
      broken = row;
      break;
    }
    prev = row.hash;
  }
  return {
    valid: !broken,
    checked,
    broken_at: broken?.family_id === familyId ? broken.id : null,
  };
}
export function createAppStore(sql: Sql): AppStore {
  // Explicit projections keep device secrets and unrelated rows off the app API.
  const alertSql = sql`select v.id, v.parent_id, to_char(v.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at, v.level, v.scam_type,
    v.reasons, v.checks_fired, v.child_feedback,
    coalesce(e.masked_text, '') as masked_snippet, coalesce(e.channel, 'device') as channel
    from public.shield_verdicts v
    left join lateral (select masked_text, channel from public.shield_events
      where id = any(v.event_ids) and family_id = v.family_id order by occurred_at desc limit 1) e on true`;
  return {
    async memberships(userId) {
      return sql<
        AppMember[]
      >`select m.family_id, m.user_id, m.person_id, m.role from public.family_memberships m
        join public.families f on f.id=m.family_id where m.user_id=${userId} and m.revoked_at is null`;
    },
    async devices(familyId) {
      return sql<
        AppSummary["devices"]
      >`select id, person_id as parent_id, label, protections,
        last_heartbeat_at::text from public.shield_devices where family_id=${familyId} order by paired_at desc`;
    },
    async parents(familyId) {
      return sql`select id, display_name as name from public.people where family_id=${familyId} and role='parent' order by id`;
    },
    async counts(familyId) {
      const [row] = await sql`select
        (select count(*)::int from public.shield_events where family_id=${familyId}
          and created_at >= date_trunc('week', now() at time zone 'UTC') at time zone 'UTC') as checks_this_week,
        (select count(*)::int from public.shield_verdicts where family_id=${familyId} and level='red'
          and child_feedback is distinct from 'safe') as frauds_stopped`;
      return row as { checks_this_week: number; frauds_stopped: number };
    },
    async alerts(familyId, cursor) {
      const rows = cursor
        ? await sql`${alertSql} where v.family_id=${familyId}
          and (v.created_at, v.id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)
          order by v.created_at asc, v.id asc limit 100`
        : await sql`${alertSql} where v.family_id=${familyId} order by v.created_at desc, v.id desc limit 100`;
      // A polling cursor walks oldest unseen batches so bursts >100 never skip events.
      return (cursor ? [...rows].reverse() : rows).map((r) =>
        AppAlert.parse(r),
      );
    },
    async alert(familyId, id) {
      const [row] =
        await sql`${alertSql} where v.family_id=${familyId} and v.id=${id} limit 1`;
      return row ? AppAlert.parse(row) : null;
    },
    async timeline(familyId, verdictId) {
      const rows = verdictId
        ? await sql`select id, seq::text, created_at::text, step, status, entry, prev_hash, hash, family_id, verdict_id, event_key
            from public.dev_timeline where family_id=${familyId} and (verdict_id=${verdictId}::uuid
            or event_key in (select e.idempotency_key from public.shield_events e join public.shield_verdicts v on e.id=any(v.event_ids) where v.id=${verdictId} and v.family_id=${familyId} and e.family_id=${familyId})) order by public.dev_timeline.seq`
        : await sql`select id, seq::text, created_at::text, step, status, entry, prev_hash, hash, family_id, verdict_id, event_key
            from public.dev_timeline where family_id=${familyId} order by public.dev_timeline.seq desc limit 500`;
      return rows as unknown as TimelineRecord[];
    },
    async chain() {
      // The signer chains globally. A single statement is a consistent snapshot. No global rows leave the service.
      return sql<
        TimelineRecord[]
      >`select id, seq::text, created_at::text, step, status, entry, prev_hash, hash, family_id
        from public.dev_timeline order by public.dev_timeline.seq`;
    },
    async pushToken(member, token) {
      await sql`insert into public.app_push_tokens(family_id,user_id,expo_token)
        values (${member.family_id},${member.user_id},${token})
        on conflict(expo_token) do update set family_id=excluded.family_id, user_id=excluded.user_id, updated_at=now()`;
    },
  };
}
