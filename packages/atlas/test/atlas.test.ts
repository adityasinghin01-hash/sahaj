import { describe, expect, it } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { evaluateGate, type GateInput } from '@sahaj/gate';
import { atlasThreadId, createAtlas, type AtlasPorts, type AtlasJob, type DeliveryObservation, type Understanding } from '../src/index';
import { createPostgresCheckpointer } from '../src/postgres';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
function fixture() {
  const job: AtlasJob = { familyId: id(1), jobId: id(2), eventId: id(3), actorId: id(4), requestId: id(5), targetId: id(6) };
  const input: GateInput = { actor: { id: job.actorId, familyId: job.familyId, active: true },
    request: { id: job.requestId, familyId: job.familyId, targetId: job.targetId, action: 'check_in' },
    now: '2026-11-14T10:00:00Z', approvals: [], consents: [], permissions: [{ id: id(7), familyId: job.familyId,
      actorId: job.actorId, action: 'check_in', validFrom: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z',
      periodStart: '2026-11-14T00:00:00Z', periodEnd: '2026-11-15T00:00:00Z', maxUses: 1, usedCount: 0,
      maxAmountMinor: 0, itemIds: [], vendorIds: [], targetIds: [job.targetId], approvalMode: 'setup' }] };
  let understanding: Understanding = { action: 'check_in', certainty: 'ready' };
  let delivery: DeliveryObservation = { verified: true, status: 'pending', responderAccepted: false };
  let enqueueCrash = false, signCrash = false;
  const outbox = new Map<string, string>(), signed = new Map<string, string>();
  const keys: string[] = [];
  let pending = Promise.resolve();
  const ports: AtlasPorts = {
    async loadJob(scope) { if (scope.jobId !== job.jobId || scope.familyId !== job.familyId) throw new Error('Family mismatch'); return job; },
    async understand() { return { ...understanding, transcript: 'SYNTHETIC_PRIVATE_PAYLOAD_MUST_NOT_PERSIST' } as Understanding; },
    async loadGateInput() { return input; },
    async enqueueAuthorized(command) {
      keys.push(command.idempotencyKey);
      const existing = outbox.get(command.idempotencyKey);
      if (existing) return { status: 'enqueued', outboxId: existing };
      const decision = evaluateGate(input);
      if (decision.decision !== 'allow') return { status: decision.decision === 'ask' ? 'review' : 'denied' };
      input.permissions[0].usedCount += 1;
      outbox.set(command.idempotencyKey, id(8));
      if (enqueueCrash) { enqueueCrash = false; throw new Error('Synthetic crash after durable enqueue'); }
      return { status: 'enqueued', outboxId: id(8) };
    },
    async observeDelivery() { return delivery; },
    async appendSignedOutcome(entry) {
      signed.set(entry.idempotencyKey, entry.status);
      if (signCrash) { signCrash = false; throw new Error('Synthetic crash after signed append'); }
    },
    async withJobLock(_scope, work) {
      const previous = pending;
      let release!: () => void;
      pending = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try { return await work(); } finally { release(); }
    },
  };
  return { job, input, ports, outbox, signed, keys,
    understand(value: Understanding) { understanding = value; }, delivery(value: DeliveryObservation) { delivery = value; },
    crashEnqueue() { enqueueCrash = true; }, crashSign() { signCrash = true; } };
}

