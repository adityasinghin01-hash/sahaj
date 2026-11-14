import { generateKeyPairSync } from "node:crypto";
import { evaluateGate, type SetupPermission } from "@sahaj/gate";
import { SHIELD_HEADERS } from "@sahaj/shared";
import {
  deriveDeviceSecret,
  sha256Hex as shieldSha256Hex,
  signShieldBody,
} from "../../../../packages/shield/src/server/crypto";
import { createMemoryReplayGuard } from "../../src/app/api/core1/maa/_lib/device-auth";
import type { MaaDeviceRecord, MaaPersonRecord, MaaRepo } from "../../src/app/api/core1/maa/_lib/repo";
import type { VoiceNotifyDeps } from "../../src/lib/core1/voice-notify";
import {
  Core2Error,
  createWebhookCryptoPort,
  type Core2AuthPort,
  type Core2DispatchPort,
  type Core2IdempotencyRecord,
  type Core2Membership,
  type Core2Person,
  type Core2Repository,
  type Core2TimelineAppendInput,
  type Core2TimelinePort,
  type OfferNextContactResult,
  type ReassuranceRow,
  type SharingPreferencesRow,
  type TrustedContactRow,
  type TrustedContactScope,
} from "../../src/lib/core2";
import {
  createCore2ProofRouteHandlers,
  createCore2ProofService,
  normalizeCodeWord,
  sha256Hex,
  type AnyPhoneSessionRow,
  type ProofAnyPhoneRepo,
  type ProofChallengeRow,
  type ProofPersonCandidate,
  type ProofStoragePort,
  type SaarasSttInput,
  type SaarasSttPort,
  type VoiceAudioLookup,
} from "../../src/lib/core2-proof";
import {
  canonicalJson,
  signTimelineEvent,
  verifyTimelineChain,
  type SignedTimelineEvent,
  type TimelineKey,
} from "../../src/lib/timeline";
import { SYNTH_IDS } from "../core2/harness";

export { SYNTH_IDS };

const TEST_ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
export const TEST_PAIRING_SECRET = "synthetic-maa-pairing-secret-0123456789abcdef";
export const TEST_MAA_DEVICE_ID = "dev-maa-synth-01";
export const TEST_INITIAL_CODE_WORD = "kesar";

export async function buildSignedMaaRequest(input: {
  url: string;
  method: "GET" | "POST";
  body?: Record<string, unknown>;
  deviceId?: string;
  pairingSecret?: string;
  timestampMs?: number;
}): Promise<Request> {
  const deviceId = input.deviceId ?? TEST_MAA_DEVICE_ID;
  const pairingSecret = input.pairingSecret ?? TEST_PAIRING_SECRET;
  const ts = String(input.timestampMs ?? Date.now());
  const rawBodyText = input.method === "POST" ? JSON.stringify(input.body ?? {}) : "";
  const rawBytes = new TextEncoder().encode(rawBodyText);
  const deviceSecret = await deriveDeviceSecret(pairingSecret, deviceId);
  const sig = await signShieldBody(deviceSecret, ts, rawBytes);

  const headers = new Headers({
    [SHIELD_HEADERS.device]: deviceId,
    [SHIELD_HEADERS.ts]: ts,
    [SHIELD_HEADERS.sig]: sig,
  });
  if (input.method === "POST") {
    headers.set("content-type", "application/json");
  }
  return new Request(input.url, {
    method: input.method,
    headers,
    ...(input.method === "POST" ? { body: rawBodyText } : {}),
  });
}

