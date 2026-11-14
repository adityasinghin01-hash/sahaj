import { verifyMaaDeviceRequest } from "@/app/api/core1/maa/_lib/device-auth";
import { Core2Error, type Core2Actor, type Core2ErrorCode } from "@/lib/core2/contracts";
import type { GateInput } from "@sahaj/gate";
import {
  assertBoolean,
  assertBoundedInt,
  assertCronSecret,
  assertOptionalUuid,
  assertPlainObject,
  assertSafeString,
  assertSarvamToolToken,
  assertValidUuid,
  authenticateCore2Actor,
  hashCanonicalRequest,
  parseIdempotencyKey,
  scaleDurationMs,
  sha256Hex,
} from "@/lib/core2/security";
import {
  verifyTimelineChain,
  type SignedTimelineEvent,
  type TimelineEnvelope,
} from "@/lib/timeline";
import { verifyTwilioFormSignature } from "@sahaj/adapters";
import {
  BADGE_UNCONFIRMED_HI,
  formatHeardBadge,
  type AfterReportDeliveryItem,
  type AfterReportDto,
  type CircleCompanionCandidate,
  type Core2NewsDeps,
  type GentleNewsRow,
  type HeardEvidenceType,
  type HeardMessageKind,
  type HeardStatusDto,
  type MaaQuestionEntry,
  type PublicGentleNewsDto,
  type TwilioOutboxLookup,
  type ZapierZ3Payload,
  type ZapierZ3Status,
} from "./contracts";
import {
  createDefaultZapierDispatcher,
  redactProseText,
  sanitizeCalmSummary,
  sanitizeReportValue,
  toShortCalmVersion,
} from "./redaction";

const DEFAULT_CIRCLE_WAIT_MS = 5 * 60_000;
const NO_CIRCLE_WAIT_MS = 2 * 60_000;
const ZAPIER_TIMEOUT_MS = 3_000;

export interface AuthRequestContext {
  bearerToken: string | null | undefined;
  familyIdHeader?: string | null | undefined;
  idempotencyKeyHeader?: string | null | undefined;
}

function nowOf(deps: Core2NewsDeps): Date {
  return deps.core2.now ? deps.core2.now() : new Date();
}

function uuidOf(deps: Core2NewsDeps): string {
  return deps.core2.uuid ? deps.core2.uuid() : crypto.randomUUID();
}

function envOf(deps: Core2NewsDeps): Record<string, string | undefined> {
  return deps.core2.env ?? process.env;
}

function assertMaintenanceClear(env: Record<string, string | undefined>): void {
  if (env.MAINTENANCE_KILL === "1" || env.MAINTENANCE_KILL === "true") {
    throw new Core2Error("unavailable", 503, "Service temporarily paused for maintenance");
  }
}

function mapDeviceAuthError(err: unknown): Core2Error {
  if (err instanceof Core2Error) return err;
  const rawStatus =
    typeof err === "object" && err !== null && "status" in err && typeof (err as { status?: unknown }).status === "number"
      ? (err as { status: number }).status
      : 401;
  const status: 400 | 401 | 403 | 404 | 409 | 422 | 503 =
    rawStatus === 400 ||
    rawStatus === 401 ||
    rawStatus === 403 ||
    rawStatus === 404 ||
    rawStatus === 409 ||
    rawStatus === 422 ||
    rawStatus === 503
      ? rawStatus
      : 401;
  const code: Core2ErrorCode =
    status === 403 ? "forbidden" : status === 503 ? "unavailable" : "unauthenticated";
  const msg = err instanceof Error ? err.message : "Device authentication failed";
  return new Core2Error(code, status, msg);
}

async function authorizeAndEnqueueOutbox(
  deps: Core2NewsDeps,
  input: {
    familyId: string;
    actorPersonId: string;
    action: GateInput["request"]["action"];
    targetPersonId: string;
    consentSubjectId?: string;
    outboxKind: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
  },
): Promise<{ decision: "allow" | "ask" | "deny"; outboxId: string | null }> {
  if (deps.core2.dispatch.authorizeAndSend && input.outboxKind === 'gentle_news.circle_offer') return deps.core2.dispatch.authorizeAndSend(input);
  const nowIso = nowOf(deps).toISOString();
  const gateInput = await deps.core2.repo.loadGateInput({
    familyId: input.familyId,
    actorPersonId: input.actorPersonId,
    requestId: uuidOf(deps),
    action: input.action,
    targetId: input.targetPersonId,
    consentSubjectId: input.consentSubjectId,
    now: nowIso,
  });
  const decision = await deps.core2.gate.evaluate(gateInput);
  if (decision.decision !== "allow") {
    return { decision: decision.decision, outboxId: null };
  }
  const safePayload = sanitizeReportValue(input.payload);
  const { payloadCiphertext } = deps.core2.crypto.encryptPayload(
    input.familyId,
    input.dedupeKey,
    "core2-news",
    safePayload,
  );
  const outbox = await deps.core2.dispatch.enqueueAuthorized({
    familyId: input.familyId,
    actionRequestId: null,
    kind: input.outboxKind,
    dedupeKey: input.dedupeKey,
    payloadCiphertext,
  });
  return { decision: "allow", outboxId: outbox.outboxId };
}

async function ingestAndAppendTimeline(
  deps: Core2NewsDeps,
  input: {
    familyId: string;
    source: string;
    providerEventId: string;
    eventType: string;
    entityId: string | null;
    humanLine: string;
    payload: Record<string, unknown>;
  },
): Promise<{ rawEventId: string }> {
  const nowIso = nowOf(deps).toISOString();
  const safePayload = sanitizeReportValue(input.payload);
  const eventId = uuidOf(deps);
  const { payloadHash, payloadCiphertext } = deps.core2.crypto.encryptPayload(
    input.familyId,
    eventId,
    input.source,
    safePayload,
  );
  const { rawEventId } = await deps.core2.repo.ingestRawEvent({
    source: input.source,
    providerEventId: input.providerEventId,
    eventType: input.eventType,
    familyId: input.familyId,
    metadata: { entity_id: input.entityId },
    payloadHash,
    payloadCiphertext,
  });
  await deps.core2.timeline.append({
    familyId: input.familyId,
    eventId,
    dedupeKey: `${input.source}:${input.providerEventId}`,
    eventType: input.eventType,
    entityId: input.entityId,
    humanLine: redactProseText(input.humanLine),
    occurredAt: nowIso,
    payload: safePayload,
  });
  return { rawEventId };
}

