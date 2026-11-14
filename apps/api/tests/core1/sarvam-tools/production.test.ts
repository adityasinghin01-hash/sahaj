import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductionSarvamDeps, trustedCommandPorts, type ProductionOverrides } from '@/lib/core1/sarvam-tools/production';
import { executeCore1Command } from '@/lib/core1/service';
import { executeRefillProposalCommand } from '@/lib/core1/refill-service';
import { getCore2Service } from '@/lib/core2';
import { enqueueAuthorizedSend, claimAuthorizedSend, claimAuthorizedPush } from '@/lib/core1/authorized-send';
import { dispatchStore } from '@/lib/provider-dispatch/supabase-store';
import { defaultSendExpoPush } from '@/lib/core1/voice-notify';
import { createSupabaseCore1TimelinePort } from '@/lib/core1/wiring-common';
import { createShieldRuntime } from '../../../../../packages/shield/src/runtime';

vi.mock('@/lib/core1/authorized-send', () => ({ enqueueAuthorizedSend: vi.fn(), claimAuthorizedSend: vi.fn(), claimAuthorizedPush: vi.fn() }));
vi.mock('@/lib/provider-dispatch/supabase-store', () => ({ dispatchStore: vi.fn() }));
vi.mock('@/lib/core1/service', () => ({ executeCore1Command: vi.fn() }));
vi.mock('@/lib/core1/refill-service', () => ({ createProductionRefillDeps: vi.fn(() => ({ auth: {}, store: { getMedicine: vi.fn() } })), executeRefillProposalCommand: vi.fn() }));
vi.mock('@/lib/core2', () => ({ getCore2Service: vi.fn() }));
vi.mock('@/lib/core1/voice-notify', () => ({ defaultSendExpoPush: vi.fn() }));
vi.mock('../../../../../packages/shield/src/runtime', () => ({ createShieldRuntime: vi.fn() }));
vi.mock('../../../../shield-api/src/ports', () => ({ createShieldPorts: vi.fn(() => ({})) }));
vi.mock('@/lib/core1/wiring-common', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/core1/wiring-common')>(), createSupabaseCore1TimelinePort: vi.fn() }));
const ctx = { familyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', parentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const env = { EXPO_PUSH_ENABLED: 'true', WEBHOOK_ENCRYPTION_KEY: 'ab'.repeat(32), CALL_CONSENT_VERSION: 'v1', SARVAM_TOOL_TOKEN: 'test-token', TIMELINE_SIGNING_PRIVATE_KEY: 'fake-key-for-mocked-timeline' };
const now = () => new Date('2026-11-15T00:00:00Z');
function fixture() {
  const query = vi.fn(async (_q: string, _args: unknown[]): Promise<Record<string, unknown>[]> => [{ id }]);
  const sql = Object.assign(async (parts: TemplateStringsArray, ...args: unknown[]) => query(parts.join('?'), args), {
    reserve: vi.fn(), begin: vi.fn(), release: vi.fn(),
  });
  sql.reserve.mockResolvedValue(sql);
  sql.begin.mockImplementation(async work => work(sql));
  const db = { from: vi.fn() };
  const chain = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), single: vi.fn() };
  for (const name of ['select', 'eq', 'is'] as const) chain[name].mockReturnValue(chain);
  chain.single.mockResolvedValue({ data: { family_id: ctx.familyId, person_id: ctx.parentId, user_id: id, role: 'parent' } });
  db.from.mockReturnValue(chain);
  const familyRun = vi.fn().mockResolvedValue({ status: 'checking', check_id: id });
  vi.mocked(createShieldRuntime).mockReturnValue({ shieldTools: { run: familyRun } } as unknown as ReturnType<typeof createShieldRuntime>);
  const deps = createProductionSarvamDeps(env, { db, sql, now } as unknown as ProductionOverrides);
  return { deps, sql, query, db, chain, familyRun };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(enqueueAuthorizedSend).mockResolvedValue({ id, duplicate: false, channel: 'expo' });
  vi.mocked(claimAuthorizedSend).mockResolvedValue({ lease: id, attempt: 1, callId: null, personId: id });
  vi.mocked(claimAuthorizedPush).mockResolvedValue(['ExponentPushToken[fake]']);
  vi.mocked(dispatchStore).mockReturnValue({ finishOutbox: vi.fn().mockResolvedValue(true) } as unknown as ReturnType<typeof dispatchStore>);
  vi.mocked(createSupabaseCore1TimelinePort).mockReturnValue({ append: vi.fn().mockResolvedValue({ sequence: 1, chainHash: 'hash', deduped: false }) });
  vi.mocked(executeCore1Command).mockResolvedValue({ eventId: id, commandType: 'urgent_help', status: 'queued', deduped: false });
  vi.mocked(executeRefillProposalCommand).mockResolvedValue(Response.json({ status: 'awaiting_approval' }));
  vi.mocked(defaultSendExpoPush).mockResolvedValue({ sent: 1, failed: 0 });
});
describe('production integrations without provider calls', () => {
  it('imports the existing urgent command and binds the target to Maa', async () => {
    const { deps } = fixture();
    expect(await deps.urgentCommand(ctx, { severity: 'critical', said: 'Gir gayi' }, 'turn-urgent')).toEqual({ status: 'queued' });
    const [request, , command] = vi.mocked(executeCore1Command).mock.calls[0];
    expect(command).toBe('urgent_help');
    expect(await request.json()).toEqual({ familyId: ctx.familyId, payload: { subjectPersonId: ctx.parentId, severity: 'critical', action: 'initiate' } });
  });
  it('requires live membership when adapting Sarvam to the existing command', async () => {
    const { db, chain } = fixture(); chain.single.mockResolvedValue({ data: null, error: { message: 'missing' } });
    await expect(trustedCommandPorts(db as unknown as Parameters<typeof trustedCommandPorts>[0], ctx)).rejects.toThrow();
  });
  it('does not invent a four-minute ETA when no promise was stored', async () => {
    const { deps, query } = fixture(); query.mockResolvedValue([{ state: 'accepted', display_name: 'Sharma uncle', promised_at: null }]);
    expect(await deps.openIncident(ctx)).toEqual({ status: 'accepted', responder_name: 'Sharma uncle', eta_minutes: undefined });
  });
  it('computes an actual promised ETA and scopes the incident to Maa', async () => {
    const { deps, query } = fixture(); query.mockResolvedValue([{ state: 'accepted', display_name: 'Sharma uncle', promised_at: '2026-11-15T00:04:00Z' }]);
    expect((await deps.openIncident(ctx)).eta_minutes).toBe(4);
    expect(query.mock.calls[0][1]).toEqual([ctx.familyId, ctx.parentId]);
  });
  it('calls the Core 2 truth line with its authenticated context and strips location', async () => {
    const querySarvamTruthLine = vi.fn().mockResolvedValue({ body: { status: 'safe', location: 'Delhi', spoken_text: 'private extra' } });
    vi.mocked(getCore2Service).mockReturnValue({ querySarvamTruthLine } as unknown as ReturnType<typeof getCore2Service>);
    const { deps } = fixture();
    expect(await deps.truthLine(ctx, {})).toEqual({ status: 'safe' });
    expect(querySarvamTruthLine).toHaveBeenCalledWith('test-token', { family_id: ctx.familyId, parent_id: ctx.parentId });
  });
  it('uses Shield’s existing family-check runtime with the verified context', async () => {
    const { deps, familyRun } = fixture();
    expect(await deps.familyCheck(ctx, { claimed_name: 'Riya', asked_for: 'paise' }, 'turn-scam')).toEqual({ status: 'checking', check_id: id });
    expect(familyRun).toHaveBeenCalledWith('family_check', ctx, { claimed_name: 'Riya', asked_for: 'paise' });
  });
  it('does not treat Shield’s safe fallback as a successful family check', async () => {
    const { deps, familyRun } = fixture(); familyRun.mockResolvedValue({ status: 'unknown_person', check_id: null });
    await expect(deps.familyCheck(ctx, { claimed_name: 'Riya', asked_for: 'paise' }, 'turn-scam')).rejects.toThrow();
  });
  it.each([['record', 'call_recording'], ['share', 'call_transcript'], ['call', 'check_in']])('stores %s consent for the exact call', async (purpose, stored) => {
    const { deps, query } = fixture();
    await deps.recordConsent(ctx, { purpose, answer: false, call_id: id, turn_id: 'consent' }, 'turn-consent');
    expect(query.mock.calls[0][1]).toEqual([ctx.familyId, ctx.parentId, id]);
    expect(query.mock.calls[1][1]).toContain(stored);
    expect(query.mock.calls[1][1]).toContain(false);
  });
  it('uses the existing transcript-consent gate to make this call private', async () => {
    const { deps, query } = fixture();
    await deps.markPrivate(ctx, { call_id: id }, 'turn-private');
    expect(query.mock.calls.some(([q]) => q.includes("'call_transcript'") && q.includes('false'))).toBe(true);
    expect(query.mock.calls.some(([q]) => q.includes('sahaj_private.private_items'))).toBe(true);
    expect(JSON.stringify(query.mock.calls)).not.toContain('summary_private');
  });
  it('revokes only the parent-owned permission', async () => {
    const { deps, query } = fixture();
    await deps.cancelPermission(ctx, { permission_id: id }, 'turn-cancel');
    expect(query.mock.calls[0][1]).toEqual([ctx.familyId, ctx.parentId, id]);
    expect(query.mock.calls[0][0]).toContain('coalesce(revoked_at,now())');
  });
  it('scopes rescheduling to the enabled check-in and Maa', async () => {
    const { deps, query } = fixture();
    await deps.reschedule(ctx, { schedule_id: id, hours: 2 }, 'turn-later');
    expect(query.mock.calls[0][1]).toEqual(['2026-11-15T02:00:00.000Z', ctx.familyId, ctx.parentId, id]);
    expect(query.mock.calls[0][0]).toContain("kind='check_in' and enabled");
  });
  it('calls the existing refill proposal service with its Gate intact', async () => {
    const { deps } = fixture();
    await deps.proposeRefill(ctx, id, id, 'turn-low');
    const [request, refillDeps] = vi.mocked(executeRefillProposalCommand).mock.calls[0];
    expect(await request.json()).toEqual({ familyId: ctx.familyId, personId: ctx.parentId, medicineId: id, vendorId: id });
    expect(await refillDeps.auth.authenticate(request)).toMatchObject({ role: 'parent', familyId: ctx.familyId, personId: ctx.parentId });
  });
  it('refuses unavailable refill Gate results', async () => {
    const { deps } = fixture(); vi.mocked(executeRefillProposalCommand).mockResolvedValue(Response.json({ error: 'denied' }, { status: 403 }));
    await expect(deps.proposeRefill(ctx, id, id, 'turn-low')).rejects.toThrow();
  });
  it('pushes a labeled transcript only after authorized enqueue and a durable push claim', async () => {
    const { deps, query } = fixture(); query.mockResolvedValue([{ id }]);
    await deps.sendTranscript(ctx, 'Riya ghar aa jao', "AI transcript of Maa's words", 'turn-message');
    expect(enqueueAuthorizedSend).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.objectContaining({
      familyId: ctx.familyId, subjectId: ctx.parentId, recipientId: id, kind: 'core1.sarvam_message_push',
    }));
    expect(claimAuthorizedPush).toHaveBeenCalledWith(expect.anything(), ctx.familyId, id, id);
    expect(defaultSendExpoPush).toHaveBeenCalledWith([expect.objectContaining({ title: "AI transcript of Maa's words", body: 'Riya ghar aa jao' })]);
  });
  it('transfers rather than sending without a recipient registration', async () => {
    const { deps, query } = fixture(); query.mockResolvedValue([{ id }]);
    vi.mocked(claimAuthorizedPush).mockResolvedValue(null);
    await expect(deps.sendTranscript(ctx, 'Riya ghar aa jao', "AI transcript of Maa's words", 'turn-message')).rejects.toThrow('push_registration_missing');
    expect(defaultSendExpoPush).not.toHaveBeenCalled();
  });
  it('does not send again when a prior push has uncertain delivery', async () => {
    const { deps, query } = fixture(); query.mockResolvedValue([{ id }]);
    vi.mocked(claimAuthorizedSend).mockResolvedValue(null);
    await expect(deps.sendTranscript(ctx, 'Riya ghar aa jao', "AI transcript of Maa's words", 'turn-message')).rejects.toThrow('push_already_claimed');
    expect(defaultSendExpoPush).not.toHaveBeenCalled();
  });
  it('never calls push if durable gate authorization fails', async () => {
    const { deps, query } = fixture(); query.mockResolvedValue([{ id }]);
    vi.mocked(enqueueAuthorizedSend).mockRejectedValue(new Error('send_not_authorized'));
    await expect(deps.sendTranscript(ctx, 'Riya ghar aa jao', "AI transcript of Maa's words", 'turn-message')).rejects.toThrow('send_not_authorized');
    expect(defaultSendExpoPush).not.toHaveBeenCalled();
  });
  it('replays an encrypted completed tool without repeating its effect', async () => {
    const { deps, query, sql } = fixture();
    let stored: Record<string, unknown> | undefined;
    query.mockImplementation(async (q, args) => {
      if (q.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (q.includes('select payload_hash')) return stored ? [stored] : [];
      if (q.includes('insert into public.raw_events')) stored = { payload_hash: args[4], payload_ciphertext: args[5], tool_state: 'started' };
      if (q.includes('update public.raw_events')) stored = { ...stored, payload_ciphertext: args[0], tool_state: 'done' };
      return [];
    });
    const work = vi.fn().mockResolvedValue({ status: 'saved' });
    expect(await deps.runOnce('cancel_permission', ctx, { permission_id: id }, 'turn-cancel', work)).toEqual({ status: 'saved' });
    expect(await deps.runOnce('cancel_permission', ctx, { permission_id: id }, 'turn-cancel', work)).toEqual({ status: 'saved' });
    expect(work).toHaveBeenCalledTimes(1); expect(sql.release).toHaveBeenCalledTimes(2);
    await expect(deps.runOnce('cancel_permission', ctx, { permission_id: ctx.parentId }, 'turn-cancel', work)).rejects.toThrow('idempotency_conflict');
  });
  it('binds the request before a partial failure and never repeats its effects', async () => {
    const { deps, query } = fixture();
    let stored: Record<string, unknown> | undefined;
    query.mockImplementation(async (q, args) => {
      if (q.includes('pg_try_advisory_lock')) return [{ locked: true }];
      if (q.includes('select payload_hash')) return stored ? [stored] : [];
      if (q.includes('insert into public.raw_events')) stored = { payload_hash: args[4], payload_ciphertext: args[5], tool_state: 'started' };
      return [];
    });
    const work = vi.fn().mockRejectedValue(new Error('provider outcome unknown'));
    await expect(deps.runOnce('raise_urgent', ctx, { said: 'madad' }, 'turn-urgent', work)).rejects.toThrow();
    await expect(deps.runOnce('raise_urgent', ctx, { said: 'madad' }, 'turn-urgent', work)).rejects.toThrow('tool_previous_attempt_incomplete');
    await expect(deps.runOnce('raise_urgent', ctx, { said: 'different' }, 'turn-urgent', work)).rejects.toThrow('idempotency_conflict');
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('does not mutate or send if signing the attempt fails', async () => {
    const append = vi.fn().mockRejectedValue(new Error('signer unavailable'));
    vi.mocked(createSupabaseCore1TimelinePort).mockReturnValue({ append });
    const { deps, query } = fixture();
    query.mockImplementation(async q => q.includes('pg_try_advisory_lock') ? [{ locked: true }] : []);
    const work = vi.fn();
    await expect(deps.runOnce('raise_urgent', ctx, { said: 'madad' }, 'turn-urgent', work)).rejects.toThrow('signer unavailable');
    expect(work).not.toHaveBeenCalled();
  });
  it('requires normalized, call-bound evidence before responder acceptance', async () => {
    // K-SARVAMCALL: the decision goes to the urgent-help service, whose SQL refuses a call we did not place for this assignment.
    const recordSarvamResponderDecision = vi.fn().mockRejectedValue(new Error('sarvam_decision_refused'));
    const getIncident = vi.fn().mockResolvedValue({ id, familyId: ctx.familyId, subjectPersonId: ctx.parentId, state: 'offered', severity: 'urgent', ownerPersonId: null, promisedAt: null, createdAt: now().toISOString() });
    const urgent = { store: { recordSarvamResponderDecision, getIncident } } as unknown as NonNullable<ProductionOverrides['urgent']>;
    const { query, sql, db } = fixture();
    const deps = createProductionSarvamDeps(env, { db, sql, now, urgent } as unknown as ProductionOverrides);
    query.mockResolvedValue([]);
    await expect(deps.responderCommand('accept_incident', ctx, { call_id: id, incident_id: id, assignment_id: id, responder_person_id: id, promise_minutes: 4 }, 'turn-accept')).rejects.toThrow('sarvam_decision_refused');
    expect(recordSarvamResponderDecision).toHaveBeenCalledWith({ familyId: ctx.familyId, callId: id, incidentId: id, assignmentId: id, responderPersonId: id, decision: 'accept' });
    expect(executeCore1Command).not.toHaveBeenCalled();
  });
});