export async function createCore2ProofTestHarness(opts?: {
  initialNowIso?: string;
  env?: Record<string, string | undefined>;
  initialCodeWord?: string;
}) {
  let currentNow = new Date(opts?.initialNowIso ?? "2026-11-15T10:00:00.000Z");
  const keyPair = generateKeyPairSync("ed25519");
  const testEnv: Record<string, string | undefined> = {
    CRON_SECRET: "test-cron-secret",
    SARVAM_TOOL_TOKEN: "test-sarvam-tool-token",
    ...(opts?.env ?? {}),
  };

  let seq = 500;
  const nextId = () => {
    seq += 1;
    return `99000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
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
      targetIds: [SYNTH_IDS.personMaa, SYNTH_IDS.personNeha],
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2099-01-01T00:00:00.000Z",
      maxUses: 100,
      usedCount: 0,
      approvalMode: "setup",
    },
  ];

  const idempotency: Core2IdempotencyRecord[] = [];
  const contacts: TrustedContactRow[] = [];
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
  }> = [];
  const outboxRows: Array<{
    id: string;
    familyId: string;
    kind: string;
    dedupeKey: string;
    status: string;
    payloadCiphertext: string;
    trustedContactId?: string | null;
  }> = [];
  const timelineEvents: Array<{ raw: Core2TimelineAppendInput; signed: SignedTimelineEvent }> = [];
  const heads = new Map<string, { sequence: number; chainHash: string | null }>();

  const auth: Core2AuthPort = {
    async verifyBearer(bearerToken) {
      if (!bearerToken) return null;
      const userId = tokens.get(bearerToken);
      return userId ? { userId } : null;
    },
  };

  const core2Repo = {
    async listActiveMemberships(userId: string) {
      return memberships.filter((m) => m.userId === userId && m.revokedAt === null);
    },
    async getPerson(familyId: string, personId: string) {
      return people.find((p) => p.familyId === familyId && p.id === personId) ?? null;
    },
    async listPeopleByRole(familyId: string, role: "parent" | "child" | "circle") {
      return people.filter((p) => p.familyId === familyId && p.role === role);
    },
    async getIdempotency(familyId: string, actorPersonId: string, action: string, keyHash: string) {
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
    async saveIdempotency(rec: Core2IdempotencyRecord) {
      idempotency.push(rec);
    },
    async ingestRawEvent() {
      return { rawEventId: nextId() };
    },
    async loadGateInput(input: {
      familyId: string;
      actorPersonId: string;
      requestId: string;
      action: "urgent_responder" | "check_in" | "share_data";
      targetId: string;
      consentSubjectId?: string;
      now: string;
    }) {
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
        consents: [],
        now: input.now,
      };
    },
    async createRequestAndIncident(input: {
      familyId: string;
      personId: string;
      requestKind: string;
      severity: "routine" | "urgent" | "critical";
      incidentState: string;
    }) {
      const requestId = nextId();
      const incidentId = nextId();
      incidents.set(incidentId, {
        id: incidentId,
        familyId: input.familyId,
        personId: input.personId,
        state: input.incidentState,
        ownerPersonId: null,
      });
      return { requestId, incidentId };
    },
    async offerNextTrustedContact(input: {
      familyId: string;
      incidentId: string;
      scope: TrustedContactScope;
      offerExpiresAt: string;
      nowIso: string;
    }): Promise<OfferNextContactResult> {
      const inc = incidents.get(input.incidentId);
      if (!inc || inc.familyId !== input.familyId) {
        throw new Core2Error("not_found", 404, "Incident not found.");
      }
      const nowMs = Date.parse(input.nowIso);
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
        inc.state = "escalated";
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

      const assignmentId = nextId();
      assignments.push({
        id: assignmentId,
        familyId: input.familyId,
        incidentId: input.incidentId,
        personId: nextTc.contactPersonId,
        status: "offered",
        offeredAt: input.nowIso,
        expiresAt: input.offerExpiresAt,
      });
      inc.state = "offered";
      return {
        assignmentId,
        trustedContactId: nextTc.id,
        contactPersonId: nextTc.contactPersonId,
        rank: nextTc.rank,
        offeredAt: input.nowIso,
        expiresAt: input.offerExpiresAt,
        newlyCreated: true,
        exhausted: false,
      };
    },
    async getSharingPreferences(familyId: string, subjectPersonId: string): Promise<SharingPreferencesRow> {
      return {
        familyId,
        subjectPersonId,
        shareStatusWithParent: true,
        allowLocationShare: false,
        allowHealthShare: false,
        allowNarrativeShare: false,
        version: 1,
        updatedAt: currentNow.toISOString(),
      };
    },
    async createReassuranceUpdate(input: Omit<ReassuranceRow, "id" | "deliveryVerified" | "heardVerified" | "verifiedRawEventId" | "createdAt">): Promise<ReassuranceRow> {
      const row: ReassuranceRow = {
        id: nextId(),
        ...input,
        deliveryVerified: false,
        heardVerified: false,
        verifiedRawEventId: null,
        createdAt: currentNow.toISOString(),
      };
      reassuranceUpdates.push(row);
      return row;
    },
  } as unknown as Core2Repository;

  const dispatch: Core2DispatchPort = {
    async enqueueAuthorized(request) {
      const existing = outboxRows.find(
        (o) => o.familyId === request.familyId && o.dedupeKey === request.dedupeKey,
      );
      if (existing) return { outboxId: existing.id, status: "pending" };
      const id = nextId();
      outboxRows.push({
        id,
        familyId: request.familyId,
        kind: request.kind,
        dedupeKey: request.dedupeKey,
        status: "pending",
        payloadCiphertext: request.payloadCiphertext,
        trustedContactId: request.trustedContactId ?? null,
      });
      return { outboxId: id, status: "pending" };
    },
  };

  const timeline: Core2TimelinePort = {
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
  };

  const codeWordHashes = new Map<string, string | null>();
  const initialWord = opts?.initialCodeWord ?? TEST_INITIAL_CODE_WORD;
  codeWordHashes.set(
    SYNTH_IDS.familyA,
    await sha256Hex(normalizeCodeWord(initialWord)),
  );

  const personAliases = new Map<string, string[]>([
    [SYNTH_IDS.personRiya, ["riya", "रिया", "betu"]],
  ]);

  const challenges = new Map<string, ProofChallengeRow>();
  const guards = new Map<
    string,
    {
      failedAttempts: number;
      lockedUntil: string | null;
      lastFailedAt: string | null;
      lastVerifiedAt: string | null;
    }
  >();
  const anyPhoneSessions = new Map<string, AnyPhoneSessionRow>();
  const storedVoiceObjects = new Map<
    string,
    {
      voiceMediaId: string;
      voicePostId: string | null;
      senderId: string;
      recipientId: string;
      objectPath: string;
      contentType: string;
      durationS: number | null;
      bytes: Uint8Array;
    }
  >();
  const voiceNotifications: Array<{
    familyId: string;
    voicePostId: string;
    senderId: string;
    recipientId: string;
  }> = [];
  const pushMessages: Array<{
    to: string;
    title: string;
    body: string;
    data?: Record<string, string>;
  }> = [];

  let sttResponder: (input: SaarasSttInput) => string = () =>
    "Maa main theek hoon gulab";
  let wordIndexCounter = 0;

  const proofRepo: ProofAnyPhoneRepo = {
    async findPersonByNameOrAlias(familyId, saidName, role): Promise<ProofPersonCandidate | null> {
      const wanted = normalizeCodeWord(saidName);
      if (!wanted) return null;
      const roles: Array<"child" | "parent" | "circle"> = role
        ? [role]
        : ["child", "parent", "circle"];
      for (const r of roles) {
        const list = await core2Repo.listPeopleByRole(familyId, r);
        for (const p of list) {
          const aliases = personAliases.get(p.id) ?? [];
          const normDisplay = normalizeCodeWord(p.displayName);
          const firstToken = normDisplay.split(" ")[0] ?? "";
          if (
            normDisplay === wanted ||
            firstToken === wanted ||
            aliases.some((a) => normalizeCodeWord(a) === wanted)
          ) {
            return { ...p, aliases };
          }
        }
      }
      return null;
    },

    async listPushTokensForPerson(_familyId, personId) {
      return [`ExponentPushToken[${personId.slice(0, 8)}]`];
    },

    async createProofChallenge(input) {
      const nowIso = currentNow.toISOString();
      const row: ProofChallengeRow = {
        id: nextId(),
        familyId: input.familyId,
        requesterPersonId: input.requesterPersonId,
        subjectPersonId: input.subjectPersonId,
        wordToken: input.wordToken,
        wordAliases: [...input.wordAliases],
        status: "pending",
        ttlSeconds: input.ttlSeconds,
        expiresAt: input.expiresAt,
        answeredAt: null,
        verifiedAt: null,
        escalatedAt: null,
        voiceMediaId: null,
        voicePostId: null,
        voiceObjectPath: null,
        sttTranscript: null,
        sttMatched: false,
        incidentId: null,
        requestId: null,
        offeredContactPersonId: null,
        offeredContactName: null,
        attempts: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      challenges.set(row.id, row);
      return { ...row };
    },

    async getProofChallenge(familyId, challengeId) {
      const row = challenges.get(challengeId);
      if (!row || row.familyId !== familyId) return null;
      return { ...row };
    },

    async getLatestProofChallenge(familyId, subjectPersonId) {
      const all = [...challenges.values()]
        .filter(
          (c) =>
            c.familyId === familyId &&
            (!subjectPersonId || c.subjectPersonId === subjectPersonId),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return all[0] ? { ...all[0] } : null;
    },

    async updateProofChallengeAnswer(input) {
      const existing = challenges.get(input.challengeId);
      if (!existing || existing.familyId !== input.familyId) {
        throw new Error("challenge_not_found");
      }
      const next: ProofChallengeRow = {
        ...existing,
        status: input.status,
        answeredAt: input.answeredAt,
        verifiedAt: input.verifiedAt,
        voiceMediaId: input.voiceMediaId,
        voicePostId: input.voicePostId,
        voiceObjectPath: input.voiceObjectPath,
        sttTranscript: input.sttTranscript,
        sttMatched: input.sttMatched,
        attempts: input.attempts,
        updatedAt: input.answeredAt,
      };
      challenges.set(next.id, next);
      return { ...next };
    },

    async markProofChallengeEscalated(input) {
      const existing = challenges.get(input.challengeId);
      if (!existing || existing.familyId !== input.familyId) {
        throw new Error("challenge_not_found");
      }
      const next: ProofChallengeRow = {
        ...existing,
        status: "escalated",
        escalatedAt: input.escalatedAt,
        incidentId: input.incidentId,
        requestId: input.requestId,
        offeredContactPersonId: input.offeredContactPersonId,
        offeredContactName: input.offeredContactName,
        updatedAt: input.escalatedAt,
      };
      challenges.set(next.id, next);
      return { ...next };
    },

    async claimDueProofChallenges(nowIso, limit) {
      const nowMs = Date.parse(nowIso);
      const claimed: ProofChallengeRow[] = [];
      for (const c of challenges.values()) {
        if (
          (c.status === "pending" || c.status === "word_mismatch") &&
          Date.parse(c.expiresAt) <= nowMs
        ) {
          const updated: ProofChallengeRow = { ...c, status: "expired", updatedAt: nowIso };
          challenges.set(c.id, updated);
          claimed.push({ ...updated });
          if (claimed.length >= limit) break;
        }
      }
      return claimed;
    },

    async getCodeWordHash(familyId) {
      return codeWordHashes.get(familyId) ?? null;
    },

    async rotateCodeWordHash(familyId, newHashHex) {
      codeWordHashes.set(familyId, newHashHex);
    },

    async recordAnyPhoneAttempt(input) {
      const nowMs = Date.parse(input.nowIso);
      const current = guards.get(input.familyId) ?? {
        failedAttempts: 0,
        lockedUntil: null,
        lastFailedAt: null,
        lastVerifiedAt: null,
      };

      if (current.lockedUntil && Date.parse(current.lockedUntil) > nowMs) {
        return {
          locked: true,
          lockedUntil: current.lockedUntil,
          failedAttempts: current.failedAttempts,
          remainingAttempts: 0,
        };
      }

      if (current.lockedUntil && Date.parse(current.lockedUntil) <= nowMs) {
        current.failedAttempts = 0;
        current.lockedUntil = null;
      }

      if (input.ok) {
        current.failedAttempts = 0;
        current.lockedUntil = null;
        current.lastVerifiedAt = input.nowIso;
        guards.set(input.familyId, current);
        return {
          locked: false,
          lockedUntil: null,
          failedAttempts: 0,
          remainingAttempts: input.maxAttempts,
        };
      }

      current.failedAttempts += 1;
      current.lastFailedAt = input.nowIso;
      if (current.failedAttempts >= input.maxAttempts) {
        current.lockedUntil = new Date(nowMs + input.lockSeconds * 1000).toISOString();
      }
      guards.set(input.familyId, current);

      return {
        locked: current.lockedUntil !== null,
        lockedUntil: current.lockedUntil,
        failedAttempts: current.failedAttempts,
        remainingAttempts: Math.max(0, input.maxAttempts - current.failedAttempts),
      };
    },

    async createAnyPhoneSession(input) {
      const nowIso = currentNow.toISOString();
      const row: AnyPhoneSessionRow = {
        id: nextId(),
        familyId: input.familyId,
        subjectPersonId: input.subjectPersonId,
        incidentId: input.incidentId,
        requestId: input.requestId,
        callRefHash: input.callRefHash,
        callerChannel: "any_phone",
        grantedPowers: [...input.grantedPowers],
        deniedPowers: [...input.deniedPowers],
        codeWordRotated: input.codeWordRotated,
        voicePostId: null,
        voiceObjectPath: null,
        statusMessageHi: input.statusMessageHi,
        statusMessageEn: input.statusMessageEn,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      anyPhoneSessions.set(row.id, row);
      return { ...row };
    },

    async getAnyPhoneSession(familyId, sessionId) {
      const row = anyPhoneSessions.get(sessionId);
      if (!row || row.familyId !== familyId) return null;
      return { ...row };
    },

    async getLatestAnyPhoneSession(familyId) {
      const all = [...anyPhoneSessions.values()]
        .filter((s) => s.familyId === familyId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return all[0] ? { ...all[0] } : null;
    },

    async attachVoiceToAnyPhoneSession(input) {
      const existing = anyPhoneSessions.get(input.sessionId);
      if (!existing || existing.familyId !== input.familyId) {
        throw new Error("session_not_found");
      }
      const next: AnyPhoneSessionRow = {
        ...existing,
        voicePostId: input.voicePostId,
        voiceObjectPath: input.voiceObjectPath,
        updatedAt: currentNow.toISOString(),
      };
      anyPhoneSessions.set(next.id, next);
      return { ...next };
    },

    async recordVoiceShareConsent() {
      return { consentId: nextId() };
    },

    async createVoicePostWithMedia(input) {
      const voicePostId = nextId();
      storedVoiceObjects.set(input.objectPath, {
        voiceMediaId: voicePostId,
        voicePostId,
        senderId: input.senderId,
        recipientId: input.recipientId,
        objectPath: input.objectPath,
        contentType: "audio/wav",
        durationS: 6,
        bytes: new Uint8Array([82, 73, 70, 70]),
      });
      return { voicePostId };
    },
  };

  const storage: ProofStoragePort = {
    async readVoiceMediaForAnswer(input): Promise<VoiceAudioLookup | null> {
      for (const item of storedVoiceObjects.values()) {
        if (
          (input.voiceMediaId && item.voiceMediaId === input.voiceMediaId) ||
          (input.voicePostId && item.voicePostId === input.voicePostId) ||
          (input.mediaObjectPath && item.objectPath === input.mediaObjectPath)
        ) {
          return { ...item };
        }
      }
      return null;
    },

    async uploadVoiceBytes(objectPath, bytes, contentType) {
      storedVoiceObjects.set(objectPath, {
        voiceMediaId: nextId(),
        voicePostId: null,
        senderId: SYNTH_IDS.personRiya,
        recipientId: SYNTH_IDS.personMaa,
        objectPath,
        contentType,
        durationS: 6,
        bytes,
      });
    },

    async createSignedVoiceUrl(input) {
      return {
        url: `https://storage.sahaj.example/${input.objectPath}?token=signed`,
        expiresInSeconds: input.expiresInSeconds ?? 60,
      };
    },
  };

  const stt: SaarasSttPort = {
    async transcribe(input) {
      return {
        transcript: sttResponder(input),
        languageCode: "hi-IN",
        provider: "saaras",
      };
    },
  };

  const deviceSecret = await deriveDeviceSecret(TEST_PAIRING_SECRET, TEST_MAA_DEVICE_ID);
  const deviceSecretHash = await shieldSha256Hex(deviceSecret);
  const maaDevices = new Map<string, MaaDeviceRecord>([
    [
      TEST_MAA_DEVICE_ID,
      {
        deviceId: TEST_MAA_DEVICE_ID,
        familyId: SYNTH_IDS.familyA,
        personId: SYNTH_IDS.personMaa,
        platform: "android",
        revoked: false,
        deviceSecretHash,
      },
    ],
  ]);

  const maaRepo: MaaRepo = {
    storage: {
      async stat() {
        return { size: 1024, contentType: "audio/mp4" };
      },
      async createSignedUrl(bucket, path, ttl) {
        return `https://storage.sahaj.example/${bucket}/${path}?ttl=${ttl}`;
      },
    },
    async authorizeMedia() {
      return "allow";
    },
    async getDevice(deviceId) {
      return maaDevices.get(deviceId) ?? null;
    },
    async getPersonInFamily(familyId, personId): Promise<MaaPersonRecord | null> {
      const p = await core2Repo.getPerson(familyId, personId);
      if (!p) return null;
      return {
        id: p.id,
        familyId: p.familyId,
        displayName: p.displayName,
        role: p.role,
      };
    },
    async listPeopleInFamily(familyId) {
      const roles: Array<"parent" | "child" | "circle"> = ["parent", "child", "circle"];
      const out: MaaPersonRecord[] = [];
      for (const r of roles) {
        const list = await core2Repo.listPeopleByRole(familyId, r);
        for (const p of list) {
          out.push({ id: p.id, familyId: p.familyId, displayName: p.displayName, role: p.role });
        }
      }
      return out;
    },
    async listVoicePostsForRecipient() {
      return [];
    },
    async getVoicePostById() {
      return null;
    },
    async getVoiceContent() {
      return null;
    },
    async getConsent() {
      return null;
    },
    async listConsentHistory() {
      return [];
    },
    async markVoicePostHeard(_f, _p, _r, heardAt) {
      return { playedAt: heardAt };
    },
    async createVoiceShareConsent() {
      throw new Error("unused");
    },
    async uploadVoiceObject() {},
    async createFamilyVoicePost() {
      throw new Error("unused");
    },
    async findCommandIdempotency() {
      return null;
    },
    async persistCommandEvent() {},
    async createUrgentIncidentOffer() {
      throw new Error("unused");
    },
    async getUrgentIncidentById() {
      return null;
    },
    async listIncidentAssignments() {
      return [];
    },
  };

  const service = createCore2ProofService({
    auth,
    core2Repo,
    proofRepo,
    storage,
    stt,
    dispatch,
    gate: { evaluate: evaluateGate },
    timeline,
    crypto: createWebhookCryptoPort(TEST_ENC_KEY),
    voiceNotifyDeps: {} as VoiceNotifyDeps,
    async notifyOnVoicePost(_deps, input) {
      voiceNotifications.push(input);
    },
    async sendPush(msgs) {
      pushMessages.push(...msgs);
      return { sent: msgs.length, failed: 0 };
    },
    verifyTwilioSignature(req) {
      return req.headers.get("x-twilio-signature") === "valid-twilio-sig";
    },
    async fetchTwilioRecordingAudio() {
      return {
        audio: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]),
        contentType: "audio/wav",
      };
    },
    async fetchSarvamRecordingAudio() {
      return {
        audio: new Uint8Array([82, 73, 70, 70, 5, 6, 7, 8]),
        contentType: "audio/wav",
      };
    },
    now: () => currentNow,
    uuid: nextId,
    randomIndex: (max) => {
      const idx = wordIndexCounter % max;
      wordIndexCounter += 1;
      return idx;
    },
    env: testEnv,
  });

  const handlers = createCore2ProofRouteHandlers(() => service, {
    getMaaRepo: () => maaRepo,
    pairingSecret: TEST_PAIRING_SECRET,
    replayGuard: createMemoryReplayGuard(),
    now: () => currentNow,
  });

  const core2 = {
    getNow: () => currentNow,
    advanceMs(ms: number) {
      currentNow = new Date(currentNow.getTime() + ms);
    },
    outboxRows,
    reassuranceUpdates,
    incidents,
    assignments,
    timelineEvents,
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
    addPermission(p: SetupPermission) {
      permissions.push(p);
    },
    service: {
      async inviteTrustedContact(
        _auth: unknown,
        input: {
          contact_person_id: string;
          rank: number;
          scopes: TrustedContactScope[];
          effective_until?: string | null;
        },
      ) {
        const id = nextId();
        const nowIso = currentNow.toISOString();
        const row: TrustedContactRow = {
          id,
          familyId: SYNTH_IDS.familyA,
          subjectPersonId: SYNTH_IDS.personRiya,
          contactPersonId: input.contact_person_id,
          rank: input.rank,
          scopes: input.scopes,
          state: "invited",
          approvedAt: null,
          consentId: null,
          consentAt: null,
          effectiveFrom: nowIso,
          effectiveUntil: input.effective_until ?? null,
          revokedAt: null,
          version: 1,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        contacts.push(row);
        return { status: 201, body: { contact: { id } } };
      },
      async approveTrustedContact(_auth: unknown, contactId: string, _body: unknown) {
        const row = contacts.find((c) => c.id === contactId);
        if (row) {
          row.state = "active";
          row.approvedAt = currentNow.toISOString();
          row.consentId = nextId();
          row.consentAt = currentNow.toISOString();
        }
        return { status: 200, body: { contact: { id: contactId } } };
      },
    },
    async approveNehaAsTrustedContact(
      scopes: TrustedContactScope[] = ["sos", "watch_escalation", "reassurance"],
      effectiveUntil: string | null = null,
    ) {
      const id = nextId();
      const nowIso = currentNow.toISOString();
      contacts.push({
        id,
        familyId: SYNTH_IDS.familyA,
        subjectPersonId: SYNTH_IDS.personRiya,
        contactPersonId: SYNTH_IDS.personNeha,
        rank: 1,
        scopes,
        state: "active",
        approvedAt: nowIso,
        consentId: nextId(),
        consentAt: nowIso,
        effectiveFrom: nowIso,
        effectiveUntil,
        revokedAt: null,
        version: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
      return id;
    },
    verifyTimeline(familyId: string = SYNTH_IDS.familyA) {
      const familyEvents = timelineEvents
        .filter((e) => e.raw.familyId === familyId)
        .map((e) => e.signed);
      const head = heads.get(familyId) ?? { sequence: 0, chainHash: null };
      const keys = new Map<string, TimelineKey>([["core2-test-key", keyPair.publicKey]]);
      return verifyTimelineChain(familyEvents, keys, {
        familyId,
        sequence: head.sequence,
        chainHash: head.chainHash,
      });
    },
  };

  const seedVoiceMedia = (input?: {
    voiceMediaId?: string;
    voicePostId?: string | null;
    senderId?: string;
    recipientId?: string;
    objectPath?: string;
    contentType?: string;
    durationS?: number | null;
    bytes?: Uint8Array;
  }) => {
    const voiceMediaId = input?.voiceMediaId ?? nextId();
    const objectPath =
      input?.objectPath ??
      `${SYNTH_IDS.familyA}/proof/${SYNTH_IDS.personRiya}/${voiceMediaId}.m4a`;
    const rec = {
      voiceMediaId,
      voicePostId: input?.voicePostId ?? nextId(),
      senderId: input?.senderId ?? SYNTH_IDS.personRiya,
      recipientId: input?.recipientId ?? SYNTH_IDS.personMaa,
      objectPath,
      contentType: input?.contentType ?? "audio/mp4",
      durationS: input?.durationS !== undefined ? input.durationS : 5,
      bytes: input?.bytes ?? new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
    };
    storedVoiceObjects.set(objectPath, rec);
    return rec;
  };

  return {
    core2,
    service,
    handlers,
    codeWordHashes,
    challenges,
    guards,
    anyPhoneSessions,
    storedVoiceObjects,
    voiceNotifications,
    pushMessages,
    maaDevices,
    setSttTranscript(fn: ((input: SaarasSttInput) => string) | string) {
      sttResponder = typeof fn === "function" ? fn : () => fn;
    },
    seedVoiceMedia,
    seedUploadedVoiceClip: seedVoiceMedia,
  };
}
