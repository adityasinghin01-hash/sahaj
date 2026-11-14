import { decryptWebhook } from "../webhook-security";
import { Core1CommandError } from "../core1/errors";
import { validateCheckInPayload, validateUrgentHelpPayload } from "../core1/validation";
import {
  createSupabaseCore1OutboxPort,
  createSupabaseCore1TimelinePort,
  stableCore1Uuid,
  type Core1OutboxPort,
  type Core1TimelinePort,
  type SupabaseClientLike,
} from "../core1/wiring-common";
import { UUID } from "./db";
import type { CommandEvent, CommandHandlers, CommandOutcome } from "./runner";

/**
 * Handlers for the `core1.command` and `core2.event` workflow kinds (see runner.ts routeEventKind).
 *
 * Core 1 commands accepted by /api/core1, /api/core1/check-in and /api/core1/urgent-help are stored encrypted in raw_events
 * (`command.<type>`, source `core1_command`, AAD `core1:<family>:<scoped idempotency key>`) and acted on here:
 *   - check_in      -> one outbox row (kind core1.check_in, action check_in) + signed timeline line. The outbox row carries
 *                      no dispatch binding, so no provider tick can claim it; it is the durable, inspectable intent.
 *   - urgent_help   -> initiate: create_urgent_incident_offer (incident + offer to the top consenting circle member).
 *                      accept: accept_responder_assignment_verified with the supplied normalized proof, then a push
 *                      outbox row + child_alerts row for every other adult child (e.g. Riya) + signed timeline line.
 *   - voice_message: /api/core1/voice-message stores this event and then creates the voice post + notify in the same
 *     request, so the job confirms it (code voice_message_finalized_at_route). The generic /api/core1 route stores the
 *     same event type WITHOUT finalizing; that gap is reported, not papered over here.
 *   - refill_proposal, missed_call_nudge, family_report: their dedicated routes act synchronously and never write a
 *     command.* event. Only the generic /api/core1 route stores these, so the job completes with an explicit rejection.
 * Maa's paired-device routes (source core1_maa_device) and Core 2 (source core2) already applied the state change inside
 * the request; their jobs confirm the stored input and complete.
 * Codes are [a-z0-9_] only. No payload, number or token is logged or returned.
 */

export interface UrgentPorts {
  createOffer(p: { familyId: string; subjectPersonId: string; severity: string; offerTimeoutMinutes: number }):
    Promise<{ incidentId: string; assignmentId: string | null; state: string }>;
  acceptVerified(p: { familyId: string; incidentId: string; assignmentId: string; responderPersonId: string; rawEventId: string; promiseMinutes: number }):
    Promise<{ ok: true } | { ok: false; code: string; permanent: boolean }>;
  /** Active adult children of the family (role child). */
  listChildren(familyId: string): Promise<string[]>;
  recordChildAlert(p: { id: string; familyId: string; personId: string; incidentId: string; kind: string }): Promise<void>;
}
export interface Core1CommandPorts {
  encryptionKeyHex: string | undefined;
  outbox: Core1OutboxPort;
  timeline: Core1TimelinePort;
  urgent: UrgentPorts;
  /** True when a signed timeline entry with this dedupe key exists (the step already ran). */
  hasTimeline(familyId: string, dedupeKey: string): Promise<boolean>;
}

const done = (code: string): CommandOutcome => ({ action: "done", code });
const rejected = (code: string): CommandOutcome => ({ action: "rejected", code });
const retry = (code: string): CommandOutcome => ({ action: "retry", code });
const ENVELOPE_KEYS = new Set(["command", "command_type", "familyId", "family_id", "idempotencyKey", "idempotency_key"]);
const DEDICATED_ROUTE_COMMANDS = new Set(["refill_proposal", "missed_call_nudge", "family_report"]);

/** Same envelope handling as core1/service.ts executeCore1Command. */
function commandPayload(body: Record<string, unknown>): Record<string, unknown> {
  const input = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (!ENVELOPE_KEYS.has(k)) out[k] = v;
  return out;
}

