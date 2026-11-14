import { createHmac, generateKeyPairSync } from "node:crypto";
import { createMemoryReplayGuard } from "@/app/api/core1/maa/_lib/device-auth";
import type { MaaRepo } from "@/app/api/core1/maa/_lib/repo";
import type {
  Core2Deps,
  Core2IdempotencyRecord,
  Core2Membership,
  Core2Person,
} from "@/lib/core2/contracts";
import type { GateInput } from "@sahaj/gate";
import type {
  AfterReportRow,
  AssignmentSummaryRow,
  CircleCompanionCandidate,
  Core2NewsDeps,
  Core2NewsRepository,
  GentleNewsRow,
  HeardReceiptRow,
  IncidentSummaryRow,
  ReassuranceDeliveryRow,
  RecordHeardInput,
  TimelineSummaryRow,
  TwilioOutboxLookup,
  VoicePostDeliveryRow,
  ZapierZ3Payload,
} from "@/lib/core2-news/contracts";
import { canonicalJson, signTimelineEvent, type TimelineKey } from "@/lib/timeline";
import { SHIELD_HEADERS } from "@sahaj/shared";
import {
  deriveDeviceSecret,
  sha256Hex as shieldSha256Hex,
  signShieldBody,
} from "../../../../packages/shield/src/server/crypto";

export const TEST_IDS = {
  familyA: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1",
  familyB: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2",
  riya: "11111111-1111-4111-8111-111111111111",
  maa: "22222222-2222-4222-8222-222222222222",
  sharma: "33333333-3333-4333-8333-333333333333",
  rohit: "44444444-4444-4444-8444-444444444444",
  otherChild: "55555555-5555-4555-8555-555555555555",
  incident1: "66666666-6666-4666-8666-666666666661",
  reassurance1: "77777777-7777-4777-8777-777777777771",
  voicePost1: "88888888-8888-4888-8888-888888888881",
  consent1: "99999999-9999-4999-8999-999999999991",
  assignment1: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  maaDeviceId: "maa-phone-01",
  pairingSecret: "synthetic-pairing-secret-32-bytes-ok",
  twilioAuthToken: "synthetic-twilio-auth-token-12345",
  cronSecret: "synthetic-cron-secret-xyz",
  sarvamToolToken: "synthetic-sarvam-tool-token-abc",
} as const;

export interface FakeOutboxEntry {
  outboxId: string;
  familyId: string;
  kind: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

export async function buildSignedDeviceRequest(
  url: string,
  bodyObj: Record<string, unknown>,
  opts?: {
    deviceId?: string;
    pairingSecret?: string;
    tsMs?: number;
    tamperSig?: boolean;
  },
): Promise<Request> {
  const deviceId = opts?.deviceId ?? TEST_IDS.maaDeviceId;
  const pairingSecret = opts?.pairingSecret ?? TEST_IDS.pairingSecret;
  const ts = String(opts?.tsMs ?? Date.parse("2026-11-14T19:42:00.000Z"));
  const rawText = JSON.stringify(bodyObj);
  const rawBytes = new TextEncoder().encode(rawText);
  const secret = await deriveDeviceSecret(pairingSecret, deviceId);
  const sig = opts?.tamperSig
    ? "0".repeat(64)
    : await signShieldBody(secret, ts, rawBytes);

  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SHIELD_HEADERS.device]: deviceId,
      [SHIELD_HEADERS.ts]: ts,
      [SHIELD_HEADERS.sig]: sig,
    },
    body: rawBytes,
  });
}

export function buildSignedTwilioFormRequest(
  url: string,
  formFields: Record<string, string>,
  opts?: {
    authToken?: string;
    tamperSig?: boolean;
  },
): Request {
  const authToken = opts?.authToken ?? TEST_IDS.twilioAuthToken;
  const params = new URLSearchParams(formFields);
  const sortedKeys = Array.from(new Set(params.keys())).sort();
  let data = url;
  for (const k of sortedKeys) {
    for (const v of params.getAll(k).sort()) {
      data += k + v;
    }
  }
  const sig = opts?.tamperSig
    ? "invalidsig=="
    : createHmac("sha1", authToken).update(data, "utf8").digest("base64");

  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": sig,
    },
    body: params.toString(),
  });
}

