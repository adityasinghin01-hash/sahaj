import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { safeTokenEquals } from "@/lib/secrets";
import { readWebhookBody, WebhookError } from "@/lib/webhook-security";
import { eventStore } from "@/lib/event-store";
import { ingestWhatsApp } from "@/lib/whatsapp-ingestion";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && challenge !== null && safeTokenEquals(token, process.env.WHATSAPP_VERIFY_TOKEN)) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

export async function POST(request: Request) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  let body: Buffer;
  try { body = await readWebhookBody(request); }
  catch (error) {
    return NextResponse.json({ error: error instanceof WebhookError ? error.code : "body_read_failed" }, { status: error instanceof WebhookError ? error.status : 400 });
  }
  const received = request.headers.get("x-hub-signature-256");
  const expected = createHmac("sha256", secret).update(body).digest();
  const validFormat = received !== null && /^sha256=[0-9a-f]{64}$/.test(received);
  const actual = validFormat ? Buffer.from(received.slice(7), "hex") : Buffer.alloc(32);
  if (!validFormat || !timingSafeEqual(actual, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const account = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!account) return NextResponse.json({ error: "provider_account_not_configured" }, { status: 503 });
  let payload: unknown;
  try { payload = JSON.parse(body.toString("utf8")); }
  catch { return NextResponse.json({ error: "invalid_json" }, { status: 400 }); }
  try {
    const accepted = await ingestWhatsApp(payload, account, eventStore());
    return NextResponse.json({ accepted, processing: "queued" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof WebhookError ? error.code : "event_persistence_failed" }, { status: error instanceof WebhookError ? error.status : 503 });
  }
}
