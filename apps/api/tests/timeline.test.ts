import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, signTimelineEvent, timelinePayloadHash, verifyTimelineChain, verifyTimelineEvent } from '../src/lib/timeline';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const familyId = '10000000-0000-4000-8000-000000000001';
function event(sequence = 1, previousHash: string | null = null) {
  return signTimelineEvent({ familyId, eventId: `20000000-0000-4000-8000-${String(sequence).padStart(12,'0')}`,
    sequence, previousHash, dedupeKey: `synthetic-${sequence}`, eventType: 'checkin.completed', entityId: null,
    humanLine: 'Synthetic check-in completed by AI.', occurredAt: '2026-11-14T12:00:00.000Z', keyId: 'test-key',
    payload: { synthetic: true, status: 'completed' } }, privateKey);
}
describe('signed timeline', () => {
  it('canonicalizes nested JSON independently of insertion order', () => {
    expect(canonicalJson({ z: [false, null, -0], a: { y: 'नमस्ते', x: 3 } }))
      .toBe(canonicalJson({ a: { x: 3, y: 'नमस्ते' }, z: [false, null, 0] }));
    expect(timelinePayloadHash({ b: 2, a: 1 })).toBe(timelinePayloadHash({ a: 1, b: 2 }));
  });
  it('rejects non-JSON, cyclic data, accessors and unsafe prototypes', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    let getterInvoked = false;
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { getterInvoked = true; return 'secret'; } });
    for (const value of [undefined, NaN, Infinity, 1n, new Date(), new Map(), cycle, [undefined], Array(1), accessor, JSON.parse('{"__proto__":{}}')]) {
      expect(() => canonicalJson(value)).toThrow();
    }
    expect(getterInvoked).toBe(false);
  });
  it('signs deterministically and protects every envelope field', () => {
    const signed = event();
    expect(event()).toEqual(signed);
    expect(verifyTimelineEvent(signed, publicKey)).toBe(true);
    for (const field of Object.keys(signed.envelope)) {
      const changed = structuredClone(signed);
      (changed.envelope as unknown as Record<string, unknown>)[field] = 'tampered';
      expect(verifyTimelineEvent(changed, publicKey), field).toBe(false);
    }
    expect(verifyTimelineEvent({ ...signed, signature: 'A'.repeat(86) + '==' }, publicKey)).toBe(false);
    expect(verifyTimelineEvent(signed, generateKeyPairSync('ed25519').publicKey)).toBe(false);
  });
  it('finds the first tampered, removed or reordered link and missing tail', () => {
    const first = event(); const second = event(2, first.chainHash); const third = event(3, second.chainHash);
    const events = [first, second, third]; const keys = new Map([['test-key', publicKey]]);
    const head = { familyId, sequence: 3, chainHash: third.chainHash };
    expect(verifyTimelineChain(events, keys, head)).toEqual({ valid: true });
    const changed = structuredClone(events); changed[1].envelope.humanLine = 'tampered';
    expect(verifyTimelineChain(changed, keys, head)).toEqual({ valid: false, index: 1, reason: 'signature' });
    expect(verifyTimelineChain([first, third], keys, head)).toEqual({ valid: false, index: 1, reason: 'sequence' });
    expect(verifyTimelineChain([second, first, third], keys, head)).toEqual({ valid: false, index: 0, reason: 'sequence' });
    expect(verifyTimelineChain([first, second], keys, head)).toEqual({ valid: false, index: 2, reason: 'head' });
    expect(verifyTimelineChain(events, new Map(), head)).toEqual({ valid: false, index: 0, reason: 'signature' });
    expect(verifyTimelineChain([], keys, { familyId, sequence: 0, chainHash: null })).toEqual({ valid: true });
  });
});
