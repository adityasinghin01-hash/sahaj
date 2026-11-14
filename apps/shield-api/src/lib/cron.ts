import type { Sql } from "postgres";

export interface DueJobRow {
  id: string;
  name: string;
  payload: unknown;
}

export interface CronRunResult {
  processed: number;
  results: {
    id: string;
    name: string;
    status: "done" | "failed";
    result?: unknown;
    error?: string;
  }[];
}

export async function runDueShieldJobs(opts: {
  sql: Sql;
  handleScheduledJob: (name: string, payload: unknown, jobId: string) => Promise<unknown>;
  now: () => Date;
  limit?: number;
}): Promise<CronRunResult> {
  const limit = opts.limit ?? 25;
  const now = opts.now();

  return opts.sql.begin(async (tx) => {
    const due = await tx<DueJobRow[]>`
      select id, name, payload
      from public.shield_jobs
      where status = 'pending' and run_at <= ${now}::timestamptz
      order by run_at asc, id asc
      limit ${limit}
      for update skip locked`;

    const results: CronRunResult["results"] = [];
    for (const job of due) {
      try {
        const result = await opts.handleScheduledJob(job.name, job.payload, job.id);
        await tx`
          update public.shield_jobs
          set status = 'done',
              attempts = attempts + 1,
              done_at = ${opts.now()}::timestamptz,
              last_error = null
          where id = ${job.id}`;
        results.push({ id: job.id, name: job.name, status: "done", result });
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 200) : "job_failed";
        await tx`
          update public.shield_jobs
          set status = 'failed',
              attempts = attempts + 1,
              done_at = ${opts.now()}::timestamptz,
              last_error = ${msg}
          where id = ${job.id}`;
        results.push({ id: job.id, name: job.name, status: "failed", error: msg });
      }
    }

    return { processed: results.length, results };
  });
}

