import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  GateApproval,
  GateConsent,
  GateDecision,
  GateInput,
  SetupPermission,
} from "@sahaj/gate";

let gateModulePromise: Promise<typeof import("@sahaj/gate")> | null = null;
function loadGateModule(): Promise<typeof import("@sahaj/gate")> {
  gateModulePromise ??= import("@sahaj/gate");
  return gateModulePromise;
}
import { serviceDatabase } from "@/lib/database";
import { supabaseAuth } from "@/lib/media/supabase";
import { canonicalJson, signTimelineEvent } from "@/lib/timeline";
import {
  Core2Error,
  type AcceptIncidentResult,
  type Core2AuthPort,
  type Core2ConsentRecord,
  type Core2Deps,
  type Core2DispatchPort,
  type Core2GatePort,
  type Core2Membership,
  type Core2Person,
  type Core2Repository,
  type Core2TimelinePort,
  type Core2VoicePostRecord,
  type DeclineIncidentResult,
  type DueIncidentEscalation,
  type OfferNextContactResult,
  type ReassuranceRow,
  type SharingPreferencesRow,
  type SosRow,
  type TrustedContactRow,
  type TrustedContactScope,
  type TruthLineStateSnapshot,
  type WatchRow,
} from "./contracts";
import { createWebhookCryptoPort, sha256Hex } from "./security";

type Row = Record<string, unknown>;

const str = (v: unknown, field = "column"): string => {
  if (typeof v !== "string") throw new Core2Error("unavailable", 503, `Invalid row ${field}`);
  return v;
};

const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));
const num = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Core2Error("unavailable", 503, "Invalid numeric column");
  }
  return v;
};
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : [];

