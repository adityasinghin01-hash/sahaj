import { NextResponse } from "next/server";
import { safeTokenEquals } from "@/lib/secrets";
import { serviceDatabase } from "@/lib/database";
import { randomUUID } from "node:crypto";
import { WebhookError } from "@/lib/webhook-security";
import { dispatchEvents, runWorkflowJobs, type ClaimedEvent } from "@/lib/atlas-runtime/runner";
import { createAtlasRuntime } from "@/lib/atlas-runtime/factory";
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

    const { WEBHOOK_ENCRYPTION_KEY: key, DATABASE_URL: databaseUrl, TIMELINE_SIGNING_PRIVATE_KEY: signing, TIMELINE_KEY_ID: keyId } = process.env;
    let workflow: Record<string, unknown> = { status: "not_configured" };
    if (key && databaseUrl && signing && keyId) {
      // The model/provider understanding port is deliberately not injected yet: only exact commands are understood.
      const atlas = createAtlasRuntime({ db: db as never, workerId: randomUUID(), encryptionKeyHex: key, databaseUrl,
        timelinePrivateKeyPem: signing.replace(/\\n/g, "\n"), timelineKeyId: keyId });
      try { workflow = await runWorkflowJobs(atlas.deps); } finally { await atlas.close().catch(() => undefined); }
    }
    return NextResponse.json({ ...routed, workflow, care_actions_run: 0, processing: "durable_workflow_queue" },
      { status: routed.failed > 0 ? 503 : 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof WebhookError ? error.code : "tick_failed" }, { status: error instanceof WebhookError ? error.status : 503 });
  }
}
