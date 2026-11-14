import { NextResponse } from "next/server";
import { safeTokenEquals } from "@/lib/secrets";
import { serviceDatabase } from "@/lib/database";
import { randomUUID } from "node:crypto";
import { WebhookError } from "@/lib/webhook-security";
import { dispatchEvents, runWorkflowJobs, type ClaimedEvent } from "@/lib/atlas-runtime/runner";
import { createAtlasRuntime } from "@/lib/atlas-runtime/factory";
import { loadAtlasConfig } from "@/lib/atlas-runtime/config";
import { runDispatchTick } from "@/lib/atlas-runtime/bridge";
import { buildProviderBridge } from "@/lib/atlas-runtime/providers";
import type { RpcDb } from "@/lib/atlas-runtime/db";

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
    const { data: events, error } = await db.rpc("claim_raw_events", { p_worker_id: randomUUID(), p_limit: 20, p_lease_seconds: 60 });
    if (error) throw new WebhookError("event_claim_failed", 503);
    // Routing only turns accepted input into durable work or an explicit dead letter. No care action runs here.
    const routed = await dispatchEvents(db as unknown as RpcDb, (events ?? []) as ClaimedEvent[]);

    const bridge = buildProviderBridge();
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
    const dispatch = await runDispatchTick(db as unknown as RpcDb, bridge, randomUUID());
    const providers = { dispatch, normalize: bridge.normalize ? "configured" : "unavailable", recording: bridge.recording ? "configured" : "unavailable" };
    return NextResponse.json({ ...routed, workflow, providers, care_actions_run: 0, processing: "durable_workflow_queue" },
      { status: routed.failed > 0 ? 503 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof WebhookError ? error.code : "tick_failed" }, { status: error instanceof WebhookError ? error.status : 503 });
  }
}
