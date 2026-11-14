import { describe, expect, it, vi, afterEach } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Core2Error, type Core2Repository, type Core2Membership, type TrustedContactRow } from '../../src/lib/core2/contracts';
import { createWebhookCryptoPort } from '../../src/lib/core2/security';
import { createDeviceService, parseDeviceInput } from '../../src/lib/core2-device/service';
import { deviceRoutes } from '../../src/lib/core2-device/routes';
import { createDeviceStore } from '../../src/lib/core2-device/supabase';
import type { DeviceStore, Handover } from '../../src/lib/core2-device/contracts';
import { verifyTimelineEvent } from '../../src/lib/timeline';
const family = '10000000-0000-4000-8000-000000000001', person = '10000000-0000-4000-8000-000000000002';
const other = '20000000-0000-4000-8000-000000000001', contactId = randomUUID(), maa = randomUUID();
const at = '2026-11-15T00:00:00.000Z';
const input = { battery_level: 10, is_charging: false, sampled_at: at };
const job: Handover = { id: randomUUID(), family_id: family, person_id: person, watch_id: randomUUID(), sos_id: null,
  request_id: randomUUID(), reason: 'low_battery', last_seen_at: '2026-11-14T23:58:00.000Z', created_at: at };
function harness(jobs: Handover[] = [], timerScale = 1) {
  const memberships: Core2Membership[] = [{ familyId: family, personId: person, userId: person, role: 'child', revokedAt: null }];
  const contact = { id: contactId, familyId: family, subjectPersonId: person, contactPersonId: randomUUID(),
    rank: 1, state: 'active', approvedAt: at, consentAt: at, consentId: randomUUID(), revokedAt: null,
    effectiveFrom: at, effectiveUntil: null, scopes: ['sos','watch_escalation'] } as TrustedContactRow;
  const repo = {
    listActiveMemberships: vi.fn(async () => memberships),
    getPerson: vi.fn(async () => ({ displayName: 'Riya' })),
    listActiveTrustedContacts: vi.fn(async () => [contact]),
    getSharingPreferences: vi.fn(async () => ({ shareStatusWithParent: true })),
    listPeopleByRole: vi.fn(async () => [{ id: maa }]),
    loadGateInput: vi.fn(async (i) => i),
    ingestRawEvent: vi.fn(async () => ({ rawEventId: randomUUID() })),
  };
  const devices = { get: vi.fn<DeviceStore['get']>(async () => null), report: vi.fn<DeviceStore['report']>(async () => ({ device_status: { ...input, family_id: family, person_id: person, heartbeat_at: at }, idempotent_replay: false })),
    due: vi.fn<DeviceStore['due']>(async () => jobs), complete: vi.fn<DeviceStore['complete']>(async () => {}) } satisfies DeviceStore;
  const gate = { evaluate: vi.fn(async () => ({ decision: 'allow' as const, reason: 'allowed' as const })) };
  const svc = createDeviceService({ auth: { verifyBearer: async (t) => t === 'valid' ? { userId: person } : null },
    repo: repo as unknown as Core2Repository, devices, gate,
    dispatch: { enqueueAuthorized: vi.fn() }, timeline: { append: vi.fn() },
    crypto: createWebhookCryptoPort('ab'.repeat(32)), now: () => new Date(at), timerScale });
  const routes = deviceRoutes(() => svc);
  function request(method = 'POST', body: unknown = input, token = 'valid', familyId = family, key = 'device-key') {
    return new Request('https://synthetic.example/api/core2/device-status', { method,
      headers: { Authorization: `Bearer ${token}`, 'X-Sahaj-Family-Id': familyId, 'Idempotency-Key': key },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  }
  return { svc, routes, request, devices, repo, contact, gate, memberships };
}
afterEach(() => vi.unstubAllEnvs());
describe('device auth and own-family contract', () => {
  it.each(['GET','POST'])('requires verified bearer on %s', async (method) => {
    const h = harness(); const response = await h.routes[method as 'GET'|'POST'](h.request(method,input,'invalid'));
    expect(response.status).toBe(401); expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(h.devices.report).not.toHaveBeenCalled();
  });
  it.each(['GET','POST'])('denies cross-family %s', async (method) => {
    const h = harness(); expect((await h.routes[method as 'GET'|'POST'](h.request(method,input,'valid',other))).status).toBe(403);
    expect(h.devices.get).not.toHaveBeenCalled(); expect(h.devices.report).not.toHaveBeenCalled();
  });
  it('requires explicit family selection for multiple memberships', async () => {
    const h = harness(); h.memberships.push({ ...h.memberships[0], familyId: other });
    const req = h.request('GET'); req.headers.delete('X-Sahaj-Family-Id');
    expect((await h.routes.GET(req)).status).toBe(409);
  });
  it('GET derives the person and returns only their status', async () => {
    const h = harness(); expect((await h.routes.GET(h.request('GET'))).status).toBe(200);
    expect(h.devices.get).toHaveBeenCalledWith(family,person);
  });
  it.each([{ ...input, person_id: other }, { ...input, family_id: other }, { ...input, battery_level: 101 }, { ...input, battery_level: -1 }, { ...input, is_charging: 'yes' }, { ...input, sampled_at: 'bad' }])('rejects forged/invalid input %#', async (body) => {
    const h = harness(); expect((await h.routes.POST(h.request('POST',body))).status).toBe(400);
    expect(h.devices.report).not.toHaveBeenCalled();
  });
  it('requires an idempotency key', async () => {
    const h = harness(); expect((await h.routes.POST(h.request('POST',input,'valid',family,''))).status).toBe(400);
  });
  it('accepts unknown battery state without turning it into zero', () => {
    expect(parseDeviceInput({ ...input, battery_level: null, is_charging: null }).battery_level).toBeNull();
  });
  it('persists encrypted raw input before atomic report and passes scoped hashes', async () => {
    const h = harness(); expect((await h.routes.POST(h.request())).status).toBe(200);
    expect(h.repo.ingestRawEvent.mock.invocationCallOrder[0]).toBeLessThan(h.devices.report.mock.invocationCallOrder[0]);
    expect(h.devices.report.mock.calls[0][0]).toMatchObject({ familyId: family, personId: person, keyHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
  it('fails closed if encrypted storage fails', async () => {
    const h = harness(); h.repo.ingestRawEvent.mockRejectedValueOnce(new Error('down'));
    expect((await h.routes.POST(h.request())).status).toBe(503); expect(h.devices.report).not.toHaveBeenCalled();
  });
});
describe('handover preparation and stale worker', () => {
  it('does no handover without a due threshold/active-watch job', async () => {
    const h = harness(); await h.svc.tick(); expect(h.devices.complete).not.toHaveBeenCalled();
    expect(h.devices.due).toHaveBeenCalledWith(180000, undefined, undefined);
  });
  it('scales the server stale deadline with DEMO_TIMER_SCALE', async () => {
    const h = harness([],0.01); await h.svc.tick();
    expect(h.devices.due).toHaveBeenCalledWith(1800,undefined,undefined);
  });
  it('selects the lowest ranked approved contact deterministically', async () => {
    const h = harness([job]);
    const higher = { ...h.contact, id: randomUUID(), contactPersonId: randomUUID(), rank: 2 };
    h.repo.listActiveTrustedContacts.mockResolvedValueOnce([higher,h.contact]);
    await h.svc.tick(); expect(h.devices.complete.mock.calls[0][2][0].recipient).toBe(h.contact.contactPersonId);
  });
  it('queues only the top approved contact, with elapsed update age, and a location-free Maa line', async () => {
    const h = harness([job]); await h.svc.tick();
    const [, timeline, notices] = h.devices.complete.mock.calls[0];
    expect(timeline.eventType).toBe('core2.device.handover'); expect(notices).toHaveLength(2);
    expect(notices[0].statusLabel).toContain('last update 2 min pehle: raste mein');
    expect(notices[1].recipient).toBe(maa); expect(notices[1].statusLabel).not.toMatch(/raste|location|sampark mein|SOS|emergency|danger/i);
    expect(notices[0].command.payloadCiphertext).not.toContain('Riya');
  });
  it('handles stale watch without inventing a low battery fact', async () => {
    const h = harness([{ ...job, reason: 'stale_heartbeat' }]); await h.svc.tick();
    expect(h.devices.complete.mock.calls[0][2][0].statusLabel).toContain('naya update nahi aaya');
    expect(h.devices.complete.mock.calls[0][2][1].statusLabel).not.toContain('charge kam');
  });
  it('normalizes PostgreSQL timestamps to the timeline signing contract', async () => {
    const h = harness([{ ...job, created_at: '2026-11-15T00:00:00.123456+00:00' }]); await h.svc.tick();
    expect(h.devices.complete.mock.calls[0][1].occurredAt).toBe('2026-11-15T00:00:00.123Z');
  });
  it('filters unapproved contacts and honors disabled parent sharing', async () => {
    const h = harness([job]); h.contact.approvedAt = null; h.repo.getSharingPreferences.mockResolvedValueOnce({ shareStatusWithParent: false });
    await h.svc.tick(); expect(h.devices.complete.mock.calls[0][2]).toEqual([]);
  });
  it.each(['ask','deny'])('does not enqueue when gate says %s', async (decision) => {
    const h = harness([job]); h.gate.evaluate.mockResolvedValue({ decision, reasons: [] } as never);
    await h.svc.tick(); expect(h.devices.complete.mock.calls[0][2]).toEqual([]);
  });
  it('requires cron secret and honors maintenance without processing', async () => {
    const h = harness(); vi.stubEnv('CRON_SECRET','synthetic-cron');
    expect((await h.routes.tick(h.request())).status).toBe(401);
    const req = h.request(); req.headers.set('x-cron-secret','synthetic-cron');
    vi.stubEnv('MAINTENANCE_KILL','true'); expect((await h.routes.tick(req)).status).toBe(503);
    vi.stubEnv('MAINTENANCE_KILL','false'); expect((await h.routes.tick(req)).status).toBe(200);
  });
});
describe('atomic SQL adapter', () => {
  it('maps stored idempotency conflicts to 409', async () => {
    const db = { rpc: vi.fn(async () => ({ data: null, error: { message: 'idempotency_conflict' } })) };
    const store = createDeviceStore(db as never,'unused','test');
    await expect(store.report({ familyId: family, personId: person, keyHash: 'a'.repeat(64), requestHash: 'b'.repeat(64), status: input, rawEventId: randomUUID() })).rejects.toMatchObject({ status: 409 });
  });
  it('signs the atomic commit and retries a head CAS without issuing separate outbox writes', async () => {
    const pair = generateKeyPairSync('ed25519');
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null, error: null }) };
    const db = { from: vi.fn((_table: string) => query), rpc: vi.fn().mockResolvedValueOnce({ error: { code: '40001' } }).mockResolvedValue({ error: null }) };
    const store = createDeviceStore(db as never,pair.privateKey.export({ type:'pkcs8',format:'pem' }).toString(),'test');
    const event = { familyId: family,eventId:job.id,dedupeKey:`core2:device:${job.id}`,eventType:'core2.device.handover',entityId:job.watch_id,humanLine:'Phone handover recorded.',occurredAt:at,payload:{ location_included:false } };
    await store.complete(job,event,[]);
    expect(db.rpc).toHaveBeenCalledTimes(2); const args = db.rpc.mock.calls[1][1];
    expect(verifyTimelineEvent({ envelope: args.p_event,chainHash:args.p_chain_hash,signature:args.p_signature },pair.publicKey)).toBe(true);
    expect(db.from.mock.calls.every(([table]) => table === 'timeline_stream_heads')).toBe(true);
  });
});
