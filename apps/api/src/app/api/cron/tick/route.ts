import { NextResponse } from "next/server";
import { safeTokenEquals } from "@/lib/secrets";
import { serviceDatabase } from "@/lib/database";
import { randomUUID } from "node:crypto";
import { WebhookError } from "@/lib/webhook-security";

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
    let dispatched = 0;
    for (const event of events ?? []) {
      // This only moves accepted input into durable work. It does not claim a care action occurred.
      const { error: dispatchError } = await db.rpc("dispatch_raw_event", {
        p_event_id: event.id, p_lease_token: event.lease_token,
        p_workflow_kind: "core1.ingest", p_thread_id: event.id,
      });
      if (dispatchError) {
        await db.rpc("finish_raw_event", { p_event_id: event.id, p_lease_token: event.lease_token, p_success: false, p_error_code: "dispatch_failed" });
        throw new WebhookError("workflow_dispatch_failed", 503);
      }
      dispatched++;
    }
    return NextResponse.json({ dispatched, care_actions_run: 0, processing: "durable_workflow_queue" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof WebhookError ? error.code : "tick_failed" }, { status: error instanceof WebhookError ? error.status : 503 });
  }
}
