import type { ISql, Sql } from "postgres";
import { createDrillPg, createExperiencePg } from "../drills";
import { createCallGatePg } from "../callgate";
import { createEvidencePg } from "../evidence";
import { ShieldEvent, Verdict } from "@sahaj/shared";
import type { StoredVerdict } from "../brain/types.js";
import { createShieldPg, isUuid } from "../db/pg";
import { createGatewayPg } from "../db/gateway_pg";
import type { ShieldRuntimeDb } from "./types";

/** Decode DB nulls/timestamps without relaxing the shared phone contract. */
function eventFromRow(row: Record<string, unknown>): ShieldEvent {
  const value = { ...row };
  for (const key of ["device_id", "masked_text", "sender_type", "caller_type", "local_level"]) {
    if (value[key] === null) delete value[key];
  }
  // postgres.js returns Dates for direct columns, but to_jsonb timestamps have an
  // explicit +00:00 offset. The phone schema requires canonical UTC with Z.
  if (value.occurred_at instanceof Date || typeof value.occurred_at === "string") {
    value.occurred_at = new Date(value.occurred_at).toISOString();
  }
  return ShieldEvent.parse(value);
}

/** Uses only existing migrations; no runtime DDL or assumptions about core line columns. */
export function createShieldRuntimePg(sql: Sql, contacts?: Pick<NonNullable<ShieldRuntimeDb["callgate"]>, "isFamilyNumber">): ShieldRuntimeDb {
  const build = (query: ISql): ShieldRuntimeDb => {
    const pg = createShieldPg(query);
    const db: ShieldRuntimeDb = {
      drills: createDrillPg(sql),
      experience: createExperiencePg(sql),
      callgate: createCallGatePg(query, contacts),
      evidence: createEvidencePg(query),
      server: pg.server,
      gateway: createGatewayPg(query),
      tools: {
        ...pg.tools,
        async markFamilyCheckNoAnswer(checkId, at) {
          if (!isUuid(checkId)) return false;
          const rows = await query`
            update public.family_checks set state = 'no_answer', answered_at = ${at}::timestamptz
            where id = ${checkId} and state = 'asked' returning id`;
          return rows.length > 0;
        },
      },
      async getEvent(eventId) {
        if (!isUuid(eventId)) return null;
        const [row] = await query`select * from public.shield_events where id = ${eventId}`;
        return row ? eventFromRow(row) : null;
      },
      async insertVoiceEvent(raw) {
        const event = ShieldEvent.parse(raw);
        const [row] = await query<{ id: string }[]>`
          insert into public.shield_events (idempotency_key, family_id, parent_id, channel, kind,
            occurred_at, context, matched_rules, link_domains, masked_text, sender_type, caller_type, local_level)
          values (${event.idempotency_key}, ${event.family_id}, ${event.parent_id}, 'keypad_voice', 'voice_report',
            ${event.occurred_at}::timestamptz, ${query.json(event.context)}, ${event.matched_rules}::text[], ${event.link_domains}::text[],
            ${event.masked_text ?? null}, ${event.sender_type ?? null}, ${event.caller_type ?? null}, ${event.local_level ?? null})
          returning id`;
        if (!row) throw new Error("Shield voice event insert returned no row");
        return row;
      },
      async getVerdictForEvent(eventId) {
        if (!isUuid(eventId)) return null;
        const [row] = await query<{ id: string }[]>`
          select v.id from public.shield_verdicts v join public.shield_events e
            on e.id = any(v.event_ids) and e.family_id = v.family_id and e.parent_id = v.parent_id
          where e.id = ${eventId} order by v.created_at, v.id limit 1`;
        return row ? db.brain.getVerdict(row.id) : null;
      },
      brain: {
        async getParent({ familyId, parentId }) {
          if (!isUuid(familyId) || !isUuid(parentId)) return null;
          const [row] = await query<{ id: string; family_id: string }[]>`
            select id, family_id from public.people where id = ${parentId} and family_id = ${familyId}`;
          return row ?? null;
        },
        async getRecentEvents({ familyId, parentId, since, until }) {
          if (!isUuid(familyId) || !isUuid(parentId)) return [];
          const rows = await query`
            select * from public.shield_events where family_id = ${familyId} and parent_id = ${parentId}
              and occurred_at >= ${since}::timestamptz and occurred_at <= ${until}::timestamptz
            order by occurred_at, id`;
          return rows.map(eventFromRow);
        },
        async insertVerdict({ event, parent, verdict: rawVerdict }) {
          const verdict = Verdict.parse(rawVerdict);
          const [source] = await query<{ id: string }[]>`
            select id from public.shield_events where idempotency_key = ${event.idempotency_key}
              and family_id = ${event.family_id} and parent_id = ${parent.id} and family_id = ${parent.family_id}`;
          if (!source) throw new Error("Shield verdict source event not found");
          const [row] = await query<{ id: string }[]>`
            insert into public.shield_verdicts
              (family_id, parent_id, event_ids, level, scam_type, reasons, checks_fired,
               ai_used, models_agreed, confidence, actions)
            values (${event.family_id}, ${event.parent_id}, ${[source.id]}::uuid[], ${verdict.level},
              ${verdict.scam_type}, ${query.json(verdict.reasons)}, ${verdict.checks_fired}::text[],
              ${verdict.ai_used}, ${verdict.models_agreed}::text[], ${verdict.confidence}, ${verdict.actions}::text[])
            returning id`;
          if (!row) throw new Error("Shield verdict insert returned no row");
          return row;
        },
        async getVerdict(verdictId) {
          if (!isUuid(verdictId)) return null;
          const [row] = await query`
            select v.*, to_jsonb(e) as event, p.id as person_id from public.shield_verdicts v
              join public.shield_events e on e.id = v.event_ids[1]
                and e.family_id = v.family_id and e.parent_id = v.parent_id
              join public.people p on p.id = v.parent_id and p.family_id = v.family_id
            where v.id = ${verdictId}`;
          if (!row) return null;
          return { id: row.id, event: eventFromRow(row.event),
            parent: { id: row.person_id, family_id: row.family_id },
            verdict: Verdict.parse({ ...row, confidence: Number(row.confidence) }) } satisfies StoredVerdict;
        },
        async hasChildReaction({ verdictId }) {
          if (!isUuid(verdictId)) throw new Error("Invalid Shield verdict id");
          const [row] = await query<{ reacted: boolean }[]>`
            select (child_feedback is not null or feedback_at is not null) as reacted
            from public.shield_verdicts where id = ${verdictId}`;
          if (!row) throw new Error("Shield reaction verdict not found");
          return row.reacted;
        },
      },
      async withEventLock(eventId, work) {
        if (!isUuid(eventId)) throw new Error("Invalid Shield event id");
        // Session lock: verdict inserts commit before providers are called. The reserved
        // connection MUST be session/direct Postgres, not a transaction-mode pooler.
        const reserved = await sql.reserve();
        try {
          await reserved`select pg_advisory_lock(hashtextextended(${`shield.event:${eventId}`}, 0))`;
          try { return await work(build(reserved)); }
          finally { await reserved`select pg_advisory_unlock(hashtextextended(${`shield.event:${eventId}`}, 0))`; }
        } finally { reserved.release(); }
      },
    };
    return db;
  };
  return build(sql);
}