describe('Atlas durable LangGraph scaffold', () => {
  it('interrupts until verified delivery, resumes after graph reconstruction, and ignores duplicate wakeups', async () => {
    const f = fixture(), saver = new MemorySaver();
    const first = await createAtlas(f.ports, saver).start(f.job);
    expect(first.next).toEqual(['wait']); expect(first.values.status).toBe('waiting');
    expect(f.outbox.size).toBe(1); expect(f.signed.size).toBe(0);
    f.delivery({ verified: true, status: 'delivered', responderAccepted: false });
    const rebuilt = createAtlas(f.ports, saver);
    const completed = await rebuilt.resume(f.job);
    expect(completed.next).toEqual([]); expect(completed.values.status).toBe('delivered');
    await rebuilt.resume(f.job); await rebuilt.start(f.job);
    expect(f.outbox.size).toBe(1); expect(f.keys).toHaveLength(1); expect(f.signed.size).toBe(1);
  });
  it('rejects wrong family before loading or resuming the checkpoint', async () => {
    const f = fixture(), saver = new MemorySaver(), atlas = createAtlas(f.ports, saver);
    await atlas.start(f.job);
    await expect(atlas.resume({ ...f.job, familyId: id(99) })).rejects.toThrow('Atlas job load failed');
    expect(f.outbox.size).toBe(1); expect(f.signed.size).toBe(0);
  });
  it('uses bounded deterministic family-scoped thread IDs', () => {
    const f = fixture(); expect(atlasThreadId(f.job)).toHaveLength(73);
    expect(atlasThreadId(f.job)).toBe(atlasThreadId({ familyId: f.job.familyId, jobId: f.job.jobId }));
    expect(atlasThreadId(f.job)).not.toBe(atlasThreadId({ ...f.job, familyId: id(99) }));
    expect(() => atlasThreadId({ familyId: 'bad', jobId: id(2) })).toThrow();
  });
  it('interrupts uncertainty and re-understands trusted records after a wakeup', async () => {
    const f = fixture(), saver = new MemorySaver(), atlas = createAtlas(f.ports, saver);
    f.understand({ action: 'unknown', certainty: 'uncertain' });
    const paused = await atlas.start(f.job); expect(paused.next).toEqual(['review']); expect(f.outbox.size).toBe(0);
    f.understand({ action: 'check_in', certainty: 'ready' });
    expect((await atlas.resume(f.job)).next).toEqual(['wait']); expect(f.outbox.size).toBe(1);
  });
  it('does not treat wakeup as approval and reloads revoked permissions', async () => {
    const f = fixture(), saver = new MemorySaver(), atlas = createAtlas(f.ports, saver);
    f.input.permissions[0].approvalMode = 'two_person';
    expect((await atlas.start(f.job)).next).toEqual(['review']);
    expect((await atlas.resume(f.job)).next).toEqual(['review']); expect(f.outbox.size).toBe(0);
    f.input.permissions[0].revokedAt = f.input.now;
    expect((await atlas.resume(f.job)).values.status).toBe('denied'); expect(f.outbox.size).toBe(0);
  });
  it.each(['payment', 'collect_otp', 'medical_diagnosis'] as const)('never dispatches autonomous %s', async action => {
    const f = fixture(); f.understand({ action, certainty: 'ready' });
    const result = await createAtlas(f.ports, new MemorySaver()).start(f.job);
    expect(result.values.status).toBe('denied'); expect(f.outbox.size).toBe(0); expect([...f.signed.values()]).toEqual(['denied']);
  });
  it('requires verified responder acceptance beyond call delivery', async () => {
    const f = fixture(), atlas = createAtlas(f.ports, new MemorySaver());
    f.understand({ action: 'urgent_responder', certainty: 'ready' });
    f.input.request.action = 'urgent_responder'; f.input.permissions[0].action = 'urgent_responder';
    f.delivery({ verified: false, status: 'delivered', responderAccepted: true });
    expect((await atlas.start(f.job)).next).toEqual(['wait']);
    f.delivery({ verified: true, status: 'delivered', responderAccepted: false });
    expect((await atlas.resume(f.job)).next).toEqual(['wait']); expect(f.signed.size).toBe(0);
    f.delivery({ verified: true, status: 'delivered', responderAccepted: true });
    expect((await atlas.resume(f.job)).values.status).toBe('accepted');
    expect([...f.signed.values()]).toEqual(['accepted']);
  });
  it('recovers crash after outbox commit without spending quota twice', async () => {
    const f = fixture(), saver = new MemorySaver(); f.crashEnqueue();
    await expect(createAtlas(f.ports, saver).start(f.job)).rejects.toThrow('Atlas outbox write failed');
    const recovered = await createAtlas(f.ports, saver).resume(f.job);
    expect(recovered.next).toEqual(['wait']); expect(f.outbox.size).toBe(1); expect(f.input.permissions[0].usedCount).toBe(1);
    expect(f.keys).toHaveLength(2); expect(f.keys[0]).toBe(f.keys[1]);
  });
  it('retries signed append with the same idempotency key after a crash', async () => {
    const f = fixture(), saver = new MemorySaver(); f.delivery({ verified: true, status: 'failed', responderAccepted: false }); f.crashSign();
    await expect(createAtlas(f.ports, saver).start(f.job)).rejects.toThrow('Atlas timeline append failed');
    const recovered = await createAtlas(f.ports, saver).resume(f.job);
    expect(recovered.values.status).toBe('failed'); expect(f.signed.size).toBe(1);
  });
  it('serializes concurrent duplicate starts through the required repository lock', async () => {
    const f = fixture(), atlas = createAtlas(f.ports, new MemorySaver());
    await Promise.all([atlas.start(f.job), atlas.start(f.job)]); expect(f.keys).toHaveLength(1);
  });
  it('checkpoints only enum projections and identifiers', async () => {
    const f = fixture(), saver = new MemorySaver(); await createAtlas(f.ports, saver).start(f.job);
    const serialized: string[] = [];
    for await (const checkpoint of saver.list({ configurable: { thread_id: atlasThreadId(f.job) } })) serialized.push(JSON.stringify(checkpoint));
    expect(serialized.length).toBeGreaterThan(3);
    expect(serialized.join('')).not.toContain('SYNTHETIC_PRIVATE_PAYLOAD_MUST_NOT_PERSIST');
    expect(serialized.join('')).not.toContain('permissions');
    expect(serialized.join('')).not.toContain('maxAmountMinor');
  });
  it('redacts provider errors before they reach checkpoint task metadata', async () => {
    const f = fixture(), saver = new MemorySaver();
    f.ports.understand = async () => { throw new Error('SYNTHETIC_PRIVATE_PROVIDER_ERROR'); };
    await expect(createAtlas(f.ports, saver).start(f.job)).rejects.toThrow('Atlas understanding failed');
    const serialized: string[] = [];
    for await (const checkpoint of saver.list({ configurable: { thread_id: atlasThreadId(f.job) } })) serialized.push(JSON.stringify(checkpoint));
    expect(serialized.join('')).not.toContain('SYNTHETIC_PRIVATE_PROVIDER_ERROR');
  });
  it('rejects a mismatched gate action or actor', async () => {
    const f = fixture(); f.input.request.action = 'send_alert';
    await expect(createAtlas(f.ports, new MemorySaver()).start(f.job)).rejects.toThrow('authorization scope mismatch');
    expect(f.outbox.size).toBe(0);
  });
  it('does not create a public/default-schema Postgres saver', async () => {
    expect(() => createPostgresCheckpointer('https://example.invalid/db')).toThrow();
    const saver = createPostgresCheckpointer('postgresql://synthetic:synthetic@localhost:5432/demo');
    expect(saver).toBeDefined(); await saver.end(); // No connection is made until use.
  });
});
