import type { Sql } from "postgres";
import { createShieldRuntime } from "@sahaj/shield";
import { getDbPools } from "./db";
import { runDueShieldJobs, type CronRunResult } from "./cron";
import {
  BusyReplyInputSchema,
  CallStatusInputSchema,
  ChildFeedbackInputSchema,
  createKeyedAsyncMutex,
  createPhase2Service,
  type Phase2Store,
  type RecordBusyReplyResponse,
  type RecordCallStatusResponse,
  type RecordFeedbackResponse,
  type VerdictFeedbackRow,
  type WeeklyTipResponse,
  WeeklyTipInputSchema,
} from "./phase2";
import {
  createPgGatewayAdminStore,
  registerGatewayParentWithAdapter,
  type GatewayParentInput,
  type GatewayParentResult,
} from "./gateway_admin";
import { createPgHeartbeatStore, handleShieldHeartbeat } from "./heartbeat";
import { createShieldPorts, getPortsStatus, type PortsStatus } from "@/ports";
import { writeOutbox } from "@/ports/outbox";
import { createPhase2Ports } from "@/ports/phase2";
import type { z } from "zod";

export interface OutboxRow {
  id: string;
  created_at: string;
  channel: string;
  kind: string;
  family_id: string | null;
  parent_id: string | null;
  dedupe_key: string | null;
  payload: Record<string, unknown>;
}

export interface ShieldApp {
  env: Readonly<Record<string, string | undefined>>;
  portsStatus: PortsStatus;
  runtime: ReturnType<typeof createShieldRuntime>;
  recordBusyCallStatus: (input: z.infer<typeof CallStatusInputSchema>) => Promise<RecordCallStatusResponse>;
  recordBusyReply: (input: z.infer<typeof BusyReplyInputSchema>) => Promise<RecordBusyReplyResponse>;
  recordChildFeedback: (input: z.infer<typeof ChildFeedbackInputSchema>) => Promise<RecordFeedbackResponse>;
  getWeeklyTip: (input: z.infer<typeof WeeklyTipInputSchema>) => Promise<WeeklyTipResponse>;
  registerGatewayParent: (input: GatewayParentInput) => Promise<GatewayParentResult>;
  recordDeviceHeartbeat: (req: Request) => Promise<Response>;
  runDueJobs: () => Promise<CronRunResult>;
  checkDb: () => Promise<boolean>;
  listOutbox: (limit?: number) => Promise<OutboxRow[]>;
}

function createPgPhase2Store(auxSql: Sql): Phase2Store {
  const withInProcessLock = createKeyedAsyncMutex();

  return {
    async hasParentInFamily(familyId, parentId) {
      const rows = await auxSql<{ ok: number }[]>`
        select 1 as ok
        from public.people
        where id = ${parentId} and family_id = ${familyId} and role = 'parent'
        limit 1`;
      return rows.length > 0;
    },
    async hasFamily(familyId) {
      const rows = await auxSql<{ ok: number }[]>`
        select 1 as ok
        from public.families
        where id = ${familyId}
        limit 1`;
      return rows.length > 0;
    },
    async withVerdictFeedbackLock(verdictId, fn) {
      return withInProcessLock(verdictId, async () => {
        const lockKey = `shield.verdict_feedback:${verdictId}`;
        const conn = await auxSql.reserve();
        try {
          await conn`select pg_advisory_lock(hashtextextended(${lockKey}, 0))`;
          try {
            return await fn();
          } finally {
            await conn`select pg_advisory_unlock(hashtextextended(${lockKey}, 0))`.catch(() => undefined);
          }
        } finally {
          conn.release();
        }
      });
    },
    async getVerdictRow(verdictId) {
      const rows = await auxSql<VerdictFeedbackRow[]>`
        select id, family_id, parent_id, child_feedback, feedback_at::text as feedback_at
        from public.shield_verdicts
        where id = ${verdictId}
        limit 1`;
      return rows[0] ?? null;
    },
    async setVerdictFeedbackIfUnset(verdictId, feedback, at) {
      const rows = await auxSql<VerdictFeedbackRow[]>`
        update public.shield_verdicts
        set child_feedback = ${feedback},
            feedback_at = ${at.toISOString()}::timestamptz
        where id = ${verdictId} and child_feedback is null
        returning id, family_id, parent_id, child_feedback, feedback_at::text as feedback_at`;
      return rows[0] ?? null;
    },
    async recordBusyRetryOutbox(input) {
      await writeOutbox(auxSql, {
        channel: "calls",
        kind: "busy_checkin_retry_requested",
        familyId: input.familyId,
        parentId: input.parentId,
        dedupeKey: `calls:busy_retry:${input.jobId}`,
        payload: {
          streak_id: input.streakId,
          simulated: true,
          delivery_claimed: false,
          owner: "singhal_checkin_caller",
          reason: "busy_line_streak_active",
        },
      });
    },
  };
}

