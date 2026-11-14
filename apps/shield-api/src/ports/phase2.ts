import type { Sql } from "postgres";
import {
  createBusyPg,
  createWarningsPg,
  type BusyDeps,
  type ShieldRuntimePorts,
  type WarningsDeps,
} from "@sahaj/shield";
import { writeOutbox } from "./outbox";

export interface Phase2Ports {
  busyDeps: BusyDeps;
  warningsDeps: WarningsDeps;
}

export function createPhase2Ports(opts: {
  auxSql: Sql;
  runtimePorts: Pick<ShieldRuntimePorts, "scheduler" | "atlas" | "sign" | "router">;
  clock: { now(): Date };
  env: Readonly<Record<string, string | undefined>>;
}): Phase2Ports {
  // postgres.js Sql satisfies the structural ISql contract expected by createBusyPg / createWarningsPg at runtime.
  const busyDb = createBusyPg(opts.auxSql as unknown as Parameters<typeof createBusyPg>[0]);
  const warningsDb = createWarningsPg(opts.auxSql as unknown as Parameters<typeof createWarningsPg>[0]);

  const busyDeps: BusyDeps = {
    db: busyDb,
    scheduler: {
      after: opts.runtimePorts.scheduler.after,
    },
    alerts: {
      async sendBusyAlert(input) {
        await writeOutbox(opts.auxSql, {
          channel: "push",
          kind: "busy_alert",
          familyId: input.familyId,
          parentId: input.parentId,
          dedupeKey: `push:busy_alert:${input.streakId}`,
          payload: {
            streak_id: input.streakId,
            minutes: input.minutes,
            messages: input.messages,
          },
        });
      },
    },
    atlas: {
      async startCircleChain(input) {
        await opts.runtimePorts.atlas.startCircleChain(input);
      },
    },
    sign: opts.runtimePorts.sign,
    clock: opts.clock,
    env: {
      DEMO_TIMER_SCALE: opts.env.DEMO_TIMER_SCALE,
    },
    async parentName(familyId, parentId) {
      const rows = await opts.auxSql<{ name: string }[]>`
        select name
        from public.people
        where id = ${parentId} and family_id = ${familyId}
        limit 1`;
      return rows[0]?.name ?? null;
    },
  };

  const warningsDeps: WarningsDeps = {
    db: warningsDb,
    llm: {
      understand: opts.runtimePorts.router.understand,
    },
    clock: opts.clock,
  };

  return { busyDeps, warningsDeps };
}
