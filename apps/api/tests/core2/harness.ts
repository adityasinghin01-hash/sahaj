import { generateKeyPairSync, randomUUID } from "node:crypto";
import { evaluateGate, type GateInput, type SetupPermission } from "@sahaj/gate";
import {
  Core2Error,
  createCore2RouteHandlers,
  createCore2Service,
  createWebhookCryptoPort,
  type AcceptIncidentResult,
  type Core2ConsentRecord,
  type Core2Deps,
  type Core2IdempotencyRecord,
  type Core2Membership,
  type Core2Person,
  type Core2Repository,
  type Core2TimelineAppendInput,
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
} from "../../src/lib/core2";
import { canonicalJson, signTimelineEvent, type SignedTimelineEvent } from "../../src/lib/timeline";

const TEST_ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export const SYNTH_IDS = {
  familyA: "b5000000-0000-4000-8000-000000000001",
  familyB: "b5000000-0000-4000-8000-000000000002",
  userRiya: "a5000000-0000-4000-8000-000000000001",
  userMaa: "a5000000-0000-4000-8000-000000000002",
  userNeha: "a5000000-0000-4000-8000-000000000003",
  userRohitSameFamily: "a5000000-0000-4000-8000-000000000004",
  userOtherFamily: "a5000000-0000-4000-8000-000000000005",
  personRiya: "c5000000-0000-4000-8000-000000000001",
  personMaa: "c5000000-0000-4000-8000-000000000002",
  personNeha: "c5000000-0000-4000-8000-000000000003",
  personRohitSameFamily: "c5000000-0000-4000-8000-000000000004",
  personOtherFamily: "c5000000-0000-4000-8000-000000000005",
} as const;

