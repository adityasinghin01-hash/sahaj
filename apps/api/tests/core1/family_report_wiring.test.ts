import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifyTimelineEvent, canonicalJson, signTimelineEvent, type SignedTimelineEvent } from '@/lib/timeline';
import {
  executeFamilyReportCommand,
  executeWeeklyFamilyReportZapierGet,
  type FamilyReportServiceDeps,
  type FamilyReportStore,
  type WeeklyReportDbFacts,
} from '@/lib/core1/family-report-service';
import type { Core1Actor, Core1TimelineInput } from '@/lib/core1/wiring-common';

function createFakeReportHarness(options?: { secret?: string }) {
  const familyId = '11111111-1111-4111-8111-111111111111';
  const foreignFamilyId = '99999999-9999-4999-8999-999999999999';
  const riyaPersonId = '33333333-3333-4333-8333-333333333333';
  const maaPersonId = '22222222-2222-4222-8222-222222222222';

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  const actors: Record<string, Core1Actor> = {
    'token-riya': { userId: 'u-riya', personId: riyaPersonId, familyId, role: 'child' },
    'token-maa': { userId: 'u-maa', personId: maaPersonId, familyId, role: 'parent' },
  };

  const facts: WeeklyReportDbFacts = {
    calls: [
      { id: 'c1', status: 'completed', createdAt: '2026-11-10T08:00:00.000Z' },
      { id: 'c2', status: 'completed', createdAt: '2026-11-11T08:00:00.000Z' },
      { id: 'c3', status: 'failed', createdAt: '2026-11-12T08:00:00.000Z' },
    ],
    incidents: [
      { id: 'i1', state: 'closed', severity: 'urgent', createdAt: '2026-11-11T10:00:00.000Z' },
    ],
    refills: [
      { id: 'r1', status: 'executed', createdAt: '2026-11-12T11:00:00.000Z' },
      { id: 'r2', status: 'pending', createdAt: '2026-11-13T11:00:00.000Z' },
    ],
    nudges: [
      { id: 'n1', kind: 'missed_call_single', status: 'sent', scheduledAt: '2026-11-14T09:00:00.000Z' },
    ],
    shieldEventsCount: 4,
    timelineRecords: [
      {
        id: 't1',
        familyId,
        source: 'timeline',
        eventType: 'check_in.completed',
        createdAt: '2026-11-10T08:05:00.000Z',
        contentPreview: 'Check-in completed for Maa (+919000000011)',
      },
      {
        id: 't2',
        familyId,
        source: 'timeline',
        eventType: 'core1.refill.authorized',
        createdAt: '2026-11-12T11:05:00.000Z',
        contentPreview: 'Refill order authorized, OTP 482910 never shared',
      },
      {
        id: 't3',
        familyId,
        source: 'timeline',
        eventType: 'general.note',
        createdAt: '2026-11-14T12:00:00.000Z',
        contentPreview: 'Callback requested from +919000000022 code 9912',
      },
    ],
  };

  const timelineEvents: SignedTimelineEvent[] = [];
  let seq = 0;
  let prevChainHash: string | null = null;
  const nowDate = new Date('2026-11-15T06:00:00.000Z');

  const store: FamilyReportStore = {
    async familyExists(fam) {
      return fam === familyId;
    },
    async loadWeeklyFacts(fam, start, end) {
      if (fam !== familyId) {
        return { calls: [], incidents: [], refills: [], nudges: [], shieldEventsCount: 0, timelineRecords: [] };
      }
      const inWin = (iso: string) => Date.parse(iso) >= Date.parse(start) && Date.parse(iso) <= Date.parse(end);
      return {
        calls: facts.calls.filter((c) => inWin(c.createdAt)),
        incidents: facts.incidents.filter((i) => inWin(i.createdAt)),
        refills: facts.refills.filter((r) => inWin(r.createdAt)),
        nudges: facts.nudges.filter((n) => inWin(n.scheduledAt)),
        shieldEventsCount: facts.shieldEventsCount,
        timelineRecords: facts.timelineRecords.filter((t) => inWin(t.createdAt)),
      };
    },
  };

  const deps: FamilyReportServiceDeps = {
    auth: {
      async authenticate(req) {
        const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
        const actor = actors[token];
        if (!actor) throw new (await import('@/lib/core1/errors')).Core1CommandError('unauthorized', 401);
        return actor;
      },
    },
    store,
    timeline: {
      async append(input: Core1TimelineInput) {
        seq += 1;
        const signed = signTimelineEvent(
          {
            familyId: input.familyId,
            eventId: `30000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
            sequence: seq,
            previousHash: prevChainHash,
            dedupeKey: input.dedupeKey,
            eventType: input.eventType,
            entityId: input.entityId,
            humanLine: input.humanLine,
            occurredAt: input.occurredAt ?? nowDate.toISOString(),
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
    env: options?.secret ? { ZAPIER_REPORT_SECRET: options.secret } : {},
    now: () => nowDate,
  };

  return { deps, familyId, foreignFamilyId, timelineEvents, publicPem };
}

describe('Core 1 Family Report & Zapier Z2 Endpoint Wiring (Item 5b)', () => {
  it('compiles redacted weekly counts from real database facts for Riya and denies parent role', async () => {
    const h = createFakeReportHarness({ secret: 'zap-secret-test' });

    const parentRes = await executeFamilyReportCommand(
      new Request('http://localhost/api/core1/family-report', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-maa',
          'idempotency-key': 'rep-maa',
        },
        body: JSON.stringify({
          periodStart: '2026-11-08T00:00:00.000Z',
          periodEnd: '2026-11-15T12:00:00.000Z',
        }),
      }),
      h.deps,
    );
    expect(parentRes.status).toBe(403);

    const riyaRes = await executeFamilyReportCommand(
      new Request('http://localhost/api/core1/family-report', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-riya',
          'idempotency-key': 'rep-riya',
        },
        body: JSON.stringify({
          periodStart: '2026-11-08T00:00:00.000Z',
          periodEnd: '2026-11-15T12:00:00.000Z',
        }),
      }),
      h.deps,
    );
    expect(riyaRes.status).toBe(200);
    const body = await riyaRes.json();
    expect(body.status).toBe('ready');
    expect(body.report.schema).toBe('sahaj.zapier.z2.v1');
    expect(body.report.redacted).toBe(true);
    expect(body.report.counts).toEqual({
      checkIns: 3,
      checkInsCompleted: 2,
      incidents: 1,
      incidentsResolved: 1,
      refills: 2,
      nudges: 1,
      shieldEvents: 4,
    });

    const serialized = JSON.stringify(body.report);
    expect(serialized).not.toContain('9000000011');
    expect(serialized).not.toContain('9000000022');
    expect(serialized).not.toContain('482910');
    expect(serialized).not.toContain('9912');
    expect(serialized).toContain('<MOBILE_MASKED>');
    expect(serialized).toContain('******');
    expect(verifyTimelineEvent(h.timelineEvents[0], h.publicPem)).toBe(true);
  });

  it('enforces shared secret header x-sahaj-zap-secret on GET /api/core1/family-report/weekly and returns Z2 JSON', async () => {
    const unconfigured = createFakeReportHarness();
    const unconfRes = await executeWeeklyFamilyReportZapierGet(
      new Request(`http://localhost/api/core1/family-report/weekly?familyId=${unconfigured.familyId}`, {
        headers: { 'x-sahaj-zap-secret': 'anything' },
      }),
      unconfigured.deps,
    );
    expect(unconfRes.status).toBe(503);

    const h = createFakeReportHarness({ secret: 'super-secret-z2-key' });

    const missingSecret = await executeWeeklyFamilyReportZapierGet(
      new Request(`http://localhost/api/core1/family-report/weekly?familyId=${h.familyId}`),
      h.deps,
    );
    expect(missingSecret.status).toBe(401);

    const wrongSecret = await executeWeeklyFamilyReportZapierGet(
      new Request(`http://localhost/api/core1/family-report/weekly?familyId=${h.familyId}`, {
        headers: { 'x-sahaj-zap-secret': 'wrong-secret' },
      }),
      h.deps,
    );
    expect(wrongSecret.status).toBe(401);

    const validRes = await executeWeeklyFamilyReportZapierGet(
      new Request(`http://localhost/api/core1/family-report/weekly?familyId=${h.familyId}`, {
        headers: { 'x-sahaj-zap-secret': 'super-secret-z2-key' },
      }),
      h.deps,
    );
    expect(validRes.status).toBe(200);
    const z2 = await validRes.json();
    expect(z2.schema).toBe('sahaj.zapier.z2.v1');
    expect(z2.counts.shieldEvents).toBe(4);
    expect(z2.counts.checkIns).toBe(3);
    expect(z2.counts.refills).toBe(2);
    expect(JSON.stringify(z2)).not.toContain('9000000022');
  });
});