function toPublicGentleNewsDto(
  row: GentleNewsRow,
  circleDisplayName: string | null,
  nowMs: number,
): PublicGentleNewsDto {
  const dueMs = Date.parse(row.maa_call_due_at);
  const remainingMs = Number.isFinite(dueMs) ? Math.max(0, dueMs - nowMs) : 0;
  return {
    id: row.id,
    family_id: row.family_id,
    incident_id: row.incident_id,
    subject_person_id: row.subject_person_id,
    parent_person_id: row.parent_person_id,
    status: row.status,
    calm_summary: row.calm_summary,
    voice_post_id: row.voice_post_id,
    circle_person_id: row.circle_person_id,
    circle_display_name: circleDisplayName,
    circle_offer_status: row.circle_offer_status,
    circle_offered_at: row.circle_offered_at,
    circle_accepted_at: row.circle_accepted_at,
    circle_with_maa_at: row.circle_with_maa_at,
    maa_call_due_at: row.maa_call_due_at,
    remaining_ms: remainingMs,
    maa_call_queued_at: row.maa_call_queued_at,
    maa_questions: row.maa_questions,
    maa_notified_via_push: false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function resolveDisplayName(
  deps: Core2NewsDeps,
  familyId: string,
  personId: string | null,
): Promise<string | null> {
  if (!personId) return null;
  const p = await deps.newsRepo.getPerson(familyId, personId);
  return p ? p.displayName : null;
}

async function offerCircleCompanionIfAvailable(
  deps: Core2NewsDeps,
  input: {
    familyId: string;
    incidentId: string;
    actorPersonId: string;
    companion: CircleCompanionCandidate;
    calmSummary: string;
    maaCallDueAt: string;
  },
): Promise<void> {
  await authorizeAndEnqueueOutbox(deps, {
    familyId: input.familyId,
    actorPersonId: input.actorPersonId,
    action: "urgent_responder",
    targetPersonId: input.companion.person_id,
    consentSubjectId: input.companion.person_id,
    outboxKind: "gentle_news.circle_offer",
    dedupeKey: `gentle_news:circle_offer:${input.incidentId}:${input.companion.person_id}`,
    payload: {
      recipient_person_id: input.companion.person_id,
      incident_id: input.incidentId,
      prompt_hi: "Kripya Maa ke paas jaakar baithiye. Pahunchne par 'Maa ke paas hoon' dabayein.",
      calm_summary: input.calmSummary,
      maa_call_due_at: input.maaCallDueAt,
    },
  });
}

async function queueCalmMaaOutboundCall(
  deps: Core2NewsDeps,
  row: GentleNewsRow,
  triggerReason: "companion_with_maa" | "timer_due",
): Promise<GentleNewsRow> {
  const nowIso = nowOf(deps).toISOString();
  const subject = await deps.newsRepo.getPerson(row.family_id, row.subject_person_id);
  const subjectName = subject?.displayName ?? "Aapka parivar";
  const companionName = await resolveDisplayName(deps, row.family_id, row.circle_person_id);

  // Never include phone numbers or graphic details; AI must disclose its identity cleanly.
  const dispatch = await authorizeAndEnqueueOutbox(deps, {
    familyId: row.family_id,
    actorPersonId: row.marked_by_person_id,
    action: "check_in",
    targetPersonId: row.parent_person_id,
    consentSubjectId: row.subject_person_id,
    outboxKind: "sarvam.outbound_call",
    dedupeKey: `gentle_news:maa_call:${row.incident_id}`,
    payload: {
      channel: "sarvam_voice",
      purpose: "gentle_news_calm_call",
      trigger_reason: triggerReason,
      family_id: row.family_id,
      incident_id: row.incident_id,
      recipient_person_id: row.parent_person_id,
      subject_person_id: row.subject_person_id,
      subject_name: subjectName,
      companion_with_maa: row.circle_offer_status === "with_maa",
      companion_name: companionName,
      voice_post_id: row.voice_post_id,
      ai_disclosed: true,
      ai_cloned_voice_used: false,
      calm_script_hi: toShortCalmVersion(
        `Namaste Maa, main Sahaj AI sahayak Aasha Didi bol rahi hoon. ${row.calm_summary}`,
        260,
      ),
    },
  });

  const updated = await deps.newsRepo.updateGentleNewsCas(
    row.family_id,
    row.incident_id,
    row.version,
    {
      status: "maa_call_queued",
      maa_call_outbox_id: dispatch.outboxId,
      maa_call_queued_at: nowIso,
    },
    nowIso,
  );
  if (!updated) {
    const latest = await deps.newsRepo.getGentleNewsByIncident(row.family_id, row.incident_id);
    if (latest) return latest;
    throw new Core2Error("conflict", 409, "Concurrent update while queueing gentle news call");
  }

  await ingestAndAppendTimeline(deps, {
    familyId: row.family_id,
    source: "core2.news",
    providerEventId: `maa_call_queued:${row.incident_id}`,
    eventType: "core2.gentle_news.maa_call_queued",
    entityId: row.incident_id,
    humanLine:
      triggerReason === "companion_with_maa"
        ? "Companion is sitting with Maa; calm Aasha Didi call queued with family voice option."
        : "Gentle wait timer elapsed; calm Aasha Didi call queued for Maa.",
    payload: {
      incident_id: row.incident_id,
      trigger_reason: triggerReason,
      outbox_id: dispatch.outboxId,
      has_family_voice_note: Boolean(row.voice_post_id),
      ai_disclosed: true,
    },
  });

  return updated;
}

export async function markHurtIncident(
  deps: Core2NewsDeps,
  authCtx: AuthRequestContext,
  rawBody: unknown,
): Promise<{ status: number; body: PublicGentleNewsDto }> {
  const actor = await authenticateCore2Actor(
    deps.core2.auth,
    deps.core2.repo,
    authCtx.bearerToken,
    authCtx.familyIdHeader,
  );
  if (actor.role === "parent") {
    throw new Core2Error("forbidden", 403, "Parent cannot initiate gentle news staging");
  }

  const keyHash = sha256Hex(parseIdempotencyKey(authCtx.idempotencyKeyHeader));
  const bodyObj = assertPlainObject(rawBody, ["incident_id", "calm_summary", "voice_post_id"]);
  const incidentId = assertValidUuid(bodyObj.incident_id, "incident_id");
  const rawSummary = assertSafeString(bodyObj.calm_summary, "calm_summary", 1, 400);
  const calmSummary = sanitizeCalmSummary(rawSummary);
  const voicePostId =
    bodyObj.voice_post_id === null || bodyObj.voice_post_id === undefined
      ? null
      : assertValidUuid(bodyObj.voice_post_id, "voice_post_id");

  const reqHash = hashCanonicalRequest({
    incident_id: incidentId,
    calm_summary: calmSummary,
    voice_post_id: voicePostId,
  });
  const cached = await deps.core2.repo.getIdempotency(
    actor.familyId,
    actor.personId,
    "core2.news.mark_hurt",
    keyHash,
  );
  if (cached) {
    if (cached.requestHash !== reqHash) {
      throw new Core2Error("idempotency_conflict", 409, "Idempotency key reused with different payload");
    }
    return { status: cached.responseStatus, body: cached.responseBody as PublicGentleNewsDto };
  }

  const incident = await deps.newsRepo.getIncident(actor.familyId, incidentId);
  if (!incident) {
    throw new Core2Error("not_found", 404, "Incident not found");
  }
  const assignments = await deps.newsRepo.listAssignmentsForIncident(actor.familyId, incidentId);
  const isAcceptingResponder =
    incident.owner_person_id === actor.personId ||
    assignments.some((a) => a.person_id === actor.personId && a.status === "accepted");
  if (actor.role !== "child" && !isAcceptingResponder) {
    throw new Core2Error(
      "forbidden",
      403,
      "Only child or accepting responder can mark hurt / at hospital",
    );
  }

  if (voicePostId) {
    const vp = await deps.newsRepo.getVoicePost(actor.familyId, voicePostId);
    if (!vp) {
      throw new Core2Error("not_found", 404, "Voice note not found in family");
    }
  }

  const existing = await deps.newsRepo.getGentleNewsByIncident(actor.familyId, incidentId);
  if (existing) {
    throw new Core2Error("conflict", 409, "Gentle news workflow already started for this incident");
  }

  const parents = await deps.core2.repo.listPeopleByRole(actor.familyId, "parent");
  const parent = parents[0];
  if (!parent) {
    throw new Core2Error("not_found", 404, "Parent person not found in family");
  }

  const candidates = await deps.newsRepo.listActiveCircleCompanions(actor.familyId, [
    incident.person_id,
    parent.id,
  ]);
  const topCandidate = candidates[0] ?? null;

  const env = envOf(deps);
  const now = nowOf(deps);
  const nowIso = now.toISOString();
  const waitMs = scaleDurationMs(
    topCandidate ? DEFAULT_CIRCLE_WAIT_MS : NO_CIRCLE_WAIT_MS,
    env,
  );
  const maaCallDueAt = new Date(now.getTime() + waitMs).toISOString();

  const { rawEventId } = await ingestAndAppendTimeline(deps, {
    familyId: actor.familyId,
    source: "core2.news",
    providerEventId: `hurt:${incidentId}:${keyHash.slice(0, 12)}`,
    eventType: "core2.gentle_news.initiated",
    entityId: incidentId,
    humanLine: topCandidate
      ? `Incident marked hurt/hospital; offered ${topCandidate.display_name} to sit with Maa first (Maa not notified directly).`
      : "Incident marked hurt/hospital; no circle companion available, calm call scheduled without pushing bad news directly to Maa.",
    payload: {
      incident_id: incidentId,
      marked_by_person_id: actor.personId,
      circle_person_id: topCandidate?.person_id ?? null,
      maa_call_due_at: maaCallDueAt,
      maa_notified_via_push: false,
      voice_post_id: voicePostId,
    },
  });

  const created = await deps.newsRepo.insertGentleNews({
    familyId: actor.familyId,
    incidentId,
    subjectPersonId: incident.person_id,
    parentPersonId: parent.id,
    markedByPersonId: actor.personId,
    calmSummary,
    voicePostId,
    circlePersonId: topCandidate?.person_id ?? null,
    circleOfferStatus: topCandidate ? "offered" : "none",
    circleOfferedAt: topCandidate ? nowIso : null,
    maaCallDueAt,
    rawEventId,
    nowIso,
  });

  if (topCandidate) {
    await offerCircleCompanionIfAvailable(deps, {
      familyId: actor.familyId,
      incidentId,
      actorPersonId: actor.personId,
      companion: topCandidate,
      calmSummary,
      maaCallDueAt,
    });
  }

  const dto = toPublicGentleNewsDto(created, topCandidate?.display_name ?? null, now.getTime());
  await deps.core2.repo.saveIdempotency({
    familyId: actor.familyId,
    actorPersonId: actor.personId,
    action: "core2.news.mark_hurt",
    keyHash,
    requestHash: reqHash,
    responseStatus: 201,
    responseBody: dto,
  });
  return { status: 201, body: dto };
}

export async function getGentleNewsState(
  deps: Core2NewsDeps,
  authCtx: AuthRequestContext,
  rawIncidentId: string,
): Promise<PublicGentleNewsDto> {
  const actor = await authenticateCore2Actor(
    deps.core2.auth,
    deps.core2.repo,
    authCtx.bearerToken,
    authCtx.familyIdHeader,
  );
  if (actor.role === "parent") {
    throw new Core2Error("forbidden", 403, "Parent cannot inspect gentle news staging");
  }
  const incidentId = assertValidUuid(rawIncidentId, "incident_id");
  const row = await deps.newsRepo.getGentleNewsByIncident(actor.familyId, incidentId);
  if (!row) {
    throw new Core2Error("not_found", 404, "Gentle news record not found");
  }
  if (actor.role === "circle" && row.circle_person_id !== actor.personId) {
    throw new Core2Error("forbidden", 403, "Not assigned to this gentle news workflow");
  }
  const companionName = await resolveDisplayName(deps, actor.familyId, row.circle_person_id);
  return toPublicGentleNewsDto(row, companionName, nowOf(deps).getTime());
}

export async function respondCircleOffer(
  deps: Core2NewsDeps,
  authCtx: AuthRequestContext,
  rawIncidentId: string,
  rawBody: unknown,
): Promise<PublicGentleNewsDto> {
  const actor = await authenticateCore2Actor(
    deps.core2.auth,
    deps.core2.repo,
    authCtx.bearerToken,
    authCtx.familyIdHeader,
  );
  if (actor.role === "parent") {
    throw new Core2Error("forbidden", 403, "Parent cannot act on circle offer");
  }

  const incidentId = assertValidUuid(rawIncidentId, "incident_id");
  const bodyObj = assertPlainObject(rawBody, ["action"]);
  const action = assertSafeString(bodyObj.action, "action", 1, 20);
  if (action !== "accept" && action !== "decline" && action !== "with_maa") {
    throw new Core2Error("invalid_request", 400, "Action must be accept, decline, or with_maa");
  }

  const row = await deps.newsRepo.getGentleNewsByIncident(actor.familyId, incidentId);
  if (!row) {
    throw new Core2Error("not_found", 404, "Gentle news record not found");
  }
  if (row.status === "closed") {
    throw new Core2Error("incident_closed", 409, "Gentle news workflow already closed");
  }

  const isAssignedCircle = row.circle_person_id === actor.personId;
  if ((action === "accept" || action === "decline") && !isAssignedCircle) {
    throw new Core2Error("forbidden", 403, "Only the offered circle companion can accept or decline");
  }
  if (action === "with_maa" && !isAssignedCircle && actor.role !== "child") {
    throw new Core2Error("forbidden", 403, "Only the companion or child can confirm Maa ke paas hoon");
  }

  const now = nowOf(deps);
  const nowIso = now.toISOString();

  if (action === "accept") {
    if (row.circle_offer_status === "accepted" || row.circle_offer_status === "with_maa") {
      const name = await resolveDisplayName(deps, actor.familyId, row.circle_person_id);
      return toPublicGentleNewsDto(row, name, now.getTime());
    }
    const updated = await deps.newsRepo.updateGentleNewsCas(
      actor.familyId,
      incidentId,
      row.version,
      {
        circle_offer_status: "accepted",
        circle_accepted_at: nowIso,
      },
      nowIso,
    );
    if (!updated) throw new Core2Error("conflict", 409, "Concurrent update");
    const name = await resolveDisplayName(deps, actor.familyId, updated.circle_person_id);
    await ingestAndAppendTimeline(deps, {
      familyId: actor.familyId,
      source: "core2.news",
      providerEventId: `circle_accept:${incidentId}:${actor.personId}`,
      eventType: "core2.gentle_news.circle_accepted",
      entityId: incidentId,
      humanLine: `${name ?? "Circle companion"} accepted to go sit with Maa.`,
      payload: { incident_id: incidentId, circle_person_id: actor.personId },
    });
    return toPublicGentleNewsDto(updated, name, now.getTime());
  }

  if (action === "decline") {
    const tried = Array.from(
      new Set([...row.tried_circle_person_ids, ...(row.circle_person_id ? [row.circle_person_id] : [])]),
    );
    const remaining = await deps.newsRepo.listActiveCircleCompanions(actor.familyId, [
      row.subject_person_id,
      row.parent_person_id,
      ...tried,
    ]);
    const nextCandidate = remaining[0] ?? null;
    const updated = await deps.newsRepo.updateGentleNewsCas(
      actor.familyId,
      incidentId,
      row.version,
      {
        circle_person_id: nextCandidate?.person_id ?? null,
        circle_offer_status: nextCandidate ? "offered" : "none",
        tried_circle_person_ids: tried,
        circle_offered_at: nextCandidate ? nowIso : row.circle_offered_at,
        circle_accepted_at: null,
      },
      nowIso,
    );
    if (!updated) throw new Core2Error("conflict", 409, "Concurrent update");
    if (nextCandidate) {
      await offerCircleCompanionIfAvailable(deps, {
        familyId: actor.familyId,
        incidentId,
        actorPersonId: actor.personId,
        companion: nextCandidate,
        calmSummary: row.calm_summary,
        maaCallDueAt: row.maa_call_due_at,
      });
    }
    await ingestAndAppendTimeline(deps, {
      familyId: actor.familyId,
      source: "core2.news",
      providerEventId: `circle_decline:${incidentId}:${actor.personId}:${tried.length}`,
      eventType: "core2.gentle_news.circle_declined",
      entityId: incidentId,
      humanLine: nextCandidate
        ? `Previous companion declined; offered ${nextCandidate.display_name} to sit with Maa.`
        : "No other circle companion available; waiting for calm call window.",
      payload: {
        incident_id: incidentId,
        declined_by: actor.personId,
        next_circle_person_id: nextCandidate?.person_id ?? null,
      },
    });
    return toPublicGentleNewsDto(updated, nextCandidate?.display_name ?? null, now.getTime());
  }

  // action === 'with_maa' ("Maa ke paas hoon") -> record timestamp + immediately queue calm Maa call
  const withMaaRow = await deps.newsRepo.updateGentleNewsCas(
    actor.familyId,
    incidentId,
    row.version,
    {
      status: "companion_with_maa",
      circle_offer_status: "with_maa",
      circle_accepted_at: row.circle_accepted_at ?? nowIso,
      circle_with_maa_at: row.circle_with_maa_at ?? nowIso,
    },
    nowIso,
  );
  if (!withMaaRow) throw new Core2Error("conflict", 409, "Concurrent update");
  const companionName = await resolveDisplayName(deps, actor.familyId, withMaaRow.circle_person_id);
  await ingestAndAppendTimeline(deps, {
    familyId: actor.familyId,
    source: "core2.news",
    providerEventId: `with_maa:${incidentId}:${actor.personId}`,
    eventType: "core2.gentle_news.companion_with_maa",
    entityId: incidentId,
    humanLine: `${companionName ?? "Companion"} confirmed "Maa ke paas hoon".`,
    payload: { incident_id: incidentId, circle_person_id: withMaaRow.circle_person_id },
  });

  const afterQueue = withMaaRow.maa_call_queued_at
    ? withMaaRow
    : await queueCalmMaaOutboundCall(deps, withMaaRow, "companion_with_maa");

  return toPublicGentleNewsDto(afterQueue, companionName, now.getTime());
}

export async function tickDueGentleNews(
  deps: Core2NewsDeps,
  cronSecretHeader: string | null | undefined,
): Promise<{ processed: number; queued_incident_ids: string[] }> {
  const env = envOf(deps);
  assertCronSecret(cronSecretHeader, env);
  assertMaintenanceClear(env);

  const nowIso = nowOf(deps).toISOString();
  const dueRows = await deps.newsRepo.listDueGentleNews(nowIso, 25);
  const queuedIds: string[] = [];

  for (const row of dueRows) {
    if (row.maa_call_queued_at) continue;
    const queued = await queueCalmMaaOutboundCall(deps, row, "timer_due");
    queuedIds.push(queued.incident_id);
  }

  return {
    processed: queuedIds.length,
    queued_incident_ids: queuedIds,
  };
}

export async function handleSarvamNewsTool(
  deps: Core2NewsDeps,
  bearerToken: string | null | undefined,
  rawBody: unknown,
): Promise<Record<string, unknown>> {
  const env = envOf(deps);
  assertSarvamToolToken(bearerToken, env);

  const bodyObj = assertPlainObject(rawBody, [
    "action",
    "family_id",
    "incident_id",
    "parent_person_id",
    "questions",
  ]);
  const action = assertSafeString(bodyObj.action, "action", 1, 40);
  const familyId = assertValidUuid(bodyObj.family_id, "family_id");

  if (action === "aasha_didi_check") {
    const parentPersonId = assertOptionalUuid(bodyObj.parent_person_id, "parent_person_id");
    const row = bodyObj.incident_id
      ? await deps.newsRepo.getGentleNewsByIncident(
          familyId,
          assertValidUuid(bodyObj.incident_id, "incident_id"),
        )
      : await deps.newsRepo.findLatestOpenGentleNewsForParent(familyId, parentPersonId);

    if (!row || row.status === "closed") {
      return {
        has_active_news: false,
        ai_disclosed: true,
        ai_cloned_voice_used: false,
        speak_hi:
          "Namaste Maa, main Sahaj AI sahayak Aasha Didi bol rahi hoon. Abhi sab theek hai.",
      };
    }

    const companionName = await resolveDisplayName(deps, familyId, row.circle_person_id);
    const shortCalm = toShortCalmVersion(row.calm_summary, 200);
    const nowIso = nowOf(deps).toISOString();
    if (row.status !== "maa_called") {
      await deps.newsRepo.updateGentleNewsCas(
        familyId,
        row.incident_id,
        row.version,
        { status: "maa_called" },
        nowIso,
      );
      await ingestAndAppendTimeline(deps, {
        familyId,
        source: "sarvam.tool",
        providerEventId: `aasha_didi_check:${row.incident_id}:${sha256Hex(nowIso).slice(0, 8)}`,
        eventType: "core2.gentle_news.maa_checked_aasha_didi",
        entityId: row.incident_id,
        humanLine: "Maa called Sahaj first; Aasha Didi shared the calm non-graphic summary.",
        payload: {
          incident_id: row.incident_id,
          ai_disclosed: true,
          has_family_voice_note: Boolean(row.voice_post_id),
        },
      });
    }

    return {
      has_active_news: true,
      incident_id: row.incident_id,
      ai_disclosed: true,
      ai_cloned_voice_used: false,
      calm_summary: shortCalm,
      has_family_voice_note: Boolean(row.voice_post_id),
      voice_post_id: row.voice_post_id,
      companion_with_maa: row.circle_offer_status === "with_maa",
      companion_name: companionName,
      speak_hi: `Namaste Maa, main Sahaj AI sahayak Aasha Didi hoon. ${shortCalm}`,
    };
  }

  if (action === "record_maa_questions") {
    const incidentId = assertValidUuid(bodyObj.incident_id, "incident_id");
    if (!Array.isArray(bodyObj.questions) || bodyObj.questions.length === 0 || bodyObj.questions.length > 10) {
      throw new Core2Error("invalid_request", 400, "questions must contain 1 to 10 entries");
    }
    const row = await deps.newsRepo.getGentleNewsByIncident(familyId, incidentId);
    if (!row) {
      throw new Core2Error("not_found", 404, "Gentle news record not found");
    }

    const nowIso = nowOf(deps).toISOString();
    const additions: MaaQuestionEntry[] = bodyObj.questions.map((item) => {
      const q = assertSafeString(item, "question", 1, 240);
      return {
        id: uuidOf(deps),
        question: redactProseText(q),
        recorded_at: nowIso,
        source: "sarvam_tool",
      };
    });
    const combined = [...row.maa_questions, ...additions].slice(-25);
    const updated = await deps.newsRepo.updateGentleNewsCas(
      familyId,
      incidentId,
      row.version,
      {
        status: row.status === "closed" ? "closed" : "maa_called",
        maa_questions: combined,
      },
      nowIso,
    );
    if (!updated) throw new Core2Error("conflict", 409, "Concurrent update");

    const children = await deps.core2.repo.listPeopleByRole(familyId, "child");
    const riya = children.find((c) => c.id === row.subject_person_id) ?? children[0];
    if (riya) {
      await authorizeAndEnqueueOutbox(deps, {
        familyId,
        actorPersonId: row.marked_by_person_id,
        action: "check_in",
        targetPersonId: riya.id,
        consentSubjectId: row.subject_person_id,
        outboxKind: "expo.calm_questions",
        dedupeKey: `gentle_news:questions:${incidentId}:${additions[0].id}`,
        payload: {
          recipient_person_id: riya.id,
          incident_id: incidentId,
          title: "Maa's questions after Aasha Didi call",
          questions: additions.map((a) => a.question),
        },
      });
    }

    await ingestAndAppendTimeline(deps, {
      familyId,
      source: "sarvam.tool",
      providerEventId: `maa_questions:${incidentId}:${additions[0].id}`,
      eventType: "core2.gentle_news.maa_questions_recorded",
      entityId: incidentId,
      humanLine: `Recorded ${additions.length} question(s) from Maa and forwarded calmly to Riya.`,
      payload: {
        incident_id: incidentId,
        questions_count: additions.length,
        questions: additions.map((a) => a.question),
      },
    });

    return {
      ok: true,
      incident_id: incidentId,
      recorded_count: additions.length,
      maa_questions: updated.maa_questions,
    };
  }

  throw new Core2Error("invalid_request", 400, "Unsupported sarvam news tool action");
}

function verifyReportTimeline(
  rows: readonly {
    id: string;
    family_id: string;
    event_type: string;
    entity_id: string | null;
    human_line: string;
    payload_hash: string;
    prev_chain_hash: string | null;
    chain_hash: string;
    signature: string;
    signing_key_id: string;
    created_at: string;
    sequence?: number | null;
    dedupe_key?: string | null;
    occurred_at_iso?: string | null;
    envelope_canonical?: string | null;
  }[],
  deps: Core2NewsDeps,
): boolean {
  if (!deps.timelinePublicKeys || deps.timelinePublicKeys.size === 0 || rows.length === 0) {
    return rows.every((r) => Boolean(r.chain_hash && r.signature));
  }
  const signedEvents: SignedTimelineEvent[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.envelope_canonical) {
      if (!r.sequence || !r.dedupe_key || !r.occurred_at_iso) return false;
      const envelope: TimelineEnvelope = {
        version: 1,
        familyId: r.family_id,
        eventId: r.id,
        sequence: r.sequence,
        previousHash: r.prev_chain_hash,
        dedupeKey: r.dedupe_key,
        eventType: r.event_type,
        entityId: r.entity_id,
        humanLine: r.human_line,
        payloadHash: r.payload_hash,
        occurredAt: r.occurred_at_iso,
        keyId: r.signing_key_id,
      };
      signedEvents.push({ envelope, chainHash: r.chain_hash, signature: r.signature });
    } else {
      try {
        const envelope = JSON.parse(r.envelope_canonical) as TimelineEnvelope;
        signedEvents.push({ envelope, chainHash: r.chain_hash, signature: r.signature });
      } catch {
        return false;
      }
    }
  }
  const tail = signedEvents[signedEvents.length - 1];
  const check = verifyTimelineChain(signedEvents, deps.timelinePublicKeys, {
    familyId: tail.envelope.familyId,
    sequence: tail.envelope.sequence,
    chainHash: tail.chainHash,
  });
  return check.valid;
}

function diffSeconds(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return Math.max(0, Math.round((e - s) / 1000));
}

async function buildRedactedAfterReport(
  deps: Core2NewsDeps,
  input: {
    familyId: string;
    incidentId: string;
    closedAt: string;
    zapierStatus: ZapierZ3Status;
    zapierAttemptedAt: string | null;
    zapierHttpStatus: number | null;
  },
): Promise<AfterReportDto> {
  const incident = await deps.newsRepo.getIncident(input.familyId, input.incidentId);
  if (!incident) {
    throw new Core2Error("not_found", 404, "Incident not found");
  }
  const subject = await deps.newsRepo.getPerson(input.familyId, incident.person_id);
  const parents = await deps.core2.repo.listPeopleByRole(input.familyId, "parent");
  const parent = parents[0];
  const parentTimezone = parent?.timezone ?? "Asia/Kolkata";
  const owner = incident.owner_person_id
    ? await deps.newsRepo.getPerson(input.familyId, incident.owner_person_id)
    : null;
  const assignments = await deps.newsRepo.listAssignmentsForIncident(input.familyId, input.incidentId);
  const gentleNews = await deps.newsRepo.getGentleNewsByIncident(input.familyId, input.incidentId);
  const companionName = gentleNews
    ? await resolveDisplayName(deps, input.familyId, gentleNews.circle_person_id)
    : null;

  const { reassurances, voicePosts } = parent
    ? await deps.newsRepo.listDeliveriesForReport(
        input.familyId,
        input.incidentId,
        incident.person_id,
        parent.id,
        incident.created_at,
        input.closedAt,
      )
    : { reassurances: [], voicePosts: [] };

  const deliveryIds = [
    ...reassurances.map((r) => r.id),
    ...voicePosts.map((v) => v.id),
    ...(gentleNews?.maa_call_outbox_id ? [gentleNews.maa_call_outbox_id] : []),
  ];
  const receipts = await deps.newsRepo.listHeardReceiptsByDeliveries(input.familyId, deliveryIds);
  const receiptByDelivery = new Map(receipts.map((r) => [r.delivery_id, r]));

  const deliveries: AfterReportDeliveryItem[] = [];
  for (const r of reassurances) {
    const receipt = receiptByDelivery.get(r.id);
    const heardAt = receipt?.heard_at ?? null;
    deliveries.push({
      delivery_id: r.id,
      message_kind: "core2_reassurance",
      label: redactProseText(r.status_label),
      sent_at: r.created_at,
      delivery_status: r.delivery_status,
      delivered: r.delivery_verified || r.delivery_status === "delivered" || Boolean(receipt),
      heard: Boolean(receipt) && r.heard_verified,
      heard_at: heardAt,
      heard_channel: receipt?.channel ?? null,
      heard_evidence: receipt?.evidence_type ?? null,
      badge_label: formatHeardBadge(heardAt, parentTimezone),
    });
  }
  const coveredVoiceIds = new Set(reassurances.map((r) => r.voice_post_id).filter(Boolean));
  for (const vp of voicePosts) {
    if (coveredVoiceIds.has(vp.id)) continue;
    const receipt = receiptByDelivery.get(vp.id);
    const heardAt = receipt?.heard_at ?? null;
    deliveries.push({
      delivery_id: vp.id,
      message_kind: "core1_voice_post",
      label: "Family voice note",
      sent_at: vp.created_at,
      delivery_status: vp.state,
      delivered: vp.state === "delivered" || vp.state === "heard" || Boolean(receipt),
      heard: Boolean(receipt),
      heard_at: heardAt,
      heard_channel: receipt?.channel ?? null,
      heard_evidence: receipt?.evidence_type ?? null,
      badge_label: formatHeardBadge(heardAt, parentTimezone),
    });
  }
  if (gentleNews?.maa_call_outbox_id) {
    const receipt = receiptByDelivery.get(gentleNews.maa_call_outbox_id);
    const heardAt = receipt?.heard_at ?? null;
    deliveries.push({
      delivery_id: gentleNews.maa_call_outbox_id,
      message_kind: "gentle_news_voice",
      label: "Aasha Didi calm call to Maa",
      sent_at: gentleNews.maa_call_queued_at ?? gentleNews.created_at,
      delivery_status: gentleNews.status === "maa_called" || gentleNews.status === "closed" ? "delivered" : "queued",
      delivered: Boolean(receipt) || gentleNews.status === "maa_called",
      heard: Boolean(receipt),
      heard_at: heardAt,
      heard_channel: receipt?.channel ?? null,
      heard_evidence: receipt?.evidence_type ?? null,
      badge_label: formatHeardBadge(heardAt, parentTimezone),
    });
  }

  const timelineRows = await deps.newsRepo.listFamilyTimelineForReport(input.familyId, input.incidentId);
  const chainVerified = verifyReportTimeline(timelineRows, deps);
  const acceptedAssignment = assignments.find((a) => a.accepted_at !== null) ?? null;
  const firstHeardAt =
    deliveries
      .map((d) => d.heard_at)
      .filter((x): x is string => Boolean(x))
      .sort()[0] ?? null;

  const rawReport: AfterReportDto = {
    schema_version: "sahaj.after_report.v1",
    family_id: input.familyId,
    incident_id: input.incidentId,
    closed_at: input.closedAt,
    redaction: {
      phone_numbers_stripped: true,
      location_trail_stripped: true,
      ai_cloned_voice_used: false,
    },
    what_happened: {
      severity: incident.severity,
      final_state: incident.state,
      subject_person_id: incident.person_id,
      subject_name: subject?.displayName ?? "Child",
      gentle_news_triggered: Boolean(gentleNews),
      calm_summary: gentleNews?.calm_summary ?? null,
      maa_questions: gentleNews?.maa_questions ?? [],
      timeline_chain_verified: chainVerified,
      timeline_entries: timelineRows.map((t) => ({
        id: t.id,
        event_type: t.event_type,
        human_line: redactProseText(t.human_line),
        created_at: t.created_at,
      })),
    },
    who_accepted: {
      owner_person_id: incident.owner_person_id,
      owner_name: owner?.displayName ?? acceptedAssignment?.display_name ?? null,
      assignments: assignments.map((a) => ({
        assignment_id: a.id,
        person_id: a.person_id,
        display_name: a.display_name,
        role: a.role,
        status: a.status,
        offered_at: a.offered_at,
        accepted_at: a.accepted_at,
      })),
      gentle_news_companion: gentleNews
        ? {
            person_id: gentleNews.circle_person_id,
            display_name: companionName,
            offer_status: gentleNews.circle_offer_status,
            offered_at: gentleNews.circle_offered_at,
            accepted_at: gentleNews.circle_accepted_at,
            with_maa_at: gentleNews.circle_with_maa_at,
          }
        : null,
    },
    deliveries,
    timings: {
      incident_created_at: incident.created_at,
      first_offer_at: assignments[0]?.offered_at ?? null,
      accepted_at: acceptedAssignment?.accepted_at ?? null,
      hurt_marked_at: gentleNews?.created_at ?? null,
      circle_with_maa_at: gentleNews?.circle_with_maa_at ?? null,
      maa_call_queued_at: gentleNews?.maa_call_queued_at ?? null,
      first_heard_at: firstHeardAt,
      closed_at: input.closedAt,
      accept_latency_s: diffSeconds(incident.created_at, acceptedAssignment?.accepted_at ?? null),
      resolution_duration_s: diffSeconds(incident.created_at, input.closedAt),
    },
    zapier_z3: {
      status: input.zapierStatus,
      attempted_at: input.zapierAttemptedAt,
      http_status: input.zapierHttpStatus,
    },
  };

  return sanitizeReportValue(rawReport);
}

export async function closeIncidentWithAfterReport(
  deps: Core2NewsDeps,
  authCtx: AuthRequestContext,
  rawIncidentId: string,
): Promise<AfterReportDto> {
  const actor: Core2Actor = await authenticateCore2Actor(
    deps.core2.auth,
    deps.core2.repo,
    authCtx.bearerToken,
    authCtx.familyIdHeader,
  );
  if (actor.role !== "child") {
    throw new Core2Error("forbidden", 403, "Only child can close incident and generate after-report");
  }

  const incidentId = assertValidUuid(rawIncidentId, "incident_id");
  const existing = await deps.newsRepo.getAfterReport(actor.familyId, incidentId);
  if (existing) {
    return existing.report_json;
  }

  const closedIncident = await deps.newsRepo.closeIncident(actor.familyId, incidentId);
  const nowIso = nowOf(deps).toISOString();

  const gentleNews = await deps.newsRepo.getGentleNewsByIncident(actor.familyId, incidentId);
  if (gentleNews && gentleNews.status !== "closed") {
    await deps.newsRepo.updateGentleNewsCas(
      actor.familyId,
      incidentId,
      gentleNews.version,
      { status: "closed" },
      nowIso,
    );
  }

  await ingestAndAppendTimeline(deps, {
    familyId: actor.familyId,
    source: "core2.news",
    providerEventId: `closed:${incidentId}`,
    eventType: "core2.incident.closed_after_report",
    entityId: incidentId,
    humanLine: "Incident closed cleanly; redacted G9 after-report built from signed timeline.",
    payload: { incident_id: incidentId, closed_by_person_id: actor.personId, state: closedIncident.state },
  });

  const initialReport = await buildRedactedAfterReport(deps, {
    familyId: actor.familyId,
    incidentId,
    closedAt: nowIso,
    zapierStatus: "skipped",
    zapierAttemptedAt: null,
    zapierHttpStatus: null,
  });

  const hookUrl = envOf(deps).ZAPIER_HOOK_Z3?.trim();
  let zapStatus: ZapierZ3Status = "skipped";
  let zapAttemptedAt: string | null = null;
  let zapHttpStatus: number | null = null;

  if (hookUrl) {
    zapAttemptedAt = nowIso;
    const z3Payload: ZapierZ3Payload = sanitizeReportValue({
      schema: "sahaj.zapier.z3.v1",
      event: "core2.after_report.closed",
      family_id: actor.familyId,
      incident_id: incidentId,
      closed_at: nowIso,
      summary_line: 'Incident closed; family report available in Sahaj.',
      accepted_by_name: null,
      accepted_at: initialReport.timings.accepted_at,
      deliveries_count: initialReport.deliveries.length,
      heard_count: initialReport.deliveries.filter((d) => d.heard).length,
      resolution_duration_s: initialReport.timings.resolution_duration_s,
      report: null,
    });
    try {
      const attemptId = uuidOf(deps);
      await deps.core2.timeline.append({ familyId: actor.familyId, eventId: attemptId,
        entityId: incidentId, eventType: 'zapier.attempt', dedupeKey: `zapier:z3:${attemptId}`,
        occurredAt: nowIso, humanLine: 'Redacted Zapier Z3 webhook attempt recorded.',
        payload: { hook: 'Z3', incident_id: incidentId } });
      const dispatcher = deps.zapier ?? createDefaultZapierDispatcher();
      const result = await dispatcher.postZ3(hookUrl, z3Payload, ZAPIER_TIMEOUT_MS);
      zapStatus = result.ok ? 'sent' : 'failed';
      zapHttpStatus = result.status;
    } catch {
      zapStatus = 'failed';
    }
  }

  const finalReport: AfterReportDto = sanitizeReportValue({
    ...initialReport,
    zapier_z3: {
      status: zapStatus,
      attempted_at: zapAttemptedAt,
      http_status: zapHttpStatus,
    },
  });

  const saved = await deps.newsRepo.saveAfterReport({
    familyId: actor.familyId,
    incidentId,
    closedAt: nowIso,
    reportJson: finalReport,
    zapierStatus: zapStatus,
    zapierAttemptedAt: zapAttemptedAt,
    zapierHttpStatus: zapHttpStatus,
    nowIso,
  });
  return saved.report_json;
}

export async function getAfterReport(
  deps: Core2NewsDeps,
  authCtx: AuthRequestContext,
  rawIncidentId: string,
): Promise<AfterReportDto> {
  const actor = await authenticateCore2Actor(
    deps.core2.auth,
    deps.core2.repo,
    authCtx.bearerToken,
    authCtx.familyIdHeader,
  );
  if (actor.role !== "child") {
    throw new Core2Error("forbidden", 403, "Only child can view after-report");
  }
  const incidentId = assertValidUuid(rawIncidentId, "incident_id");
  const existing = await deps.newsRepo.getAfterReport(actor.familyId, incidentId);
  if (existing) {
    return existing.report_json;
  }
  const incident = await deps.newsRepo.getIncident(actor.familyId, incidentId);
  if (!incident) {
    throw new Core2Error("not_found", 404, "Incident not found");
  }
  const closedAt = incident.state === "closed" ? nowOf(deps).toISOString() : nowOf(deps).toISOString();
  return buildRedactedAfterReport(deps, {
    familyId: actor.familyId,
    incidentId,
    closedAt,
    zapierStatus: "skipped",
    zapierAttemptedAt: null,
    zapierHttpStatus: null,
  });
}

function parseHeardMessageKind(value: unknown): HeardMessageKind {
  if (
    value === "core2_reassurance" ||
    value === "core1_voice_post" ||
    value === "gentle_news_voice"
  ) {
    return value;
  }
  throw new Core2Error("invalid_request", 400, "Invalid message_kind");
}

export async function recordDeviceHeardAck(
  deps: Core2NewsDeps,
  request: Request,
  rawBodyBytes: Uint8Array,
): Promise<{
  ok: true;
  receipt_id: string;
  heard_at: string;
  badge_label: string;
  already_recorded: boolean;
}> {
  const env = envOf(deps);
  let deviceIdentity: { deviceId: string; familyId: string; personId: string; displayName: string };
  try {
    deviceIdentity = await verifyMaaDeviceRequest(request, rawBodyBytes, {
      repo: deps.maaRepo,
      pairingSecret: env.SHIELD_DEVICE_PAIRING_SECRET,
      now: () => nowOf(deps),
      replayGuard: deps.replayGuard,
    });
  } catch (err) {
    throw mapDeviceAuthError(err);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBodyBytes));
  } catch {
    throw new Core2Error("invalid_request", 400, "Malformed JSON body");
  }

  const body = assertPlainObject(parsed, [
    "message_kind",
    "delivery_id",
    "reassurance_id",
    "voice_post_id",
    "clip_duration_s",
    "played_duration_s",
    "playback_finished",
    "finished_at",
  ]);
  const messageKind = parseHeardMessageKind(body.message_kind);
  const deliveryId = assertValidUuid(body.delivery_id, "delivery_id");
  const reassuranceId =
    assertOptionalUuid(body.reassurance_id ?? undefined, "reassurance_id") ??
    (messageKind === "core2_reassurance" ? deliveryId : null);
  const voicePostId =
    assertOptionalUuid(body.voice_post_id ?? undefined, "voice_post_id") ??
    (messageKind === "core1_voice_post" ? deliveryId : null);
  const clipDurationS = assertBoundedInt(body.clip_duration_s, "clip_duration_s", 1, 3600);
  const playedDurationS = assertBoundedInt(body.played_duration_s, "played_duration_s", 0, 7200);
  const playbackFinished = assertBoolean(body.playback_finished, "playback_finished");

  if (!playbackFinished || playedDurationS < clipDurationS) {
    throw new Core2Error(
      "invalid_request",
      400,
      "Message only counts as heard after full playback completion",
    );
  }

  if (reassuranceId) {
    const r = await deps.newsRepo.findReassurance(deviceIdentity.familyId, reassuranceId);
    if (!r || r.recipient_person_id !== deviceIdentity.personId) {
      throw new Core2Error("forbidden", 403, "Reassurance target does not match Maa device");
    }
  }
  if (voicePostId) {
    const vp = await deps.newsRepo.getVoicePost(deviceIdentity.familyId, voicePostId);
    if (!vp || vp.recipient_id !== deviceIdentity.personId) {
      throw new Core2Error("forbidden", 403, "Voice post target does not match Maa device");
    }
  }

  const nowIso = nowOf(deps).toISOString();
  const heardAt =
    typeof body.finished_at === "string" && !Number.isNaN(Date.parse(body.finished_at))
      ? new Date(body.finished_at).toISOString()
      : nowIso;

  const { rawEventId } = await ingestAndAppendTimeline(deps, {
    familyId: deviceIdentity.familyId,
    source: "core2.heard.device",
    providerEventId: `device:${deviceIdentity.deviceId}:${messageKind}:${deliveryId}`,
    eventType: "core2.heard.verified",
    entityId: deliveryId,
    humanLine: "Maa finished listening to the voice reassurance on her phone.",
    payload: {
      message_kind: messageKind,
      delivery_id: deliveryId,
      device_id: deviceIdentity.deviceId,
      evidence_type: "device_signed_playback_end",
      clip_duration_s: clipDurationS,
      played_duration_s: playedDurationS,
    },
  });

  const { receipt, alreadyRecorded } = await deps.newsRepo.recordHeardReceipt({
    familyId: deviceIdentity.familyId,
    messageKind,
    deliveryId,
    reassuranceId,
    voicePostId,
    outboxId: null,
    recipientPersonId: deviceIdentity.personId,
    channel: "smartphone_app",
    evidenceType: "device_signed_playback_end",
    deviceId: deviceIdentity.deviceId,
    callSid: null,
    clipDurationS,
    playedDurationS,
    dtmfDigit: null,
    rawEventId,
    heardAt,
  });

  const recipient = await deps.newsRepo.getPerson(deviceIdentity.familyId, deviceIdentity.personId);
  return {
    ok: true,
    receipt_id: receipt.id,
    heard_at: receipt.heard_at,
    badge_label: formatHeardBadge(receipt.heard_at, recipient?.timezone ?? "Asia/Kolkata"),
    already_recorded: alreadyRecorded,
  };
}

