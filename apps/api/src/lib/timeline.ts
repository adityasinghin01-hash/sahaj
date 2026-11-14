import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';

const PAYLOAD_DOMAIN = 'SAHAJ.timeline.payload.v1\n';
const CHAIN_DOMAIN = 'SAHAJ.timeline.chain.v1\n';
const SIGNATURE_DOMAIN = 'SAHAJ.timeline.signature.v1\n';
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Deterministic JSON for finite JSON data only; never invokes getters or toJSON. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 64) throw new TypeError('canonical_json_depth');
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('canonical_json_nonfinite');
      return JSON.stringify(item);
    }
    if (typeof item !== 'object') throw new TypeError('canonical_json_unsupported');
    if (ancestors.has(item)) throw new TypeError('canonical_json_cycle');
    if (Object.getOwnPropertySymbols(item).length) throw new TypeError('canonical_json_symbol');
    const proto = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      throw new TypeError('canonical_json_prototype');
    }
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Array.isArray(item)) {
        const keys = Object.keys(descriptors).filter(key => key !== 'length');
        if (keys.length !== item.length) throw new TypeError('canonical_json_sparse_array');
        const encoded: string[] = [];
        for (let index = 0; index < item.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new TypeError('canonical_json_accessor');
          encoded.push(encode(descriptor.value, depth + 1));
        }
        return `[${encoded.join(',')}]`;
      }
      const encoded = Object.keys(descriptors).sort().map(key => {
        const descriptor = descriptors[key];
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError('canonical_json_unsafe_key');
        if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('canonical_json_accessor');
        return `${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`;
      });
      return `{${encoded.join(',')}}`;
    } finally {
      ancestors.delete(item);
    }
  }
  return encode(value, 0);
}

export interface TimelineEnvelope {
  version: 1;
  familyId: string;
  eventId: string;
  sequence: number;
  dedupeKey: string;
  eventType: string;
  entityId: string | null;
  humanLine: string;
  payloadHash: string;
  previousHash: string | null;
  occurredAt: string;
  keyId: string;
}
export interface SignedTimelineEvent {
  envelope: TimelineEnvelope;
  chainHash: string;
  signature: string;
}
export interface TimelineHead { familyId: string; sequence: number; chainHash: string | null }
export type TimelineKey = KeyObject | string | Buffer;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const timelinePayloadHash = (payload: unknown): string => sha256(PAYLOAD_DOMAIN + canonicalJson(payload));

function validateEnvelope(envelope: TimelineEnvelope): void {
  const expectedKeys = ['version','familyId','eventId','sequence','dedupeKey','eventType','entityId','humanLine','payloadHash','previousHash','occurredAt','keyId'].sort();
  if (canonicalJson(Object.keys(envelope).sort()) !== canonicalJson(expectedKeys)) throw new TypeError('timeline_envelope_fields');
  // Inspect values only after canonical validation has rejected accessors/prototypes.
  canonicalJson(envelope);
  if (envelope.version !== 1 || typeof envelope.familyId !== 'string' || typeof envelope.eventId !== 'string'
    || !UUID.test(envelope.familyId) || !UUID.test(envelope.eventId)
    || (envelope.entityId !== null && !UUID.test(envelope.entityId))
    || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1
    || !HASH.test(envelope.payloadHash)
    || (envelope.previousHash !== null && !HASH.test(envelope.previousHash))
    || (envelope.sequence === 1) !== (envelope.previousHash === null)
    || typeof envelope.eventType !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(envelope.eventType)
    || typeof envelope.dedupeKey !== 'string' || envelope.dedupeKey.length < 1 || envelope.dedupeKey.length > 256
    || typeof envelope.keyId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(envelope.keyId)
    || typeof envelope.humanLine !== 'string' || envelope.humanLine.length > 2000
    || typeof envelope.occurredAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(envelope.occurredAt)
    || !Number.isFinite(Date.parse(envelope.occurredAt)) || new Date(envelope.occurredAt).toISOString() !== envelope.occurredAt) {
    throw new TypeError('invalid_timeline_envelope');
  }
}

export function signTimelineEvent(
  input: Omit<TimelineEnvelope, 'version' | 'payloadHash'> & { payload: unknown },
  privateKey: TimelineKey,
): SignedTimelineEvent {
  canonicalJson(input);
  const { payload, ...fields } = input;
  const envelope: TimelineEnvelope = { ...fields, version: 1, payloadHash: timelinePayloadHash(payload) };
  validateEnvelope(envelope);
  const key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey);
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new TypeError('timeline_requires_ed25519_private_key');
  const chainHash = sha256(CHAIN_DOMAIN + canonicalJson(envelope));
  const signature = sign(null, Buffer.from(SIGNATURE_DOMAIN + chainHash, 'utf8'), key).toString('base64');
  return { envelope, chainHash, signature };
}

export function verifyTimelineEvent(event: SignedTimelineEvent, publicKey: TimelineKey): boolean {
  try {
    validateEnvelope(event.envelope);
    if (!HASH.test(event.chainHash) || !/^[A-Za-z0-9+/]{86}==$/.test(event.signature)) return false;
    if (Buffer.from(event.signature, 'base64').toString('base64') !== event.signature) return false;
    if (sha256(CHAIN_DOMAIN + canonicalJson(event.envelope)) !== event.chainHash) return false;
    const key = publicKey instanceof KeyObject ? publicKey : createPublicKey(publicKey);
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, Buffer.from(SIGNATURE_DOMAIN + event.chainHash, 'utf8'), key, Buffer.from(event.signature, 'base64'));
  } catch {
    return false;
  }
}

export type TimelineVerification = { valid: true } | { valid: false; index: number; reason: 'family' | 'sequence' | 'previous_hash' | 'signature' | 'head' };
/** Verify the complete stream against a separately trusted head, including missing tail events. */
export function verifyTimelineChain(events: readonly SignedTimelineEvent[], publicKeys: ReadonlyMap<string, TimelineKey>, expectedHead: TimelineHead): TimelineVerification {
  let previousHash: string | null = null;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    try { validateEnvelope(event.envelope); } catch { return { valid: false, index, reason: 'signature' }; }
    if (event.envelope.familyId !== expectedHead.familyId) return { valid: false, index, reason: 'family' };
    if (event.envelope.sequence !== index + 1) return { valid: false, index, reason: 'sequence' };
    if (event.envelope.previousHash !== previousHash) return { valid: false, index, reason: 'previous_hash' };
    const key = publicKeys.get(event.envelope.keyId);
    if (!key || !verifyTimelineEvent(event, key)) return { valid: false, index, reason: 'signature' };
    previousHash = event.chainHash;
  }
  if (expectedHead.sequence !== events.length || expectedHead.chainHash !== previousHash) return { valid: false, index: events.length, reason: 'head' };
  return { valid: true };
}
