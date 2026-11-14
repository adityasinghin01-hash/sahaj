import { NextResponse } from "next/server";
import { safeTokenEquals } from "@/lib/secrets";
import { serviceDatabase } from "@/lib/database";
import { randomUUID } from "node:crypto";
import { WebhookError } from "@/lib/webhook-security";
import { dispatchEvents, runCommandJobs, runWorkflowJobs, type ClaimedEvent } from "@/lib/atlas-runtime/runner";
import { createProductionCommandHandlers, runMissedCallNudgePass } from "@/lib/atlas-runtime/command-handlers";
import { createProductionMissedCallNudgeDeps, processTeleCmiRawMissedCallsForFamily } from "@/lib/core1/missed-call-nudge-service";
import { createAtlasRuntime } from "@/lib/atlas-runtime/factory";
import { loadAtlasConfig } from "@/lib/atlas-runtime/config";
import { buildProviderBridge } from "@/lib/atlas-runtime/bridge";
import { phase2Entrypoints, providerConfigFromEnv } from "@/lib/atlas-runtime/providers";
import type { RpcDb } from "@/lib/atlas-runtime/db";
import { createProductionUrgentHelpDeps, processUrgentEscalationTick } from "@/lib/core1/urgent-help-service";
import {
  createProductionCheckInDeps,
  processCheckInTick,
  syncSarvamCheckInPostCalls,
} from "@/lib/core1/check-in-service";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (!safeTokenEquals(request.headers.get("x-cron-secret"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (process.env.MAINTENANCE_KILL === "true") return NextResponse.json({ paused: true }, { status: 503 });
  try {
    const db = serviceDatabase();
    // Core 1: TeleCMI missed calls -> Riya nudge, before claiming so the nudge pass still sees them pending.
    let missedCalls: Record<string, unknown>;
    try {
      const nudgeDeps = createProductionMissedCallNudgeDeps();
      missedCalls = await runMissedCallNudgePass(db, familyId => processTeleCmiRawMissedCallsForFamily(familyId, nudgeDeps));
    } catch { missedCalls = { status: "failed" }; }
    const { data: events, error } = await db.rpc("claim_raw_events", { p_worker_id: randomUUID(), p_limit: 20, p_lease_seconds: 60 });
    if (error) throw new WebhookError("event_claim_failed", 503);
    // Routing only turns accepted input into durable work or an explicit dead letter. No care action runs here.
    const routed = await dispatchEvents(db as unknown as RpcDb, (events ?? []) as ClaimedEvent[]);

    // Core 1 commands and Core 2 events need no graph, so they run with or without Atlas checkpoint configuration.
    let commands: Record<string, unknown>;
    try {
      commands = await runCommandJobs({ db: db as unknown as RpcDb, workerId: randomUUID(), handlers: createProductionCommandHandlers(db) });
    } catch { commands = { status: "failed" }; }

    const bridge = buildProviderBridge(phase2Entrypoints, db as unknown as RpcDb, providerConfigFromEnv(process.env));
    // Names of missing or invalid variables are reported; values never are. Events are still routed when this is incomplete.
    const loaded = loadAtlasConfig(process.env);
    let workflow: Record<string, unknown> = loaded.ok ? { status: "ok" } : { status: "not_configured", problems: loaded.problems };
    if (loaded.ok) {
      // The model/provider understanding port is deliberately not injected: only exact commands are understood and
      // everything else pauses for durable review.
      const atlas = createAtlasRuntime({ db: db as never, workerId: randomUUID(), config: loaded.config, bridge });
      try { workflow = { status: "ok", ...(await runWorkflowJobs(atlas.deps)) }; } finally { await atlas.close().catch(() => undefined); }
    }
    // Provider side effects happen only here, at the tick boundary, never inside Atlas graph nodes. Absent entrypoints report unavailable.
    const dispatch = bridge.dispatchTick ? await bridge.dispatchTick(randomUUID()) : { status: "unavailable" };
    // Recording purge: counts only (purged/skipped/failed/refused). Never paths, ids or provider data.
    const purge = bridge.purgeTick ? await bridge.purgeTick().catch(() => ({ status: "failed" })) : { status: "unavailable" };
    const providers = { dispatch, purge, status: bridge.statusJob ? "configured" : "unavailable", recording: { twilio: bridge.recordingJobs.twilio ? "configured" : "unavailable", sarvam: bridge.recordingJobs.sarvam ? "configured" : "unavailable" },
      dispatchCapabilities: bridge.dispatchCapabilities,
      unavailable: bridge.unavailable };

    // Core 1 urgent responder escalation & check-in scheduler / post-call projection
    const checkInDeps = createProductionCheckInDeps(process.env);
    const urgentDeps = createProductionUrgentHelpDeps(process.env);
    const sarvamProjection = await syncSarvamCheckInPostCalls(checkInDeps).catch(() => ({ projected: 0, retriedOrEscalated: 0 }));
    const checkInRun = await processCheckInTick(checkInDeps).catch(() => ({ evaluated: 0, dispatched: 0, deferred: 0, exhausted: 0 }));
    const urgentRun = await processUrgentEscalationTick(urgentDeps).catch(() => ({ acceptedNotified: 0, failedCallsAdvanced: 0, timeoutsAdvanced: 0 }));

    return NextResponse.json({
      ...routed,
      missed_calls: missedCalls,
      commands,
      workflow,
      providers,
      core1_wiring: {
        sarvamProjection,
        checkIn: checkInRun,
        urgent: urgentRun,
      },
      care_actions_run: typeof commands.done === "number" ? commands.done : 0,
      processing: "durable_workflow_queue",
    },
      { status: routed.failed > 0 ? 503 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof WebhookError ? error.code : "tick_failed" }, { status: error instanceof WebhookError ? error.status : 503 });
  }
}