function buildTwilioVerificationUrl(
  request: Request,
  env: Record<string, string | undefined>,
  explicitBaseUrl?: string,
): string {
  const incoming = new URL(request.url);
  const base = explicitBaseUrl ?? env.TWILIO_WEBHOOK_BASE_URL;
  if (!base) {
    return incoming.toString();
  }
  const normalizedBase = base.replace(/\/+$/, "");
  return `${normalizedBase}${incoming.pathname}${incoming.search}`;
}

function assertTwilioSignatureValid(
  deps: Core2NewsDeps,
  request: Request,
  params: URLSearchParams,
): void {
  const env = envOf(deps);
  const authToken = env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    throw new Core2Error("unavailable", 503, "TWILIO_AUTH_TOKEN is not configured");
  }
  const sig = request.headers.get("x-twilio-signature");
  const publicUrl = buildTwilioVerificationUrl(request, env, deps.twilioPublicBaseUrl);
  if (!verifyTwilioFormSignature(publicUrl, params, sig, authToken)) {
    throw new Core2Error("unauthenticated", 401, "Invalid Twilio signature");
  }
}

async function resolveTwilioTarget(
  deps: Core2NewsDeps,
  requestUrl: URL,
  params: URLSearchParams,
  callSid: string,
): Promise<TwilioOutboxLookup | null> {
  const hintFamilyId =
    params.get("family_id") ?? requestUrl.searchParams.get("family_id") ?? undefined;
  const lookedUp = await deps.newsRepo.resolveTwilioCallContext(callSid, hintFamilyId);
  if (lookedUp) return lookedUp;

  const familyId = params.get("family_id") ?? requestUrl.searchParams.get("family_id");
  const deliveryId = params.get("delivery_id") ?? requestUrl.searchParams.get("delivery_id");
  const rawKind = params.get("message_kind") ?? requestUrl.searchParams.get("message_kind");
  const recipientPersonId =
    params.get("recipient_person_id") ?? requestUrl.searchParams.get("recipient_person_id");
  if (!familyId || !deliveryId || !rawKind || !recipientPersonId) {
    return null;
  }
  const clipStr = params.get("clip_duration_s") ?? requestUrl.searchParams.get("clip_duration_s");
  const clipDuration = clipStr ? Number.parseInt(clipStr, 10) : null;
  return {
    family_id: assertValidUuid(familyId, "family_id"),
    outbox_id:
      assertOptionalUuid(
        params.get("outbox_id") ?? requestUrl.searchParams.get("outbox_id") ?? undefined,
        "outbox_id",
      ) ?? null,
    message_kind: parseHeardMessageKind(rawKind),
    delivery_id: assertValidUuid(deliveryId, "delivery_id"),
    reassurance_id:
      assertOptionalUuid(
        params.get("reassurance_id") ?? requestUrl.searchParams.get("reassurance_id") ?? undefined,
        "reassurance_id",
      ) ?? null,
    voice_post_id:
      assertOptionalUuid(
        params.get("voice_post_id") ?? requestUrl.searchParams.get("voice_post_id") ?? undefined,
        "voice_post_id",
      ) ?? null,
    recipient_person_id: assertValidUuid(recipientPersonId, "recipient_person_id"),
    clip_duration_s: Number.isFinite(clipDuration) ? clipDuration : null,
  };
}

