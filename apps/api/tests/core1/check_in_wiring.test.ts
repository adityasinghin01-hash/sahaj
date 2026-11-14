import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyTimelineEvent, signTimelineEvent, type SignedTimelineEvent } from '../../src/lib/timeline';
import { encryptWebhook } from '../../src/lib/webhook-security';
import { dispatchOutbound, type DispatchDeps, type DispatchStore } from '../../src/lib/provider-dispatch';
import type { Core1Actor, Core1AuthPort, Core1TimelinePort } from '../../src/lib/core1/wiring-common';
import type { CheckInConsent } from '../../../../packages/atlas/src/core1/types';
import {
  executeCheckInCommand,
  formatParentAddressForm,
  processCheckInTick,
  syncSarvamCheckInPostCalls,
  withSarvamAgentVariablesTransport,
  type CheckInCallRow,
  type CheckInScheduleRow,
  type CheckInServiceDeps,
  type CheckInStore,
  type CheckInSummaryRecord,
  type SarvamRawEventRow,
} from '../../src/lib/core1/check-in-service';

const FAM_A = '11111111-1111-4111-8111-111111111111';
const MAA_ID = 'c1000000-0000-4000-8000-000000000001';
const RIYA_ID = 'c1000000-0000-4000-8000-000000000002';
const PHONE_MAA = '+919000000001';
const PHONE_SARVAM_AGENT = '+918000000099';
const WEBHOOK_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function createCheckInHarness(initialNow = new Date('2026-11-15T03:45:00.000Z'), envOverrides: Record<string, string> = {}) {
  let now = new Date(initialNow.getTime());
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = 'checkin-ed25519-k1';

  const people = new Map<string, { familyId: string; displayName: string; phone?: string }>([
    [MAA_ID, { familyId: FAM_A, displayName: 'Meena Maa', phone: PHONE_MAA }],
    [RIYA_ID, { familyId: FAM_A, displayName: 'Riya' }],
  ]);

  let consent: CheckInConsent = { hasConsent: true };
  const schedules = new Map<string, CheckInScheduleRow>();
  const calls = new Map<string, CheckInCallRow>();
  const outboxRows = new Map<string, { id: string; callId: string; attempt: number; dedupeKey: string; lease?: string }>();
  const rawEvents: SarvamRawEventRow[] = [];
  const summaries: CheckInSummaryRecord[] = [];
  const commandDedupe = new Map<string, { payloadHash: string; result: Record<string, unknown> }>();
  const nudges: Array<{ id: string; familyId: string; personId: string; kind: string; scheduledAt: string }> = [];
  const childAlerts: Array<{ id: string; familyId: string; personId: string; kind: string }> = [];
  const timelineEvents: Array<{ signed: SignedTimelineEvent; familyId: string; dedupeKey: string; humanLine: string; eventType: string }> = [];
  let seq = 0;
  let prevHash: string | null = null;

  const sarvamHttpRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const pushCalls: Array<{ to: string; title: string; body: string; data: Record<string, string> }> = [];

  const actors: Record<string, Core1Actor> = {
    'token-riya': { userId: 'u-riya', familyId: FAM_A, personId: RIYA_ID, role: 'child' },
    'token-maa': { userId: 'u-maa', familyId: FAM_A, personId: MAA_ID, role: 'parent' },
  };

  const auth: Core1AuthPort = {
    async authenticate(req) {
      const tok = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      return actors[tok] ?? actors['token-riya'];
    },
  };

  const timeline: Core1TimelinePort = {
    async append(input) {
      const existing = timelineEvents.find((e) => e.familyId === input.familyId && e.dedupeKey === input.dedupeKey);
      if (existing) {
        return { deduped: true, sequence: seq, chainHash: existing.signed.chainHash };
      }
      seq += 1;
      const occurredAt = new Date(Date.parse(input.occurredAt ?? now.toISOString())).toISOString();
      const signed = signTimelineEvent(
        {
          familyId: input.familyId,
          eventId: randomUUID(),
          sequence: seq,
          dedupeKey: input.dedupeKey,
          eventType: input.eventType,
          entityId: input.entityId,
          humanLine: input.humanLine,
          previousHash: prevHash,
          occurredAt,
          keyId,
          payload: input.payload,
        },
        privateKey,
      );
      prevHash = signed.chainHash;
      timelineEvents.push({
        signed,
        familyId: input.familyId,
        dedupeKey: input.dedupeKey,
        humanLine: input.humanLine,
        eventType: input.eventType,
      });
      return { deduped: false, sequence: seq, chainHash: signed.chainHash };
    },
  };

  const store: CheckInStore = {
    async verifyFamilyPerson(familyId, personId) {
      return people.get(personId)?.familyId === familyId;
    },
    async getPersonDisplayName(familyId, personId) {
      const p = people.get(personId);
      return p && p.familyId === familyId ? p.displayName : 'Maa';
    },
    async getCircleMember() {
      return null;
    },
    async getLatestCheckInConsent() {
      return consent;
    },
    async getScheduleById(familyId, scheduleId) {
      const s = schedules.get(scheduleId);
      return s && s.familyId === familyId ? { ...s } : null;
    },
    async findPersonCheckInSchedule(familyId, personId) {
      return [...schedules.values()].find((s) => s.familyId === familyId && s.personId === personId) ?? null;
    },
    async upsertSchedule(params) {
      const id = params.id ?? [...schedules.values()].find((s) => s.familyId === params.familyId && s.personId === params.personId)?.id ?? randomUUID();
      const row: CheckInScheduleRow = {
        id,
        familyId: params.familyId,
        personId: params.personId,
        kind: 'check_in',
        nextAt: params.nextAt,
        timezone: params.timezone,
        enabled: params.enabled,
      };
      schedules.set(id, row);
      return { ...row };
    },
    async updateScheduleNextAt(scheduleId, nextAt, enabled) {
      const s = schedules.get(scheduleId);
      if (!s) return;
      s.nextAt = nextAt;
      if (enabled !== undefined) s.enabled = enabled;
    },
    async listDueSchedules(nowIso) {
      const t = Date.parse(nowIso);
      return [...schedules.values()].filter((s) => s.enabled && Date.parse(s.nextAt) <= t);
    },
    async listCallsForPersonBetween(familyId, personId, fromIso, toIso) {
      const from = Date.parse(fromIso);
      const to = Date.parse(toIso);
      return [...calls.values()].filter(
        (c) =>
          c.familyId === familyId &&
          c.personId === personId &&
          Date.parse(c.createdAt) >= from &&
          Date.parse(c.createdAt) <= to,
      );
    },
    async findCallByExternalId(provider, externalId) {
      return [...calls.values()].find((c) => c.provider === provider && c.externalId === externalId) ?? null;
    },
    async findCallById(familyId, callId) {
      const c = calls.get(callId);
      return c && c.familyId === familyId ? { ...c } : null;
    },
    async createInboundCallRow(params) {
      const row: CheckInCallRow = {
        id: params.id,
        familyId: params.familyId,
        personId: params.personId,
        provider: 'sarvam',
        externalId: params.externalId,
        status: params.status,
        aiDisclosedAt: now.toISOString(),
        startedAt: params.startedAt,
        endedAt: params.endedAt,
        createdAt: params.startedAt ?? now.toISOString(),
      };
      calls.set(row.id, row);
      return { ...row };
    },
    async updateCallStatus(params) {
      const c = calls.get(params.callId);
      if (!c) return;
      c.status = params.status;
      if (params.startedAt !== undefined) c.startedAt = params.startedAt;
      if (params.endedAt !== undefined) c.endedAt = params.endedAt;
    },
    async prepareCheckInDispatch(params) {
      const existing = [...outboxRows.values()].find((o) => o.dedupeKey === params.dedupeKey);
      if (existing) {
        return { status: 'existing', outboxId: existing.id, callId: existing.callId, actionRequestId: randomUUID() };
      }
      const outboxId = randomUUID();
      const callId = randomUUID();
      outboxRows.set(outboxId, { id: outboxId, callId, attempt: 0, dedupeKey: params.dedupeKey });
      calls.set(callId, {
        id: callId,
        familyId: params.familyId,
        personId: params.personId,
        provider: 'sarvam',
        externalId: null,
        status: 'scheduled',
        aiDisclosedAt: null,
        startedAt: null,
        endedAt: null,
        createdAt: now.toISOString(),
      });
      return { status: 'ready', outboxId, callId, actionRequestId: randomUUID() };
    },
    async claimOutboxForDirectDispatch(outboxId) {
      const o = outboxRows.get(outboxId);
      if (!o) return null;
      o.attempt += 1;
      o.lease = randomUUID();
      return { leaseToken: o.lease, attempt: o.attempt };
    },
    async finishOutboxDispatch() {},
    async listChildPushTokens() {
      return ['ExponentPushToken[riya-synth-device-1]'];
    },
    async recordNudge(params) {
      nudges.push(params);
    },
    async recordChildAlert(params) {
      childAlerts.push(params);
    },
    async upsertCheckInSummary(record) {
      if (summaries.some((s) => s.familyId === record.familyId && s.dedupeKey === record.dedupeKey)) return false;
      summaries.push(record);
      return true;
    },
    async hasSummaryDedupe(familyId, dedupeKey) {
      return summaries.some((s) => s.familyId === familyId && s.dedupeKey === dedupeKey);
    },
    async listUnprojectedSarvamEvents() {
      return [...rawEvents];
    },
    async findCommandDedupe(familyId, dedupeKey) {
      return commandDedupe.get(`${familyId}:${dedupeKey}`) ?? null;
    },
    async saveCommandDedupe(params) {
      commandDedupe.set(`${params.familyId}:${params.dedupeKey}`, {
        payloadHash: params.payloadHash,
        result: params.result,
      });
    },
  };

  let attemptSeq = 0;
  const dispatchStoreFake: DispatchStore = {
    async claimOutbox() { return []; },
    async getBinding() { return null; },
    async bindOutbox() { return true; },
    async claim() { return 'claimed'; },
    async complete(input) {
      const row = [...outboxRows.values()].find((o) => input.key.includes(o.id));
      if (row) {
        const c = calls.get(row.callId);
        if (c) {
          c.externalId = input.providerRef;
          c.aiDisclosedAt = now.toISOString();
          c.status = 'ringing';
        }
      }
    },
    async bindIdentity() { return true; },
    async fail() { return true; },
    async unknown() { return true; },
    async sweepStale() { return 0; },
    async reconcile() { return true; },
    async recordDeliveryProof() { return null; },
    async reconcileOutbox() { return true; },
    async acceptAssignment() { return true; },
    async finishOutbox() { return true; },
  };

  const resolveDestination: DispatchDeps['resolveDestination'] = Object.assign(
    async (_familyId: string, personId: string) => people.get(personId)?.phone ?? null,
    {
      async resolveIdentity(_familyId: string, personId: string) {
        const e164 = people.get(personId)?.phone;
        if (!e164) return null;
        return {
          e164,
          identityId: randomUUID(),
          accountId: 'app-sarvam-synth',
          identityHash: createHash('sha256').update(e164).digest('hex'),
        };
      },
    },
  );

  const dispatchDeps: DispatchDeps = {
    store: dispatchStoreFake,
    authorize: async (cmd, key) => ({
      decision: 'allow',
      consent: true,
      personId: cmd.personId,
      action: cmd.payload.action,
      idempotencyKey: key,
      expiresAt: Date.now() + 60_000,
    }),
    resolveDestination,
    identitySecret: '0'.repeat(64),
    transport: async (url, init) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      sarvamHttpRequests.push({ url, body });
      attemptSeq += 1;
      return new Response(
        JSON.stringify({ attempt_id: `att-synth-${attemptSeq}`, status: 'queued' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
    providers: {
      sarvam: {
        apiKey: 'sarvam-synth-key',
        orgId: 'org-synth',
        workspaceId: 'ws-synth',
        appId: 'app-sarvam-synth',
        appVersion: 1,
        connectionId: 'conn-synth',
        agentPhoneNumber: PHONE_SARVAM_AGENT,
        webhookUrl: 'https://api.sahaj.example/api/sarvam/webhook',
      },
    },
  };

  const pushFetch = async (_url: string, init: RequestInit) => {
    const msgs = JSON.parse(String(init.body)) as Array<{ to: string; title: string; body: string; data: Record<string, string> }>;
    pushCalls.push(...msgs);
    return new Response(JSON.stringify({ data: msgs.map(() => ({ status: 'ok' })) }), { status: 200 });
  };

  const deps: CheckInServiceDeps = {
    auth,
    store,
    timeline,
    dispatch: {
      deps: dispatchDeps,
      dispatchFn: dispatchOutbound,
    },
    pushFetch,
    encryptionKeyHex: WEBHOOK_KEY_HEX,
    now: () => new Date(now.getTime()),
    env: {
      DEMO_TIMER_SCALE: '1',
      WEBHOOK_ENCRYPTION_KEY: WEBHOOK_KEY_HEX,
      ...envOverrides,
    },
  };

  function pushEncryptedSarvamEvent(params: {
    eventType: 'sarvam.outbound' | 'sarvam.inbound';
    callId?: string;
    attemptId?: string;
    interactionId?: string;
    status: string;
    payload: Record<string, unknown>;
  }) {
    const eventId = randomUUID();
    const providerEventId = `${params.eventType}:${params.attemptId ?? params.interactionId ?? eventId}:${params.status}`;
    const cipher = encryptWebhook(
      Buffer.from(JSON.stringify(params.payload), 'utf8'),
      WEBHOOK_KEY_HEX,
      `sarvam:${providerEventId}`,
    );
    rawEvents.push({
      id: eventId,
      familyId: FAM_A,
      source: 'sarvam',
      providerEventId,
      eventType: params.eventType,
      metadata: {
        person_id: MAA_ID,
        status: params.status,
        ...(params.callId ? { call_id: params.callId } : {}),
      },
      payloadCiphertext: cipher,
      receivedAt: now.toISOString(),
    });
    return eventId;
  }

  return {
    deps,
    schedules,
    calls,
    summaries,
    timelineEvents,
    sarvamHttpRequests,
    pushCalls,
    childAlerts,
    publicKey,
    setConsent: (c: CheckInConsent) => { consent = c; },
    setNow: (d: Date) => { now = new Date(d.getTime()); },
    advanceMs: (ms: number) => { now = new Date(now.getTime() + ms); },
    pushEncryptedSarvamEvent,
  };
}

function makeCheckInReq(token: string, body: Record<string, unknown>, idempotencyKey: string): Request {
  return new Request('https://api.sahaj.example/api/core1/check-in', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

describe('Core 1 Daily Check-In End-to-End Wiring', () => {
  it('formats parent address_form cleanly and injects agent_variables without phone numbers', async () => {
    expect(formatParentAddressForm('Meena Maa')).toBe('Meena ji');
    expect(formatParentAddressForm('Maa')).toBe('Maa ji');
    expect(formatParentAddressForm('Sharma ji')).toBe('Sharma ji');

    let capturedBody: Record<string, unknown> = {};
    const wrapped = withSarvamAgentVariablesTransport(
      async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ attempt_id: 'att-1' }), { status: 200 });
      },
      { family_id: FAM_A, parent_id: MAA_ID, address_form: 'Meena ji' },
    );

    await wrapped('https://api.sarvam.ai/call-analytics/api/v1/outbounds', {
      method: 'POST',
      body: JSON.stringify({ app_config: { app_id: 'app-1' }, user_identifier: PHONE_MAA }),
    });

    const appCfg = capturedBody.app_config as { agent_variables: Record<string, string> };
    expect(appCfg.agent_variables).toEqual({
      family_id: FAM_A,
      parent_id: MAA_ID,
      address_form: 'Meena ji',
    });
    expect(JSON.stringify(appCfg.agent_variables)).not.toContain('9000');
  });

  it('respects quiet hours deferral, recovers missed cron schedule, passes Sarvam agent_variables, and prevents duplicate active-day call', async () => {
    // 23:30 IST = 18:00 UTC (inside quiet hours 22:00-07:00 IST)
    const h = createCheckInHarness(new Date('2026-11-15T18:00:00.000Z'));

    // Create schedule at 09:00 IST (overdue from 2026-11-15 morning, or immediate wake during quiet hours)
    const wakeRes = await executeCheckInCommand(
      makeCheckInReq(
        'token-riya',
        { personId: MAA_ID, preferredTime: '09:00', timezone: 'Asia/Kolkata', wakeToken: 'quiet-wake-1' },
        'chk-quiet-1',
      ),
      h.deps,
    );
    expect(wakeRes.status).toBe(201);
    expect(wakeRes.body.action).toBe('defer_quiet_hours');
    expect(h.sarvamHttpRequests).toHaveLength(0);

    // Move to 09:15 IST next morning (2026-11-16T03:45:00Z), overdue past 07:00 IST quiet end
    h.setNow(new Date('2026-11-16T03:45:00.000Z'));
    const tickRes = await processCheckInTick(h.deps);
    expect(tickRes.evaluated).toBe(1);
    expect(tickRes.dispatched).toBe(1);
    expect(h.sarvamHttpRequests).toHaveLength(1);

    const sarvamPayload = h.sarvamHttpRequests[0].body;
    expect((sarvamPayload.user_config as { user_phone_number: string }).user_phone_number).toBe(PHONE_MAA);
    const appCfg = sarvamPayload.app_config as { agent_variables: Record<string, string> };
    expect(appCfg.agent_variables.family_id).toBe(FAM_A);
    expect(appCfg.agent_variables.parent_id).toBe(MAA_ID);
    expect(appCfg.agent_variables.address_form).toBe('Meena ji');
    expect(JSON.stringify(appCfg.agent_variables)).not.toContain('9000');

    // Re-running cron while call is already active/ringing must NOT duplicate call
    const sched = [...h.schedules.values()][0];
    sched.nextAt = new Date('2026-11-16T03:40:00.000Z').toISOString();
    const secondTick = await processCheckInTick(h.deps);
    expect(secondTick.dispatched).toBe(0);
    expect(h.sarvamHttpRequests).toHaveLength(1);
  });

  it('retries once after no_answer (scaled by DEMO_TIMER_SCALE), pushes Riya via Expo on exhaustion, and projects connected/inbound post-calls for Maa\'s day', async () => {
    // 09:00 IST = 03:30 UTC
    const h = createCheckInHarness(new Date('2026-11-16T03:30:00.000Z'), { DEMO_TIMER_SCALE: '15' });

    const cmd = await executeCheckInCommand(
      makeCheckInReq(
        'token-riya',
        { personId: MAA_ID, preferredTime: '09:00', timezone: 'Asia/Kolkata', wakeToken: 'morning-wake-1' },
        'chk-wake-morning',
      ),
      h.deps,
    );
    expect(cmd.status).toBe(201);
    expect(h.sarvamHttpRequests).toHaveLength(1);
    const firstCallId = String(cmd.body.callId);

    // 1. First attempt returns no_answer -> projected + retry scheduled (+15m / 15 = +1m)
    h.advanceMs(30_000);
    h.pushEncryptedSarvamEvent({
      eventType: 'sarvam.outbound',
      callId: firstCallId,
      attemptId: 'att-synth-1',
      status: 'no_answer',
      payload: { attempt_id: 'att-synth-1', status: 'no_answer', user_identifier: PHONE_MAA },
    });

    const sync1 = await syncSarvamCheckInPostCalls(h.deps);
    expect(sync1.projected).toBe(1);
    expect(h.calls.get(firstCallId)?.status).toBe('failed');
    expect(h.summaries[0].outcome).toBe('no_answer');
    expect(h.summaries[0].shortSummary).not.toContain('9000');

    // Retry fires via cron tick after scaled 1 minute delay
    h.advanceMs(65_000);
    const retryTick = await processCheckInTick(h.deps);
    expect(retryTick.dispatched).toBe(1);
    expect(h.sarvamHttpRequests).toHaveLength(2);
    const secondCallId = [...h.calls.values()].find((c) => c.id !== firstCallId)!.id;

    // 2. Second attempt also returns no_answer -> maxAttempts (2) reached -> Expo app push to Riya (no WhatsApp!)
    h.advanceMs(30_000);
    h.pushEncryptedSarvamEvent({
      eventType: 'sarvam.outbound',
      callId: secondCallId,
      attemptId: 'att-synth-2',
      status: 'no_answer',
      payload: { attempt_id: 'att-synth-2', status: 'no_answer', user_identifier: PHONE_MAA },
    });

    const sync2 = await syncSarvamCheckInPostCalls(h.deps);
    expect(sync2.projected).toBe(1);
    expect(sync2.retriedOrEscalated).toBe(1);
    expect(h.pushCalls.length).toBeGreaterThanOrEqual(1);
    const riyaPush = h.pushCalls[h.pushCalls.length - 1];
    expect(riyaPush.to).toBe('ExponentPushToken[riya-synth-device-1]');
    expect(riyaPush.body).not.toContain('9000');

    // 3. Connected outbound call next day + inbound helpline call -> updates calls + summaries + signed timeline
    h.setNow(new Date('2026-11-17T03:35:00.000Z'));
    const nextDayTick = await processCheckInTick(h.deps);
    expect(nextDayTick.dispatched).toBe(1);
    const day2CallId = [...h.calls.values()].find((c) => c.id !== firstCallId && c.id !== secondCallId)!.id;

    h.advanceMs(90_000);
    h.pushEncryptedSarvamEvent({
      eventType: 'sarvam.outbound',
      callId: day2CallId,
      attemptId: 'att-synth-3',
      status: 'connected',
      payload: {
        attempt_id: 'att-synth-3',
        status: 'connected',
        duration_seconds: 125,
        final_agent_variables: { mood: 'cheerful', medicines_taken: 'taken' },
      },
    });
    h.pushEncryptedSarvamEvent({
      eventType: 'sarvam.inbound',
      interactionId: 'int-inbound-1',
      status: 'connected',
      payload: {
        interaction_id: 'int-inbound-1',
        status: 'connected',
        duration_seconds: 64,
      },
    });

    const sync3 = await syncSarvamCheckInPostCalls(h.deps);
    expect(sync3.projected).toBe(2);
    expect(h.calls.get(day2CallId)?.status).toBe('completed');
    expect(h.summaries.some((s) => s.callId === day2CallId && s.outcome === 'answered' && s.shortSummary.includes('cheerful'))).toBe(true);
    expect(h.summaries.some((s) => s.shortSummary.includes('Sahaj helpline'))).toBe(true);

    // Every emitted timeline event verifies cleanly with Ed25519 and omits phone numbers
    for (const ev of h.timelineEvents) {
      expect(verifyTimelineEvent(ev.signed, h.publicKey)).toBe(true);
      expect(ev.humanLine).not.toContain('9000');
    }
  });

  it('cancels a scheduled check-in cleanly', async () => {
    const h = createCheckInHarness(new Date('2026-11-15T06:00:00.000Z'));
    await executeCheckInCommand(
      makeCheckInReq('token-riya', { personId: MAA_ID, preferredTime: '09:00', timezone: 'Asia/Kolkata' }, 'chk-create'),
      h.deps,
    );
    const schedId = [...h.schedules.values()][0].id;
    const cancelRes = await executeCheckInCommand(
      makeCheckInReq(
        'token-riya',
        { personId: MAA_ID, scheduleId: schedId, cancel: true, cancellationReason: 'visiting family' },
        'chk-cancel',
      ),
      h.deps,
    );
    expect(cancelRes.status).toBe(200);
    expect(h.schedules.get(schedId)?.enabled).toBe(false);
  });
});