export function createCore2TestHarness(options?: { env?: Record<string, string | undefined> }) {
  let currentNow = new Date("2026-11-14T18:00:00.000Z");
  const keyPair = generateKeyPairSync("ed25519");
  const testEnv: Record<string, string | undefined> = {
    CRON_SECRET: "test-cron-secret",
    SARVAM_TOOL_TOKEN: "test-sarvam-token",
    ...(options?.env ?? {}),
  };

  const tokens = new Map<string, string>([
    ["tok-riya", SYNTH_IDS.userRiya],
    ["tok-maa", SYNTH_IDS.userMaa],
    ["tok-neha", SYNTH_IDS.userNeha],
    ["tok-rohit", SYNTH_IDS.userRohitSameFamily],
    ["tok-other", SYNTH_IDS.userOtherFamily],
  ]);

  const memberships: Core2Membership[] = [
    {
      familyId: SYNTH_IDS.familyA,
      userId: SYNTH_IDS.userRiya,
      personId: SYNTH_IDS.personRiya,
      role: "child",
      revokedAt: null,
    },
    {
      familyId: SYNTH_IDS.familyA,
      userId: SYNTH_IDS.userMaa,
      personId: SYNTH_IDS.personMaa,
      role: "parent",
      revokedAt: null,
    },
    {
      familyId: SYNTH_IDS.familyA,
      userId: SYNTH_IDS.userNeha,
      personId: SYNTH_IDS.personNeha,
      role: "circle",
      revokedAt: null,
    },
    {
      familyId: SYNTH_IDS.familyA,
      userId: SYNTH_IDS.userRohitSameFamily,
      personId: SYNTH_IDS.personRohitSameFamily,
      role: "child",
      revokedAt: null,
    },
    {
      familyId: SYNTH_IDS.familyB,
      userId: SYNTH_IDS.userOtherFamily,
      personId: SYNTH_IDS.personOtherFamily,
      role: "child",
      revokedAt: null,
    },
  ];

  const people: Core2Person[] = [
    { id: SYNTH_IDS.personRiya, familyId: SYNTH_IDS.familyA, displayName: "Riya", role: "child", timezone: "Asia/Kolkata" },
    { id: SYNTH_IDS.personMaa, familyId: SYNTH_IDS.familyA, displayName: "Meena", role: "parent", timezone: "Asia/Kolkata" },
    { id: SYNTH_IDS.personNeha, familyId: SYNTH_IDS.familyA, displayName: "Neha", role: "circle", timezone: "Asia/Kolkata" },
    { id: SYNTH_IDS.personRohitSameFamily, familyId: SYNTH_IDS.familyA, displayName: "Rohit", role: "child", timezone: "Asia/Kolkata" },
    { id: SYNTH_IDS.personOtherFamily, familyId: SYNTH_IDS.familyB, displayName: "Other", role: "child", timezone: "Asia/Kolkata" },
  ];

  const rawEvents: Array<{
    id: string;
    familyId: string;
    source: string;
    providerEventId: string;
    eventType: string;
    payloadHash: string;
    payloadCiphertext: string;
  }> = [];
  const idempotency: Core2IdempotencyRecord[] = [];
  const contacts: TrustedContactRow[] = [];
  const watches: WatchRow[] = [];
  const sosEvents: SosRow[] = [];
  const consents: Core2ConsentRecord[] = [];
  const voicePosts: Core2VoicePostRecord[] = [];
  const preferences = new Map<string, SharingPreferencesRow>();
  const reassuranceUpdates: ReassuranceRow[] = [];
  const incidents = new Map<
    string,
    { id: string; familyId: string; personId: string; state: string; ownerPersonId: string | null }
  >();
  const assignments: Array<{
    id: string;
    familyId: string;
    incidentId: string;
    personId: string;
    status: string;
    offeredAt: string;
    expiresAt: string;
    acceptedAt: string | null;
    verifiedByProviderEvent: string | null;
  }> = [];
  const incidentEscalations = new Map<
    string,
    {
      incidentId: string;
      familyId: string;
      subjectPersonId: string;
      watchId: string | null;
      sosId: string | null;
      currentAssignmentId: string | null;
      currentContactId: string | null;
      offerExpiresAt: string | null;
      exhaustedAt: string | null;
    }
  >();
  const outbox: Array<{
    id: string;
    familyId: string;
    kind: string;
    dedupeKey: string;
    status: string;
    payloadCiphertext: string;
    trustedContactId?: string | null;
    watchId?: string | null;
    sosId?: string | null;
  }> = [];
  const timelineEvents: Array<{ raw: Core2TimelineAppendInput; signed: SignedTimelineEvent }> = [];
  const heads = new Map<string, { sequence: number; chainHash: string | null }>();

  // Default Cedar SetupPermissions for Family A child Riya targeting Neha & Maa & self
  const permissions: SetupPermission[] = [
    {
      id: "91000000-0000-4000-8000-000000000001",
      familyId: SYNTH_IDS.familyA,
      actorId: SYNTH_IDS.personRiya,
      action: "urgent_responder",
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
      maxAmountMinor: 0,
      vendorIds: [],
      itemIds: [],
      targetIds: [SYNTH_IDS.personNeha, SYNTH_IDS.personMaa, SYNTH_IDS.personRohitSameFamily],
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2099-01-01T00:00:00.000Z",
      maxUses: 100,
      usedCount: 0,
      approvalMode: "setup",
    },
    {
      id: "91000000-0000-4000-8000-000000000002",
      familyId: SYNTH_IDS.familyA,
      actorId: SYNTH_IDS.personRiya,
      action: "check_in",
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
      maxAmountMinor: 0,
      vendorIds: [],
      itemIds: [],
      targetIds: [SYNTH_IDS.personRiya],
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2099-01-01T00:00:00.000Z",
      maxUses: 100,
      usedCount: 0,
      approvalMode: "setup",
    },
    {
      id: "91000000-0000-4000-8000-000000000003",
      familyId: SYNTH_IDS.familyA,
      actorId: SYNTH_IDS.personRiya,
      action: "share_data",
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
      maxAmountMinor: 0,
      vendorIds: [],
      itemIds: [],
      targetIds: [SYNTH_IDS.personMaa, SYNTH_IDS.personNeha],
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2099-01-01T00:00:00.000Z",
      maxUses: 100,
      usedCount: 0,
      approvalMode: "setup",
    },
    {
      id: "91000000-0000-4000-8000-000000000004",
      familyId: SYNTH_IDS.familyA,
      actorId: SYNTH_IDS.personRiya,
      action: "voice_message",
      validFrom: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
      maxAmountMinor: 0,
      vendorIds: [],
      itemIds: [],
      targetIds: [SYNTH_IDS.personMaa, SYNTH_IDS.personNeha],
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2099-01-01T00:00:00.000Z",
      maxUses: 100,
      usedCount: 0,
      approvalMode: "setup",
    },
  ];

  // Seed sharing_data consent for Riya -> Maa & Neha (for share_data gate check)
  consents.push(
    {
      id: "f5000000-0000-4000-8000-000000000001",
      familyId: SYNTH_IDS.familyA,
      personId: SYNTH_IDS.personRiya,
      callId: null,
      purpose: "share_data",
      answer: true,
      version: "v1",
      createdAt: "2026-11-14T10:00:00.000Z",
    },
  );

  let failRawIngest = false;

  const repo: Core2Repository = {
    async listActiveMemberships(userId) {
      return memberships.filter((m) => m.userId === userId && m.revokedAt === null);
    },
    async getPerson(familyId, personId) {
      return people.find((p) => p.familyId === familyId && p.id === personId) ?? null;
    },
    async listPeopleByRole(familyId, role) {
      return people.filter((p) => p.familyId === familyId && p.role === role);
    },
    async getIdempotency(familyId, actorPersonId, action, keyHash) {
      return (
        idempotency.find(
          (r) =>
            r.familyId === familyId &&
            r.actorPersonId === actorPersonId &&
            r.action === action &&
            r.keyHash === keyHash,
        ) ?? null
      );
    },
    async saveIdempotency(record) {
      idempotency.push(record);
    },
    async ingestRawEvent(input) {
      if (failRawIngest) throw new Error("db_down");
      const existing = rawEvents.find(
        (e) => e.source === input.source && e.providerEventId === input.providerEventId,
      );
      if (existing) {
        if (existing.payloadHash !== input.payloadHash || existing.familyId !== input.familyId) {
          throw new Core2Error("conflict", 409, "Event ID conflict");
        }
        return { rawEventId: existing.id };
      }
      const id = randomUUID();
      rawEvents.push({ id, ...input });
      return { rawEventId: id };
    },
    async loadGateInput(input): Promise<GateInput> {
      const activeMember = memberships.some(
        (m) => m.familyId === input.familyId && m.personId === input.actorPersonId && m.revokedAt === null,
      );
      return {
        actor: { id: input.actorPersonId, familyId: input.familyId, active: activeMember },
        request: {
          id: input.requestId,
          familyId: input.familyId,
          action: input.action,
          targetId: input.targetId,
          consentSubjectId: input.consentSubjectId,
        },
        permissions: permissions.map((p) => ({ ...p })),
        approvals: [],
        consents: consents
          .filter((c) => c.familyId === input.familyId && c.personId === (input.consentSubjectId ?? input.actorPersonId) && c.answer)
          .map((c) => ({
            familyId: c.familyId,
            subjectId: c.personId,
            targetId: input.targetId,
            scope: input.action === "share_data" ? "share_data" : "record_audio",
            grantedAt: c.createdAt,
            expiresAt: "2099-01-01T00:00:00.000Z",
            revokedAt: null,
          })),
        now: input.now,
      };
    },
    async createRequestAndIncident(input) {
      const requestId = randomUUID();
      const incidentId = randomUUID();
      incidents.set(incidentId, {
        id: incidentId,
        familyId: input.familyId,
        personId: input.personId,
        state: input.incidentState,
        ownerPersonId: null,
      });
      return { requestId, incidentId };
    },
    async createAssignment(input) {
      const assignmentId = randomUUID();
      assignments.push({
        id: assignmentId,
        familyId: input.familyId,
        incidentId: input.incidentId,
        personId: input.personId,
        status: "offered",
        offeredAt: currentNow.toISOString(),
        expiresAt: input.expiresAt,
        acceptedAt: null,
        verifiedByProviderEvent: null,
      });
      return { assignmentId };
    },
    async listActiveTrustedContacts(familyId, subjectPersonId, scope, nowIso) {
      const nowMs = Date.parse(nowIso);
      return contacts
        .filter(
          (c) =>
            c.familyId === familyId &&
            c.subjectPersonId === subjectPersonId &&
            c.state === "active" &&
            c.revokedAt === null &&
            c.scopes.includes(scope) &&
            Date.parse(c.effectiveFrom) <= nowMs &&
            (c.effectiveUntil === null || Date.parse(c.effectiveUntil) > nowMs),
        )
        .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
    },
    async listTrustedContacts(familyId, subjectPersonId, includeRevoked, limit) {
      return contacts
        .filter(
          (c) =>
            c.familyId === familyId &&
            (c.subjectPersonId === subjectPersonId || c.contactPersonId === subjectPersonId) &&
            (includeRevoked || c.state !== "revoked"),
        )
        .slice(0, limit);
    },
    async getTrustedContact(familyId, contactId) {
      return contacts.find((c) => c.familyId === familyId && c.id === contactId) ?? null;
    },
    async createTrustedContact(input) {
      const existing = contacts.find(
        (c) =>
          c.familyId === input.familyId &&
          c.subjectPersonId === input.subjectPersonId &&
          c.contactPersonId === input.contactPersonId &&
          c.state !== "revoked",
      );
      if (existing) throw new Core2Error("conflict", 409, "Trusted contact already exists.");
      const nowIso = currentNow.toISOString();
      const row: TrustedContactRow = {
        id: randomUUID(),
        familyId: input.familyId,
        subjectPersonId: input.subjectPersonId,
        contactPersonId: input.contactPersonId,
        contactDisplayName: people.find((p) => p.id === input.contactPersonId)?.displayName,
        rank: input.rank,
        scopes: input.scopes,
        state: "invited",
        approvedAt: null,
        consentId: null,
        consentAt: null,
        effectiveFrom: input.effectiveFrom,
        effectiveUntil: input.effectiveUntil,
        revokedAt: null,
        version: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      contacts.push(row);
      return { ...row };
    },
    async approveTrustedContact(input) {
      const row = contacts.find((c) => c.familyId === input.familyId && c.id === input.contactId);
      if (!row || row.state === "revoked") throw new Core2Error("conflict", 409, "Invalid contact state");
      const consentId = randomUUID();
      consents.push({
        id: consentId,
        familyId: input.familyId,
        personId: input.consentPersonId,
        callId: null,
        purpose: "trusted_contact",
        answer: true,
        version: input.consentVersion,
        createdAt: input.nowIso,
      });
      row.state = "active";
      row.approvedAt = input.nowIso;
      row.consentAt = input.nowIso;
      row.consentId = consentId;
      row.version += 1;
      row.updatedAt = input.nowIso;
      return { ...row };
    },
    async updateTrustedContact(input) {
      const row = contacts.find((c) => c.familyId === input.familyId && c.id === input.contactId);
      if (!row || row.state === "revoked" || row.version !== input.expectedVersion) {
        throw new Core2Error("stale_version", 409, "Version conflict");
      }
      if (input.rank !== undefined) row.rank = input.rank;
      if (input.scopes !== undefined) row.scopes = input.scopes;
      if (input.effectiveUntil !== undefined) row.effectiveUntil = input.effectiveUntil;
      row.version += 1;
      return { ...row };
    },
    async revokeTrustedContact(familyId, contactId, expectedVersion) {
      const row = contacts.find((c) => c.familyId === familyId && c.id === contactId);
      if (!row) throw new Core2Error("not_found", 404, "Not found");
      if (row.state === "revoked") return { ...row };
      if (expectedVersion !== undefined && row.version !== expectedVersion) {
        throw new Core2Error("stale_version", 409, "Version conflict");
      }
      row.state = "revoked";
      row.revokedAt = currentNow.toISOString();
      row.version += 1;
      for (const o of outbox) {
        if (o.familyId === familyId && o.trustedContactId === contactId && o.status === "pending") {
          o.status = "failed";
        }
      }
      return { ...row };
    },
    async createSosEvent(input) {
      const nowIso = currentNow.toISOString();
      const row: SosRow = {
        id: randomUUID(),
        familyId: input.familyId,
        subjectPersonId: input.subjectPersonId,
        incidentId: input.incidentId,
        requestId: input.requestId,
        rawEventId: input.rawEventId,
        status: input.status,
        deliveryStatus: input.deliveryStatus,
        responderAccepted: false,
        acceptedAssignmentId: null,
        acceptedRawEventId: null,
        version: 1,
        countdownUntil: input.countdownUntil,
        cancelledAt: null,
        safeAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      sosEvents.push(row);
      return { ...row };
    },
    async updateSosStatus(input) {
      const row = sosEvents.find((s) => s.familyId === input.familyId && s.id === input.sosId);
      if (!row) throw new Core2Error("not_found", 404, "SOS not found");
      if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
        throw new Core2Error("stale_version", 409, "SOS version conflict");
      }
      row.status = input.status;
      if (input.deliveryStatus !== undefined) row.deliveryStatus = input.deliveryStatus;
      if (input.cancelledAt !== undefined) row.cancelledAt = input.cancelledAt;
      if (input.safeAt !== undefined) row.safeAt = input.safeAt;
      if (input.expectedVersion !== undefined) row.version += 1;
      row.updatedAt = currentNow.toISOString();
      return { ...row };
    },
    async getSosEvent(familyId, sosId) {
      const row = sosEvents.find((s) => s.familyId === familyId && s.id === sosId);
      return row ? { ...row } : null;
    },
    async listSosEvents(familyId, subjectPersonId, limit) {
      return sosEvents
        .filter((s) => s.familyId === familyId && (!subjectPersonId || s.subjectPersonId === subjectPersonId))
        .slice(-limit)
        .reverse()
        .map((s) => ({ ...s }));
    },
    async createWatch(input) {
      const nowIso = currentNow.toISOString();
      const row: WatchRow = {
        id: randomUUID(),
        familyId: input.familyId,
        subjectPersonId: input.subjectPersonId,
        incidentId: null,
        requestId: input.requestId,
        rawEventId: input.rawEventId,
        timezone: input.timezone,
        state: "active",
        version: 1,
        graceMinutes: input.graceMinutes,
        deadlineAt: input.deadlineAt,
        graceUntil: input.graceUntil,
        nextTickAt: input.nextTickAt,
        checkedInAt: null,
        escalatedAt: null,
        safeAt: null,
        cancelledAt: null,
        safeIdempotencyKeyHash: null,
        safeVoicePostId: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      watches.push(row);
      return { ...row };
    },
    async extendWatch(input) {
      const row = watches.find((w) => w.familyId === input.familyId && w.id === input.watchId);
      if (!row) throw new Core2Error("not_found", 404, "Watch not found");
      if (row.state !== "active" && row.state !== "checking_in") {
        throw new Core2Error("conflict", 409, "Cannot extend resolved watch");
      }
      if (row.version !== input.expectedVersion) throw new Core2Error("stale_version", 409, "Version conflict");
      const baseMs = Math.max(Date.parse(row.deadlineAt), Date.parse(input.nowIso));
      const newDeadline = new Date(baseMs + (input.addMs ?? input.addMinutes * 60_000));
      const newGrace = new Date(newDeadline.getTime() + (input.graceMs ?? row.graceMinutes * 60_000));
      row.state = "active";
      row.deadlineAt = newDeadline.toISOString();
      row.graceUntil = newGrace.toISOString();
      row.nextTickAt = row.deadlineAt;
      row.version += 1;
      row.updatedAt = input.nowIso;
      return { ...row };
    },
    async cancelWatch(input) {
      const row = watches.find((w) => w.familyId === input.familyId && w.id === input.watchId);
      if (!row) throw new Core2Error("not_found", 404, "Watch not found");
      if (row.state === "safe") throw new Core2Error("conflict", 409, "Already safe");
      if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
        throw new Core2Error("stale_version", 409, "Version conflict");
      }
      row.state = "cancelled";
      row.cancelledAt = input.nowIso;
      row.nextTickAt = null;
      row.version += 1;
      row.updatedAt = input.nowIso;
      return { ...row };
    },
    async resolveWatchSafe(input) {
      const row = watches.find((w) => w.familyId === input.familyId && w.id === input.watchId);
      if (!row) throw new Core2Error("not_found", 404, "Watch not found");
      if (row.subjectPersonId !== input.subjectPersonId) throw new Core2Error("forbidden", 403, "Wrong subject");
      if (row.state === "cancelled") throw new Core2Error("watch_cancelled", 409, "Cancelled");
      if (row.state === "safe") {
        if (row.safeIdempotencyKeyHash === input.idempotencyKeyHash) return { ...row };
        if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
          throw new Core2Error("stale_version", 409, "Version conflict");
        }
        return { ...row };
      }
      if (input.expectedVersion !== undefined && row.version !== input.expectedVersion) {
        throw new Core2Error("stale_version", 409, "Version conflict");
      }
      row.state = "safe";
      row.safeAt = currentNow.toISOString();
      row.nextTickAt = null;
      row.safeIdempotencyKeyHash = input.idempotencyKeyHash;
      row.safeVoicePostId = input.voicePostId ?? null;
      row.version += 1;
      row.updatedAt = row.safeAt;
      for (const o of outbox) {
        if (o.familyId === input.familyId && o.watchId === input.watchId && o.status === "pending") {
          o.status = "failed";
        }
      }
      if (row.incidentId) {
        const inc = incidents.get(row.incidentId);
        if (inc) inc.state = "done";
      }
      return { ...row };
    },
    async tickDueWatches(nowIso, limit) {
      const nowMs = Date.parse(nowIso);
      const changed: WatchRow[] = [];
      for (const w of watches) {
        if (changed.length >= limit) break;
        if (w.state !== "active" && w.state !== "checking_in") continue;
        if (!w.nextTickAt || Date.parse(w.nextTickAt) > nowMs) continue;
        if (w.state === "active" && nowMs < Date.parse(w.graceUntil)) {
          w.state = "checking_in";
          w.checkedInAt = nowIso;
          w.nextTickAt = w.graceUntil;
          w.version += 1;
          w.updatedAt = nowIso;
          changed.push({ ...w });
        } else if (nowMs >= Date.parse(w.graceUntil)) {
          if (!w.incidentId) {
            const incId = randomUUID();
            incidents.set(incId, {
              id: incId,
              familyId: w.familyId,
              personId: w.subjectPersonId,
              state: "open",
              ownerPersonId: null,
            });
            w.incidentId = incId;
          }
          w.state = "escalated";
          w.checkedInAt = w.checkedInAt ?? nowIso;
          w.escalatedAt = nowIso;
          w.nextTickAt = null;
          w.version += 1;
          w.updatedAt = nowIso;
          changed.push({ ...w });
        }
      }
      return changed;
    },
    async getWatch(familyId, watchId) {
      const w = watches.find((x) => x.familyId === familyId && x.id === watchId);
      return w ? { ...w } : null;
    },
    async listWatches(familyId, subjectPersonId, limit) {
      return watches
        .filter((w) => w.familyId === familyId && (!subjectPersonId || w.subjectPersonId === subjectPersonId))
        .slice(-limit)
        .reverse()
        .map((w) => ({ ...w }));
    },
    async getVoicePost(familyId, postId) {
      return voicePosts.find((v) => v.familyId === familyId && v.id === postId) ?? null;
    },
    async getConsent(familyId, consentId) {
      return consents.find((c) => c.familyId === familyId && c.id === consentId) ?? null;
    },
    async listConsentHistory(familyId, personId, purpose) {
      return consents.filter(
        (c) => c.familyId === familyId && c.personId === personId && c.purpose === purpose,
      );
    },
    async getSharingPreferences(familyId, subjectPersonId) {
      return (
        preferences.get(`${familyId}:${subjectPersonId}`) ?? {
          familyId,
          subjectPersonId,
          shareStatusWithParent: true,
          allowLocationShare: false,
          allowHealthShare: false,
          allowNarrativeShare: false,
          version: 1,
          updatedAt: new Date(0).toISOString(),
        }
      );
    },
    async upsertSharingPreferences(input) {
      const existing = await this.getSharingPreferences(input.familyId, input.subjectPersonId);
      const next: SharingPreferencesRow = {
        ...input,
        version: existing.updatedAt === new Date(0).toISOString() ? 1 : existing.version + 1,
        updatedAt: currentNow.toISOString(),
      };
      preferences.set(`${input.familyId}:${input.subjectPersonId}`, next);
      return next;
    },
    async createReassuranceUpdate(input) {
      const row: ReassuranceRow = {
        id: randomUUID(),
        ...input,
        deliveryVerified: false,
        heardVerified: false,
        verifiedRawEventId: null,
        createdAt: currentNow.toISOString(),
      };
      reassuranceUpdates.push(row);
      return { ...row };
    },
    async listReassuranceUpdates(familyId, recipientOrSubjectPersonId, limit) {
      return reassuranceUpdates
        .filter(
          (r) =>
            r.familyId === familyId &&
            (!recipientOrSubjectPersonId ||
              r.subjectPersonId === recipientOrSubjectPersonId ||
              r.recipientPersonId === recipientOrSubjectPersonId),
        )
        .slice(-limit)
        .reverse()
        .map((r) => ({ ...r }));
    },
    async fencePendingSosDispatches(familyId, sosId) {
      for (const o of outbox) {
        if (o.familyId === familyId && o.sosId === sosId && o.status === "pending") {
          o.status = "failed";
        }
      }
    },
    async listDueEscalations(nowIso, limit): Promise<DueIncidentEscalation[]> {
      const nowMs = Date.parse(nowIso);
      return [...incidentEscalations.values()]
        .filter((e) => e.exhaustedAt === null && e.offerExpiresAt !== null && Date.parse(e.offerExpiresAt) <= nowMs)
        .sort((a, b) => Date.parse(a.offerExpiresAt!) - Date.parse(b.offerExpiresAt!))
        .slice(0, limit)
        .map((e) => ({
          incidentId: e.incidentId,
          familyId: e.familyId,
          subjectPersonId: e.subjectPersonId,
          watchId: e.watchId,
          sosId: e.sosId,
          offerExpiresAt: e.offerExpiresAt!,
        }));
    },
    async offerNextTrustedContact(input): Promise<OfferNextContactResult> {
      const inc = incidents.get(input.incidentId);
      if (!inc || inc.familyId !== input.familyId) {
        throw new Core2Error("not_found", 404, "Incident not found.");
      }
      if (["accepted", "done", "closed", "heard"].includes(inc.state) || inc.ownerPersonId !== null) {
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
      const linkedWatch = watches.find((w) => w.familyId === input.familyId && w.incidentId === input.incidentId) ?? null;
      if (linkedWatch && (linkedWatch.state === "safe" || linkedWatch.state === "cancelled")) {
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
      const linkedSos = sosEvents.find((s) => s.familyId === input.familyId && s.incidentId === input.incidentId) ?? null;
      const nowMs = Date.parse(input.nowIso);

      const isContactActive = (contactPersonId: string) =>
        contacts.find(
          (c) =>
            c.familyId === input.familyId &&
            c.subjectPersonId === inc.personId &&
            c.contactPersonId === contactPersonId &&
            c.state === "active" &&
            c.revokedAt === null &&
            c.scopes.includes(input.scope) &&
            Date.parse(c.effectiveFrom) <= nowMs &&
            (c.effectiveUntil === null || Date.parse(c.effectiveUntil) > nowMs),
        ) ?? null;

      const existingOffered = assignments
        .filter((a) => a.familyId === input.familyId && a.incidentId === input.incidentId && a.status === "offered")
        .sort((a, b) => Date.parse(b.offeredAt) - Date.parse(a.offeredAt))[0];

      if (existingOffered) {
        const activeTc = isContactActive(existingOffered.personId);
        if (activeTc && Date.parse(existingOffered.expiresAt) > nowMs) {
          return {
            assignmentId: existingOffered.id,
            trustedContactId: activeTc.id,
            contactPersonId: existingOffered.personId,
            rank: activeTc.rank,
            offeredAt: existingOffered.offeredAt,
            expiresAt: existingOffered.expiresAt,
            newlyCreated: false,
            exhausted: false,
          };
        }
        existingOffered.status = "expired";
      }

      const triedPeople = new Set(
        assignments
          .filter((a) => a.familyId === input.familyId && a.incidentId === input.incidentId)
          .map((a) => a.personId),
      );
      const nextTc = contacts
        .filter(
          (c) =>
            c.familyId === input.familyId &&
            c.subjectPersonId === inc.personId &&
            c.state === "active" &&
            c.revokedAt === null &&
            c.scopes.includes(input.scope) &&
            Date.parse(c.effectiveFrom) <= nowMs &&
            (c.effectiveUntil === null || Date.parse(c.effectiveUntil) > nowMs) &&
            !triedPeople.has(c.contactPersonId),
        )
        .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))[0];

      if (!nextTc) {
        incidentEscalations.set(input.incidentId, {
          incidentId: input.incidentId,
          familyId: input.familyId,
          subjectPersonId: inc.personId,
          watchId: linkedWatch?.id ?? null,
          sosId: linkedSos?.id ?? null,
          currentAssignmentId: null,
          currentContactId: null,
          offerExpiresAt: null,
          exhaustedAt: input.nowIso,
        });
        if (inc.state === "open" || inc.state === "offered") inc.state = "escalated";
        return {
          assignmentId: null,
          trustedContactId: null,
          contactPersonId: null,
          rank: null,
          offeredAt: null,
          expiresAt: null,
          newlyCreated: false,
          exhausted: true,
        };
      }

      const newAsg = {
        id: randomUUID(),
        familyId: input.familyId,
        incidentId: input.incidentId,
        personId: nextTc.contactPersonId,
        status: "offered",
        offeredAt: input.nowIso,
        expiresAt: input.offerExpiresAt,
        acceptedAt: null,
        verifiedByProviderEvent: null,
      };
      assignments.push(newAsg);
      if (inc.state === "open" || inc.state === "escalated" || inc.state === "offered") {
        inc.state = "offered";
      }
      incidentEscalations.set(input.incidentId, {
        incidentId: input.incidentId,
        familyId: input.familyId,
        subjectPersonId: inc.personId,
        watchId: linkedWatch?.id ?? null,
        sosId: linkedSos?.id ?? null,
        currentAssignmentId: newAsg.id,
        currentContactId: nextTc.id,
        offerExpiresAt: input.offerExpiresAt,
        exhaustedAt: null,
      });

      return {
        assignmentId: newAsg.id,
        trustedContactId: nextTc.id,
        contactPersonId: nextTc.contactPersonId,
        rank: nextTc.rank,
        offeredAt: newAsg.offeredAt,
        expiresAt: newAsg.expiresAt,
        newlyCreated: true,
        exhausted: false,
      };
    },
    async acceptIncidentAssignment(input): Promise<AcceptIncidentResult> {
      const inc = incidents.get(input.incidentId);
      if (!inc || inc.familyId !== input.familyId) {
        throw new Core2Error("not_found", 404, "Incident not found.");
      }
      if (inc.state === "done" || inc.state === "closed") {
        throw new Core2Error("incident_closed", 409, "Incident is already resolved or closed.");
      }
      const linkedWatch = watches.find((w) => w.familyId === input.familyId && w.incidentId === input.incidentId);
      if (linkedWatch && (linkedWatch.state === "safe" || linkedWatch.state === "cancelled")) {
        throw new Core2Error("incident_closed", 409, "Incident is already resolved or closed.");
      }

      const nowMs = Date.parse(input.nowIso);
      const tc = contacts.find(
        (c) =>
          c.familyId === input.familyId &&
          c.subjectPersonId === inc.personId &&
          c.contactPersonId === input.actorPersonId &&
          c.state === "active" &&
          c.revokedAt === null &&
          Date.parse(c.effectiveFrom) <= nowMs &&
          (c.effectiveUntil === null || Date.parse(c.effectiveUntil) > nowMs) &&
          (c.scopes.includes("sos") || c.scopes.includes("watch_escalation")),
      );
      if (!tc) {
        for (const a of assignments) {
          if (
            a.familyId === input.familyId &&
            a.incidentId === input.incidentId &&
            a.personId === input.actorPersonId &&
            a.status === "offered"
          ) {
            a.status = "expired";
          }
        }
        throw new Core2Error("forbidden", 403, "Forbidden for requested subject.");
      }

      if (inc.ownerPersonId !== null && inc.ownerPersonId !== input.actorPersonId) {
        throw new Core2Error("incident_already_accepted", 409, "Incident already accepted by another responder.");
      }

      const alreadyAsg = assignments.find(
        (a) =>
          a.familyId === input.familyId &&
          a.incidentId === input.incidentId &&
          a.personId === input.actorPersonId &&
          a.status === "accepted",
      );
      if (alreadyAsg && inc.ownerPersonId === input.actorPersonId) {
        return {
          assignmentId: alreadyAsg.id,
          incidentId: input.incidentId,
          subjectPersonId: inc.personId,
          responderPersonId: input.actorPersonId,
          offeredAt: alreadyAsg.offeredAt,
          acceptedAt: alreadyAsg.acceptedAt!,
          alreadyAccepted: true,
        };
      }

      const offeredAsg = assignments
        .filter(
          (a) =>
            a.familyId === input.familyId &&
            a.incidentId === input.incidentId &&
            a.personId === input.actorPersonId &&
            a.status === "offered",
        )
        .sort((a, b) => Date.parse(b.offeredAt) - Date.parse(a.offeredAt))[0];
      if (!offeredAsg) {
        throw new Core2Error("forbidden", 403, "No active escalation offer for caller.");
      }
      if (Date.parse(offeredAsg.expiresAt) <= nowMs) {
        offeredAsg.status = "expired";
        throw new Core2Error("assignment_expired", 409, "Escalation offer has already expired.");
      }

      offeredAsg.status = "accepted";
      offeredAsg.acceptedAt = input.nowIso;
      offeredAsg.verifiedByProviderEvent = input.rawEventId;
      for (const a of assignments) {
        if (
          a.familyId === input.familyId &&
          a.incidentId === input.incidentId &&
          a.id !== offeredAsg.id &&
          a.status === "offered"
        ) {
          a.status = "expired";
        }
      }
      inc.state = "accepted";
      inc.ownerPersonId = input.actorPersonId;

      for (const s of sosEvents) {
        if (s.familyId === input.familyId && s.incidentId === input.incidentId && s.status !== "safe" && s.status !== "cancelled") {
          s.status = "verified_accepted";
          s.responderAccepted = true;
          s.acceptedAssignmentId = offeredAsg.id;
          s.acceptedRawEventId = input.rawEventId;
          s.version += 1;
          s.updatedAt = input.nowIso;
        }
      }

      const esc = incidentEscalations.get(input.incidentId);
      if (esc) esc.offerExpiresAt = null;

      if (linkedWatch) {
        for (const o of outbox) {
          if (o.familyId === input.familyId && o.watchId === linkedWatch.id && o.trustedContactId !== tc.id && o.status === "pending") {
            o.status = "failed";
          }
        }
      }

      return {
        assignmentId: offeredAsg.id,
        incidentId: input.incidentId,
        subjectPersonId: inc.personId,
        responderPersonId: input.actorPersonId,
        offeredAt: offeredAsg.offeredAt,
        acceptedAt: offeredAsg.acceptedAt,
        alreadyAccepted: false,
      };
    },
    async declineIncidentAssignment(input): Promise<DeclineIncidentResult> {
      const inc = incidents.get(input.incidentId);
      if (!inc || inc.familyId !== input.familyId) {
        throw new Core2Error("not_found", 404, "Incident not found.");
      }
      if (inc.state === "done" || inc.state === "closed") {
        throw new Core2Error("incident_closed", 409, "Incident is already resolved or closed.");
      }
      if (inc.ownerPersonId !== null) {
        throw new Core2Error("incident_already_accepted", 409, "Incident already accepted by another responder.");
      }
      const already = assignments.find(
        (a) =>
          a.familyId === input.familyId &&
          a.incidentId === input.incidentId &&
          a.personId === input.actorPersonId &&
          a.status === "declined",
      );
      if (already) {
        return {
          assignmentId: already.id,
          incidentId: input.incidentId,
          subjectPersonId: inc.personId,
          alreadyDeclined: true,
        };
      }
      const offeredAsg = assignments.find(
        (a) =>
          a.familyId === input.familyId &&
          a.incidentId === input.incidentId &&
          a.personId === input.actorPersonId &&
          a.status === "offered",
      );
      if (!offeredAsg) {
        throw new Core2Error("forbidden", 403, "No active escalation offer for caller.");
      }
      offeredAsg.status = "declined";
      const esc = incidentEscalations.get(input.incidentId);
      if (esc && esc.currentAssignmentId === offeredAsg.id) {
        esc.offerExpiresAt = input.nowIso;
      }
      return {
        assignmentId: offeredAsg.id,
        incidentId: input.incidentId,
        subjectPersonId: inc.personId,
        alreadyDeclined: false,
      };
    },
    async loadTruthLineSnapshot(input): Promise<TruthLineStateSnapshot> {
      const child = input.subjectPersonId
        ? people.find((p) => p.familyId === input.familyId && p.id === input.subjectPersonId && p.role === "child") ?? null
        : people.find((p) => p.familyId === input.familyId && p.role === "child") ?? null;
      if (!child) {
        throw new Core2Error("not_found", 404, "Subject child person not found in family.");
      }
      const prefs = await this.getSharingPreferences(input.familyId, child.id);
      if (!prefs.shareStatusWithParent) {
        return {
          child,
          preferences: prefs,
          latestWatch: null,
          activeIncidentOwnerName: null,
          latestSos: null,
          latestReassurance: null,
        };
      }
      const latestWatch = (await this.listWatches(input.familyId, child.id, 1))[0] ?? null;
      const latestSos = (await this.listSosEvents(input.familyId, child.id, 1))[0] ?? null;
      const latestReassurance = (await this.listReassuranceUpdates(input.familyId, child.id, 1))[0] ?? null;

      const activeIncidentIds = new Set<string>();
      if (
        latestWatch?.incidentId &&
        (latestWatch.state === "active" ||
          latestWatch.state === "checking_in" ||
          latestWatch.state === "escalated")
      ) {
        activeIncidentIds.add(latestWatch.incidentId);
      }
      if (latestSos && latestSos.status !== "safe" && latestSos.status !== "cancelled") {
        activeIncidentIds.add(latestSos.incidentId);
      }

      let activeIncidentOwnerName: string | null = null;
      for (const incId of activeIncidentIds) {
        const inc = incidents.get(incId);
        if (inc && inc.familyId === input.familyId && inc.ownerPersonId) {
          const owner = people.find((p) => p.familyId === input.familyId && p.id === inc.ownerPersonId);
          if (owner) {
            activeIncidentOwnerName = owner.displayName;
            break;
          }
        }
      }

      return {
        child,
        preferences: prefs,
        latestWatch,
        activeIncidentOwnerName,
        latestSos,
        latestReassurance,
      };
    },
  };

  const deps: Core2Deps = {
    auth: {
      async verifyBearer(token) {
        const userId = tokens.get(token);
        return userId ? { userId } : null;
      },
    },
    repo,
    dispatch: {
      async enqueueAuthorized(request) {
        const existing = outbox.find(
          (o) => o.familyId === request.familyId && o.dedupeKey === request.dedupeKey,
        );
        if (existing) return { outboxId: existing.id, status: "pending" };
        const id = randomUUID();
        outbox.push({
          id,
          familyId: request.familyId,
          kind: request.kind,
          dedupeKey: request.dedupeKey,
          status: "pending",
          payloadCiphertext: request.payloadCiphertext,
          trustedContactId: request.trustedContactId,
          watchId: request.watchId,
          sosId: request.sosId,
        });
        return { outboxId: id, status: "pending" };
      },
    },
    gate: { evaluate: evaluateGate },
    timeline: {
      async append(input) {
        const dup = timelineEvents.find(
          (t) => t.raw.familyId === input.familyId && t.raw.dedupeKey === input.dedupeKey,
        );
        if (dup) {
          if (canonicalJson(dup.raw.payload) !== canonicalJson(input.payload)) {
            throw new Core2Error("conflict", 409, "Timeline dedupe conflict");
          }
          return;
        }
        const head = heads.get(input.familyId) ?? { sequence: 0, chainHash: null };
        const signed = signTimelineEvent(
          {
            familyId: input.familyId,
            eventId: input.eventId,
            sequence: head.sequence + 1,
            previousHash: head.chainHash,
            dedupeKey: input.dedupeKey,
            eventType: input.eventType,
            entityId: input.entityId,
            humanLine: input.humanLine,
            occurredAt: input.occurredAt,
            keyId: "core2-test-key",
            payload: input.payload,
          },
          keyPair.privateKey,
        );
        heads.set(input.familyId, { sequence: head.sequence + 1, chainHash: signed.chainHash });
        timelineEvents.push({ raw: input, signed });
      },
    },
    crypto: createWebhookCryptoPort(TEST_ENC_KEY),
    now: () => currentNow,
    env: testEnv,
  };

  const service = createCore2Service(deps);
  const handlers = createCore2RouteHandlers(() => service);

  return {
    service,
    handlers,
    env: testEnv,
    setNow(iso: string) {
      currentNow = new Date(iso);
    },
    advanceSeconds(sec: number) {
      currentNow = new Date(currentNow.getTime() + sec * 1_000);
    },
    advanceMinutes(min: number) {
      currentNow = new Date(currentNow.getTime() + min * 60_000);
    },
    setFailRawIngest(flag: boolean) {
      failRawIngest = flag;
    },
    addMembership(m: Core2Membership) {
      memberships.push(m);
    },
    addTrustedActor(input: {
      userId: string;
      personId: string;
      displayName: string;
      token: string;
      familyId?: string;
      role?: Core2Membership["role"];
    }) {
      const fam = input.familyId ?? SYNTH_IDS.familyA;
      const role = input.role ?? "circle";
      tokens.set(input.token, input.userId);
      people.push({
        id: input.personId,
        familyId: fam,
        displayName: input.displayName,
        role,
        timezone: "Asia/Kolkata",
      });
      memberships.push({
        familyId: fam,
        userId: input.userId,
        personId: input.personId,
        role,
        revokedAt: null,
      });
    },
    revokeMembership(userId: string, familyId: string) {
      const m = memberships.find((x) => x.userId === userId && x.familyId === familyId);
      if (m) m.revokedAt = currentNow.toISOString();
    },
    addConsent(c: Core2ConsentRecord) {
      consents.push(c);
    },
    addVoicePost(v: Core2VoicePostRecord) {
      voicePosts.push(v);
    },
    addPermission(p: SetupPermission) {
      permissions.push(p);
    },
    clearPermissions() {
      permissions.length = 0;
    },
    state: {
      rawEvents,
      contacts,
      watches,
      sosEvents,
      outbox,
      timelineEvents,
      reassuranceUpdates,
      incidents,
      assignments,
      incidentEscalations,
      publicKey: keyPair.publicKey,
    },
    async approveTrustedContactFor(input: {
      contactPersonId: string;
      approverToken: string;
      rank: number;
      scopes?: TrustedContactScope[];
      effectiveUntil?: string | null;
      subjectToken?: string;
    }) {
      const inv = await service.inviteTrustedContact(
        { bearerToken: input.subjectToken ?? "tok-riya", familyIdHeader: null, idempotencyKeyHeader: `inv-${randomUUID()}` },
        {
          contact_person_id: input.contactPersonId,
          rank: input.rank,
          scopes: input.scopes ?? ["sos", "watch_escalation", "reassurance"],
          effective_until: input.effectiveUntil ?? null,
        },
      );
      const id = (inv.body.contact as { id: string }).id;
      await service.approveTrustedContact(
        { bearerToken: input.approverToken, familyIdHeader: null, idempotencyKeyHeader: `app-${randomUUID()}` },
        id,
        {},
      );
      return id;
    },
    async approveNehaAsTrustedContact(scopes: TrustedContactScope[] = ["sos", "watch_escalation", "reassurance"], effectiveUntil: string | null = null) {
      const inv = await service.inviteTrustedContact(
        { bearerToken: "tok-riya", familyIdHeader: null, idempotencyKeyHeader: `inv-${randomUUID()}` },
        { contact_person_id: SYNTH_IDS.personNeha, rank: 1, scopes, effective_until: effectiveUntil },
      );
      const id = (inv.body.contact as { id: string }).id;
      await service.approveTrustedContact(
        { bearerToken: "tok-neha", familyIdHeader: null, idempotencyKeyHeader: `app-${randomUUID()}` },
        id,
        {},
      );
      return id;
    },
  };
}