const GLOBAL_APP_KEY = "__sahajShieldApiApp__" as const;

type GlobalWithApp = typeof globalThis & {
  [GLOBAL_APP_KEY]?: ShieldApp;
};

export function createShieldApp(env: Readonly<Record<string, string | undefined>> = process.env): ShieldApp {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }
  const { shieldSql, auxSql } = getDbPools(databaseUrl);
  const clock = { now: () => new Date() };
  const ports = createShieldPorts({ shieldSql, auxSql, env, clock });
  const runtime = createShieldRuntime(ports);
  const { busyDeps, warningsDeps } = createPhase2Ports({
    auxSql,
    runtimePorts: ports,
    clock,
    env,
  });
  const phase2 = createPhase2Service({
    store: createPgPhase2Store(auxSql),
    busyDeps,
    warningsDeps,
    clock,
    fallbackHandleScheduledJob: (name, payload) => runtime.handleScheduledJob(name, payload),
  });

  const gatewayStore = createPgGatewayAdminStore(auxSql);
  const heartbeatStore = createPgHeartbeatStore(auxSql);

  return {
    env,
    portsStatus: getPortsStatus(env),
    runtime,
    recordBusyCallStatus: phase2.submitCallStatus,
    recordBusyReply: phase2.submitBusyReply,
    recordChildFeedback: phase2.submitChildFeedback,
    getWeeklyTip: phase2.fetchWeeklyTip,
    registerGatewayParent: (input) =>
      registerGatewayParentWithAdapter({
        store: gatewayStore,
        runtimeRegister: (
          runtime as {
            registerGatewayParent?: (input: {
              familyId: string;
              parentId: string;
              phone: string;
            }) => Promise<unknown>;
          }
        ).registerGatewayParent,
        input,
      }),
    recordDeviceHeartbeat: (req) =>
      handleShieldHeartbeat(req, {
        store: heartbeatStore,
        pairingSecret: env.SHIELD_DEVICE_PAIRING_SECRET,
        clock,
      }),
    runDueJobs: () =>
      runDueShieldJobs({
        sql: auxSql,
        handleScheduledJob: phase2.dispatchScheduledJob,
        now: () => clock.now(),
      }),
    async checkDb(): Promise<boolean> {
      try {
        await auxSql`select 1`;
        return true;
      } catch {
        return false;
      }
    },
    async listOutbox(limit = 50): Promise<OutboxRow[]> {
      const safeLimit = Math.min(Math.max(1, limit), 100);
      const rows = await auxSql<OutboxRow[]>`
        select id, created_at, channel, kind, family_id, parent_id, dedupe_key, payload
        from public.dev_outbox
        order by created_at desc, id desc
        limit ${safeLimit}`;
      return rows;
    },
  };
}

export function getShieldApp(): ShieldApp {
  const g = globalThis as GlobalWithApp;
  if (!g[GLOBAL_APP_KEY]) {
    g[GLOBAL_APP_KEY] = createShieldApp(process.env);
  }
  return g[GLOBAL_APP_KEY];
}

