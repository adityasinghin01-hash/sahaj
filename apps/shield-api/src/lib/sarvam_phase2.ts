import { z } from "zod";
import { constantTimeEqual, verifyBearerToken } from "./auth";
import type { ShieldApp } from "./app";
import { parseResponderAnswer } from "./sarvam_family_check";

/**
 * Phase 2 links between Sarvam calls and Shield.
 *
 * 1. Call-status webhook → busy-line watch (step 2.4). Sarvam outbound webhooks carry no
 *    signature, so the URL holds a secret (`/api/sarvam/webhook/<SARVAM_WEBHOOK_SECRET>`) and
 *    the family/parent come from the `agent_variables` WE set when placing the call; the parent
 *    is cross-checked against the family before anything is recorded.
 * 2. Check-in variables → "is hafte ka fraud" tip (step 2.5) for the check-in caller (Core 1).
 */

const STATUS_ALIASES: Record<string, "connected" | "no_answer" | "busy" | "failed"> = {
  connected: "connected", completed: "connected", answered: "connected",
  no_answer: "no_answer", "no-answer": "no_answer", noanswer: "no_answer", not_answered: "no_answer",
  busy: "busy", user_busy: "busy",
  failed: "failed", error: "failed", rejected: "failed", cancelled: "failed", canceled: "failed",
};

const Uuid = z.string().uuid();
const MIN_SECRET = 32;
const MAX_BODY = 64 * 1024;

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

export function parseSarvamStatus(body: Record<string, unknown>) {
  const nested = asRecord(body.data) ?? {};
  // Our calls port puts family/parent/purpose in webhook_config.metadata; agent_variables also accepted.
  const vars = asRecord(pick(body, "metadata", "agent_variables", "variables"))
    ?? asRecord(pick(nested, "metadata", "agent_variables", "variables")) ?? {};
  const rawStatus = String(pick(body, "status", "call_status") ?? pick(nested, "status", "call_status") ?? "").toLowerCase();
  const status = STATUS_ALIASES[rawStatus];
  const family = Uuid.safeParse(vars.family_id);
  const parent = Uuid.safeParse(vars.parent_id ?? vars.person_id);
  if (!status || !family.success || !parent.success) return null;
  const at = pick(body, "ended_at", "updated_at", "timestamp") ?? pick(nested, "ended_at", "updated_at", "timestamp");
  const atIso = typeof at === "string" && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : undefined;
  return {
    purpose: typeof vars.purpose === "string" ? vars.purpose : "unknown",
    family_id: family.data,
    parent_id: parent.data,
    status,
    in_checkin_window: truthy(vars.in_checkin_window),
    ...(atIso ? { at: atIso } : {}),
  };
}

export function createSarvamWebhookHandler(getApp: () => ShieldApp) {
  return async function POST(req: Request, route: { params: Promise<{ secret: string }> }): Promise<Response> {
    const app = getApp();
    const expected = app.env.SARVAM_WEBHOOK_SECRET;
    if (!expected || expected.length < MIN_SECRET) {
      return Response.json({ error: "webhook_not_configured" }, { status: 500 });
    }
    const { secret } = await route.params;
    if (!constantTimeEqual(secret ?? "", expected)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const text = await req.text();
    if (text.length > MAX_BODY) return Response.json({ error: "too_large" }, { status: 413 });
    let body: Record<string, unknown> | null = null;
    try { body = asRecord(JSON.parse(text)); } catch { body = null; }
    if (!body) return Response.json({ error: "invalid_request" }, { status: 400 });
    const parsed = parseSarvamStatus(body);
    // Unknown shapes are acknowledged (Sarvam does not retry) but never recorded.
    if (!parsed) return Response.json({ ok: true, ignored: "unrecognised_payload" });
    // Responder calls placed for a keypad family check carry Rohit's spoken answer back (no WhatsApp needed).
    // Without a parsable answer on a connected call it is acknowledged like any other non-check-in call.
    const answer = parsed.purpose === "responder" && parsed.status === "connected" ? parseResponderAnswer(body) : null;
    if (answer && app.sarvamFamilyCheckStore) {
      const recorded = await app.sarvamFamilyCheckStore.recordResponderAnswer({
        familyId: parsed.family_id, personId: answer.personId, receiptId: answer.receiptId,
        checkId: answer.checkId, answer: answer.answer, at: new Date(),
      });
      if (recorded !== "recorded") return Response.json({ ok: true, ignored: recorded });
      return Response.json({ ok: true, family_check: answer.answer });
    }
    // Only check-in calls feed the busy-line watch; other purposes are acknowledged only.
    if (parsed.purpose !== "checkin") return Response.json({ ok: true, ignored: "not_checkin" });
    const result = await app.recordBusyCallStatus({
      family_id: parsed.family_id, parent_id: parsed.parent_id, status: parsed.status,
      in_checkin_window: parsed.in_checkin_window, ...(parsed.at ? { at: parsed.at } : {}),
    });
    if (!result.ok) return Response.json({ ok: true, ignored: result.error });
    return Response.json({ ok: true, streak: result.result.streak, alerted: result.result.alerted });
  };
}

export function createCheckinVarsHandler(getApp: () => ShieldApp) {
  return async function GET(req: Request): Promise<Response> {
    const app = getApp();
    if (!verifyBearerToken(req, app.env.SARVAM_TOOL_TOKEN)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const family = Uuid.safeParse(new URL(req.url).searchParams.get("family_id"));
    if (!family.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    const tip = await app.getWeeklyTip({ family_id: family.data });
    if (!tip.ok) return Response.json({ error: tip.error }, { status: tip.status });
    // Names match the check-in agent's variables ("is hafte ka fraud", @drill_story, @drill_praise).
    const body: Record<string, unknown> = {
      fraud_tip: tip.tip.fraud_tip_hi, fraud_tip_hi: tip.tip.fraud_tip_hi, fraud_tip_en: tip.tip.fraud_tip_en, as_of: tip.as_of,
      drill_id: "", drill_story: "", drill_praise: "",
    };
    const parent = Uuid.safeParse(new URL(req.url).searchParams.get("parent_id"));
    if (parent.success) {
      const runtime = app.runtime as unknown as {
        pickDrill?: (input: { familyId: string; parentId: string; now: Date }) => Promise<{ checkin_variables?: Record<string, string> } | null>;
        takeCheckinPraise?: (input: { familyId: string; parentId: string }) => Promise<{ drill_praise: string } | null>;
      };
      const ctx = { familyId: family.data, parentId: parent.data };
      // A weekly helper drill (null when one was asked in the last 7 days) and any queued praise line.
      const drill = runtime.pickDrill ? await runtime.pickDrill({ ...ctx, now: new Date() }).catch(() => null) : null;
      Object.assign(body, drill?.checkin_variables ?? {});
      const praise = runtime.takeCheckinPraise ? await runtime.takeCheckinPraise(ctx).catch(() => null) : null;
      if (praise) body.drill_praise = praise.drill_praise;
    }
    return Response.json(body);
  };
}