export async function handleTwilioHeardGather(
  deps: Core2NewsDeps,
  request: Request,
  rawFormBody: string,
): Promise<{
  ok: true;
  heard: boolean;
  receipt_id: string | null;
  heard_at: string | null;
  evidence_type: HeardEvidenceType | null;
  badge_label: string;
  twiml: string;
}> {
  const params = new URLSearchParams(rawFormBody);
  assertTwilioSignatureValid(deps, request, params);

  const callSid = assertSafeString(params.get("CallSid"), "CallSid", 2, 128);
  const digits = params.get("Digits")?.trim() ?? "";
  const playbackCompleted =
    (params.get("playback_completed") ??
      new URL(request.url).searchParams.get("playback_completed") ??
      "").toLowerCase() === "true";

  if (!playbackCompleted || !/^[0-9*#]{1,4}$/.test(digits)) {
    return {
      ok: true,
      heard: false,
      receipt_id: null,
      heard_at: null,
      evidence_type: null,
      badge_label: BADGE_UNCONFIRMED_HI,
      twiml:
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say language="hi-IN">Koi baat nahi Maa, dhanyavaad.</Say><Hangup/></Response>',
    };
  }

  const target = await resolveTwilioTarget(deps, new URL(request.url), params, callSid);
  if (!target) {
    throw new Core2Error("not_found", 404, "Unknown Twilio call delivery mapping");
  }

  const clipParam =
    params.get("clip_duration_s") ?? new URL(request.url).searchParams.get("clip_duration_s");
  const clipDurationS = Math.max(
    1,
    target.clip_duration_s ?? (clipParam ? Number.parseInt(clipParam, 10) : 10),
  );
  const nowIso = nowOf(deps).toISOString();

  const { rawEventId } = await ingestAndAppendTimeline(deps, {
    familyId: target.family_id,
    source: "twilio.gather",
    providerEventId: `twilio:gather:${callSid}:${target.delivery_id}`,
    eventType: "core2.heard.verified",
    entityId: target.delivery_id,
    humanLine: "Maa finished listening to the keypad call and pressed confirmation key.",
    payload: {
      message_kind: target.message_kind,
      delivery_id: target.delivery_id,
      call_sid: callSid,
      evidence_type: "twilio_gather_after_playback",
    },
  });

  const { receipt } = await deps.newsRepo.recordHeardReceipt({
    familyId: target.family_id,
    messageKind: target.message_kind,
    deliveryId: target.delivery_id,
    reassuranceId: target.reassurance_id,
    voicePostId: target.voice_post_id,
    outboxId: target.outbox_id,
    recipientPersonId: target.recipient_person_id,
    channel: "keypad_twilio",
    evidenceType: "twilio_gather_after_playback",
    deviceId: null,
    callSid,
    clipDurationS,
    playedDurationS: clipDurationS,
    dtmfDigit: digits,
    rawEventId,
    heardAt: nowIso,
  });

  const recipient = await deps.newsRepo.getPerson(target.family_id, target.recipient_person_id);
  return {
    ok: true,
    heard: true,
    receipt_id: receipt.id,
    heard_at: receipt.heard_at,
    evidence_type: "twilio_gather_after_playback",
    badge_label: formatHeardBadge(receipt.heard_at, recipient?.timezone ?? "Asia/Kolkata"),
    twiml:
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say language="hi-IN">Dhanyavaad Maa, humne parivar ko bata diya hai ki aapne sun liya.</Say><Hangup/></Response>',
  };
}

export async function handleTwilioHeardStatus(
  deps: Core2NewsDeps,
  request: Request,
  rawFormBody: string,
): Promise<{
  ok: true;
  heard: boolean;
  receipt_id: string | null;
  heard_at: string | null;
  evidence_type: HeardEvidenceType | null;
  badge_label: string;
}> {
  const params = new URLSearchParams(rawFormBody);
  assertTwilioSignatureValid(deps, request, params);

  const callSid = assertSafeString(params.get("CallSid"), "CallSid", 2, 128);
  const callStatus = (params.get("CallStatus") ?? "").trim().toLowerCase();
  const durationRaw = params.get("CallDuration");
  const durationS = durationRaw !== null ? Number.parseInt(durationRaw, 10) : Number.NaN;

  const target = await resolveTwilioTarget(deps, new URL(request.url), params, callSid);
  if (!target) {
    return {
      ok: true,
      heard: false,
      receipt_id: null,
      heard_at: null,
      evidence_type: null,
      badge_label: BADGE_UNCONFIRMED_HI,
    };
  }

  const clipParam =
    params.get("clip_duration_s") ?? new URL(request.url).searchParams.get("clip_duration_s");
  const clipDurationS = Math.max(
    1,
    target.clip_duration_s ?? (clipParam ? Number.parseInt(clipParam, 10) : 10),
  );

  if (callStatus !== "completed" || !Number.isFinite(durationS) || durationS < clipDurationS) {
    return {
      ok: true,
      heard: false,
      receipt_id: null,
      heard_at: null,
      evidence_type: null,
      badge_label: BADGE_UNCONFIRMED_HI,
    };
  }

  const nowIso = nowOf(deps).toISOString();
  const { rawEventId } = await ingestAndAppendTimeline(deps, {
    familyId: target.family_id,
    source: "twilio.status",
    providerEventId: `twilio:status:${callSid}:${target.delivery_id}`,
    eventType: "core2.heard.verified",
    entityId: target.delivery_id,
    humanLine: "Maa stayed on the keypad call for the full recording duration.",
    payload: {
      message_kind: target.message_kind,
      delivery_id: target.delivery_id,
      call_sid: callSid,
      evidence_type: "twilio_status_duration_gte_clip",
      clip_duration_s: clipDurationS,
      call_duration_s: durationS,
    },
  });

  const { receipt } = await deps.newsRepo.recordHeardReceipt({
    familyId: target.family_id,
    messageKind: target.message_kind,
    deliveryId: target.delivery_id,
    reassuranceId: target.reassurance_id,
    voicePostId: target.voice_post_id,
    outboxId: target.outbox_id,
    recipientPersonId: target.recipient_person_id,
    channel: "keypad_twilio",
    evidenceType: "twilio_status_duration_gte_clip",
    deviceId: null,
    callSid,
    clipDurationS,
    playedDurationS: durationS,
    dtmfDigit: null,
    rawEventId,
    heardAt: nowIso,
  });

  const recipient = await deps.newsRepo.getPerson(target.family_id, target.recipient_person_id);
  return {
    ok: true,
    heard: true,
    receipt_id: receipt.id,
    heard_at: receipt.heard_at,
    evidence_type: "twilio_status_duration_gte_clip",
    badge_label: formatHeardBadge(receipt.heard_at, recipient?.timezone ?? "Asia/Kolkata"),
  };
}

export async function getHeardStatus(
  deps: Core2NewsDeps,
  authCtx: AuthRequestContext,
  query: { deliveryId: string; messageKind?: string | null },
): Promise<HeardStatusDto> {
  const actor = await authenticateCore2Actor(
    deps.core2.auth,
    deps.core2.repo,
    authCtx.bearerToken,
    authCtx.familyIdHeader,
  );
  const deliveryId = assertValidUuid(query.deliveryId, "delivery_id");
  const messageKind = query.messageKind
    ? parseHeardMessageKind(query.messageKind)
    : undefined;

  const receipt = await deps.newsRepo.getHeardReceiptByDelivery(
    actor.familyId,
    deliveryId,
    messageKind,
  );
  if (!receipt) {
    return {
      delivery_id: deliveryId,
      message_kind: messageKind ?? "core2_reassurance",
      heard_verified: false,
      heard_at: null,
      channel: null,
      evidence_type: null,
      badge_label: BADGE_UNCONFIRMED_HI,
    };
  }
  if (actor.role === "parent" && receipt.recipient_person_id !== actor.personId) {
    throw new Core2Error("forbidden", 403, "Forbidden");
  }
  const recipient = await deps.newsRepo.getPerson(actor.familyId, receipt.recipient_person_id);
  return {
    delivery_id: receipt.delivery_id,
    message_kind: receipt.message_kind,
    heard_verified: true,
    heard_at: receipt.heard_at,
    channel: receipt.channel,
    evidence_type: receipt.evidence_type,
    badge_label: formatHeardBadge(receipt.heard_at, recipient?.timezone ?? "Asia/Kolkata"),
  };
}