function mapWatch(r: Row): WatchRow {
  return {
    id: str(r.id),
    familyId: str(r.family_id),
    subjectPersonId: str(r.subject_person_id),
    incidentId: optStr(r.incident_id),
    requestId: optStr(r.request_id),
    rawEventId: str(r.raw_event_id),
    timezone: str(r.timezone),
    state: str(r.state) as WatchRow["state"],
    version: num(r.version),
    graceMinutes: num(r.grace_minutes),
    deadlineAt: str(r.deadline_at),
    graceUntil: str(r.grace_until),
    nextTickAt: optStr(r.next_tick_at),
    checkedInAt: optStr(r.checked_in_at),
    escalatedAt: optStr(r.escalated_at),
    safeAt: optStr(r.safe_at),
    cancelledAt: optStr(r.cancelled_at),
    safeIdempotencyKeyHash: optStr(r.safe_idempotency_key_hash),
    safeVoicePostId: optStr(r.safe_voice_post_id),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function mapSos(r: Row): SosRow {
  return {
    id: str(r.id),
    familyId: str(r.family_id),
    subjectPersonId: str(r.subject_person_id),
    incidentId: str(r.incident_id),
    requestId: str(r.request_id),
    rawEventId: str(r.raw_event_id),
    status: str(r.status) as SosRow["status"],
    deliveryStatus: str(r.delivery_status) as SosRow["deliveryStatus"],
    responderAccepted: r.responder_accepted === true,
    acceptedAssignmentId: optStr(r.accepted_assignment_id),
    acceptedRawEventId: optStr(r.accepted_raw_event_id),
    version: num(r.version),
    countdownUntil: optStr(r.countdown_until),
    cancelledAt: optStr(r.cancelled_at),
    safeAt: optStr(r.safe_at),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function mapContact(r: Row): TrustedContactRow {
  const person = r.people as Row | undefined;
  return {
    id: str(r.id),
    familyId: str(r.family_id),
    subjectPersonId: str(r.subject_person_id),
    contactPersonId: str(r.contact_person_id),
    contactDisplayName: person && typeof person.display_name === "string" ? person.display_name : undefined,
    rank: num(r.rank),
    scopes: strArr(r.scopes) as TrustedContactScope[],
    state: str(r.state) as TrustedContactRow["state"],
    approvedAt: optStr(r.approved_at),
    consentId: optStr(r.consent_id),
    consentAt: optStr(r.consent_at),
    effectiveFrom: str(r.effective_from),
    effectiveUntil: optStr(r.effective_until),
    revokedAt: optStr(r.revoked_at),
    version: num(r.version),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function mapReassurance(r: Row): ReassuranceRow {
  return {
    id: str(r.id),
    familyId: str(r.family_id),
    subjectPersonId: str(r.subject_person_id),
    recipientPersonId: str(r.recipient_person_id),
    kind: str(r.kind) as ReassuranceRow["kind"],
    watchId: optStr(r.watch_id),
    sosId: optStr(r.sos_id),
    voicePostId: optStr(r.voice_post_id),
    outboxId: optStr(r.outbox_id),
    statusLabel: str(r.status_label),
    deliveryStatus: str(r.delivery_status) as ReassuranceRow["deliveryStatus"],
    deliveryVerified: r.delivery_verified === true,
    heardVerified: r.heard_verified === true,
    verifiedRawEventId: optStr(r.verified_raw_event_id),
    locationShared: r.location_shared === true,
    healthShared: r.health_shared === true,
    narrativeShared: r.narrative_shared === true,
    createdAt: str(r.created_at),
  };
}

function mapConsent(r: Row): Core2ConsentRecord {
  return {
    id: str(r.id),
    familyId: str(r.family_id),
    personId: str(r.person_id),
    callId: optStr(r.call_id),
    purpose: str(r.purpose),
    answer: r.answer === true,
    version: str(r.version),
    createdAt: str(r.created_at),
  };
}

function mapRpcError(error: { code?: string; message?: string }): never {
  const msg = error.message ?? "";
  if (error.code === "P0002" || msg.includes("not_found")) {
    throw new Core2Error("not_found", 404, "Requested record not found.");
  }
  if (error.code === "42501" || msg.includes("forbidden")) {
    throw new Core2Error("forbidden", 403, "Forbidden for requested subject.");
  }
  if (error.code === "40001" || msg.includes("stale_version")) {
    throw new Core2Error("stale_version", 409, "Version conflict; reload and retry.");
  }
  if (error.code === "40901" || msg.includes("watch_cancelled")) {
    throw new Core2Error("watch_cancelled", 409, "Watch was already cancelled.");
  }
  if (error.code === "40902" || msg.includes("incident_closed")) {
    throw new Core2Error("incident_closed", 409, "Incident is already resolved or closed.");
  }
  if (error.code === "40903" || msg.includes("incident_already_accepted")) {
    throw new Core2Error("incident_already_accepted", 409, "Incident already accepted by another responder.");
  }
  if (error.code === "40904" || msg.includes("assignment_expired")) {
    throw new Core2Error("assignment_expired", 409, "Escalation offer has already expired.");
  }
  if (error.code === "23505") {
    throw new Core2Error("conflict", 409, "Duplicate conflicting Core 2 record.");
  }
  throw new Core2Error("unavailable", 503, "Database operation failed.");
}

export function createSupabaseCore2Repository(db: SupabaseClient): Core2Repository {
  return {
    async listActiveMemberships(userId): Promise<Core2Membership[]> {
      const { data, error } = await db
        .from("family_memberships")
        .select("family_id,user_id,person_id,role,revoked_at")
        .eq("user_id", userId)
        .is("revoked_at", null);
      if (error || !Array.isArray(data)) throw new Core2Error("unavailable", 503, "Membership lookup failed.");
      return (data as Row[]).map((r) => ({
        familyId: str(r.family_id),
        userId: str(r.user_id),
        personId: str(r.person_id),
        role: str(r.role) as Core2Membership["role"],
        revokedAt: optStr(r.revoked_at),
      }));
    },

    async getPerson(familyId, personId): Promise<Core2Person | null> {
      const { data, error } = await db
        .from("people")
        .select("id,family_id,display_name,role,timezone")
        .eq("family_id", familyId)
        .eq("id", personId)
        .maybeSingle();
      if (error) throw new Core2Error("unavailable", 503, "Person lookup failed.");
      if (!data) return null;
      const r = data as Row;
      return {
        id: str(r.id),
        familyId: str(r.family_id),
        displayName: str(r.display_name),
        role: str(r.role) as Core2Person["role"],
        timezone: str(r.timezone),
      };
    },

    async listPeopleByRole(familyId, role): Promise<Core2Person[]> {
      const { data, error } = await db
        .from("people")
        .select("id,family_id,display_name,role,timezone")
        .eq("family_id", familyId)
        .eq("role", role);
      if (error || !Array.isArray(data)) throw new Core2Error("unavailable", 503, "People lookup failed.");
      return (data as Row[]).map((r) => ({
        id: str(r.id),
        familyId: str(r.family_id),
        displayName: str(r.display_name),
        role: str(r.role) as Core2Person["role"],
        timezone: str(r.timezone),
      }));
    },

    async getIdempotency(familyId, actorPersonId, action, keyHash) {
      const { data, error } = await db
        .from("core2_idempotency_records")
        .select("family_id,actor_person_id,action,key_hash,request_hash,response_status,response_body")
        .eq("family_id", familyId)
        .eq("actor_person_id", actorPersonId)
        .eq("action", action)
        .eq("key_hash", keyHash)
        .maybeSingle();
      if (error) throw new Core2Error("unavailable", 503, "Idempotency lookup failed.");
      if (!data) return null;
      const r = data as Row;
      return {
        familyId: str(r.family_id),
        actorPersonId: str(r.actor_person_id),
        action: str(r.action),
        keyHash: str(r.key_hash),
        requestHash: str(r.request_hash),
        responseStatus: num(r.response_status),
        responseBody: r.response_body,
      };
    },

    async saveIdempotency(record) {
      const { error } = await db.from("core2_idempotency_records").insert({
        family_id: record.familyId,
        actor_person_id: record.actorPersonId,
        action: record.action,
        key_hash: record.keyHash,
        request_hash: record.requestHash,
        response_status: record.responseStatus,
        response_body: record.responseBody,
      });
      if (error && error.code !== "23505") {
        throw new Core2Error("unavailable", 503, "Idempotency save failed.");
      }
    },

    async ingestRawEvent(input) {
      const { data, error } = await db.rpc("ingest_raw_event", {
        p_source: input.source,
        p_provider_event_id: input.providerEventId,
        p_event_type: input.eventType,
        p_family_id: input.familyId,
        p_metadata: input.metadata,
        p_payload_hash: input.payloadHash,
        p_payload_ciphertext: input.payloadCiphertext,
      });
      if (error || !data || typeof data !== "object") {
        if (error) mapRpcError(error);
        throw new Core2Error("storage_unavailable", 503, "Encrypted ingest failed.");
      }
      return { rawEventId: str((data as Row).id) };
    },

    async loadGateInput(input): Promise<GateInput> {
      const [memberRes, permsRes, approvalsRes, consentsRes] = await Promise.all([
        db
          .from("family_memberships")
          .select("person_id,family_id,revoked_at")
          .eq("family_id", input.familyId)
          .eq("person_id", input.actorPersonId)
          .is("revoked_at", null)
          .maybeSingle(),
        db
          .from("permissions")
          .select("id,family_id,person_id,action,decision,limits,expires_at,revoked_at,two_person_required,created_at")
          .eq("family_id", input.familyId)
          .eq("person_id", input.actorPersonId)
          .eq("action", input.action),
        db
          .from("action_answers")
          .select("action_request_id,approver_person_id,answer,answered_at")
          .eq("family_id", input.familyId)
          .eq("action_request_id", input.requestId),
        input.consentSubjectId
          ? db
              .from("consents")
              .select("id,family_id,person_id,purpose,answer,created_at")
              .eq("family_id", input.familyId)
              .eq("person_id", input.consentSubjectId)
          : Promise.resolve({ data: [] as Row[], error: null }),
      ]);

      if (memberRes.error || permsRes.error || approvalsRes.error || consentsRes.error) {
        throw new Core2Error("unavailable", 503, "Authorization context load failed.");
      }

      const activeActor = Boolean(memberRes.data);
      const permissions: SetupPermission[] = ((permsRes.data ?? []) as Row[])
        .filter((p) => p.decision === "allow")
        .map((p) => {
          const limits = (p.limits && typeof p.limits === "object" ? p.limits : {}) as Row;
          return {
            id: str(p.id),
            familyId: str(p.family_id),
            actorId: str(p.person_id),
            action: input.action,
            validFrom: typeof limits.valid_from === "string" ? limits.valid_from : str(p.created_at),
            expiresAt: str(p.expires_at),
            revokedAt: optStr(p.revoked_at),
            maxAmountMinor: typeof limits.max_amount_minor === "number" ? limits.max_amount_minor : 0,
            vendorIds: strArr(limits.vendor_ids),
            itemIds: strArr(limits.item_ids),
            targetIds: strArr(limits.target_ids),
            periodStart: typeof limits.period_start === "string" ? limits.period_start : str(p.created_at),
            periodEnd: typeof limits.period_end === "string" ? limits.period_end : str(p.expires_at),
            maxUses: typeof limits.max_uses === "number" ? limits.max_uses : 1,
            usedCount: typeof limits.used_count === "number" ? limits.used_count : 0,
            approvalMode: p.two_person_required === true ? "two_person" : "setup",
          };
        });

      const gateRequest: GateInput["request"] = {
        id: input.requestId,
        familyId: input.familyId,
        action: input.action,
        targetId: input.targetId,
        consentSubjectId: input.consentSubjectId,
      };
      const { requestFingerprint } = await loadGateModule();
      const fp = requestFingerprint(gateRequest);
      const permId = permissions[0]?.id ?? "";

      const approvals: GateApproval[] = ((approvalsRes.data ?? []) as Row[])
        .filter((a) => a.answer === true)
        .map((a, idx) => ({
          id: `${str(a.action_request_id)}:${str(a.approver_person_id)}:${idx}`,
          requestId: input.requestId,
          requestFingerprint: fp,
          permissionId: permId,
          familyId: input.familyId,
          approverId: str(a.approver_person_id),
          approverActive: true,
          approverCanApprove: true,
          createdAt: str(a.answered_at),
          expiresAt: "2099-01-01T00:00:00.000Z",
          revokedAt: null,
        }));

      const consents: GateConsent[] = [];
      for (const c of (consentsRes.data ?? []) as Row[]) {
        const purpose = str(c.purpose);
        if (purpose !== input.action && !purpose.startsWith("voice_share:") && purpose !== "trusted_contact") {
          continue;
        }
        const scope =
          input.action === "voice_message" || input.action === "share_data" ? "share_data" : "record_audio";
        if (c.answer === true) {
          consents.push({
            familyId: str(c.family_id),
            subjectId: str(c.person_id),
            targetId: input.targetId,
            scope,
            grantedAt: str(c.created_at),
            expiresAt: "2099-01-01T00:00:00.000Z",
            revokedAt: null,
          });
        }
      }

      return {
        actor: { id: input.actorPersonId, familyId: input.familyId, active: activeActor },
        request: gateRequest,
        permissions,
        approvals,
        consents,
        now: input.now,
      };
    },

    async createRequestAndIncident(input) {
      const { data: reqData, error: reqErr } = await db
        .from("requests")
        .insert({
          family_id: input.familyId,
          person_id: input.personId,
          kind: input.requestKind,
          status: "pending",
        })
        .select("id")
        .single();
      if (reqErr || !reqData) throw new Core2Error("unavailable", 503, "Failed to create request.");

      const requestId = str((reqData as Row).id);
      const { data: incData, error: incErr } = await db
        .from("incidents")
        .insert({
          family_id: input.familyId,
          person_id: input.personId,
          request_id: requestId,
          severity: input.severity,
          state: input.incidentState,
        })
        .select("id")
        .single();
      if (incErr || !incData) throw new Core2Error("unavailable", 503, "Failed to create incident.");

      return { requestId, incidentId: str((incData as Row).id) };
    },

    async createAssignment(input) {
      const { data, error } = await db
        .from("assignments")
        .insert({
          family_id: input.familyId,
          incident_id: input.incidentId,
          person_id: input.personId,
          expires_at: input.expiresAt,
        })
        .select("id")
        .single();
      if (error || !data) throw new Core2Error("unavailable", 503, "Failed to create assignment.");
      return { assignmentId: str((data as Row).id) };
    },

    async listActiveTrustedContacts(familyId, subjectPersonId, scope, nowIso) {
      const { data, error } = await db
        .from("core2_trusted_contacts")
        .select("*")
        .eq("family_id", familyId)
        .eq("subject_person_id", subjectPersonId)
        .eq("state", "active")
        .is("revoked_at", null)
        .contains("scopes", [scope])
        .lte("effective_from", nowIso)
        .order("rank", { ascending: true })
        .order("id", { ascending: true });
      if (error || !Array.isArray(data)) throw new Core2Error("unavailable", 503, "Trusted contact query failed.");
      const nowMs = Date.parse(nowIso);
      return (data as Row[])
        .map(mapContact)
        .filter((c) => c.effectiveUntil === null || Date.parse(c.effectiveUntil) > nowMs);
    },

    async listTrustedContacts(familyId, subjectPersonId, includeRevoked, limit) {
      let q = db
        .from("core2_trusted_contacts")
        .select("*")
        .eq("family_id", familyId)
        .or(`subject_person_id.eq.${subjectPersonId},contact_person_id.eq.${subjectPersonId}`)
        .order("rank", { ascending: true })
        .limit(limit);
      if (!includeRevoked) {
        q = q.neq("state", "revoked");
      }
      const { data, error } = await q;
      if (error || !Array.isArray(data)) throw new Core2Error("unavailable", 503, "Trusted contacts list failed.");
      return (data as Row[]).map(mapContact);
    },

    async getTrustedContact(familyId, contactId) {
      const { data, error } = await db
        .from("core2_trusted_contacts")
        .select("*")
        .eq("family_id", familyId)
        .eq("id", contactId)
        .maybeSingle();
      if (error) throw new Core2Error("unavailable", 503, "Trusted contact lookup failed.");
      return data ? mapContact(data as Row) : null;
    },

    async createTrustedContact(input) {
      const { data, error } = await db
        .from("core2_trusted_contacts")
        .insert({
          family_id: input.familyId,
          subject_person_id: input.subjectPersonId,
          contact_person_id: input.contactPersonId,
          rank: input.rank,
          scopes: input.scopes,
          state: "invited",
          effective_from: input.effectiveFrom,
          effective_until: input.effectiveUntil,
        })
        .select("*")
        .single();
      if (error || !data) {
        if (error) mapRpcError(error);
        throw new Core2Error("unavailable", 503, "Failed to create trusted contact.");
      }
      return mapContact(data as Row);
    },

    async approveTrustedContact(input) {
      const { data: consentRow, error: consentErr } = await db
        .from("consents")
        .insert({
          family_id: input.familyId,
          person_id: input.consentPersonId,
          purpose: "trusted_contact",
          question: "Do you agree to serve as an emergency trusted contact?",
          answer: true,
          version: input.consentVersion,
        })
        .select("id")
        .single();
      if (consentErr || !consentRow) throw new Core2Error("unavailable", 503, "Failed to record contact consent.");

      const consentId = str((consentRow as Row).id);
      const { data, error } = await db
        .from("core2_trusted_contacts")
        .update({
          state: "active",
          approved_at: input.nowIso,
          consent_at: input.nowIso,
          consent_id: consentId,
          updated_at: input.nowIso,
        })
        .eq("family_id", input.familyId)
        .eq("id", input.contactId)
        .neq("state", "revoked")
        .select("*")
        .single();
      if (error || !data) {
        if (error) mapRpcError(error);
        throw new Core2Error("unavailable", 503, "Failed to approve trusted contact.");
      }
      return mapContact(data as Row);
    },

    async updateTrustedContact(input) {
      const patch: Row = { updated_at: new Date().toISOString(), version: input.expectedVersion + 1 };
      if (input.rank !== undefined) patch.rank = input.rank;
      if (input.scopes !== undefined) patch.scopes = input.scopes;
      if (input.effectiveUntil !== undefined) patch.effective_until = input.effectiveUntil;

      const { data, error } = await db
        .from("core2_trusted_contacts")
        .update(patch)
        .eq("family_id", input.familyId)
        .eq("id", input.contactId)
        .eq("version", input.expectedVersion)
        .neq("state", "revoked")
        .select("*")
        .maybeSingle();
      if (error) mapRpcError(error);
      if (!data) throw new Core2Error("stale_version", 409, "Trusted contact version conflict or revoked.");
      return mapContact(data as Row);
    },

    async revokeTrustedContact(familyId, contactId, expectedVersion) {
      const { data, error } = await db.rpc("core2_revoke_trusted_contact", {
        p_family_id: familyId,
        p_contact_id: contactId,
        p_expected_version: expectedVersion ?? null,
      });
      if (error || !data) {
        if (error) mapRpcError(error);
        throw new Core2Error("unavailable", 503, "Failed to revoke trusted contact.");
      }
      return mapContact(data as Row);
    },

    async createSosEvent(input) {
      const { data, error } = await db
        .from("core2_sos_events")
        .insert({
          family_id: input.familyId,
          subject_person_id: input.subjectPersonId,
          incident_id: input.incidentId,
          request_id: input.requestId,
          raw_event_id: input.rawEventId,
          status: input.status,
          delivery_status: input.deliveryStatus,
          countdown_until: input.countdownUntil,
        })
        .select("*")
        .single();
      if (error || !data) throw new Core2Error("unavailable", 503, "Failed to persist SOS event.");
      return mapSos(data as Row);
    },

    async updateSosStatus(input) {
      const patch: Row = {
        status: input.status,
        updated_at: new Date().toISOString(),
      };
      if (input.deliveryStatus !== undefined) patch.delivery_status = input.deliveryStatus;
      if (input.cancelledAt !== undefined) patch.cancelled_at = input.cancelledAt;
      if (input.safeAt !== undefined) patch.safe_at = input.safeAt;
      if (input.expectedVersion !== undefined) patch.version = input.expectedVersion + 1;

      let q = db
        .from("core2_sos_events")
        .update(patch)
        .eq("family_id", input.familyId)
        .eq("id", input.sosId);
      if (input.expectedVersion !== undefined) {
        q = q.eq("version", input.expectedVersion);
      }
      const { data, error } = await q.select("*").maybeSingle();
      if (error) mapRpcError(error);
      if (!data) throw new Core2Error("stale_version", 409, "SOS version conflict.");
      return mapSos(data as Row);
    },

    async getSosEvent(familyId, sosId) {
      const { data, error } = await db
        .from("core2_sos_events")
        .select("*")
        .eq("family_id", familyId)
        .eq("id", sosId)
        .maybeSingle();
      if (error) throw new Core2Error("unavailable", 503, "SOS lookup failed.");
      return data ? mapSos(data as Row) : null;
    },

    async listSosEvents(familyId, subjectPersonId, limit) {
      let q = db
        .from("core2_sos_events")
        .select("*")
        .eq("family_id", familyId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (subjectPersonId) q = q.eq("subject_person_id", subjectPersonId);
      const { data, error } = await q;
      if (error || !Array.isArray(data)) throw new Core2Error("unavailable", 503, "SOS list failed.");
      return (data as Row[]).map(mapSos);
    },

    async createWatch(input) {
      const { data, error } = await db
        .from("core2_watches")
        .insert({
          family_id: input.familyId,
          subject_person_id: input.subjectPersonId,
          raw_event_id: input.rawEventId,
          request_id: input.requestId,
          timezone: input.timezone,
          grace_minutes: input.graceMinutes,
          deadline_at: input.deadlineAt,
          grace_until: input.graceUntil,
          next_tick_at: input.nextTickAt,
          route_ciphertext: input.routeCiphertext,
        })
        .select("*")
        .single();
      if (error || !data) throw new Core2Error("unavailable", 503, "Failed to create watch.");
      return mapWatch(data as Row);
    },

    async extendWatch(input) {
      const { data: existing, error: fetchErr } = await db
        .from("core2_watches")
        .select("*")
        .eq("family_id", input.familyId)
        .eq("id", input.watchId)
        .maybeSingle();
      if (fetchErr) throw new Core2Error("unavailable", 503, "Watch lookup failed.");
      if (!existing) throw new Core2Error("not_found", 404, "Watch not found.");
      const w = mapWatch(existing as Row);
      if (w.state !== "active" && w.state !== "checking_in") {
        throw new Core2Error("conflict", 409, "Cannot extend a resolved or escalated watch.");
      }
      if (w.version !== input.expectedVersion) {
        throw new Core2Error("stale_version", 409, "Watch version conflict.");
      }
      const baseMs = Math.max(Date.parse(w.deadlineAt), Date.parse(input.nowIso));
      const newDeadline = new Date(baseMs + (input.addMs ?? input.addMinutes * 60_000));
      const newGrace = new Date(newDeadline.getTime() + (input.graceMs ?? w.graceMinutes * 60_000));
      const { data, error } = await db
        .from("core2_watches")
        .update({
          state: "active",
          deadline_at: newDeadline.toISOString(),
          grace_until: newGrace.toISOString(),
          next_tick_at: newDeadline.toISOString(),
          version: w.version + 1,
          updated_at: input.nowIso,
        })
        .eq("family_id", input.familyId)
        .eq("id", input.watchId)
        .eq("version", w.version)
        .in("state", ["active", "checking_in"])
        .select("*")
        .maybeSingle();
      if (error) mapRpcError(error);
      if (!data) throw new Core2Error("stale_version", 409, "Watch changed concurrently.");
      return mapWatch(data as Row);
    },

    async cancelWatch(input) {
      const { data: existing, error: fetchErr } = await db
        .from("core2_watches")
        .select("*")
        .eq("family_id", input.familyId)
        .eq("id", input.watchId)
        .maybeSingle();
      if (fetchErr) throw new Core2Error("unavailable", 503, "Watch lookup failed.");
      if (!existing) throw new Core2Error("not_found", 404, "Watch not found.");
      const w = mapWatch(existing as Row);
      if (w.state === "safe") throw new Core2Error("conflict", 409, "Watch is already safe.");
      if (w.state === "cancelled") return w;
      if (input.expectedVersion !== undefined && w.version !== input.expectedVersion) {
        throw new Core2Error("stale_version", 409, "Watch version conflict.");
      }
      const { data, error } = await db
        .from("core2_watches")
        .update({
          state: "cancelled",
          cancelled_at: input.nowIso,
          next_tick_at: null,
          version: w.version + 1,
          updated_at: input.nowIso,
        })
        .eq("family_id", input.familyId)
        .eq("id", input.watchId)
        .eq("version", w.version)
        .select("*")
        .maybeSingle();
      if (error) mapRpcError(error);
      if (!data) throw new Core2Error("stale_version", 409, "Watch changed concurrently.");
      return mapWatch(data as Row);
    },

    async resolveWatchSafe(input) {
      const { data, error } = await db.rpc("core2_resolve_watch_safe", {
        p_family_id: input.familyId,
        p_watch_id: input.watchId,
        p_subject_person_id: input.subjectPersonId,
        p_expected_version: input.expectedVersion ?? null,
        p_idempotency_key_hash: input.idempotencyKeyHash,
        p_voice_post_id: input.voicePostId ?? null,
      });
      if (error || !data) {
        if (error) mapRpcError(error);
        throw new Core2Error("unavailable", 503, "Failed to resolve watch safe.");
      }
      return mapWatch(data as Row);
    },

    async tickDueWatches(nowIso, limit) {
      const { data, error } = await db.rpc("core2_tick_due_watches", {
        p_now: nowIso,
        p_limit: limit,
      });
      if (error || !Array.isArray(data)) {
        throw new Core2Error("unavailable", 503, "Watch tick RPC failed.");
      }
      return (data as Row[]).map(mapWatch);
    },

    async getWatch(familyId, watchId) {
      const { data, error } = await db
        .from("core2_watches")
        .select("*")
        .eq("family_id", familyId)
        .eq("id", watchId)
        .maybeSingle();
      if (error) throw new Core2Error("unavailable", 503, "Watch lookup failed.");
      return data ? mapWatch(data as Row) : null;
    },

    async listWatches(familyId, subjectPersonId, limit) {
      let q = db
        .from("core2_watches")
        .select("*")
        .eq("family_id", familyId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (subjectPersonId) q = q.eq("subject_person_id", subjectPersonId);
      const { data, error } = await q;
      if (error || !Array.isArray(data)) throw new Core2Error("unavailable", 503, "Watch list failed.");
      return (data as Row[]).map(mapWatch);
    },

    async getVoicePost(familyId, postId): Promise<Core2VoicePostRecord | null> {
      const { data, error } = await db
        .from("voice_posts")
        .select("id,family_id,sender_id,recipient_id,consent_id")
        .eq("family_id", familyId)
        .eq("id", postId)
        .maybeSingle();
      if (error) throw new Core2Error("unavailable", 503, "Voice post lookup failed.");
      if (!data) return null;
      const r = data as Row;
      return {
        id: str(r.id),
        familyId: str(r.family_id),
        senderId: str(r.sender_id),
        recipientId: str(r.recipient_id),
        consentId: str(r.consent_id),
      };
    },

    async getConsent(familyId, consentId) {
      const { data, error } = await db
        .from("consents")
        .select("id,family_id,person_id,call_id,purpose,answer,version,created_at")
        .eq("family_id", familyId)
        .eq("id", consentId)
        .maybeSingle();
      if (error) throw new Core2Error("unavailable", 503, "Consent lookup failed.");
      return data ? mapConsent(data as Row) : null;
    },

    async listConsentHistory(familyId, personId, purpose) {
      const { data, error } = await db
        .from("consents")
        .select("id,family_id,person_id,call_id,purpose,answer,version,created_at")
        .eq("family_id", familyId)
        .eq("person_id", personId)
        .eq("purpose", purpose)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error || !Array.isArray(data) || data.length >= 200) {
        throw new Core2Error("unavailable", 503, "Consent history unavailable.");
      }
      return (data as Row[]).map(mapConsent);
    },

    async getSharingPreferences(familyId, subjectPersonId): Promise<SharingPreferencesRow> {
      const { data, error } = await db
        .from("core2_sharing_preferences")
        .select("*")
        .eq("family_id", familyId)
        .eq("subject_person_id", subjectPersonId)
        .maybeSingle();
      if (error) throw new Core2Error("unavailable", 503, "Sharing preferences lookup failed.");
      if (!data) {
        return {
          familyId,
          subjectPersonId,
          shareStatusWithParent: true,
          allowLocationShare: false,
          allowHealthShare: false,
          allowNarrativeShare: false,
          version: 1,
          updatedAt: new Date(0).toISOString(),
        };
      }
      const r = data as Row;
      return {
        familyId: str(r.family_id),
        subjectPersonId: str(r.subject_person_id),
        shareStatusWithParent: r.share_status_with_parent === true,
        allowLocationShare: r.allow_location_share === true,
        allowHealthShare: r.allow_health_share === true,
        allowNarrativeShare: r.allow_narrative_share === true,
        version: num(r.version),
        updatedAt: str(r.updated_at),
      };
    },

    async upsertSharingPreferences(input): Promise<SharingPreferencesRow> {
      const existing = await this.getSharingPreferences(input.familyId, input.subjectPersonId);
      const { data, error } = await db
        .from("core2_sharing_preferences")
        .upsert(
          {
            family_id: input.familyId,
            subject_person_id: input.subjectPersonId,
            share_status_with_parent: input.shareStatusWithParent,
            allow_location_share: input.allowLocationShare,
            allow_health_share: input.allowHealthShare,
            allow_narrative_share: input.allowNarrativeShare,
            version: existing.updatedAt === new Date(0).toISOString() ? 1 : existing.version + 1,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "family_id,subject_person_id" },
        )
        .select("*")
        .single();
      if (error || !data) throw new Core2Error("unavailable", 503, "Preferences save failed.");
      const r = data as Row;
      return {
        familyId: str(r.family_id),
        subjectPersonId: str(r.subject_person_id),
        shareStatusWithParent: r.share_status_with_parent === true,
        allowLocationShare: r.allow_location_share === true,
        allowHealthShare: r.allow_health_share === true,
        allowNarrativeShare: r.allow_narrative_share === true,
        version: num(r.version),
        updatedAt: str(r.updated_at),
      };
    },

    async createReassuranceUpdate(input) {
      const { data, error } = await db
        .from("core2_reassurance_updates")
        .insert({
          family_id: input.familyId,
          subject_person_id: input.subjectPersonId,
          recipient_person_id: input.recipientPersonId,
          kind: input.kind,
          watch_id: input.watchId,
          sos_id: input.sosId,
          voice_post_id: input.voicePostId,
          outbox_id: input.outboxId,
          status_label: input.statusLabel,
          delivery_status: input.deliveryStatus,
          location_shared: input.locationShared,
          health_shared: input.healthShared,
          narrative_shared: input.narrativeShared,
        })
        .select("*")
        .single();
      if (error || !data) throw new Core2Error("unavailable", 503, "Reassurance persistence failed.");
      return mapReassurance(data as Row);
    },

    async listReassuranceUpdates(familyId, recipientOrSubjectPersonId, limit) {
      let q = db
        .from("core2_reassurance_updates")
        .select("*")
        .eq("family_id", familyId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (recipientOrSubjectPersonId) {
        q = q.or(
          `subject_person_id.eq.${recipientOrSubjectPersonId},recipient_person_id.eq.${recipientOrSubjectPersonId}`,
        );
      }
      const { data, error } = await q;
      if (error || !Array.isArray(data)) throw new Core2Error("unavailable", 503, "Reassurance list failed.");
      return (data as Row[]).map(mapReassurance);
    },

    async fencePendingSosDispatches(familyId, sosId, reason) {
      const nowIso = new Date().toISOString();
      const { data: fences, error } = await db
        .from("core2_dispatch_fences")
        .update({ state: "fenced_resolved", fenced_at: nowIso })
        .eq("family_id", familyId)
        .eq("sos_id", sosId)
        .eq("state", "armed")
        .select("outbox_id");
      if (error) throw new Core2Error("unavailable", 503, "Failed to fence SOS dispatches.");
      const outboxIds = ((fences ?? []) as Row[]).map((f) => str(f.outbox_id));
      if (outboxIds.length > 0) {
        await db
          .from("outbox")
          .update({ status: "failed", last_error_code: `sos_${reason}` })
          .in("id", outboxIds)
          .eq("status", "pending")
          .is("lease_token", null);
      }
    },

    async listDueEscalations(nowIso, limit): Promise<DueIncidentEscalation[]> {
      const { data, error } = await db
        .from("core2_incident_escalations")
        .select("incident_id,family_id,subject_person_id,watch_id,sos_id,offer_expires_at")
        .is("exhausted_at", null)
        .not("offer_expires_at", "is", null)
        .lte("offer_expires_at", nowIso)
        .order("offer_expires_at", { ascending: true })
        .limit(limit);
      if (error || !Array.isArray(data)) {
        throw new Core2Error("unavailable", 503, "Due escalation lookup failed.");
      }
      return (data as Row[]).map((r) => ({
        incidentId: str(r.incident_id),
        familyId: str(r.family_id),
        subjectPersonId: str(r.subject_person_id),
        watchId: optStr(r.watch_id),
        sosId: optStr(r.sos_id),
        offerExpiresAt: str(r.offer_expires_at),
      }));
    },

    async offerNextTrustedContact(input): Promise<OfferNextContactResult> {
      const { data, error } = await db.rpc("core2_offer_next_trusted_contact", {
        p_family_id: input.familyId,
        p_incident_id: input.incidentId,
        p_scope: input.scope,
        p_offer_expires_at: input.offerExpiresAt,
        p_now: input.nowIso,
      });
      if (error) mapRpcError(error);
      const r = Array.isArray(data) ? ((data[0] as Row | undefined) ?? null) : ((data as Row | null) ?? null);
      if (!r) {
        return {
          assignmentId: null,
          trustedContactId: null,
          contactPersonId: null,
          rank: null,
          offeredAt: null,
          expiresAt: null,
          newlyCreated: false,
          exhausted: false,
        };
      }
      return {
        assignmentId: optStr(r.assignment_id),
        trustedContactId: optStr(r.trusted_contact_id),
        contactPersonId: optStr(r.contact_person_id),
        rank: r.rank === null || r.rank === undefined ? null : num(r.rank),
        offeredAt: optStr(r.offered_at),
        expiresAt: optStr(r.expires_at),
        newlyCreated: r.newly_created === true,
        exhausted: r.exhausted === true,
      };
    },

    async acceptIncidentAssignment(input): Promise<AcceptIncidentResult> {
      const { data, error } = await db.rpc("core2_accept_incident_assignment", {
        p_family_id: input.familyId,
        p_incident_id: input.incidentId,
        p_actor_person_id: input.actorPersonId,
        p_raw_event_id: input.rawEventId,
        p_now: input.nowIso,
      });
      if (error) mapRpcError(error);
      const r = Array.isArray(data) ? ((data[0] as Row | undefined) ?? null) : ((data as Row | null) ?? null);
      if (!r) throw new Core2Error("unavailable", 503, "Incident accept RPC returned empty.");
      return {
        assignmentId: str(r.assignment_id),
        incidentId: str(r.incident_id),
        subjectPersonId: str(r.subject_person_id),
        responderPersonId: str(r.responder_person_id),
        offeredAt: str(r.offered_at),
        acceptedAt: str(r.accepted_at),
        alreadyAccepted: r.already_accepted === true,
      };
    },

    async declineIncidentAssignment(input): Promise<DeclineIncidentResult> {
      const { data, error } = await db.rpc("core2_decline_incident_assignment", {
        p_family_id: input.familyId,
        p_incident_id: input.incidentId,
        p_actor_person_id: input.actorPersonId,
        p_now: input.nowIso,
      });
      if (error) mapRpcError(error);
      const r = Array.isArray(data) ? ((data[0] as Row | undefined) ?? null) : ((data as Row | null) ?? null);
      if (!r) throw new Core2Error("unavailable", 503, "Incident decline RPC returned empty.");
      return {
        assignmentId: str(r.assignment_id),
        incidentId: str(r.incident_id),
        subjectPersonId: str(r.subject_person_id),
        alreadyDeclined: r.already_declined === true,
      };
    },

    async loadTruthLineSnapshot(input): Promise<TruthLineStateSnapshot> {
      let child: Core2Person | null = null;
      if (input.subjectPersonId) {
        const candidate = await this.getPerson(input.familyId, input.subjectPersonId);
        if (!candidate || candidate.role !== "child") {
          throw new Core2Error("not_found", 404, "Subject child person not found in family.");
        }
        child = candidate;
      } else {
        const children = await this.listPeopleByRole(input.familyId, "child");
        child = children[0] ?? null;
        if (!child) {
          throw new Core2Error("not_found", 404, "No child member found in family.");
        }
      }

      const preferences = await this.getSharingPreferences(input.familyId, child.id);
      if (!preferences.shareStatusWithParent) {
        return {
          child,
          preferences,
          latestWatch: null,
          activeIncidentOwnerName: null,
          latestSos: null,
          latestReassurance: null,
        };
      }

      const [watches, sosList, reassurances] = await Promise.all([
        this.listWatches(input.familyId, child.id, 1),
        this.listSosEvents(input.familyId, child.id, 1),
        this.listReassuranceUpdates(input.familyId, child.id, 1),
      ]);
      const latestWatch = watches[0] ?? null;
      const latestSos = sosList[0] ?? null;
      const latestReassurance = reassurances[0] ?? null;

      const activeIncidentIds: string[] = [];
      if (
        latestWatch?.incidentId &&
        (latestWatch.state === "active" ||
          latestWatch.state === "checking_in" ||
          latestWatch.state === "escalated")
      ) {
        activeIncidentIds.push(latestWatch.incidentId);
      }
      if (latestSos && latestSos.status !== "safe" && latestSos.status !== "cancelled") {
        activeIncidentIds.push(latestSos.incidentId);
      }

      let activeIncidentOwnerName: string | null = null;
      if (activeIncidentIds.length > 0) {
        const { data: acceptedInc, error: incErr } = await db
          .from("incidents")
          .select("owner_person_id")
          .eq("family_id", input.familyId)
          .in("id", activeIncidentIds)
          .not("owner_person_id", "is", null)
          .limit(1)
          .maybeSingle();
        if (incErr) {
          throw new Core2Error("unavailable", 503, "Incident owner lookup failed.");
        }
        const ownerId = acceptedInc ? optStr((acceptedInc as Row).owner_person_id) : null;
        if (ownerId) {
          const owner = await this.getPerson(input.familyId, ownerId);
          activeIncidentOwnerName = owner?.displayName ?? null;
        }
      }

      return {
        child,
        preferences,
        latestWatch,
        activeIncidentOwnerName,
        latestSos,
        latestReassurance,
      };
    },
  };
}

export function createSupabaseDispatchPort(db: SupabaseClient): Core2DispatchPort {
  return {
    async enqueueAuthorized(request) {
      const { data: existing } = await db
        .from("outbox")
        .select("id")
        .eq("family_id", request.familyId)
        .eq("dedupe_key", request.dedupeKey)
        .maybeSingle();
      if (existing) {
        return { outboxId: str((existing as Row).id), status: "pending" };
      }

      const { data, error } = await db
        .from("outbox")
        .insert({
          family_id: request.familyId,
          action_request_id: request.actionRequestId,
          kind: request.kind,
          dedupe_key: request.dedupeKey,
          payload_ciphertext: request.payloadCiphertext,
          status: "pending",
        })
        .select("id")
        .single();
      if (error || !data) throw new Core2Error("unavailable", 503, "Failed to enqueue outbox command.");
      const outboxId = str((data as Row).id);

      const { error: fenceErr } = await db.from("core2_dispatch_fences").upsert(
        {
          family_id: request.familyId,
          outbox_id: outboxId,
          trusted_contact_id: request.trustedContactId ?? null,
          watch_id: request.watchId ?? null,
          sos_id: request.sosId ?? null,
          state: "armed",
        },
        { onConflict: "outbox_id" },
      );
      if (fenceErr) throw new Core2Error("unavailable", 503, "Failed to arm dispatch fence.");

      return { outboxId, status: "pending" };
    },
  };
}

export function createSupabaseTimelinePort(
  db: SupabaseClient,
  privateKeyPem: string | undefined,
  keyId: string,
): Core2TimelinePort {
  return {
    async append(input) {
      if (!privateKeyPem) {
        throw new Core2Error("storage_unavailable", 503, "Timeline signing key is not configured.");
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { data: head } = await db
          .from("timeline_stream_heads")
          .select("last_sequence,last_chain_hash")
          .eq("family_id", input.familyId)
          .maybeSingle();

        const sequence = head ? num((head as Row).last_sequence) + 1 : 1;
        const previousHash = head ? optStr((head as Row).last_chain_hash) : null;

        const signed = signTimelineEvent(
          {
            familyId: input.familyId,
            eventId: input.eventId,
            sequence,
            previousHash,
            dedupeKey: input.dedupeKey,
            eventType: input.eventType,
            entityId: input.entityId,
            humanLine: input.humanLine,
            occurredAt: input.occurredAt,
            keyId,
            payload: input.payload,
          },
          privateKeyPem,
        );

        const { error } = await db.rpc("append_timeline_event", {
          p_event: signed.envelope,
          p_payload_canonical: canonicalJson(input.payload),
          p_chain_hash: signed.chainHash,
          p_signature: signed.signature,
        });
        if (!error) return;
        if (error.code !== "40001") {
          throw new Core2Error("unavailable", 503, "Timeline append failed.");
        }
      }
      throw new Core2Error("unavailable", 503, "Timeline stream contention exceeded retries.");
    },
  };
}

export function createProductionCore2Deps(): Core2Deps {
  const encryptionKey = process.env.WEBHOOK_ENCRYPTION_KEY;
  const identitySecret = process.env.IDENTITY_HASH_SECRET;
  const timelineKey = process.env.TIMELINE_SIGNING_PRIVATE_KEY;
  const timelineKeyId = process.env.TIMELINE_SIGNING_KEY_ID || "core2-default";
  if (!encryptionKey || !identitySecret || !timelineKey) {
    throw new Core2Error(
      "storage_unavailable",
      503,
      "Core 2 encryption or timeline signing configuration missing.",
    );
  }
  const db = serviceDatabase();
  const baseAuth = supabaseAuth(db);
  const auth: Core2AuthPort = {
    verifyBearer: (token) => baseAuth.verifyBearer(token),
  };
  const gate: Core2GatePort = {
    evaluate: async (input: GateInput): Promise<GateDecision> =>
      (await loadGateModule()).evaluateGate(input),
  };
  const crypto = createWebhookCryptoPort(encryptionKey);

  return {
    auth,
    repo: createSupabaseCore2Repository(db),
    dispatch: createSupabaseDispatchPort(db),
    gate,
    timeline: createSupabaseTimelinePort(db, timelineKey, timelineKeyId),
    crypto,
  };
}

export { sha256Hex };
