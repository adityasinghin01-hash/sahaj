import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signTimelineEvent, type SignedTimelineEvent, verifyTimelineEvent } from '@/lib/timeline';
import { Core1CommandError } from '@/lib/core1/errors';
import type { ExpoPushMessage } from '@/lib/core1/voice-notify';
import {
  BOTH_FREE_NUDGE_BODY,
  handleFreeTimesDelete,
  handleFreeTimesGet,
  handleFreeTimesPost,
  handleMatcherTick,
  handleSarvamFreeTimeTool,
  type Core1MatcherDeps,
  type Core1MatcherStore,
  type FreeWindowRecord,
  type MatcherAuthActor,
  type MatcherNudgeLogRecord,
  type PersonScheduleContext,
} from '@/lib/core1-matcher';

function createMatcherHarness(initialNowIso = '2026-11-15T13:00:00.000Z') {
  const familyId = '11111111-1111-4111-8111-111111111111';
  const familyBId = '99999999-9999-4999-8999-999999999999';
  const maaId = '22222222-2222-4222-8222-222222222222';
  const riyaId = '33333333-3333-4333-8333-333333333333';
  const uncleId = '44444444-4444-4444-8444-444444444444';

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  let now = new Date(initialNowIso);
  let seq = 0;
  let prevHash: string | null = null;
  let idCounter = 0;

  const actors: Record<string, MatcherAuthActor> = {
    'token-riya': { userId: 'u-riya', familyId, personId: riyaId, role: 'child' },
    'token-maa': { userId: 'u-maa', familyId, personId: maaId, role: 'parent' },
    'token-uncle': { userId: 'u-uncle', familyId, personId: uncleId, role: 'circle' },
  };

  const people: PersonScheduleContext[] = [
    {
      id: maaId,
      familyId,
      displayName: 'Meena Maa',
      role: 'parent',
      timezone: 'Asia/Kolkata',
      quietWindows: [{ start: '22:00', end: '07:00' }],
    },
    {
      id: riyaId,
      familyId,
      displayName: 'Riya',
      role: 'child',
      timezone: 'Asia/Kolkata',
      quietWindows: [],
    },
  ];

  const windows: FreeWindowRecord[] = [];
  const nudgeLogs: MatcherNudgeLogRecord[] = [];
  const nudges: Array<{ id: string; recipientPersonId: string; kind: string; status: string }> = [];
  const childAlerts: Array<{ id: string; recipientPersonId: string; kind: string }> = [];
  const outboxRows: Array<{
    outboxId: string;
    familyId: string;
    kind: string;
    action: string;
    dedupeKey: string;
    payload: Record<string, unknown>;
  }> = [];
  const pushedMessages: ExpoPushMessage[] = [];
  const timelineEvents: SignedTimelineEvent[] = [];
  let talkedTodayFlag = false;

  const env: Record<string, string | undefined> = {
    CRON_SECRET: 'test-cron-secret',
    SARVAM_TOOL_TOKEN: 'test-sarvam-tool-token',
    DEMO_TIMER_SCALE: '1',
  };

  const store: Core1MatcherStore = {
    async getPerson(fam, pid) {
      return people.find((p) => p.familyId === fam && p.id === pid) ?? null;
    },
    async listFamilyPeople(fam) {
      return people.filter((p) => p.familyId === fam);
    },
    async listCandidateFamilyIds(requested) {
      if (requested) return [requested];
      return [...new Set(windows.filter((w) => w.active).map((w) => w.familyId))];
    },
    async listActiveWindowsForFamily(fam) {
      return windows.filter((w) => w.familyId === fam && w.active);
    },
    async listActiveWindowsForPerson(fam, pid) {
      return windows.filter((w) => w.familyId === fam && w.personId === pid && w.active);
    },
    async createWindow(input, options) {
      if (options?.deactivateSource) {
        for (const w of windows) {
          if (
            w.familyId === input.familyId &&
            w.personId === input.personId &&
            w.source === options.deactivateSource &&
            w.active
          ) {
            w.active = false;
          }
        }
      }
      const rec: FreeWindowRecord = {
        id: input.id,
        familyId: input.familyId,
        personId: input.personId,
        timezone: input.timezone,
        startMinute: input.startMinute,
        endMinute: input.endMinute,
        kind: input.kind,
        daysOfWeek: input.daysOfWeek,
        expiresAt: input.expiresAt,
        source: input.source,
        label: input.label,
        active: true,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      windows.push(rec);
      return rec;
    },
    async deactivateWindow(fam, pid, wid) {
      const target = windows.find(
        (w) => w.id === wid && w.familyId === fam && w.personId === pid && w.active,
      );
      if (!target) return false;
      target.active = false;
      return true;
    },
    async getMatcherNudgeForDay(fam, parentId, localDate) {
      return (
        nudgeLogs.find(
          (n) =>
            n.familyId === fam &&
            n.parentPersonId === parentId &&
            n.localDate === localDate,
        ) ?? null
      );
    },
    async claimMatcherNudgeForDay(input) {
      const existing = nudgeLogs.find(
        (n) =>
          n.familyId === input.familyId &&
          n.parentPersonId === input.parentPersonId &&
          n.localDate === input.localDate,
      );
      if (existing) return { claimed: false, existing };
      nudgeLogs.push({
        id: input.id,
        familyId: input.familyId,
        parentPersonId: input.parentPersonId,
        childPersonId: input.childPersonId,
        localDate: input.localDate,
        nudgeId: input.nudgeId,
        outboxId: input.outboxId,
        childAlertId: input.childAlertId,
        status: 'sent',
        matchedAt: input.matchedAt,
      });
      return { claimed: true };
    },
    async hasTalkedToday() {
      return talkedTodayFlag;
    },
    async listPushTokens(fam, pid) {
      if (fam === familyId && pid === riyaId) {
        return ['ExponentPushToken[riya-synthetic-1]'];
      }
      return [];
    },
    async recordNudge(input) {
      const existing = nudges.find((n) => n.id === input.id);
      if (!existing) {
        nudges.push({
          id: input.id,
          recipientPersonId: input.recipientPersonId,
          kind: input.kind,
          status: input.status,
        });
      }
    },
    async recordChildAlert(input) {
      const existing = childAlerts.find((a) => a.id === input.id);
      if (!existing) {
        childAlerts.push({
          id: input.id,
          recipientPersonId: input.recipientPersonId,
          kind: input.kind,
        });
      }
    },
  };

  const deps: Core1MatcherDeps = {
    auth: {
      async authenticate(request, requestedFamilyId) {
        const authHeader = request.headers.get('authorization');
        if (!authHeader?.startsWith('Bearer ')) {
          throw new Core1CommandError('missing_bearer_token', 401);
        }
        const tok = authHeader.slice('Bearer '.length).trim();
        const actor = actors[tok];
        if (!actor) throw new Core1CommandError('invalid_access_token', 401);
        if (requestedFamilyId && requestedFamilyId !== actor.familyId) {
          throw new Core1CommandError('forbidden_not_family_member', 403);
        }
        return actor;
      },
    },
    store,
    outbox: {
      async enqueue(input) {
        const existing = outboxRows.find(
          (o) => o.familyId === input.familyId && o.dedupeKey === input.dedupeKey,
        );
        if (existing) return { outboxId: existing.outboxId, deduped: true };
        const outboxId = `outbox-${outboxRows.length + 1}`;
        outboxRows.push({ outboxId, ...input });
        return { outboxId, deduped: false };
      },
    },
    timeline: {
      async append(input) {
        const dup = timelineEvents.find(
          (e) => e.envelope.familyId === input.familyId && e.envelope.dedupeKey === input.dedupeKey,
        );
        if (dup) return { written: true, deduped: true };
        seq += 1;
        const signed = signTimelineEvent(
          {
            familyId: input.familyId,
            eventId: `20000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
            sequence: seq,
            previousHash: prevHash,
            dedupeKey: input.dedupeKey,
            eventType: input.eventType,
            entityId: input.entityId,
            humanLine: input.humanLine,
            occurredAt: input.occurredAt ?? now.toISOString(),
            keyId: 'matcher-test',
            payload: input.payload,
          },
          privatePem,
        );
        prevHash = signed.chainHash;
        timelineEvents.push(signed);
        return { written: true, deduped: false };
      },
    },
    sendPush: async (messages) => {
      pushedMessages.push(...messages);
      return { sent: messages.length, failed: 0 };
    },
    env,
    now: () => now,
    newId: () => `10000000-0000-4000-8000-${String(++idCounter).padStart(12, '0')}`,
  };

  return {
    familyId,
    familyBId,
    maaId,
    riyaId,
    people,
    windows,
    nudgeLogs,
    nudges,
    childAlerts,
    outboxRows,
    pushedMessages,
    timelineEvents,
    publicPem,
    env,
    deps,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
    setTalkedToday: (val: boolean) => {
      talkedTodayFlag = val;
    },
  };
}

describe('Core 1 C3 free-times & Sarvam tool & matcher tick', () => {
  it('supports Riya GET, POST recurring window, POST free_now (30m), and DELETE', async () => {
    // 2026-11-15T13:00:00Z is 18:30 IST
    const h = createMatcherHarness('2026-11-15T13:00:00.000Z');

    const postWin = await handleFreeTimesPost(
      new Request('http://localhost/api/core1/free-times', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-riya',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          start_time: '18:00',
          end_time: '20:00',
          timezone: 'Asia/Kolkata',
        }),
      }),
      h.deps,
    );
    expect(postWin.status).toBe(201);
    const postJson = (await postWin.json()) as {
      ok: boolean;
      window: { id: string; start_time: string; end_time: string; active_now: boolean };
    };
    expect(postJson.ok).toBe(true);
    expect(postJson.window.start_time).toBe('18:00');
    expect(postJson.window.end_time).toBe('20:00');
    expect(postJson.window.active_now).toBe(true);

    const postFreeNow = await handleFreeTimesPost(
      new Request('http://localhost/api/core1/free-times', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-riya',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: 'free_now' }),
      }),
      h.deps,
    );
    expect(postFreeNow.status).toBe(201);
    const freeNowJson = (await postFreeNow.json()) as {
      window: { id: string; source: string; kind: string; expires_at: string };
    };
    expect(freeNowJson.window.source).toBe('free_now');
    expect(freeNowJson.window.kind).toBe('ad_hoc');
    expect(Date.parse(freeNowJson.window.expires_at) - Date.parse('2026-11-15T13:00:00.000Z')).toBe(
      30 * 60_000,
    );

    const getRes = await handleFreeTimesGet(
      new Request('http://localhost/api/core1/free-times', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-riya' },
      }),
      h.deps,
    );
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as {
      windows: Array<{ id: string }>;
      riya_free_now: boolean;
      both_free_now: boolean;
    };
    expect(getJson.windows).toHaveLength(2);
    expect(getJson.riya_free_now).toBe(true);
    expect(getJson.both_free_now).toBe(false);

    const delRes = await handleFreeTimesDelete(
      new Request(`http://localhost/api/core1/free-times/${postJson.window.id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token-riya' },
      }),
      h.deps,
      postJson.window.id,
    );
    expect(delRes.status).toBe(200);
    expect(h.windows.filter((w) => w.active)).toHaveLength(1);
  });

  it('rejects circle role, unknown fields, and invalid timezones', async () => {
    const h = createMatcherHarness();

    const circleGet = await handleFreeTimesGet(
      new Request('http://localhost/api/core1/free-times', {
        method: 'GET',
        headers: { Authorization: 'Bearer token-uncle' },
      }),
      h.deps,
    );
    expect(circleGet.status).toBe(403);

    const badField = await handleFreeTimesPost(
      new Request('http://localhost/api/core1/free-times', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-riya',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ start_time: '18:00', end_time: '20:00', admin_bypass: true }),
      }),
      h.deps,
    );
    expect(badField.status).toBe(400);

    const badTz = await handleFreeTimesPost(
      new Request('http://localhost/api/core1/free-times', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-riya',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          start_time: '18:00',
          end_time: '20:00',
          timezone: 'Mars/Olympus',
        }),
      }),
      h.deps,
    );
    expect(badTz.status).toBe(400);
  });

  it('handles Sarvam free-time-tool auth, context validation, save, and ask-again', async () => {
    const h = createMatcherHarness('2026-11-15T13:00:00.000Z');

    const unauth = await handleSarvamFreeTimeTool(
      new Request('http://localhost/api/core1/matcher/free-time-tool', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          family_id: h.familyId,
          parent_id: h.maaId,
          said: 'shaam 6 ke baad free hoon',
        }),
      }),
      h.deps,
    );
    expect(unauth.status).toBe(401);

    const missingCtx = await handleSarvamFreeTimeTool(
      new Request('http://localhost/api/core1/matcher/free-time-tool', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-sarvam-tool-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ said: 'shaam 6 ke baad' }),
      }),
      h.deps,
    );
    expect(missingCtx.status).toBe(400);

    const unknownPhrase = await handleSarvamFreeTimeTool(
      new Request('http://localhost/api/core1/matcher/free-time-tool', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-sarvam-tool-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          variables: { family_id: h.familyId, parent_id: h.maaId },
          input: { said: 'pata nahi beta' },
        }),
      }),
      h.deps,
    );
    expect(unknownPhrase.status).toBe(200);
    const unknownJson = (await unknownPhrase.json()) as { saved: boolean; line_hi: string };
    expect(unknownJson.saved).toBe(false);
    expect(unknownJson.line_hi).toContain('samay samajh nahi aaya');
    expect(h.windows).toHaveLength(0);

    const okRes = await handleSarvamFreeTimeTool(
      new Request('http://localhost/api/core1/matcher/free-time-tool', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-sarvam-tool-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          family_id: h.familyId,
          parent_id: h.maaId,
          said: 'shaam 6 ke baad free hoon',
        }),
      }),
      h.deps,
    );
    expect(okRes.status).toBe(200);
    const okJson = (await okRes.json()) as {
      ok: boolean;
      saved: boolean;
      start_time: string;
      end_time: string;
      line_hi: string;
      read_back: string;
    };
    expect(okJson.ok).toBe(true);
    expect(okJson.saved).toBe(true);
    expect(okJson.start_time).toBe('18:00');
    expect(okJson.end_time).toBe('20:00');
    expect(okJson.read_back).toBe('Theek hai, aap shaam 6 se 8 baje tak free hain.');
    expect(okJson.line_hi).toBe(okJson.read_back);
    expect(h.windows).toHaveLength(1);
  });

  it('sends exactly one nudge on matcher tick when both are free, idempotent across repeats/concurrency', async () => {
    // 18:30 IST
    const h = createMatcherHarness('2026-11-15T13:00:00.000Z');
    h.env.DEMO_TIMER_SCALE = '60';

    // 1. Maa says she is free after 6pm
    await handleSarvamFreeTimeTool(
      new Request('http://localhost/api/core1/matcher/free-time-tool', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-sarvam-tool-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          family_id: h.familyId,
          parent_id: h.maaId,
          said: 'shaam 6 ke baad free hoon',
        }),
      }),
      h.deps,
    );

    // 2. Riya taps "Free now for 30 min"
    await handleFreeTimesPost(
      new Request('http://localhost/api/core1/free-times', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-riya',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: 'free_now' }),
      }),
      h.deps,
    );

    // Unauthorized tick fails
    const badTick = await handleMatcherTick(
      new Request('http://localhost/api/core1/matcher/tick', {
        method: 'POST',
        headers: { 'x-cron-secret': 'wrong' },
      }),
      h.deps,
    );
    expect(badTick.status).toBe(401);

    // Concurrent ticks -> strictly ONE nudge sent
    const [tick1, tick2] = await Promise.all([
      handleMatcherTick(
        new Request('http://localhost/api/core1/matcher/tick', {
          method: 'POST',
          headers: { 'x-cron-secret': 'test-cron-secret' },
        }),
        h.deps,
      ),
      handleMatcherTick(
        new Request('http://localhost/api/core1/matcher/tick', {
          method: 'POST',
          headers: { 'x-cron-secret': 'test-cron-secret' },
        }),
        h.deps,
      ),
    ]);

    expect(tick1.status).toBe(200);
    expect(tick2.status).toBe(200);
    const j1 = (await tick1.json()) as {
      nudges_sent: unknown[];
      timer_scale: number;
      tick_interval_ms: number;
      auto_bridge: boolean;
    };
    const j2 = (await tick2.json()) as { nudges_sent: unknown[] };

    expect(j1.timer_scale).toBe(60);
    expect(j1.tick_interval_ms).toBe(10_000);
    expect(j1.auto_bridge).toBe(false);
    expect(j1.nudges_sent.length + j2.nudges_sent.length).toBe(1);

    expect(h.nudgeLogs).toHaveLength(1);
    expect(h.outboxRows).toHaveLength(1);
    expect(h.nudges).toHaveLength(1);
    expect(h.childAlerts).toHaveLength(1);
    expect(h.pushedMessages).toHaveLength(1);
    expect(h.pushedMessages[0].body).toBe(BOTH_FREE_NUDGE_BODY);
    expect(h.outboxRows[0].payload.autoBridge).toBe(false);

    // Verify signed timeline event
    const matchEvent = h.timelineEvents.find(
      (e) => e.envelope.eventType === 'core1.matcher.both_free_nudge',
    );
    expect(matchEvent).toBeDefined();
    if (matchEvent) {
      expect(verifyTimelineEvent(matchEvent, h.publicPem)).toBe(true);
    }

    // Next day (2026-11-16 at 18:30 IST): recurring window for Maa + recurring window for Riya -> nudges once again
    h.setNow('2026-11-16T13:00:00.000Z');
    await handleFreeTimesPost(
      new Request('http://localhost/api/core1/free-times', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-riya',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ start_time: '18:00', end_time: '20:00' }),
      }),
      h.deps,
    );

    const day2Tick = await handleMatcherTick(
      new Request('http://localhost/api/core1/matcher/tick', {
        method: 'POST',
        headers: { 'x-cron-secret': 'test-cron-secret' },
      }),
      h.deps,
    );
    const day2Json = (await day2Tick.json()) as { nudges_sent: unknown[] };
    expect(day2Json.nudges_sent).toHaveLength(1);
    expect(h.nudgeLogs).toHaveLength(2);
  });

  it('respects Maa quiet hours, talked-today guard, and cross-timezone windows', async () => {
    // 22:30 IST (17:00 UTC) -> inside Maa's quiet_windows (22:00-07:00)
    const h = createMatcherHarness('2026-11-15T17:00:00.000Z');
    await handleSarvamFreeTimeTool(
      new Request('http://localhost/api/core1/matcher/free-time-tool', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-sarvam-tool-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          family_id: h.familyId,
          parent_id: h.maaId,
          said: 'raat 10 se 11',
        }),
      }),
      h.deps,
    );
    await handleFreeTimesPost(
      new Request('http://localhost/api/core1/free-times', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-riya',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ start_time: '22:00', end_time: '23:30' }),
      }),
      h.deps,
    );

    const quietTick = await handleMatcherTick(
      new Request('http://localhost/api/core1/matcher/tick', {
        method: 'POST',
        headers: { 'x-cron-secret': 'test-cron-secret' },
      }),
      h.deps,
    );
    const quietJson = (await quietTick.json()) as {
      nudges_sent: unknown[];
      skipped: Array<{ reason: string }>;
    };
    expect(quietJson.nudges_sent).toHaveLength(0);
    expect(quietJson.skipped[0]?.reason).toBe('maa_quiet_hours');

    // Move to 18:30 IST (13:00 UTC) with Riya in America/New_York (08:00 EST) -> cross-timezone match!
    h.setNow('2026-11-15T13:00:00.000Z');
    h.windows.length = 0;
    await handleSarvamFreeTimeTool(
      new Request('http://localhost/api/core1/matcher/free-time-tool', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-sarvam-tool-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          family_id: h.familyId,
          parent_id: h.maaId,
          said: 'shaam 6 ke baad',
        }),
      }),
      h.deps,
    );
    await handleFreeTimesPost(
      new Request('http://localhost/api/core1/free-times', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-riya',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          start_time: '07:30',
          end_time: '09:00',
          timezone: 'America/New_York',
        }),
      }),
      h.deps,
    );

    // If they already talked today -> skip!
    h.setTalkedToday(true);
    const talkedTick = await handleMatcherTick(
      new Request('http://localhost/api/core1/matcher/tick', {
        method: 'POST',
        headers: { 'x-cron-secret': 'test-cron-secret' },
      }),
      h.deps,
    );
    const talkedJson = (await talkedTick.json()) as {
      nudges_sent: unknown[];
      skipped: Array<{ reason: string }>;
    };
    expect(talkedJson.nudges_sent).toHaveLength(0);
    expect(talkedJson.skipped[0]?.reason).toBe('already_talked_today');

    // If they have NOT talked today -> cross-timezone match fires!
    h.setTalkedToday(false);
    const matchTick = await handleMatcherTick(
      new Request('http://localhost/api/core1/matcher/tick', {
        method: 'POST',
        headers: { 'x-cron-secret': 'test-cron-secret' },
      }),
      h.deps,
    );
    const matchJson = (await matchTick.json()) as { nudges_sent: unknown[] };
    expect(matchJson.nudges_sent).toHaveLength(1);
  });
});