export function createCore1CommandHandler(ports: Core1CommandPorts): NonNullable<CommandHandlers["core1"]> {
  return async (ev: CommandEvent) => {
    if (ev.source === "core1_maa_device") return done("applied_at_device_route");
    if (ev.source !== "core1_command" || !ev.eventType.startsWith("command.")) return rejected("unexpected_command_source");
    const command = ev.eventType.slice("command.".length);
    if (ev.metadata.command !== command) return rejected("command_metadata_mismatch");
    const actor = ev.metadata.actorPersonId;
    if (typeof actor !== "string" || !UUID.test(actor)) return rejected("command_actor_missing");
    if (DEDICATED_ROUTE_COMMANDS.has(command)) return rejected(`${command}_requires_dedicated_route`);
    if (command === "voice_message") return done("voice_message_finalized_at_route");

    const key = ports.encryptionKeyHex;
    if (!key || !/^[0-9a-f]{64}$/i.test(key)) return retry("encryption_not_configured");
    if (!ev.payloadCiphertext) return rejected("command_payload_missing");
    let payload: Record<string, unknown>;
    try {
      const body = JSON.parse(decryptWebhook(ev.payloadCiphertext, key, `core1:${ev.familyId}:${ev.providerEventId}`).toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) return rejected("command_payload_invalid");
      payload = commandPayload(body as Record<string, unknown>);
    } catch { return rejected("command_decrypt_failed"); }

    try {
      if (command === "check_in") return await checkIn(ports, ev, actor, payload);
      if (command === "urgent_help") return await urgentHelp(ports, ev, actor, payload);
      return rejected("unsupported_command");
    } catch (error) {
      if (error instanceof Core1CommandError) {
        const code = error.code.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 70);
        return error.status >= 500 ? retry(code) : rejected(code);
      }
      return retry("core1_command_failed");
    }
  };
}

async function checkIn(ports: Core1CommandPorts, ev: CommandEvent, actor: string, raw: Record<string, unknown>): Promise<CommandOutcome> {
  const p = validateCheckInPayload(raw);
  if (p.cancel) {
    await ports.timeline.append({ familyId: ev.familyId, eventType: "core1.check_in.cancel_requested", entityId: p.scheduleId ?? null,
      humanLine: "A check-in cancellation was recorded.", payload: { eventId: ev.eventId, personId: p.personId, scheduleId: p.scheduleId ?? null },
      dedupeKey: `core1:check_in:cancel:${ev.eventId}` });
    return done("check_in_cancel_recorded");
  }
  const dedupeKey = `core1:check_in:${ev.eventId}`;
  const out = await ports.outbox.enqueue({ familyId: ev.familyId, kind: "core1.check_in", action: "check_in", dedupeKey,
    payload: { v: 1, eventId: ev.eventId, personId: p.personId, requestedBy: actor, scheduleId: p.scheduleId ?? null,
      preferredTime: p.preferredTime ?? null, timezone: p.timezone ?? null, aiDisclose: true } });
  await ports.timeline.append({ familyId: ev.familyId, eventType: "core1.check_in.queued", entityId: out.outboxId,
    humanLine: "A check-in call was queued.", payload: { eventId: ev.eventId, outboxId: out.outboxId, personId: p.personId },
    dedupeKey: `timeline:${dedupeKey}` });
  return done("check_in_queued");
}