export async function createCore2NewsTestHarness(overrides?: {
  env?: Record<string, string | undefined>;
  zapierResult?: { ok: boolean; status: number | null } | "throw";
}) {
  let clockMs = Date.parse("2026-11-14T19:40:00.000Z");
  let uuidCounter = 100;
  const nextUuid = () => {
    uuidCounter += 1;
    const hex = uuidCounter.toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${hex}`;
  };

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = "test-ed25519-1";
  const publicKeys = new Map<string, TimelineKey>([[keyId, publicKey]]);

  const people = new Map<string, Core2Person>([
    [
      TEST_IDS.riya,
      {
        id: TEST_IDS.riya,
        familyId: TEST_IDS.familyA,
        displayName: "Riya",
        role: "child",
        timezone: "Asia/Kolkata",
      },
    ],
    [
      TEST_IDS.maa,
      {
        id: TEST_IDS.maa,
        familyId: TEST_IDS.familyA,
        displayName: "Meena Maa",
        role: "parent",
        timezone: "Asia/Kolkata",
      },
    ],
    [
      TEST_IDS.sharma,
      {
        id: TEST_IDS.sharma,
        familyId: TEST_IDS.familyA,
        displayName: "Sharma Uncle",
        role: "circle",
        timezone: "Asia/Kolkata",
      },
    ],
    [
      TEST_IDS.rohit,
      {
        id: TEST_IDS.rohit,
        familyId: TEST_IDS.familyA,
        displayName: "Rohit",
        role: "circle",
        timezone: "Asia/Kolkata",
      },
    ],
    [
      TEST_IDS.otherChild,
      {
        id: TEST_IDS.otherChild,
        familyId: TEST_IDS.familyB,
        displayName: "Other Child",
        role: "child",
        timezone: "Asia/Kolkata",
      },
    ],
  ]);

  const tokenToMembership = new Map<string, Core2Membership>([
    [
      "tok-riya",
      {
        familyId: TEST_IDS.familyA,
        userId: "55555555-5555-4555-8555-555555555501",
        personId: TEST_IDS.riya,
        role: "child",
        revokedAt: null,
      },
    ],
    [
      "tok-maa",
      {
        familyId: TEST_IDS.familyA,
        userId: "55555555-5555-4555-8555-555555555502",
        personId: TEST_IDS.maa,
        role: "parent",
        revokedAt: null,
      },
    ],
    [
      "tok-sharma",
      {
        familyId: TEST_IDS.familyA,
        userId: "55555555-5555-4555-8555-555555555503",
        personId: TEST_IDS.sharma,
        role: "circle",
        revokedAt: null,
      },
    ],
    [
      "tok-rohit",
      {
        familyId: TEST_IDS.familyA,
        userId: "55555555-5555-4555-8555-555555555504",
        personId: TEST_IDS.rohit,
        role: "circle",
        revokedAt: null,
      },
    ],
    [
      "tok-other",
      {
        familyId: TEST_IDS.familyB,
        userId: "55555555-5555-4555-8555-555555555505",
        personId: TEST_IDS.otherChild,
        role: "child",
        revokedAt: null,
      },
    ],
  ]);

  const incidents = new Map<string, IncidentSummaryRow>([
    [
      TEST_IDS.incident1,
      {
        id: TEST_IDS.incident1,
        family_id: TEST_IDS.familyA,
        person_id: TEST_IDS.riya,
        owner_person_id: TEST_IDS.sharma,
        state: "accepted",
        severity: "urgent",
        promised_at: "2026-11-14T19:45:00.000Z",
        created_at: "2026-11-14T19:35:00.000Z",
      },
    ],
  ]);

  const assignments: AssignmentSummaryRow[] = [
    {
      id: TEST_IDS.assignment1,
      family_id: TEST_IDS.familyA,
      incident_id: TEST_IDS.incident1,
      person_id: TEST_IDS.sharma,
      display_name: "Sharma Uncle",
      role: "circle",
      status: "accepted",
      offered_at: "2026-11-14T19:35:30.000Z",
      expires_at: "2026-11-14T19:40:30.000Z",
      accepted_at: "2026-11-14T19:36:10.000Z",
    },
  ];

  const circleCompanions: CircleCompanionCandidate[] = [
    {
      person_id: TEST_IDS.sharma,
      display_name: "Sharma Uncle",
      device: "keypad",
      rank: 1,
    },
    {
      person_id: TEST_IDS.rohit,
      display_name: "Rohit",
      device: "smartphone",
      rank: 2,
    },
  ];

  const reassurances = new Map<string, ReassuranceDeliveryRow>([
    [
      TEST_IDS.reassurance1,
      {
        id: TEST_IDS.reassurance1,
        family_id: TEST_IDS.familyA,
        subject_person_id: TEST_IDS.riya,
        recipient_person_id: TEST_IDS.maa,
        kind: "im_safe",
        watch_id: null,
        sos_id: null,
        voice_post_id: TEST_IDS.voicePost1,
        outbox_id: null,
        status_label: "Main safe hoon Maa (+91 9876543210)",
        delivery_status: "delivered",
        delivery_verified: true,
        heard_verified: false,
        created_at: "2026-11-14T19:38:00.000Z",
      },
    ],
  ]);

  const voicePosts = new Map<string, VoicePostDeliveryRow>([
    [
      TEST_IDS.voicePost1,
      {
        id: TEST_IDS.voicePost1,
        family_id: TEST_IDS.familyA,
        sender_id: TEST_IDS.riya,
        recipient_id: TEST_IDS.maa,
        state: "delivered",
        consent_id: TEST_IDS.consent1,
        created_at: "2026-11-14T19:38:00.000Z",
      },
    ],
  ]);

  const gentleNewsByIncident = new Map<string, GentleNewsRow>();
  const heardReceipts = new Map<string, HeardReceiptRow>();
  const afterReports = new Map<string, AfterReportRow>();
  const idempotencyStore = new Map<string, Core2IdempotencyRecord>();
  const outboxEntries: FakeOutboxEntry[] = [];
  const timelineRows: TimelineSummaryRow[] = [];
  const zapierCalls: Array<{ hookUrl: string; payload: ZapierZ3Payload }> = [];
  const callSidToContext = new Map<string, TwilioOutboxLookup>();

  const deviceSecret = await deriveDeviceSecret(TEST_IDS.pairingSecret, TEST_IDS.maaDeviceId);
  const deviceSecretHash = await shieldSha256Hex(deviceSecret);

  const maaRepo = {
    async getDevice(deviceId: string) {
      if (deviceId !== TEST_IDS.maaDeviceId) return null;
      return {
        deviceId: TEST_IDS.maaDeviceId,
        familyId: TEST_IDS.familyA,
        personId: TEST_IDS.maa,
        platform: "android",
        deviceSecretHash,
        revoked: false,
      };
    },
    async getPersonInFamily(familyId: string, personId: string) {
      const p = people.get(personId);
      if (!p || p.familyId !== familyId) return null;
      return {
        id: p.id,
        familyId: p.familyId,
        displayName: p.displayName,
        role: p.role,
        timezone: p.timezone,
      };
    },
  } as unknown as MaaRepo;

  const newsRepo: Core2NewsRepository = {
    async getIncident(familyId, incidentId) {
      const inc = incidents.get(incidentId);
      return inc && inc.family_id === familyId ? { ...inc } : null;
    },
    async closeIncident(familyId, incidentId) {
      const inc = incidents.get(incidentId);
      if (!inc || inc.family_id !== familyId) throw new Error("Incident not found");
      const closed = { ...inc, state: "closed" };
      incidents.set(incidentId, closed);
      return closed;
    },
    async getPerson(familyId, personId) {
      const p = people.get(personId);
      return p && p.familyId === familyId ? { ...p } : null;
    },
    async listAssignmentsForIncident(familyId, incidentId) {
      return assignments.filter(
        (a) => a.family_id === familyId && a.incident_id === incidentId,
      );
    },
    async listActiveCircleCompanions(familyId, excludedPersonIds) {
      if (familyId !== TEST_IDS.familyA) return [];
      const ex = new Set(excludedPersonIds);
      return circleCompanions.filter((c) => !ex.has(c.person_id));
    },
    async getVoicePost(familyId, voicePostId) {
      const vp = voicePosts.get(voicePostId);
      return vp && vp.family_id === familyId ? { ...vp } : null;
    },
    async getGentleNewsByIncident(familyId, incidentId) {
      const row = gentleNewsByIncident.get(incidentId);
      return row && row.family_id === familyId ? { ...row } : null;
    },
    async findLatestOpenGentleNewsForParent(familyId, parentPersonId) {
      for (const row of gentleNewsByIncident.values()) {
        if (
          row.family_id === familyId &&
          row.status !== "closed" &&
          (!parentPersonId || row.parent_person_id === parentPersonId)
        ) {
          return { ...row };
        }
      }
      return null;
    },
    async insertGentleNews(input) {
      const row: GentleNewsRow = {
        id: nextUuid(),
        family_id: input.familyId,
        incident_id: input.incidentId,
        subject_person_id: input.subjectPersonId,
        parent_person_id: input.parentPersonId,
        marked_by_person_id: input.markedByPersonId,
        status: "circle_offered",
        calm_summary: input.calmSummary,
        voice_post_id: input.voicePostId,
        circle_person_id: input.circlePersonId,
        circle_offer_status: input.circleOfferStatus,
        tried_circle_person_ids: [],
        circle_offered_at: input.circleOfferedAt,
        circle_accepted_at: null,
        circle_with_maa_at: null,
        maa_call_due_at: input.maaCallDueAt,
        maa_call_outbox_id: null,
        maa_call_queued_at: null,
        maa_questions: [],
        raw_event_id: input.rawEventId,
        version: 1,
        created_at: input.nowIso,
        updated_at: input.nowIso,
      };
      gentleNewsByIncident.set(input.incidentId, row);
      return { ...row };
    },
    async updateGentleNewsCas(familyId, incidentId, expectedVersion, patch, nowIso) {
      const current = gentleNewsByIncident.get(incidentId);
      if (!current || current.family_id !== familyId || current.version !== expectedVersion) {
        return null;
      }
      const next: GentleNewsRow = {
        ...current,
        ...patch,
        version: expectedVersion + 1,
        updated_at: nowIso,
      };
      gentleNewsByIncident.set(incidentId, next);
      return { ...next };
    },
    async listDueGentleNews(nowIso, limit) {
      const dueMs = Date.parse(nowIso);
      const out: GentleNewsRow[] = [];
      for (const row of gentleNewsByIncident.values()) {
        if (
          (row.status === "circle_offered" || row.status === "companion_with_maa") &&
          row.maa_call_queued_at === null &&
          Date.parse(row.maa_call_due_at) <= dueMs
        ) {
          out.push({ ...row });
        }
      }
      return out.slice(0, limit);
    },
    async listFamilyTimelineForReport(familyId) {
      return timelineRows.filter((t) => t.family_id === familyId);
    },
    async listDeliveriesForReport(familyId, _incidentId, subjectPersonId, parentPersonId) {
      return {
        reassurances: Array.from(reassurances.values()).filter(
          (r) =>
            r.family_id === familyId &&
            r.subject_person_id === subjectPersonId &&
            r.recipient_person_id === parentPersonId,
        ),
        voicePosts: Array.from(voicePosts.values()).filter(
          (v) =>
            v.family_id === familyId &&
            v.sender_id === subjectPersonId &&
            v.recipient_id === parentPersonId,
        ),
      };
    },
    async listHeardReceiptsByDeliveries(familyId, deliveryIds) {
      const set = new Set(deliveryIds);
      return Array.from(heardReceipts.values()).filter(
        (r) => r.family_id === familyId && set.has(r.delivery_id),
      );
    },
    async getHeardReceiptByDelivery(familyId, deliveryId, messageKind) {
      for (const r of heardReceipts.values()) {
        if (
          r.family_id === familyId &&
          r.delivery_id === deliveryId &&
          (!messageKind || r.message_kind === messageKind)
        ) {
          return { ...r };
        }
      }
      return null;
    },
    async findReassurance(familyId, reassuranceId) {
      const r = reassurances.get(reassuranceId);
      return r && r.family_id === familyId ? { ...r } : null;
    },
    async resolveTwilioCallContext(callSid) {
      return callSidToContext.get(callSid) ?? null;
    },
    async recordHeardReceipt(input: RecordHeardInput) {
      const key = `${input.familyId}:${input.messageKind}:${input.deliveryId}`;
      const existing = heardReceipts.get(key);
      if (existing) {
        return { receipt: { ...existing }, alreadyRecorded: true };
      }
      const receipt: HeardReceiptRow = {
        id: nextUuid(),
        family_id: input.familyId,
        message_kind: input.messageKind,
        delivery_id: input.deliveryId,
        reassurance_id: input.reassuranceId,
        voice_post_id: input.voicePostId,
        outbox_id: input.outboxId,
        recipient_person_id: input.recipientPersonId,
        channel: input.channel,
        evidence_type: input.evidenceType,
        device_id: input.deviceId,
        call_sid: input.callSid,
        clip_duration_s: input.clipDurationS,
        played_duration_s: input.playedDurationS,
        dtmf_digit: input.dtmfDigit,
        raw_event_id: input.rawEventId,
        heard_at: input.heardAt,
        created_at: input.heardAt,
      };
      heardReceipts.set(key, receipt);
      if (input.reassuranceId) {
        const r = reassurances.get(input.reassuranceId);
        if (r) {
          reassurances.set(input.reassuranceId, {
            ...r,
            heard_verified: true,
            delivery_verified: true,
            delivery_status: "delivered",
          });
        }
      }
      if (input.voicePostId) {
        const vp = voicePosts.get(input.voicePostId);
        if (vp) {
          voicePosts.set(input.voicePostId, { ...vp, state: "heard" });
        }
      }
      return { receipt: { ...receipt }, alreadyRecorded: false };
    },
    async getAfterReport(familyId, incidentId) {
      const r = afterReports.get(incidentId);
      return r && r.family_id === familyId ? { ...r } : null;
    },
    async saveAfterReport(input) {
      const row: AfterReportRow = {
        id: nextUuid(),
        family_id: input.familyId,
        incident_id: input.incidentId,
        closed_at: input.closedAt,
        report_json: input.reportJson,
        zapier_z3_status: input.zapierStatus,
        zapier_z3_attempted_at: input.zapierAttemptedAt,
        zapier_z3_http_status: input.zapierHttpStatus,
        created_at: input.nowIso,
        updated_at: input.nowIso,
      };
      afterReports.set(input.incidentId, row);
      return row;
    },
    async updateAfterReportZapierStatus(
      familyId,
      incidentId,
      status,
      attemptedAt,
      httpStatus,
      nowIso,
    ) {
      const existing = afterReports.get(incidentId);
      if (existing && existing.family_id === familyId) {
        afterReports.set(incidentId, {
          ...existing,
          zapier_z3_status: status,
          zapier_z3_attempted_at: attemptedAt,
          zapier_z3_http_status: httpStatus,
          updated_at: nowIso,
        });
      }
    },
  };

  const core2Deps: Core2Deps = {
    now: () => new Date(clockMs),
    uuid: nextUuid,
    env: {
      SHIELD_DEVICE_PAIRING_SECRET: TEST_IDS.pairingSecret,
      TWILIO_AUTH_TOKEN: TEST_IDS.twilioAuthToken,
      CRON_SECRET: TEST_IDS.cronSecret,
      SARVAM_TOOL_TOKEN: TEST_IDS.sarvamToolToken,
      DEMO_TIMER_SCALE: "100",
      ...overrides?.env,
    },
    auth: {
      async verifyBearer(token: string) {
        const m = tokenToMembership.get(token);
        return m ? { userId: m.userId } : null;
      },
    },
    repo: {
      async listActiveMemberships(userId: string) {
        return Array.from(tokenToMembership.values()).filter((m) => m.userId === userId);
      },
      async getPerson(familyId: string, personId: string) {
        return newsRepo.getPerson(familyId, personId);
      },
      async listPeopleByRole(
        familyId: string,
        role: "parent" | "child" | "circle" | "vendor",
      ) {
        return Array.from(people.values()).filter(
          (p) => p.familyId === familyId && p.role === role,
        );
      },
      async getIdempotency(
        familyId: string,
        actorPersonId: string,
        action: string,
        keyHash: string,
      ) {
        return idempotencyStore.get(`${familyId}:${actorPersonId}:${action}:${keyHash}`) ?? null;
      },
      async saveIdempotency(record: Core2IdempotencyRecord) {
        idempotencyStore.set(
          `${record.familyId}:${record.actorPersonId}:${record.action}:${record.keyHash}`,
          record,
        );
      },
      async ingestRawEvent() {
        return { rawEventId: nextUuid() };
      },
      async loadGateInput(input: {
        familyId: string;
        actorPersonId: string;
        requestId: string;
        action: GateInput["request"]["action"];
        targetId: string;
        consentSubjectId?: string;
        now: string;
      }): Promise<GateInput> {
        return {
          actor: {
            id: input.actorPersonId,
            familyId: input.familyId,
            active: true,
          },
          request: {
            id: input.requestId,
            familyId: input.familyId,
            action: input.action,
            targetId: input.targetId,
          },
          permissions: [],
          approvals: [],
          consents: [],
          now: input.now,
        };
      },
    } as unknown as Core2Deps["repo"],
    gate: {
      async evaluate() {
        return { decision: "allow" as const, reason: "allowed" as const };
      },
    },
    crypto: {
      encryptPayload(_familyId, _eventId, _source, payload) {
        const json = JSON.stringify(payload);
        return {
          payloadHash: "a".repeat(64),
          payloadCiphertext: json,
        };
      },
      encryptSecretNote(_aad, note) {
        return JSON.stringify(note);
      },
    },
    dispatch: {
      async enqueueAuthorized(req) {
        const outboxId = nextUuid();
        outboxEntries.push({
          outboxId,
          familyId: req.familyId,
          kind: req.kind,
          dedupeKey: req.dedupeKey,
          payload: JSON.parse(req.payloadCiphertext) as Record<string, unknown>,
        });
        return { outboxId, status: "pending" };
      },
    },
    timeline: {
      async append(input) {
        const seq = timelineRows.length + 1;
        const prev = seq > 1 ? timelineRows[seq - 2].chain_hash : null;
        const signed = signTimelineEvent(
          {
            familyId: input.familyId,
            eventId: input.eventId,
            sequence: seq,
            previousHash: prev,
            dedupeKey: input.dedupeKey,
            eventType: input.eventType,
            entityId: input.entityId,
            humanLine: input.humanLine,
            occurredAt: input.occurredAt,
            keyId,
            payload: input.payload,
          },
          privateKey,
        );
        timelineRows.push({
          id: input.eventId,
          family_id: input.familyId,
          event_type: input.eventType,
          entity_id: input.entityId,
          human_line: input.humanLine,
          payload_hash: signed.envelope.payloadHash,
          prev_chain_hash: prev,
          chain_hash: signed.chainHash,
          signature: signed.signature,
          signing_key_id: keyId,
          created_at: input.occurredAt,
          sequence: seq,
          dedupe_key: input.dedupeKey,
          occurred_at_iso: input.occurredAt,
          envelope_canonical: canonicalJson(signed.envelope),
        });
      },
    },
  };

  const deps: Core2NewsDeps = {
    core2: core2Deps,
    newsRepo,
    maaRepo,
    replayGuard: createMemoryReplayGuard(),
    timelinePublicKeys: publicKeys,
    zapier: {
      async postZ3(hookUrl, payload) {
        zapierCalls.push({ hookUrl, payload });
        if (overrides?.zapierResult === "throw") {
          return { ok: false, status: null };
        }
        return overrides?.zapierResult ?? { ok: true, status: 200 };
      },
    },
  };

  return {
    deps,
    outboxEntries,
    timelineRows,
    zapierCalls,
    reassurances,
    voicePosts,
    callSidToContext,
    advanceClockMs(ms: number) {
      clockMs += ms;
    },
    setClockIso(iso: string) {
      clockMs = Date.parse(iso);
    },
  };
}
