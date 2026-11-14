import type { Sql } from "postgres";
import type { ShieldRuntimePorts } from "@sahaj/shield";

type JsonParam = Parameters<Sql["json"]>[0];

function jobDedupeKey(name: string, payload: Record<string, unknown>): string | null {
  const verdictId = typeof payload.verdictId === "string" ? payload.verdictId : null;
  const checkId = typeof payload.check_id === "string" ? payload.check_id : null;
  const streakId = typeof payload.streak_id === "string" ? payload.streak_id : null;
  const attempt = typeof payload.attempt === "number" ? String(payload.attempt) : "";
  if (verdictId) return `job:${name}:${verdictId}:${attempt}`;
  if (checkId) return `job:${name}:${checkId}`;
  // shield.busy.retry can fire once per busy attempt inside a streak; only deduplicate circle escalation per streak.
  if (name === "shield.busy.circle" && streakId) return `job:${name}:${streakId}`;
  return null;
}

export function createSchedulerPort(
  sql: Sql,
  clock: { now(): Date },
): ShieldRuntimePorts["scheduler"] {
  return {
    async after(delayMs: number, name: string, payload: Record<string, unknown>): Promise<void> {
      const now = clock.now();
      const safeDelay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
      const runAt = new Date(now.getTime() + safeDelay);
      const claimKey = jobDedupeKey(name, payload);
      const jsonPayload = payload as JsonParam;

      if (claimKey) {
        await sql`
          insert into public.shield_jobs (name, payload, run_at, status, claim_key)
          values (${name}, ${sql.json(jsonPayload)}, ${runAt}::timestamptz, 'pending', ${claimKey})
          on conflict (claim_key) do nothing`;
        return;
      }

      await sql`
        insert into public.shield_jobs (name, payload, run_at, status)
        values (${name}, ${sql.json(jsonPayload)}, ${runAt}::timestamptz, 'pending')`;
    },

    async claim(key: string): Promise<boolean> {
      const now = clock.now();
      const rows = await sql<{ id: string }[]>`
        insert into public.shield_jobs (name, payload, run_at, status, claim_key, done_at)
        values ('__claim__', '{}'::jsonb, ${now}::timestamptz, 'claimed', ${`claim:${key}`}, ${now}::timestamptz)
        on conflict (claim_key) do nothing
        returning id`;
      return rows.length > 0;
    },
  };
}