async function urgentHelp(ports: Core1CommandPorts, ev: CommandEvent, actor: string, raw: Record<string, unknown>): Promise<CommandOutcome> {
  const p = validateUrgentHelpPayload(raw);
  const action = p.action ?? "initiate";
  if (action === "initiate") {
    const marker = `core1:urgent:offer:${ev.eventId}`;
    if (await ports.hasTimeline(ev.familyId, marker)) return done("urgent_offer_exists");
    const offer = await ports.urgent.createOffer({ familyId: ev.familyId, subjectPersonId: p.subjectPersonId, severity: p.severity, offerTimeoutMinutes: 3 });
    await ports.timeline.append({ familyId: ev.familyId, eventType: offer.assignmentId ? "core1.urgent.offered" : "core1.urgent.escalated",
      entityId: offer.incidentId, humanLine: offer.assignmentId ? "Urgent help was offered to a family member." : "Urgent help found no available family member.",
      payload: { eventId: ev.eventId, incidentId: offer.incidentId, assignmentId: offer.assignmentId, state: offer.state }, dedupeKey: marker });
    return done(offer.assignmentId ? "urgent_offered" : "urgent_escalated_no_responder");
  }
  if (action === "accept") {
    if (!p.incidentId || !p.assignmentId || !p.rawEventId) return rejected("urgent_accept_needs_incident_assignment_and_proof");
    const marker = `core1:urgent:accepted:${p.assignmentId}`;
    if (!(await ports.hasTimeline(ev.familyId, marker))) {
      const res = await ports.urgent.acceptVerified({ familyId: ev.familyId, incidentId: p.incidentId, assignmentId: p.assignmentId,
        responderPersonId: actor, rawEventId: p.rawEventId, promiseMinutes: p.promiseMinutes ?? 15 });
      if (!res.ok) return res.permanent ? rejected(`urgent_accept_${res.code}`) : retry(`urgent_accept_${res.code}`);
    }
    // Tell every other adult child (Riya) through app push. Deterministic ids make retries reuse the same rows.
    for (const child of await ports.urgent.listChildren(ev.familyId)) {
      if (child === actor) continue;
      const dedupeKey = `core1:urgent_accepted_push:${p.assignmentId}:${child}`;
      const pushed = await ports.outbox.enqueue({ familyId: ev.familyId, kind: "core1.urgent_accepted_push", action: "send_alert", dedupeKey,
        payload: { v: 1, channel: "app_push", recipientPersonId: child, incidentId: p.incidentId, assignmentId: p.assignmentId, responderPersonId: actor,
          notification: { title: "Maa ki madad ho rahi hai", body: "Family ka ek sadasya Maa ki madad ke liye ja raha hai.", englishHint: "A family member accepted the urgent request." } } });
      if (!pushed.deduped) {
        await ports.urgent.recordChildAlert({ id: stableCore1Uuid(["urgent_accepted_alert", p.assignmentId, child]), familyId: ev.familyId,
          personId: child, incidentId: p.incidentId, kind: "urgent_accepted" });
      }
    }
    await ports.timeline.append({ familyId: ev.familyId, eventType: "core1.urgent.accepted", entityId: p.incidentId,
      humanLine: "A family member accepted the urgent request.", payload: { eventId: ev.eventId, incidentId: p.incidentId, assignmentId: p.assignmentId, responderPersonId: actor },
      dedupeKey: marker });
    return done("urgent_accepted");
  }
  return rejected(`urgent_${action}_not_supported_by_command`);
}

/** Core 2 applies watches, SOS, contacts and incident changes inside the request; the raw event is its encrypted input record. */
export function createCore2EventHandler(): NonNullable<CommandHandlers["core2"]> {
  return async (ev: CommandEvent) => {
    if (ev.source !== "core2" || !ev.eventType.startsWith("core2.")) return rejected("unexpected_core2_source");
    if (!ev.payloadCiphertext) return rejected("core2_payload_missing");
    return done("core2_applied_inline");
  };
}

const RPC_CODE = /^[a-z_]{3,60}$/;
const sqlstate = (code: unknown) => `sqlstate_${String(code ?? "unknown").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "unknown"}`;
const PERMANENT_SQLSTATE = new Set(["42501", "P0002", "22023", "42703", "23503", "23514"]);

