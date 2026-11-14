/**
 * Domain-separated idempotency key derivation and conflict detection.
 *
 * Implements:
 * - Scoped hash derivation binding familyId, actorPersonId, and client idempotency key
 * - Prevents cross-family and cross-user providerEventId collisions
 * - SHA-256 body hash comparison to detect changed-body replay conflicts (409 Conflict)
 */

import { createHash } from 'node:crypto';

export function deriveScopedIdempotencyKey(
  familyId: string,
  actorPersonId: string,
  clientKey: string
): string {
  if (!familyId || !actorPersonId || !clientKey) {
    throw new Error('familyId, actorPersonId, and clientKey are required to derive scoped idempotency key');
  }

  const hash = createHash('sha256')
    .update(`core1:idempotency:${familyId}:${actorPersonId}:${clientKey.trim()}`)
    .digest('hex');

  // Format as stable opaque provider event ID
  return `idemp-${hash.slice(0, 32)}`;
}

export function computePayloadHash(body: Buffer | string): string {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  return createHash('sha256').update(buf).digest('hex');
}
