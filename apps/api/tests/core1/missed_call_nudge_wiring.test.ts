import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifyTimelineEvent, canonicalJson, signTimelineEvent, type SignedTimelineEvent } from '@/lib/timeline';
import { encryptWebhook } from '@/lib/webhook-security';
import {
  executeMissedCallNudgeCommand,
  processTeleCmiRawMissedCallsForFamily,
  type MissedCallNudgeDeps,
  type MissedCallNudgeStore,
} from '@/lib/core1/missed-call-nudge-service';
import type { MissedCallEvent } from '../../../../packages/atlas/src/core1/types';
import type { Core1Actor, Core1OutboxEnqueueInput, Core1TimelineInput } from '@/lib/core1/wiring-common';

function createFakeMissedCallHarness() {
  const familyId = '11111111-1111-4111-8111-111111111111';
  const maaPersonId = '22222222-2222-4222-8222-222222222222';
  const riyaPersonId = '33333333-3333-4333-8333-333333333333';
  const foreignPersonId = '99999999-9999-4999-8999-999999999999';

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const encryptionKeyHex = randomBytes(32).toString('hex');

  const actors: Record<string, Core1Actor> = {
    'token-riya': { userId: 'u-riya', personId: riyaPersonId, familyId, role: 'child' },
    'token-maa': { userId: 'u-maa', personId: maaPersonId, familyId, role: 'parent' },
  };

  const recentCalls: MissedCallEvent[] = [];
  const processedRawIds = new Set<string>();
  const pendingRawEvents: Array<{
    id: string;
    familyId: string;
    source: string;
    providerEventId: string;
    callerPersonId: string | null;
    payloadCiphertext: string;
    receivedAt: string;
  }> = [];

  const nudges: Array<{ id: string; kind: string; recipientPersonId: string; scheduledAt: string }> = [];
  const childAlerts: Array<{ id: string; kind: string; recipientPersonId: string }> = [];
  const outboxRows: Core1OutboxEnqueueInput[] = [];
  const timelineEvents: SignedTimelineEvent[] = [];
  const pushTokensByPerson = new Map<string, string[]>([
    [riyaPersonId, ['ExponentPushToken[riya-phone-001]']],
  ]);

  let seq = 0;
  let prevChainHash: string | null = null;
  let nowMs = Date.parse('2026-11-15T06:00:00.000Z');

  const store: MissedCallNudgeStore = {
    async verifyFamilyPerson(fam, pid) {
      return fam === familyId && (pid === maaPersonId || pid === riyaPersonId);
    },
    async findDefaultChildRecipient(fam) {
      return fam === familyId ? riyaPersonId : null;
    },
    async listPushTokens(_fam, pid) {
      return pushTokensByPerson.get(pid) ?? [];
    },
    async listRecentCallsInWindow(fam, caller, recipient, sinceIso) {
      const since = Date.parse(sinceIso);
      return recentCalls.filter(
        (c) =>
          c.familyId === fam &&
          c.callerPersonId === caller &&
          c.recipientPersonId === recipient &&
          Date.parse(c.timestamp) >= since,
      );
    },
    async hasProcessedCallKey(dedupeKey, fam) {
      return timelineEvents.some(
        (e) => e.envelope.familyId === fam && e.envelope.dedupeKey === dedupeKey,
      );
    },
    async recordNudge(input) {
      nudges.push({
        id: input.id,
        kind: input.kind,
        recipientPersonId: input.recipientPersonId,
        scheduledAt: input.scheduledAt,
      });
      return { nudgeId: input.id };
    },
    async recordChildAlert(input) {
      childAlerts.push({ id: input.id, kind: input.kind, recipientPersonId: input.recipientPersonId });
    },
    async listPendingTeleCmiRawEvents(fam) {
      return pendingRawEvents.filter((r) => r.familyId === fam && !processedRawIds.has(r.id));
    },
    async markRawEventProcessed(rawEventId) {
      processedRawIds.add(rawEventId);
    },
  };

  const deps: MissedCallNudgeDeps = {
    auth: {
      async authenticate(req) {
        const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
        const actor = actors[token];
        if (!actor) throw new (await import('@/lib/core1/errors')).Core1CommandError('unauthorized', 401);
        return actor;
      },
    },
    store,
    outbox: {
      async enqueue(input) {
        const idx = outboxRows.findIndex(
          (r) => r.familyId === input.familyId && r.dedupeKey === input.dedupeKey,
        );
        if (idx >= 0) return { outboxId: `outbox-${idx + 1}`, deduped: true };
        outboxRows.push(input);
        return { outboxId: `outbox-${outboxRows.length}`, deduped: false };
      },
    },
    timeline: {
      async append(input: Core1TimelineInput) {
        const found = timelineEvents.find(
          (e) => e.envelope.familyId === input.familyId && e.envelope.dedupeKey === input.dedupeKey,
        );
        if (found) {
          return { sequence: found.envelope.sequence, chainHash: found.chainHash, deduped: true };
        }
        seq += 1;
        const signed = signTimelineEvent(
          {
            familyId: input.familyId,
            eventId: `20000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
            sequence: seq,
            previousHash: prevChainHash,
            dedupeKey: input.dedupeKey,
            eventType: input.eventType,
            entityId: input.entityId,
            humanLine: input.humanLine,
            occurredAt: input.occurredAt ?? new Date(nowMs).toISOString(),
            keyId: 'test-key',
            payload: input.payload,
          },
          privatePem,
        );
        canonicalJson(input.payload);
        timelineEvents.push(signed);
        prevChainHash = signed.chainHash;
        return { sequence: seq, chainHash: signed.chainHash, deduped: false };
      },
    },
    encryptionKeyHex,
    now: () => new Date(nowMs),
    windowSeconds: 20,
  };

  function addRawTeleCmiCall(callId: string, occurredAt: string, appId = 777111) {
    const providerEventId = `${appId}:missed:${callId}`;
    const plaintext = JSON.stringify({ app_id: appId, call_id: callId, occurred_at: occurredAt });
    const ciphertext = encryptWebhook(
      Buffer.from(plaintext, 'utf8'),
      encryptionKeyHex,
      `telecmi:${providerEventId}`,
    );
    pendingRawEvents.push({
      id: `raw-${pendingRawEvents.length + 1}`,
      familyId,
      source: 'telecmi',
      providerEventId,
      callerPersonId: maaPersonId,
      payloadCiphertext: ciphertext,
      receivedAt: occurredAt,
    });
  }

  return {
    deps,
    familyId,
    maaPersonId,
    riyaPersonId,
    foreignPersonId,
    recentCalls,
    nudges,
    childAlerts,
    outboxRows,
    timelineEvents,
    processedRawIds,
    publicPem,
    addRawTeleCmiCall,
    advanceTime: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe('Core 1 Missed-Call Nudge Wiring (Item 5a)', () => {
  it('enqueues Riya app push for 1 missed call ("call me when free"), dedupes duplicate TeleCMI call IDs, and drops WhatsApp', async () => {
    const h = createFakeMissedCallHarness();

    const makeReq = (idemp: string) =>
      new Request('http://localhost/api/core1/missed-call-nudge', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-riya',
          'idempotency-key': idemp,
        },
        body: JSON.stringify({
          callerPersonId: h.maaPersonId,
          recipientPersonId: h.riyaPersonId,
          providerCallId: 'cmi-call-001',
          providerAccountId: '777111',
          timestamp: '2026-11-15T06:00:00.000Z',
        }),
      });

    const res1 = await executeMissedCallNudgeCommand(makeReq('mc-1'), h.deps);
    expect(res1.status).toBe(202);
    const b1 = await res1.json();
    expect(b1.status).toBe('queued');
    expect(b1.tier).toBe('single');
    expect(b1.urgency).toBe('routine');
    expect(b1.channel).toBe('app_push');
    expect(b1.notification.body).toBe('Maa ne missed call di — free ho toh call karo');
    expect(b1.notification.englishHint).toBe('Call me when free');

    expect(h.outboxRows).toHaveLength(1);
    expect(h.outboxRows[0].payload.channel).toBe('app_push');
    expect(h.outboxRows[0].payload.whatsappDropped).toBe(true);
    expect(h.outboxRows[0].kind).toBe('core1.missed_call_push');
    expect(JSON.stringify(h.outboxRows[0].payload)).not.toContain('90000');

    // Duplicate providerCallId in same family+recipient+account -> deduped cleanly, no second push
    const res2 = await executeMissedCallNudgeCommand(makeReq('mc-2'), h.deps);
    expect(res2.status).toBe(200);
    const b2 = await res2.json();
    expect(b2.status).toBe('deduped');
    expect(h.outboxRows).toHaveLength(1);
    expect(h.nudges).toHaveLength(1);
    expect(h.childAlerts).toHaveLength(1);

    for (const ev of h.timelineEvents) {
      expect(verifyTimelineEvent(ev, h.publicPem)).toBe(true);
    }
  });

  it('preserves 3-tier urgency escalation from raw TeleCMI events (1=single, 2=repeated, 3+=urgent) cleanly via app push', async () => {
    const h = createFakeMissedCallHarness();

    h.addRawTeleCmiCall('cmi-a', '2026-11-15T06:00:01.000Z');
    h.addRawTeleCmiCall('cmi-b', '2026-11-15T06:00:05.000Z');
    h.addRawTeleCmiCall('cmi-c', '2026-11-15T06:00:10.000Z');
    // Duplicate of cmi-c should deduplicate inside domain grouping
    h.addRawTeleCmiCall('cmi-c', '2026-11-15T06:00:10.000Z');
    // Separate window > 20s later with 2 calls -> elevated tier
    h.addRawTeleCmiCall('cmi-d', '2026-11-15T06:01:00.000Z');
    h.addRawTeleCmiCall('cmi-e', '2026-11-15T06:01:05.000Z');

    const result = await processTeleCmiRawMissedCallsForFamily(h.familyId, h.deps);
    expect(result.clusters).toHaveLength(2);

    expect(result.clusters[0].tier).toBe('urgent');
    expect(result.clusters[0].urgency).toBe('urgent');
    expect(result.clusters[0].callCount).toBe(3);
    expect(result.clusters[0].channel).toBe('app_push');

    expect(result.clusters[1].tier).toBe('repeated');
    expect(result.clusters[1].urgency).toBe('elevated');
    expect(result.clusters[1].callCount).toBe(2);
    expect(result.clusters[1].channel).toBe('app_push');

    expect(h.processedRawIds.size).toBe(6);
    expect(h.outboxRows.every((r) => r.payload.channel === 'app_push' && r.payload.whatsappDropped === true)).toBe(true);
    for (const ev of h.timelineEvents) {
      expect(verifyTimelineEvent(ev, h.publicPem)).toBe(true);
    }
  });

  it('rejects cross-family targets and unauthorized parent role calls fail closed', async () => {
    const h = createFakeMissedCallHarness();

    const parentAttempt = await executeMissedCallNudgeCommand(
      new Request('http://localhost/api/core1/missed-call-nudge', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-maa',
          'idempotency-key': 'mc-parent',
        },
        body: JSON.stringify({
          callerPersonId: h.maaPersonId,
          recipientPersonId: h.riyaPersonId,
          providerCallId: 'cmi-x1',
        }),
      }),
      h.deps,
    );
    expect(parentAttempt.status).toBe(403);

    const foreignTarget = await executeMissedCallNudgeCommand(
      new Request('http://localhost/api/core1/missed-call-nudge', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-riya',
          'idempotency-key': 'mc-foreign',
        },
        body: JSON.stringify({
          callerPersonId: h.foreignPersonId,
          recipientPersonId: h.riyaPersonId,
          providerCallId: 'cmi-x2',
        }),
      }),
      h.deps,
    );
    expect(foreignTarget.status).toBe(403);
    expect(h.outboxRows).toHaveLength(0);
  });
});

