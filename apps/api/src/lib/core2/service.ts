import { randomUUID } from "node:crypto";
import { consentIsCurrent } from "@/lib/media/consent";
import {
  Core2Error,
  type Core2Actor,
  type Core2ConsentRecord,
  type Core2Deps,
  type PublicReassuranceDto,
  type PublicSharingPreferencesDto,
  type PublicSosDto,
  type PublicTrustedContactDto,
  type PublicWatchDto,
  type ReassuranceKind,
  type ReassuranceRow,
  type SharingPreferencesRow,
  type SosRow,
  type TrustedContactRow,
  type TrustedContactScope,
  type WatchRow,
} from "./contracts";
import {
  assertBoolean,
  assertBoundedInt,
  assertIanaTimezone,
  assertIsoTimestamp,
  assertOptionalUuid,
  assertPaginationLimit,
  assertPlainObject,
  assertSafeString,
  assertValidUuid,
  authenticateCore2Actor,
  hashCanonicalRequest,
  parseIdempotencyKey,
  sha256Hex,
} from "./security";

const VALID_SCOPES: readonly TrustedContactScope[] = ["sos", "watch_escalation", "reassurance"];
const WATCH_EXTEND_MAX_MINUTES = 120;

function toPublicWatch(row: WatchRow): PublicWatchDto {
  return {
    id: row.id,
    family_id: row.familyId,
    subject_person_id: row.subjectPersonId,
    incident_id: row.incidentId,
    request_id: row.requestId,
    timezone: row.timezone,
    state: row.state,
    version: row.version,
    grace_minutes: row.graceMinutes,
    deadline_at: row.deadlineAt,
    grace_until: row.graceUntil,
    checked_in_at: row.checkedInAt,
    escalated_at: row.escalatedAt,
    safe_at: row.safeAt,
    cancelled_at: row.cancelledAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function toPublicSos(row: SosRow): PublicSosDto {
  return {
    id: row.id,
    family_id: row.familyId,
    subject_person_id: row.subjectPersonId,
    incident_id: row.incidentId,
    request_id: row.requestId,
    status: row.status,
    delivery_status: row.deliveryStatus,
    responder_accepted: row.responderAccepted,
    version: row.version,
    countdown_until: row.countdownUntil,
    cancelled_at: row.cancelledAt,
    safe_at: row.safeAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function toPublicContact(row: TrustedContactRow): PublicTrustedContactDto {
  return {
    id: row.id,
    family_id: row.familyId,
    subject_person_id: row.subjectPersonId,
    contact_person_id: row.contactPersonId,
    display_name: row.contactDisplayName ?? null,
    rank: row.rank,
    scopes: row.scopes,
    state: row.state,
    effective_from: row.effectiveFrom,
    effective_until: row.effectiveUntil,
    revoked_at: row.revokedAt,
    version: row.version,
    created_at: row.createdAt,
  };
}

function toPublicPreferences(row: SharingPreferencesRow): PublicSharingPreferencesDto {
  return {
    family_id: row.familyId,
    subject_person_id: row.subjectPersonId,
    share_status_with_parent: row.shareStatusWithParent,
    allow_location_share: row.allowLocationShare,
    allow_health_share: row.allowHealthShare,
    allow_narrative_share: row.allowNarrativeShare,
    version: row.version,
    updated_at: row.updatedAt,
  };
}

function toPublicReassurance(
  row: ReassuranceRow,
  prefs: SharingPreferencesRow,
): PublicReassuranceDto {
  // Enforce current preferences at read time; never retro-expand or leak private flags.
  return {
    id: row.id,
    family_id: row.familyId,
    subject_person_id: row.subjectPersonId,
    recipient_person_id: row.recipientPersonId,
    kind: row.kind,
    watch_id: row.watchId,
    sos_id: row.sosId,
    status: row.deliveryStatus,
    delivery_verified: row.deliveryVerified,
    heard_verified: row.heardVerified,
    facts_exposed: {
      status_label: row.statusLabel,
      location_included: row.locationShared && prefs.allowLocationShare,
      health_included: row.healthShared && prefs.allowHealthShare,
      narrative_included: row.narrativeShared && prefs.allowNarrativeShare,
    },
    created_at: row.createdAt,
  };
}

function parseScopes(raw: unknown): TrustedContactScope[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > VALID_SCOPES.length) {
    throw new Core2Error("invalid_request", 400, "scopes must be a non-empty array of valid contact scopes.");
  }
  const seen = new Set<TrustedContactScope>();
  for (const item of raw) {
    if (typeof item !== "string" || !VALID_SCOPES.includes(item as TrustedContactScope)) {
      throw new Core2Error("invalid_request", 400, `Invalid trusted contact scope "${String(item)}".`);
    }
    seen.add(item as TrustedContactScope);
  }
  return [...seen].sort();
}

function deterministicStatusLabel(kind: ReassuranceKind, watch: WatchRow | null, sos: SosRow | null): string {
  if (kind === "reached_home" || watch?.state === "safe") return "reached_home_safe";
  if (kind === "im_safe" || sos?.status === "safe") return "checked_in_safe";
  if (sos) {
    return sos.responderAccepted ? "help_confirmed" : "help_requested_pending";
  }
  if (watch) {
    if (watch.state === "escalated") return "late_home_escalated_pending";
    if (watch.state === "checking_in") return "late_home_checking_in";
    return "watch_active";
  }
  return "reassurance_update";
}

function checkVoiceShareConsent(
  linked: Core2ConsentRecord | null,
  history: Core2ConsentRecord[],
  familyId: string,
  personId: string,
  recipientId: string,
  now: Date,
): boolean {
  return consentIsCurrent({
    linked,
    history,
    familyId,
    personId,
    purpose: `voice_share:${recipientId}`,
    now,
  });
}

export function createCore2Service(deps: Core2Deps) {
  const getNow = deps.now ?? (() => new Date());
  const nextUuid = deps.uuid ?? (() => randomUUID());

  async function requireActor(auth: { bearerToken: string | null; familyIdHeader: string | null }): Promise<Core2Actor> {
    return authenticateCore2Actor(deps.auth, deps.repo, auth.bearerToken, auth.familyIdHeader);
  }

  async function runIdempotent<T extends Record<string, unknown>>(
    actor: Core2Actor,
    action: string,
    rawIdempotencyKey: string | null,
    canonicalInput: unknown,
    work: (keyHash: string) => Promise<{ status: number; body: T }>,
  ): Promise<{ status: number; body: T & { idempotent_replay?: boolean } }> {
    const key = parseIdempotencyKey(rawIdempotencyKey);
    const keyHash = sha256Hex(key);
    const requestHash = hashCanonicalRequest(canonicalInput);

    const existing = await deps.repo.getIdempotency(actor.familyId, actor.personId, action, keyHash);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new Core2Error(
          "idempotency_conflict",
          409,
          "Idempotency-Key reused with different request parameters.",
        );
      }
      return {
        status: existing.responseStatus,
        body: { ...(existing.responseBody as T), idempotent_replay: true },
      };
    }

    const result = await work(keyHash);
    await deps.repo.saveIdempotency({
      familyId: actor.familyId,
      actorPersonId: actor.personId,
      action,
      keyHash,
      requestHash,
      responseStatus: result.status,
      responseBody: result.body,
    });
    return { status: result.status, body: { ...result.body, idempotent_replay: false } };
  }

  async function ingestEncryptedEvent(input: {
    familyId: string;
    actorPersonId: string;
    eventType: string;
    providerEventId: string;
    payload: Record<string, unknown>;
  }): Promise<string> {
    try {
      const { payloadHash, payloadCiphertext } = deps.crypto.encryptPayload(
        input.familyId,
        input.providerEventId,
        "core2",
        input.payload,
      );
      const { rawEventId } = await deps.repo.ingestRawEvent({
        source: "core2",
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        familyId: input.familyId,
        metadata: { actor_person_id: input.actorPersonId },
        payloadHash,
        payloadCiphertext,
      });
      return rawEventId;
    } catch (err) {
      if (err instanceof Core2Error) throw err;
      throw new Core2Error("storage_unavailable", 503, "Failed to persist encrypted Core 2 input.");
    }
  }

  async function appendTimeline(input: {
    familyId: string;
    dedupeKey: string;
    eventType: string;
    entityId: string | null;
    humanLine: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await deps.timeline.append({
      familyId: input.familyId,
      eventId: nextUuid(),
      dedupeKey: input.dedupeKey,
      eventType: input.eventType,
      entityId: input.entityId,
      humanLine: input.humanLine,
      occurredAt: getNow().toISOString(),
      payload: input.payload,
    });
  }

  async function authorizeAndDispatch(input: {
    familyId: string;
    actorPersonId: string;
    requestId: string;
    action: "urgent_responder" | "check_in" | "voice_message" | "share_data";
    targetPersonId: string;
    consentSubjectId?: string;
    outboxKind: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
    trustedContactId?: string | null;
    watchId?: string | null;
    sosId?: string | null;
  }): Promise<{ decision: "allow" | "ask" | "deny"; outboxId: string | null }> {
    const nowIso = getNow().toISOString();
    const gateInput = await deps.repo.loadGateInput({
      familyId: input.familyId,
      actorPersonId: input.actorPersonId,
      requestId: input.requestId,
      action: input.action,
      targetId: input.targetPersonId,
      consentSubjectId: input.consentSubjectId,
      now: nowIso,
    });
    const decision = await deps.gate.evaluate(gateInput);
    if (decision.decision !== "allow") {
      return { decision: decision.decision, outboxId: null };
    }
    const { payloadCiphertext } = deps.crypto.encryptPayload(
      input.familyId,
      input.dedupeKey,
      "core2-outbox",
      input.payload,
    );
    const outbox = await deps.dispatch.enqueueAuthorized({
      familyId: input.familyId,
      actionRequestId: null,
      kind: input.outboxKind,
      dedupeKey: input.dedupeKey,
      payloadCiphertext,
      trustedContactId: input.trustedContactId ?? null,
      watchId: input.watchId ?? null,
      sosId: input.sosId ?? null,
    });
    return { decision: "allow", outboxId: outbox.outboxId };
  }

  function assertSubjectAccess(actor: Core2Actor, subjectPersonId: string, actionLabel: string): void {
    if (actor.personId !== subjectPersonId) {
      throw new Core2Error("forbidden", 403, `Only the subject may ${actionLabel}.`);
    }
  }

  return {
    // ------------------------------------------------------------------
    // Task 1: SOS
    // ------------------------------------------------------------------
    async triggerSos(
      auth: { bearerToken: string | null; familyIdHeader: string | null; idempotencyKeyHeader: string | null },
      rawBody: unknown,
    ) {
      const actor = await requireActor(auth);
      const body = assertPlainObject(rawBody, [
        "subject_person_id",
        "countdown_seconds",
        "note",
        "client_triggered_at",
      ]);

      const subjectPersonId =
        assertOptionalUuid(body.subject_person_id, "subject_person_id") ?? actor.personId;
      assertSubjectAccess(actor, subjectPersonId, "trigger SOS");

      if (actor.role !== "child") {
        throw new Core2Error("forbidden", 403, "SOS creation requires child membership role.");
      }

      const countdownSeconds =
        body.countdown_seconds === undefined
          ? 0
          : assertBoundedInt(body.countdown_seconds, "countdown_seconds", 0, 60);
      const note = body.note === undefined ? undefined : assertSafeString(body.note, "note", 1, 240);
      const clientTriggeredAt =
        body.client_triggered_at === undefined
          ? undefined
          : assertIsoTimestamp(body.client_triggered_at, "client_triggered_at");

      return runIdempotent(
        actor,
        "core2.sos.create",
        auth.idempotencyKeyHeader,
        { subjectPersonId, countdownSeconds, note: note ?? null, clientTriggeredAt: clientTriggeredAt ?? null },
        async (keyHash) => {
          const now = getNow();
          const nowIso = now.toISOString();
          const rawEventId = await ingestEncryptedEvent({
            familyId: actor.familyId,
            actorPersonId: actor.personId,
            eventType: "core2.sos.triggered",
            providerEventId: `sos:${actor.familyId}:${keyHash}`,
            payload: {
              subject_person_id: subjectPersonId,
              countdown_seconds: countdownSeconds,
              note: note ?? null,
              client_triggered_at: clientTriggeredAt ?? nowIso,
            },
          });

          const { requestId, incidentId } = await deps.repo.createRequestAndIncident({
            familyId: actor.familyId,
            personId: subjectPersonId,
            requestKind: "sos",
            severity: "critical",
            incidentState: "open",
          });

          const contacts = await deps.repo.listActiveTrustedContacts(
            actor.familyId,
            subjectPersonId,
            "sos",
            nowIso,
          );

          const countdownUntil =
            countdownSeconds > 0 ? new Date(now.getTime() + countdownSeconds * 1000).toISOString() : null;

          let status: SosRow["status"] = "pending_contacts";
          let deliveryStatus: SosRow["deliveryStatus"] = "none";

          if (countdownUntil) {
            status = "countdown";
          } else if (contacts.length === 0) {
            status = "pending_contacts";
          }

          const sos = await deps.repo.createSosEvent({
            familyId: actor.familyId,
            subjectPersonId,
            incidentId,
            requestId,
            rawEventId,
            status,
            deliveryStatus,
            countdownUntil,
          });

          const dispatches: Array<{
            assignment_id: string;
            contact_person_id: string;
            rank: number;
            status: "queued" | "awaiting_approval" | "denied";
          }> = [];

          if (!countdownUntil && contacts.length > 0) {
            let queuedCount = 0;
            let askCount = 0;

            for (const contact of contacts) {
              const gateRes = await authorizeAndDispatch({
                familyId: actor.familyId,
                actorPersonId: actor.personId,
                requestId,
                action: "urgent_responder",
                targetPersonId: contact.contactPersonId,
                outboxKind: "core2.sos_alert",
                dedupeKey: `core2:sos:${sos.id}:${contact.id}`,
                payload: {
                  kind: "core2.sos_alert",
                  sos_id: sos.id,
                  incident_id: incidentId,
                  subject_person_id: subjectPersonId,
                  contact_person_id: contact.contactPersonId,
                  rank: contact.rank,
                },
                trustedContactId: contact.id,
                sosId: sos.id,
              });

              const assignment = await deps.repo.createAssignment({
                familyId: actor.familyId,
                incidentId,
                personId: contact.contactPersonId,
                expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
              });

              if (gateRes.decision === "allow") {
                queuedCount += 1;
                dispatches.push({
                  assignment_id: assignment.assignmentId,
                  contact_person_id: contact.contactPersonId,
                  rank: contact.rank,
                  status: "queued",
                });
              } else if (gateRes.decision === "ask") {
                askCount += 1;
                dispatches.push({
                  assignment_id: assignment.assignmentId,
                  contact_person_id: contact.contactPersonId,
                  rank: contact.rank,
                  status: "awaiting_approval",
                });
              } else {
                dispatches.push({
                  assignment_id: assignment.assignmentId,
                  contact_person_id: contact.contactPersonId,
                  rank: contact.rank,
                  status: "denied",
                });
              }
            }

            if (queuedCount > 0) {
              status = "queued";
              deliveryStatus = "queued";
            } else if (askCount > 0) {
              status = "awaiting_approval";
            } else {
              status = "denied";
            }

            const updated = await deps.repo.updateSosStatus({
              familyId: actor.familyId,
              sosId: sos.id,
              status,
              deliveryStatus,
            });
            await appendTimeline({
              familyId: actor.familyId,
              dedupeKey: `core2:sos:trigger:${sos.id}`,
              eventType: "core2.sos.triggered",
              entityId: sos.id,
              humanLine: `SOS requested (${status}).`,
              payload: { sos_id: sos.id, status, contacts_count: dispatches.length },
            });

            return {
              status: 202,
              body: {
                sos: toPublicSos(updated),
                contacts_notified_count: queuedCount,
                dispatches,
              },
            };
          }

          await appendTimeline({
            familyId: actor.familyId,
            dedupeKey: `core2:sos:trigger:${sos.id}`,
            eventType: "core2.sos.triggered",
            entityId: sos.id,
            humanLine: `SOS requested (${status}).`,
            payload: { sos_id: sos.id, status, contacts_count: 0 },
          });

          return {
            status: 202,
            body: {
              sos: toPublicSos(sos),
              contacts_notified_count: 0,
              dispatches,
            },
          };
        },
      );
    },

    async cancelSos(
      auth: { bearerToken: string | null; familyIdHeader: string | null; idempotencyKeyHeader: string | null },
      sosIdRaw: string,
      rawBody: unknown,
    ) {
      const actor = await requireActor(auth);
      const sosId = assertValidUuid(sosIdRaw, "sosId");
      const body = assertPlainObject(rawBody, ["reason", "expected_version"]);
      const reason =
        body.reason === undefined
          ? "false_alarm"
          : assertSafeString(body.reason, "reason", 1, 32);
      if (reason !== "false_alarm" && reason !== "im_safe") {
        throw new Core2Error("invalid_request", 400, "reason must be false_alarm or im_safe.");
      }
      const expectedVersion =
        body.expected_version === undefined
          ? undefined
          : assertBoundedInt(body.expected_version, "expected_version", 1, 1_000_000);

      return runIdempotent(
        actor,
        `core2.sos.cancel:${sosId}`,
        auth.idempotencyKeyHeader,
        { sosId, reason, expectedVersion: expectedVersion ?? null },
        async () => {
          const existing = await deps.repo.getSosEvent(actor.familyId, sosId);
          if (!existing) throw new Core2Error("not_found", 404, "SOS event not found.");
          assertSubjectAccess(actor, existing.subjectPersonId, "cancel or close SOS");

          if (existing.status === "cancelled" || existing.status === "safe") {
            return { status: 200, body: { sos: toPublicSos(existing) } };
          }
          if (expectedVersion !== undefined && existing.version !== expectedVersion) {
            throw new Core2Error("stale_version", 409, "SOS version mismatch.");
          }

          const nowIso = getNow().toISOString();
          const nextStatus: SosRow["status"] =
            existing.status === "countdown" && reason === "false_alarm" ? "cancelled" : "safe";

          await deps.repo.fencePendingSosDispatches(actor.familyId, sosId, reason);
          const updated = await deps.repo.updateSosStatus({
            familyId: actor.familyId,
            sosId,
            expectedVersion: existing.version,
            status: nextStatus,
            cancelledAt: nextStatus === "cancelled" ? nowIso : existing.cancelledAt,
            safeAt: nextStatus === "safe" ? nowIso : existing.safeAt,
          });

          await appendTimeline({
            familyId: actor.familyId,
            dedupeKey: `core2:sos:${nextStatus}:${sosId}:v${updated.version}`,
            eventType: `core2.sos.${nextStatus}`,
            entityId: sosId,
            humanLine: nextStatus === "cancelled" ? "SOS countdown cancelled." : "SOS marked safe.",
            payload: { sos_id: sosId, status: nextStatus, version: updated.version },
          });

          return { status: 200, body: { sos: toPublicSos(updated) } };
        },
      );
    },

    async listSos(
      auth: { bearerToken: string | null; familyIdHeader: string | null },
      limitRaw: string | null,
    ) {
      const actor = await requireActor(auth);
      const limit = assertPaginationLimit(limitRaw);
      // Same-family isolation: non-subject actors see SOS events ONLY when named an active "sos" trusted contact.
      const all = await deps.repo.listSosEvents(actor.familyId, null, limit);
      const nowIso = getNow().toISOString();
      const visible: PublicSosDto[] = [];
      for (const item of all) {
        if (item.subjectPersonId === actor.personId) {
          visible.push(toPublicSos(item));
          continue;
        }
        const contacts = await deps.repo.listActiveTrustedContacts(
          actor.familyId,
          item.subjectPersonId,
          "sos",
          nowIso,
        );
        if (contacts.some((c) => c.contactPersonId === actor.personId)) {
          visible.push(toPublicSos(item));
        }
      }
      return { items: visible };
    },

    async getSos(
      auth: { bearerToken: string | null; familyIdHeader: string | null },
      sosIdRaw: string,
    ) {
      const actor = await requireActor(auth);
      const sosId = assertValidUuid(sosIdRaw, "sosId");
      const item = await deps.repo.getSosEvent(actor.familyId, sosId);
      if (!item) throw new Core2Error("not_found", 404, "SOS event not found.");
      if (actor.personId !== item.subjectPersonId) {
        const contacts = await deps.repo.listActiveTrustedContacts(
          actor.familyId,
          item.subjectPersonId,
          "sos",
          getNow().toISOString(),
        );
        if (!contacts.some((c) => c.contactPersonId === actor.personId)) {
          throw new Core2Error("forbidden", 403, "Not permitted to view this SOS.");
        }
      }
      return { sos: toPublicSos(item) };
    },

    // ------------------------------------------------------------------
    // Task 2 & 3: Going-Home Watch & Transactional Safe Resolution
    // ------------------------------------------------------------------
    async startWatch(
      auth: { bearerToken: string | null; familyIdHeader: string | null; idempotencyKeyHeader: string | null },
      rawBody: unknown,
    ) {
      const actor = await requireActor(auth);
      if (actor.role !== "child") {
        throw new Core2Error("forbidden", 403, "Going-home watch requires child membership role.");
      }

      const body = assertPlainObject(rawBody, [
        "eta_minutes",
        "grace_minutes",
        "timezone",
        "from_label",
        "to_label",
        "cab_note",
      ]);

      const etaMinutes = assertBoundedInt(body.eta_minutes, "eta_minutes", 1, 240);
      const graceMinutes =
        body.grace_minutes === undefined
          ? 10
          : assertBoundedInt(body.grace_minutes, "grace_minutes", 1, 60);
      const timezone =
        body.timezone === undefined ? "Asia/Kolkata" : assertIanaTimezone(body.timezone, "timezone");
      const fromLabel = assertSafeString(body.from_label, "from_label", 1, 160);
      const toLabel = assertSafeString(body.to_label, "to_label", 1, 160);
      const cabNote =
        body.cab_note === undefined ? undefined : assertSafeString(body.cab_note, "cab_note", 1, 160);

      return runIdempotent(
        actor,
        "core2.watch.start",
        auth.idempotencyKeyHeader,
        { etaMinutes, graceMinutes, timezone, fromLabel, toLabel, cabNote: cabNote ?? null },
        async (keyHash) => {
          const now = getNow();
          const deadline = new Date(now.getTime() + etaMinutes * 60_000);
          const graceUntil = new Date(deadline.getTime() + graceMinutes * 60_000);

          const rawEventId = await ingestEncryptedEvent({
            familyId: actor.familyId,
            actorPersonId: actor.personId,
            eventType: "core2.watch.started",
            providerEventId: `watch:${actor.familyId}:${keyHash}`,
            payload: {
              from_label: fromLabel,
              to_label: toLabel,
              cab_note: cabNote ?? null,
              eta_minutes: etaMinutes,
              grace_minutes: graceMinutes,
              timezone,
            },
          });

          const routeCiphertext = deps.crypto.encryptSecretNote(
            `watch:${actor.familyId}:${keyHash}`,
            { from_label: fromLabel, to_label: toLabel, cab_note: cabNote ?? null },
          );

          const { requestId } = await deps.repo.createRequestAndIncident({
            familyId: actor.familyId,
            personId: actor.personId,
            requestKind: "going_home_watch",
            severity: "routine",
            incidentState: "open",
          });

          const watch = await deps.repo.createWatch({
            familyId: actor.familyId,
            subjectPersonId: actor.personId,
            rawEventId,
            requestId,
            timezone,
            graceMinutes,
            deadlineAt: deadline.toISOString(),
            graceUntil: graceUntil.toISOString(),
            nextTickAt: deadline.toISOString(),
            routeCiphertext,
          });

          await appendTimeline({
            familyId: actor.familyId,
            dedupeKey: `core2:watch:start:${watch.id}`,
            eventType: "core2.watch.started",
            entityId: watch.id,
            humanLine: "Going-home safety watch started.",
            payload: { watch_id: watch.id, eta_minutes: etaMinutes, timezone },
          });

          return { status: 201, body: { watch: toPublicWatch(watch) } };
        },
      );
    },

    async extendWatch(
      auth: { bearerToken: string | null; familyIdHeader: string | null; idempotencyKeyHeader: string | null },
      watchIdRaw: string,
      rawBody: unknown,
    ) {
      const actor = await requireActor(auth);
      const watchId = assertValidUuid(watchIdRaw, "watchId");
      const body = assertPlainObject(rawBody, ["add_minutes", "expected_version"]);
      const addMinutes = assertBoundedInt(body.add_minutes, "add_minutes", 1, WATCH_EXTEND_MAX_MINUTES);
      const expectedVersion = assertBoundedInt(body.expected_version, "expected_version", 1, 1_000_000);

      return runIdempotent(
        actor,
        `core2.watch.extend:${watchId}`,
        auth.idempotencyKeyHeader,
        { watchId, addMinutes, expectedVersion },
        async () => {
          const existing = await deps.repo.getWatch(actor.familyId, watchId);
          if (!existing) throw new Core2Error("not_found", 404, "Watch not found.");
          assertSubjectAccess(actor, existing.subjectPersonId, "extend watch");

          const updated = await deps.repo.extendWatch({
            familyId: actor.familyId,
            watchId,
            subjectPersonId: actor.personId,
            expectedVersion,
            addMinutes,
            nowIso: getNow().toISOString(),
          });

          await appendTimeline({
            familyId: actor.familyId,
            dedupeKey: `core2:watch:extend:${watchId}:v${updated.version}`,
            eventType: "core2.watch.extended",
            entityId: watchId,
            humanLine: `Going-home watch extended (+${addMinutes} min).`,
            payload: { watch_id: watchId, add_minutes: addMinutes, version: updated.version },
          });

          return { status: 200, body: { watch: toPublicWatch(updated) } };
        },
      );
    },

    async cancelWatch(
      auth: { bearerToken: string | null; familyIdHeader: string | null; idempotencyKeyHeader: string | null },
      watchIdRaw: string,
      rawBody: unknown,
    ) {
      const actor = await requireActor(auth);
      const watchId = assertValidUuid(watchIdRaw, "watchId");
      const body = assertPlainObject(rawBody ?? {}, ["expected_version"]);
      const expectedVersion =
        body.expected_version === undefined
          ? undefined
          : assertBoundedInt(body.expected_version, "expected_version", 1, 1_000_000);

      return runIdempotent(
        actor,
        `core2.watch.cancel:${watchId}`,
        auth.idempotencyKeyHeader,
        { watchId, expectedVersion: expectedVersion ?? null },
        async () => {
          const existing = await deps.repo.getWatch(actor.familyId, watchId);
          if (!existing) throw new Core2Error("not_found", 404, "Watch not found.");
          assertSubjectAccess(actor, existing.subjectPersonId, "cancel watch");

          const updated = await deps.repo.cancelWatch({
            familyId: actor.familyId,
            watchId,
            subjectPersonId: actor.personId,
            expectedVersion,
            nowIso: getNow().toISOString(),
          });

          await appendTimeline({
            familyId: actor.familyId,
            dedupeKey: `core2:watch:cancel:${watchId}:v${updated.version}`,
            eventType: "core2.watch.cancelled",
            entityId: watchId,
            humanLine: "Going-home watch cancelled.",
            payload: { watch_id: watchId, version: updated.version },
          });

          return { status: 200, body: { watch: toPublicWatch(updated) } };
        },
      );
    },

    async resolveWatchSafe(
      auth: { bearerToken: string | null; familyIdHeader: string | null; idempotencyKeyHeader: string | null },
      watchIdRaw: string,
      rawBody: unknown,
    ) {
      const actor = await requireActor(auth);
      const watchId = assertValidUuid(watchIdRaw, "watchId");
      const body = assertPlainObject(rawBody ?? {}, [
        "expected_version",
        "voice_post_id",
        "note",
        "delegated",
      ]);

      const expectedVersion =
        body.expected_version === undefined
          ? undefined
          : assertBoundedInt(body.expected_version, "expected_version", 1, 1_000_000);
      const voicePostId = assertOptionalUuid(body.voice_post_id, "voice_post_id");
      const note = body.note === undefined ? undefined : assertSafeString(body.note, "note", 1, 160);
      const delegated = body.delegated === undefined ? false : assertBoolean(body.delegated, "delegated");

      return runIdempotent(
        actor,
        `core2.watch.safe:${watchId}`,
        auth.idempotencyKeyHeader,
        {
          watchId,
          expectedVersion: expectedVersion ?? null,
          voicePostId: voicePostId ?? null,
          note: note ?? null,
          delegated,
        },
        async (keyHash) => {
          const watch = await deps.repo.getWatch(actor.familyId, watchId);
          if (!watch) throw new Core2Error("not_found", 404, "Watch not found.");

          if (watch.subjectPersonId !== actor.personId) {
            if (!delegated) {
              throw new Core2Error("forbidden", 403, "Only the watch subject or a delegated contact may mark safe.");
            }
            const contacts = await deps.repo.listActiveTrustedContacts(
              actor.familyId,
              watch.subjectPersonId,
              "watch_escalation",
              getNow().toISOString(),
            );
            if (!contacts.some((c) => c.contactPersonId === actor.personId)) {
              throw new Core2Error("forbidden", 403, "Actor is not an active delegated contact for this watch.");
            }
          }

          if (voicePostId) {
            const voicePost = await deps.repo.getVoicePost(actor.familyId, voicePostId);
            if (!voicePost || voicePost.senderId !== watch.subjectPersonId) {
              throw new Core2Error("forbidden", 403, "Voice post not owned by watch subject.");
            }
            const [linked, history] = await Promise.all([
              deps.repo.getConsent(actor.familyId, voicePost.consentId),
              deps.repo.listConsentHistory(
                actor.familyId,
                watch.subjectPersonId,
                `voice_share:${voicePost.recipientId}`,
              ),
            ]);
            if (
              !checkVoiceShareConsent(
                linked,
                history,
                actor.familyId,
                watch.subjectPersonId,
                voicePost.recipientId,
                getNow(),
              )
            ) {
              throw new Core2Error("consent_required", 403, "Voice sharing consent is missing or revoked.");
            }
          }

          await ingestEncryptedEvent({
            familyId: actor.familyId,
            actorPersonId: actor.personId,
            eventType: "core2.watch.safe",
            providerEventId: `watch-safe:${watchId}:${keyHash}`,
            payload: { watch_id: watchId, note: note ?? null, delegated },
          });

          const resolved = await deps.repo.resolveWatchSafe({
            familyId: actor.familyId,
            watchId,
            subjectPersonId: watch.subjectPersonId,
            expectedVersion,
            idempotencyKeyHash: keyHash,
            voicePostId: voicePostId ?? null,
          });

          await appendTimeline({
            familyId: actor.familyId,
            dedupeKey: `core2:watch:safe:${watchId}:v${resolved.version}`,
            eventType: "core2.watch.safe",
            entityId: watchId,
            humanLine: "Checked in safe; going-home watch closed.",
            payload: { watch_id: watchId, version: resolved.version, state: resolved.state },
          });

          return { status: 200, body: { watch: toPublicWatch(resolved) } };
        },
      );
    },

    async listWatches(
      auth: { bearerToken: string | null; familyIdHeader: string | null },
      limitRaw: string | null,
    ) {
      const actor = await requireActor(auth);
      const limit = assertPaginationLimit(limitRaw);
      const rows = await deps.repo.listWatches(actor.familyId, null, limit);
      const nowIso = getNow().toISOString();
      const visible: PublicWatchDto[] = [];
      for (const w of rows) {
        if (w.subjectPersonId === actor.personId) {
          visible.push(toPublicWatch(w));
          continue;
        }
        // Escalation contacts only see a watch once it escalated (never active/pre-escalation private routes).
        if (w.state === "escalated" || (w.state === "safe" && w.escalatedAt !== null)) {
          const contacts = await deps.repo.listActiveTrustedContacts(
            actor.familyId,
            w.subjectPersonId,
            "watch_escalation",
            nowIso,
          );
          if (contacts.some((c) => c.contactPersonId === actor.personId)) {
            visible.push(toPublicWatch(w));
          }
        }
      }
      return { items: visible };
    },

    async getWatch(
      auth: { bearerToken: string | null; familyIdHeader: string | null },
      watchIdRaw: string,
    ) {
      const actor = await requireActor(auth);
      const watchId = assertValidUuid(watchIdRaw, "watchId");
      const watch = await deps.repo.getWatch(actor.familyId, watchId);
      if (!watch) throw new Core2Error("not_found", 404, "Watch not found.");
      if (actor.personId !== watch.subjectPersonId) {
        const contacts = await deps.repo.listActiveTrustedContacts(
          actor.familyId,
          watch.subjectPersonId,
          "watch_escalation",
          getNow().toISOString(),
        );
        const isEscContact = contacts.some((c) => c.contactPersonId === actor.personId);
        const escalatedOrPostEscalationSafe =
          watch.state === "escalated" || (watch.state === "safe" && watch.escalatedAt !== null);
        if (!isEscContact || !escalatedOrPostEscalationSafe) {
          throw new Core2Error("forbidden", 403, "Not permitted to inspect this watch.");
        }
      }
      return { watch: toPublicWatch(watch) };
    },

    async tickDueWatches(limit = 25): Promise<{
      processed: number;
      checking_in: number;
      escalated: number;
      dispatches_queued: number;
    }> {
      const nowIso = getNow().toISOString();
      const updated = await deps.repo.tickDueWatches(nowIso, limit);
      let checkingIn = 0;
      let escalated = 0;
      let dispatchesQueued = 0;

      for (const watch of updated) {
        if (watch.state === "checking_in") {
          checkingIn += 1;
          if (watch.requestId) {
            const gateRes = await authorizeAndDispatch({
              familyId: watch.familyId,
              actorPersonId: watch.subjectPersonId,
              requestId: watch.requestId,
              action: "check_in",
              targetPersonId: watch.subjectPersonId,
              outboxKind: "core2.watch_checkin",
              dedupeKey: `core2:watch:checkin:${watch.id}:v${watch.version}`,
              payload: { kind: "core2.watch_checkin", watch_id: watch.id },
              watchId: watch.id,
            });
            if (gateRes.decision === "allow") dispatchesQueued += 1;
          }
          await appendTimeline({
            familyId: watch.familyId,
            dedupeKey: `core2:watch:checking_in:${watch.id}:v${watch.version}`,
            eventType: "core2.watch.checking_in",
            entityId: watch.id,
            humanLine: "Watch deadline reached; check-in requested.",
            payload: { watch_id: watch.id, version: watch.version },
          });
        } else if (watch.state === "escalated") {
          escalated += 1;
          const contacts = await deps.repo.listActiveTrustedContacts(
            watch.familyId,
            watch.subjectPersonId,
            "watch_escalation",
            nowIso,
          );
          for (const contact of contacts) {
            if (watch.requestId) {
              const gateRes = await authorizeAndDispatch({
                familyId: watch.familyId,
                actorPersonId: watch.subjectPersonId,
                requestId: watch.requestId,
                action: "urgent_responder",
                targetPersonId: contact.contactPersonId,
                outboxKind: "core2.watch_escalation",
                dedupeKey: `core2:watch:esc:${watch.id}:v${watch.version}:${contact.id}`,
                payload: {
                  kind: "core2.watch_escalation",
                  watch_id: watch.id,
                  incident_id: watch.incidentId,
                  contact_person_id: contact.contactPersonId,
                },
                trustedContactId: contact.id,
                watchId: watch.id,
              });
              if (gateRes.decision === "allow") dispatchesQueued += 1;
            }
            if (watch.incidentId) {
              await deps.repo.createAssignment({
                familyId: watch.familyId,
                incidentId: watch.incidentId,
                personId: contact.contactPersonId,
                expiresAt: new Date(getNow().getTime() + 15 * 60_000).toISOString(),
              });
            }
          }
          await appendTimeline({
            familyId: watch.familyId,
            dedupeKey: `core2:watch:escalated:${watch.id}:v${watch.version}`,
            eventType: "core2.watch.escalated",
            entityId: watch.id,
            humanLine: "Watch grace expired; escalation recorded.",
            payload: { watch_id: watch.id, version: watch.version, contacts_count: contacts.length },
          });
        }
      }

      return {
        processed: updated.length,
        checking_in: checkingIn,
        escalated,
        dispatches_queued: dispatchesQueued,
      };
    },

    // ------------------------------------------------------------------
    // Task 4: Trusted Contacts Lifecycle
    // ------------------------------------------------------------------
    async inviteTrustedContact(
      auth: { bearerToken: string | null; familyIdHeader: string | null; idempotencyKeyHeader: string | null },
      rawBody: unknown,
    ) {
      const actor = await requireActor(auth);
      if (actor.role !== "child") {
        throw new Core2Error("forbidden", 403, "Only an active child member may invite trusted contacts.");
      }
      const body = assertPlainObject(rawBody, [
        "subject_person_id",
        "contact_person_id",
        "rank",
        "scopes",
        "effective_from",
        "effective_until",
      ]);

      const subjectPersonId =
        assertOptionalUuid(body.subject_person_id, "subject_person_id") ?? actor.personId;
      assertSubjectAccess(actor, subjectPersonId, "invite a trusted contact");
      const contactPersonId = assertValidUuid(body.contact_person_id, "contact_person_id");
      if (contactPersonId === subjectPersonId) {
        throw new Core2Error("invalid_request", 400, "Cannot invite yourself as a trusted contact.");
      }
      const rank = assertBoundedInt(body.rank, "rank", 1, 20);
      const scopes = parseScopes(body.scopes);
      const effectiveFrom =
        body.effective_from === undefined
          ? getNow().toISOString()
          : assertIsoTimestamp(body.effective_from, "effective_from");
      const effectiveUntil =
        body.effective_until === undefined || body.effective_until === null
          ? null
          : assertIsoTimestamp(body.effective_until, "effective_until");

      if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) {
        throw new Core2Error("invalid_request", 400, "effective_until must be after effective_from.");
      }

      return runIdempotent(
        actor,
        "core2.trusted_contact.invite",
        auth.idempotencyKeyHeader,
        { subjectPersonId, contactPersonId, rank, scopes, effectiveFrom, effectiveUntil },
        async () => {
          const contactPerson = await deps.repo.getPerson(actor.familyId, contactPersonId);
          if (!contactPerson) {
            throw new Core2Error("not_found", 404, "Contact person not found in family.");
          }

          const created = await deps.repo.createTrustedContact({
            familyId: actor.familyId,
            subjectPersonId,
            contactPersonId,
            rank,
            scopes,
            effectiveFrom,
            effectiveUntil,
          });

          await appendTimeline({
            familyId: actor.familyId,
            dedupeKey: `core2:contact:invite:${created.id}`,
            eventType: "core2.contact.invited",
            entityId: created.id,
            humanLine: "Trusted contact invitation recorded.",
            payload: { contact_id: created.id, rank, scopes },
          });

          return { status: 201, body: { contact: toPublicContact(created) } };
        },
      );
    },

    async approveTrustedContact(
      auth: { bearerToken: string | null; familyIdHeader: string | null; idempotencyKeyHeader: string | null },
      contactIdRaw: string,
      rawBody: unknown,
    ) {
      const actor = await requireActor(auth);
      const contactId = assertValidUuid(contactIdRaw, "contactId");
      const body = assertPlainObject(rawBody ?? {}, ["consent_version", "accept"]);
      const consentVersion =
        body.consent_version === undefined
          ? "core2-v1"
          : assertSafeString(body.consent_version, "consent_version", 1, 64);
      const accept = body.accept === undefined ? true : assertBoolean(body.accept, "accept");
      if (!accept) {
        throw new Core2Error("invalid_request", 400, "Use revoke to decline a trusted contact invite.");
      }

      return runIdempotent(
        actor,
        `core2.trusted_contact.approve:${contactId}`,
        auth.idempotencyKeyHeader,
        { contactId, consentVersion, accept },
        async () => {
          const existing = await deps.repo.getTrustedContact(actor.familyId, contactId);
          if (!existing) throw new Core2Error("not_found", 404, "Trusted contact not found.");
          if (existing.state === "revoked") {
            throw new Core2Error("conflict", 409, "Revoked trusted contact cannot be approved.");
          }
          // Only the contact person themselves may consent & activate their emergency contact grant.
          if (actor.personId !== existing.contactPersonId) {
            throw new Core2Error(
              "forbidden",
              403,
              "Only the named contact may approve and consent to a trusted contact invitation.",
            );
          }

          const approved = await deps.repo.approveTrustedContact({
            familyId: actor.familyId,
            contactId,
            consentPersonId: actor.personId,
            consentVersion,
            nowIso: getNow().toISOString(),
          });

          await appendTimeline({
            familyId: actor.familyId,
            dedupeKey: `core2:contact:approve:${contactId}:v${approved.version}`,
            eventType: "core2.contact.approved",
            entityId: contactId,
            humanLine: "Trusted contact approved and consented.",
            payload: { contact_id: contactId, state: approved.state, version: approved.version },
          });

          return { status: 200, body: { contact: toPublicContact(approved) } };
        },
      );
    },

    async updateTrustedContact(
      auth: { bearerToken: string | null; familyIdHeader: string | null; idempotencyKeyHeader: string | null },
      contactIdRaw: string,
      rawBody: unknown,
    ) {
      const actor = await requireActor(auth);
      const contactId = assertValidUuid(contactIdRaw, "contactId");
      const body = assertPlainObject(rawBody, ["expected_version", "rank", "scopes", "effective_until"]);
      const expectedVersion = assertBoundedInt(body.expected_version, "expected_version", 1, 1_000_000);
      const rank =
        body.rank === undefined ? undefined : assertBoundedInt(body.rank, "rank", 1, 20);
      const scopes = body.scopes === undefined ? undefined : parseScopes(body.scopes);
      const effectiveUntil =
        body.effective_until === undefined
          ? undefined
          : body.effective_until === null
            ? null
            : assertIsoTimestamp(body.effective_until, "effective_until");

      return runIdempotent(
        actor,
        `core2.trusted_contact.update:${contactId}`,
        auth.idempotencyKeyHeader,
        { contactId, expectedVersion, rank: rank ?? null, scopes: scopes ?? null, effectiveUntil: effectiveUntil ?? null },
        async () => {
          const existing = await deps.repo.getTrustedContact(actor.familyId, contactId);
          if (!existing) throw new Core2Error("not_found", 404, "Trusted contact not found.");
          assertSubjectAccess(actor, existing.subjectPersonId, "update trusted contact");

          if (effectiveUntil && Date.parse(effectiveUntil) <= Date.parse(existing.effectiveFrom)) {
            throw new Core2Error("invalid_request", 400, "effective_until must be after effective_from.");
          }

          const updated = await deps.repo.updateTrustedContact({
            familyId: actor.familyId,
            contactId,
            expectedVersion,
            rank,
            scopes,
            effectiveUntil,
          });
          return { status: 200, body: { contact: toPublicContact(updated) } };
        },
      );
    },

    async revokeTrustedContact(
      auth: { bearerToken: string | null; familyIdHeader: string | null; idempotencyKeyHeader: string | null },
      contactIdRaw: string,
      rawBody: unknown,
    ) {
      const actor = await requireActor(auth);
      const contactId = assertValidUuid(contactIdRaw, "contactId");
      const body = assertPlainObject(rawBody ?? {}, ["expected_version"]);
      const expectedVersion =
        body.expected_version === undefined
          ? undefined
          : assertBoundedInt(body.expected_version, "expected_version", 1, 1_000_000);

      return runIdempotent(
        actor,
        `core2.trusted_contact.revoke:${contactId}`,
        auth.idempotencyKeyHeader,
        { contactId, expectedVersion: expectedVersion ?? null },
        async () => {
          const existing = await deps.repo.getTrustedContact(actor.familyId, contactId);
          if (!existing) throw new Core2Error("not_found", 404, "Trusted contact not found.");
          if (
            actor.personId !== existing.subjectPersonId &&
            actor.personId !== existing.contactPersonId &&
            actor.role !== "child"
          ) {
            throw new Core2Error("forbidden", 403, "Not permitted to revoke this trusted contact.");
          }

          const revoked = await deps.repo.revokeTrustedContact(actor.familyId, contactId, expectedVersion);

          await appendTimeline({
            familyId: actor.familyId,
            dedupeKey: `core2:contact:revoke:${contactId}:v${revoked.version}`,
            eventType: "core2.contact.revoked",
            entityId: contactId,
            humanLine: "Trusted contact revoked.",
            payload: { contact_id: contactId, version: revoked.version },
          });

          return { status: 200, body: { contact: toPublicContact(revoked) } };
        },
      );
    },

    async listTrustedContacts(
      auth: { bearerToken: string | null; familyIdHeader: string | null },
      includeRevoked: boolean,
      limitRaw: string | null,
    ) {
      const actor = await requireActor(auth);
      const limit = assertPaginationLimit(limitRaw);
      const rows = await deps.repo.listTrustedContacts(actor.familyId, actor.personId, includeRevoked, limit);
      const visible =
        actor.role === "child"
          ? rows
          : rows.filter((r) => r.subjectPersonId === actor.personId || r.contactPersonId === actor.personId);
      return { items: visible.map(toPublicContact) };
    },

    // ------------------------------------------------------------------
    // Task 5: Emergency Communication & Reassurance + Preferences
    // ------------------------------------------------------------------
    async getSharingPreferences(auth: { bearerToken: string | null; familyIdHeader: string | null }) {
      const actor = await requireActor(auth);
      if (actor.role !== "child") {
        throw new Core2Error("forbidden", 403, "Only subject/child may read raw sharing preferences.");
      }
      const prefs = await deps.repo.getSharingPreferences(actor.familyId, actor.personId);
      return { preferences: toPublicPreferences(prefs) };
    },

    async updateSharingPreferences(
      auth: { bearerToken: string | null; familyIdHeader: string | null; idempotencyKeyHeader: string | null },
      rawBody: unknown,
    ) {
      const actor = await requireActor(auth);
      if (actor.role !== "child") {
        throw new Core2Error("forbidden", 403, "Only the child subject may update sharing preferences.");
      }
      const body = assertPlainObject(rawBody, [
        "share_status_with_parent",
        "allow_location_share",
        "allow_health_share",
        "allow_narrative_share",
      ]);

      const existing = await deps.repo.getSharingPreferences(actor.familyId, actor.personId);
      const next = {
        shareStatusWithParent:
          body.share_status_with_parent === undefined
            ? existing.shareStatusWithParent
            : assertBoolean(body.share_status_with_parent, "share_status_with_parent"),
        allowLocationShare:
          body.allow_location_share === undefined
            ? existing.allowLocationShare
            : assertBoolean(body.allow_location_share, "allow_location_share"),
        allowHealthShare:
          body.allow_health_share === undefined
            ? existing.allowHealthShare
            : assertBoolean(body.allow_health_share, "allow_health_share"),
        allowNarrativeShare:
          body.allow_narrative_share === undefined
            ? existing.allowNarrativeShare
            : assertBoolean(body.allow_narrative_share, "allow_narrative_share"),
      };

      return runIdempotent(
        actor,
        "core2.reassurance.preferences",
        auth.idempotencyKeyHeader,
        next,
        async () => {
          const updated = await deps.repo.upsertSharingPreferences({
            familyId: actor.familyId,
            subjectPersonId: actor.personId,
            ...next,
          });
          await appendTimeline({
            familyId: actor.familyId,
            dedupeKey: `core2:prefs:${actor.personId}:v${updated.version}`,
            eventType: "core2.preferences.updated",
            entityId: actor.personId,
            humanLine: "Reassurance sharing preferences updated.",
            payload: { version: updated.version },
          });
          return { status: 200, body: { preferences: toPublicPreferences(updated) } };
        },
      );
    },

    async sendReassurance(
      auth: { bearerToken: string | null; familyIdHeader: string | null; idempotencyKeyHeader: string | null },
      rawBody: unknown,
    ) {
      const actor = await requireActor(auth);
      if (actor.role !== "child") {
        throw new Core2Error("forbidden", 403, "Only child subject may emit reassurance updates.");
      }
      const body = assertPlainObject(rawBody, [
        "kind",
        "watch_id",
        "sos_id",
        "voice_post_id",
        "recipient_person_ids",
      ]);

      const kindRaw = assertSafeString(body.kind, "kind", 1, 32);
      if (kindRaw !== "im_safe" && kindRaw !== "reached_home" && kindRaw !== "truth_line") {
        throw new Core2Error("invalid_request", 400, "kind must be im_safe, reached_home, or truth_line.");
      }
      const kind = kindRaw as ReassuranceKind;
      const watchId = assertOptionalUuid(body.watch_id, "watch_id") ?? null;
      const sosId = assertOptionalUuid(body.sos_id, "sos_id") ?? null;
      const voicePostId = assertOptionalUuid(body.voice_post_id, "voice_post_id") ?? null;

      let requestedRecipients: string[] | undefined;
      if (body.recipient_person_ids !== undefined) {
        if (!Array.isArray(body.recipient_person_ids) || body.recipient_person_ids.length === 0 || body.recipient_person_ids.length > 10) {
          throw new Core2Error("invalid_request", 400, "recipient_person_ids must have 1..10 UUIDs.");
        }
        requestedRecipients = [...new Set(body.recipient_person_ids.map((v, i) => assertValidUuid(v, `recipient_person_ids[${i}]`)))];
      }

      return runIdempotent(
        actor,
        "core2.reassurance.send",
        auth.idempotencyKeyHeader,
        { kind, watchId, sosId, voicePostId, recipientPersonIds: requestedRecipients ?? null },
        async (keyHash) => {
          const now = getNow();
          const nowIso = now.toISOString();

          const [watch, sos, prefs, parents, trusted] = await Promise.all([
            watchId ? deps.repo.getWatch(actor.familyId, watchId) : Promise.resolve(null),
            sosId ? deps.repo.getSosEvent(actor.familyId, sosId) : Promise.resolve(null),
            deps.repo.getSharingPreferences(actor.familyId, actor.personId),
            deps.repo.listPeopleByRole(actor.familyId, "parent"),
            deps.repo.listActiveTrustedContacts(actor.familyId, actor.personId, "reassurance", nowIso),
          ]);

          if (watchId && (!watch || watch.subjectPersonId !== actor.personId)) {
            throw new Core2Error("not_found", 404, "Referenced watch not found for subject.");
          }
          if (sosId && (!sos || sos.subjectPersonId !== actor.personId)) {
            throw new Core2Error("not_found", 404, "Referenced SOS not found for subject.");
          }

          const eligibleRecipients = new Set<string>();
          const parentIds = new Set(parents.map((p) => p.id));
          if (prefs.shareStatusWithParent) {
            for (const p of parents) eligibleRecipients.add(p.id);
          }
          for (const c of trusted) eligibleRecipients.add(c.contactPersonId);

          const recipients = requestedRecipients ?? [...eligibleRecipients];
          if (recipients.length === 0) {
            throw new Core2Error("consent_required", 403, "No consented reassurance recipients available.");
          }
          for (const recipientId of recipients) {
            if (!eligibleRecipients.has(recipientId)) {
              if (parentIds.has(recipientId) && !prefs.shareStatusWithParent) {
                throw new Core2Error("consent_required", 403, "Parent reassurance sharing is disabled by preferences.");
              }
              throw new Core2Error("forbidden", 403, "Recipient is not an active reassurance contact or parent.");
            }
          }

          if (voicePostId) {
            const voicePost = await deps.repo.getVoicePost(actor.familyId, voicePostId);
            if (!voicePost || voicePost.senderId !== actor.personId) {
              throw new Core2Error("forbidden", 403, "Voice post not owned by subject.");
            }
            if (!recipients.includes(voicePost.recipientId)) {
              throw new Core2Error("forbidden", 403, "Voice post recipient does not match reassurance target.");
            }
            const [linked, history] = await Promise.all([
              deps.repo.getConsent(actor.familyId, voicePost.consentId),
              deps.repo.listConsentHistory(
                actor.familyId,
                actor.personId,
                `voice_share:${voicePost.recipientId}`,
              ),
            ]);
            if (
              !checkVoiceShareConsent(
                linked,
                history,
                actor.familyId,
                actor.personId,
                voicePost.recipientId,
                now,
              )
            ) {
              throw new Core2Error("consent_required", 403, "Voice share consent required.");
            }
          }

          const { requestId } = await deps.repo.createRequestAndIncident({
            familyId: actor.familyId,
            personId: actor.personId,
            requestKind: "reassurance",
            severity: "routine",
            incidentState: "open",
          });

          await ingestEncryptedEvent({
            familyId: actor.familyId,
            actorPersonId: actor.personId,
            eventType: "core2.reassurance.requested",
            providerEventId: `reassurance:${actor.familyId}:${keyHash}`,
            payload: { kind, watch_id: watchId, sos_id: sosId, recipients },
          });

          const statusLabel = deterministicStatusLabel(kind, watch, sos);
          const trustedByPerson = new Map(trusted.map((c) => [c.contactPersonId, c.id]));

          const createdRows: PublicReassuranceDto[] = [];
          let anyQueued = false;
          for (const recipientId of recipients) {
            const gateAction = voicePostId ? "voice_message" : "share_data";
            const gateRes = await authorizeAndDispatch({
              familyId: actor.familyId,
              actorPersonId: actor.personId,
              requestId,
              action: gateAction,
              targetPersonId: recipientId,
              consentSubjectId: actor.personId,
              outboxKind: "core2.reassurance",
              dedupeKey: `core2:reassurance:${keyHash}:${recipientId}`,
              // Never invent facts, never expose unconsented location, health or narrative.
              payload: {
                kind: "core2.reassurance",
                status_label: statusLabel,
                voice_post_id: voicePostId,
                location_included: false,
                health_included: false,
                narrative_included: false,
              },
              trustedContactId: trustedByPerson.get(recipientId) ?? null,
              watchId,
              sosId,
            });

            if (gateRes.decision === "allow") anyQueued = true;

            const saved = await deps.repo.createReassuranceUpdate({
              familyId: actor.familyId,
              subjectPersonId: actor.personId,
              recipientPersonId: recipientId,
              kind,
              watchId,
              sosId,
              voicePostId,
              outboxId: gateRes.outboxId,
              statusLabel,
              deliveryStatus: gateRes.decision === "allow" ? "queued" : "denied",
              locationShared: false,
              healthShared: false,
              narrativeShared: false,
            });
            createdRows.push(toPublicReassurance(saved, prefs));
          }

          await appendTimeline({
            familyId: actor.familyId,
            dedupeKey: `core2:reassurance:${keyHash}`,
            eventType: "core2.reassurance.queued",
            entityId: createdRows[0]?.id ?? null,
            humanLine: `Reassurance update recorded (${statusLabel}).`,
            payload: { kind, status_label: statusLabel, recipient_count: createdRows.length },
          });

          return {
            status: anyQueued ? 202 : 403,
            body: {
              reassurance: createdRows[0] ?? null,
              updates: createdRows,
            },
          };
        },
      );
    },

    async listReassurance(
      auth: { bearerToken: string | null; familyIdHeader: string | null },
      limitRaw: string | null,
    ) {
      const actor = await requireActor(auth);
      const limit = assertPaginationLimit(limitRaw);
      const rows = await deps.repo.listReassuranceUpdates(
        actor.familyId,
        actor.role === "child" ? null : actor.personId,
        limit,
      );

      const nowIso = getNow().toISOString();
      const items: PublicReassuranceDto[] = [];
      const prefCache = new Map<string, SharingPreferencesRow>();
      const contactCache = new Map<string, Set<string>>();

      for (const row of rows) {
        let prefs = prefCache.get(row.subjectPersonId);
        if (!prefs) {
          prefs = await deps.repo.getSharingPreferences(actor.familyId, row.subjectPersonId);
          prefCache.set(row.subjectPersonId, prefs);
        }

        if (actor.role === "child" || actor.personId === row.subjectPersonId) {
          items.push(toPublicReassurance(row, prefs));
          continue;
        }

        if (actor.personId !== row.recipientPersonId) continue;

        if (actor.role === "parent") {
          if (!prefs.shareStatusWithParent) continue;
          items.push(toPublicReassurance(row, prefs));
          continue;
        }

        let activeRecipients = contactCache.get(row.subjectPersonId);
        if (!activeRecipients) {
          const contacts = await deps.repo.listActiveTrustedContacts(
            actor.familyId,
            row.subjectPersonId,
            "reassurance",
            nowIso,
          );
          activeRecipients = new Set(contacts.map((c) => c.contactPersonId));
          contactCache.set(row.subjectPersonId, activeRecipients);
        }
        if (activeRecipients.has(actor.personId)) {
          items.push(toPublicReassurance(row, prefs));
        }
      }

      return { items };
    },
  };
}