/** Production wiring over the service-role Supabase client. */
export function createProductionCommandHandlers(db: SupabaseClientLike, env: Record<string, string | undefined> = process.env): CommandHandlers {
  const encryptionKeyHex = env.WEBHOOK_ENCRYPTION_KEY;
  const timeline = createSupabaseCore1TimelinePort(db, env.TIMELINE_SIGNING_PRIVATE_KEY ?? env.SIGNING_PRIVATE_KEY,
    env.TIMELINE_SIGNING_KEY_ID ?? env.SIGNING_KEY_ID ?? "core1-default");
  const urgent: UrgentPorts = {
    async createOffer(p) {
      const { data, error } = await db.rpc("create_urgent_incident_offer", { p_family_id: p.familyId, p_subject_person_id: p.subjectPersonId,
        p_severity: p.severity, p_offer_timeout_minutes: p.offerTimeoutMinutes });
      if (error || !data) {
        const permanent = PERMANENT_SQLSTATE.has(error?.code ?? "");
        throw new Core1CommandError(`urgent_offer_${sqlstate(error?.code)}`, permanent ? 422 : 503);
      }
      const d = data as Record<string, unknown>;
      return { incidentId: String(d.incident_id), assignmentId: typeof d.assignment_id === "string" ? d.assignment_id : null, state: String(d.state) };
    },
    async acceptVerified(p) {
      const { error } = await db.rpc("accept_responder_assignment_verified", { p_family_id: p.familyId, p_incident_id: p.incidentId,
        p_assignment_id: p.assignmentId, p_responder_person_id: p.responderPersonId, p_raw_event_id: p.rawEventId, p_promise_minutes: p.promiseMinutes });
      if (!error) return { ok: true };
      const code = typeof error.message === "string" && RPC_CODE.test(error.message) ? error.message : sqlstate(error.code);
      return { ok: false, code, permanent: PERMANENT_SQLSTATE.has(error.code ?? "") };
    },
    async listChildren(familyId) {
      const { data, error } = await db.from("family_memberships").select("person_id,role,revoked_at").eq("family_id", familyId).eq("role", "child").is("revoked_at", null);
      if (error) throw new Core1CommandError("children_lookup_failed", 503);
      return [...new Set(((data ?? []) as Array<{ person_id: string }>).map(r => String(r.person_id)))];
    },
    async recordChildAlert(p) {
      const { error } = await db.from("child_alerts").upsert({ id: p.id, family_id: p.familyId, person_id: p.personId, incident_id: p.incidentId, kind: p.kind },
        { onConflict: "id", ignoreDuplicates: true });
      if (error) throw new Core1CommandError("child_alert_persist_failed", 503);
    },
  };
  return {
    core1: createCore1CommandHandler({
      encryptionKeyHex,
      outbox: createSupabaseCore1OutboxPort(db, encryptionKeyHex),
      timeline,
      urgent,
      async hasTimeline(familyId, dedupeKey) {
        const { data, error } = await db.from("timeline_events").select("id").eq("family_id", familyId).eq("dedupe_key", dedupeKey).maybeSingle();
        if (error) throw new Core1CommandError("timeline_lookup_failed", 503);
        return Boolean(data);
      },
    }),
    core2: createCore2EventHandler(),
  };
}

/**
 * Core 1 tick step: pending TeleCMI missed calls (ingested by /api/missed-call/[secret]) go through Core 1's grouping
 * and Riya app-push nudge (nudges + child_alerts + outbox) BEFORE raw events are claimed, so the nudge pass sees them
 * pending. Calls it cannot attribute stay pending and are then routed as before. Counts only.
 */
export async function runMissedCallNudgePass(
  db: SupabaseClientLike,
  process: (familyId: string) => Promise<{ processed: number; clusters: unknown[] }>,
): Promise<{ status: "ok" | "failed"; families: number; processed: number; clusters: number; failedFamilies: number }> {
  const out = { status: "ok" as "ok" | "failed", families: 0, processed: 0, clusters: 0, failedFamilies: 0 };
  const { data, error } = await db.from("raw_events").select("family_id").eq("source", "telecmi").eq("event_type", "telecmi.missed_call")
    .eq("status", "pending").limit(200);
  if (error) return { ...out, status: "failed" };
  const families = [...new Set(((data ?? []) as Array<{ family_id: string }>).map(r => String(r.family_id)).filter(f => UUID.test(f)))];
  out.families = families.length;
  for (const familyId of families) {
    try {
      const r = await process(familyId);
      out.processed += r.processed; out.clusters += r.clusters.length;
    } catch { out.failedFamilies++; }
  }
  return out;
}
