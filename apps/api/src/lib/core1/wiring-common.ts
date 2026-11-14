import { enqueueAuthorizedSend } from './authorized-send';
import { createHash } from 'node:crypto';
import type { FamilyMembership, FamilyRole, AuthPort } from './types';
import { Core1CommandError } from './errors';
import { readCommandBody, parseCommandJson, validateUuid, isValidUuid } from './validation';
import { createDefaultAuthPort } from './handler';
import { canonicalJson, signTimelineEvent } from '../timeline';
import { encryptWebhook, decryptWebhook } from '../webhook-security';
import { serviceDatabase } from '../database';

export interface Core1Actor {
  userId: string;
  personId: string;
  familyId: string;
  role: FamilyRole;
}

export function toFamilyMembership(actor: Core1Actor): FamilyMembership {
  return {
    familyId: actor.familyId,
    userId: actor.userId,
    personId: actor.personId,
    role: actor.role,
  };
}

export interface Core1AuthPort {
  authenticate(request: Request, requestedFamilyId?: string): Promise<Core1Actor>;
}

export interface Core1TimelineInput {
  familyId: string;
  eventType: string;
  entityId: string | null;
  humanLine: string;
  payload: unknown;
  dedupeKey: string;
  occurredAt?: string;
}

export interface Core1TimelineResult {
  sequence: number;
  chainHash: string;
  deduped: boolean;
}

export interface Core1TimelinePort {
  append(input: Core1TimelineInput): Promise<Core1TimelineResult>;
}

export interface Core1OutboxEnqueueInput {
  familyId: string;
  actionRequestId?: string | null;
  permissionId?: string | null;
  kind: string;
  action: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
}

export interface Core1OutboxEnqueueResult {
  outboxId: string;
  deduped: boolean;
}

export interface Core1OutboxPort {
  assertRouteAvailable?(kind: string): void;
  enqueue(input: Core1OutboxEnqueueInput): Promise<Core1OutboxEnqueueResult>;
}

export type SupabaseClientLike = ReturnType<typeof serviceDatabase>;

export function clockAt(date: Date) {
  return {
    now: () => date,
    nowIso: () => date.toISOString(),
    nowMs: () => date.getTime(),
  };
}

export function stableCore1Uuid(parts: readonly string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000'), 'utf8').digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function extractBearerToken(request: Request): string {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) {
    throw new Core1CommandError('unauthorized_missing_bearer_token', 401);
  }
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer' || !parts[1].trim()) {
    throw new Core1CommandError('unauthorized_malformed_bearer_token', 401);
  }
  return parts[1].trim();
}

export async function readCore1JsonRequest(request: Request): Promise<Record<string, unknown>> {
  const bodyBuf = await readCommandBody(request);
  return parseCommandJson(bodyBuf);
}

export function parseOptionalFamilyId(
  request: Request,
  bodyObject: Record<string, unknown>,
): string | undefined {
  const headerFam = request.headers.get('x-family-id');
  const raw = headerFam ?? bodyObject.familyId ?? bodyObject.family_id;
  if (raw === undefined || raw === null || raw === '') return undefined;
  return validateUuid(raw, 'family_id');
}

export function createSupabaseCore1AuthPort(
  db: SupabaseClientLike,
  authPort: AuthPort = createDefaultAuthPort(),
): Core1AuthPort {
  return {
    async authenticate(request: Request, requestedFamilyId?: string): Promise<Core1Actor> {
      const token = extractBearerToken(request);
      const user = await authPort.getUser(token);
      if (!user?.id || !isValidUuid(user.id)) {
        throw new Core1CommandError('unauthorized_invalid_bearer_token', 401);
      }

      const { data: memberships, error } = await db
        .from('family_memberships')
        .select('family_id,person_id,role,revoked_at,people!inner(id)')
        .eq('user_id', user.id)
        .is('revoked_at', null);

      if (error) {
        throw new Core1CommandError('membership_lookup_failed', 503);
      }

      const active = (memberships ?? []).filter((m: Record<string, unknown>) => {
        const person = Array.isArray(m.people) ? m.people[0] : m.people;
        return !person || (person as { active?: boolean }).active !== false;
      });

      if (active.length === 0) {
        throw new Core1CommandError('forbidden_no_active_membership', 403);
      }

      let chosen: Record<string, unknown>;
      if (requestedFamilyId) {
        const match = active.find((m: Record<string, unknown>) => m.family_id === requestedFamilyId);
        if (!match) {
          throw new Core1CommandError('forbidden_not_family_member', 403);
        }
        chosen = match;
      } else {
        if (active.length > 1) {
          throw new Core1CommandError('ambiguous_family_membership', 400);
        }
        chosen = active[0];
      }

      return {
        userId: user.id,
        personId: String(chosen.person_id),
        familyId: String(chosen.family_id),
        role: chosen.role as FamilyRole,
      };
    },
  };
}

export function createSupabaseCore1TimelinePort(
  db: SupabaseClientLike,
  privateKeyPem: string | undefined,
  keyId: string = 'core1-default',
  now: () => Date = () => new Date(),
): Core1TimelinePort {
  return {
    async append(input: Core1TimelineInput): Promise<Core1TimelineResult> {
      const { data: existing, error: lookupErr } = await db
        .from('timeline_events')
        .select('sequence,chain_hash')
        .eq('family_id', input.familyId)
        .eq('dedupe_key', input.dedupeKey)
        .maybeSingle();

      if (lookupErr) {
        throw new Core1CommandError('timeline_lookup_failed', 503);
      }
      if (existing) {
        return {
          sequence: Number((existing as { sequence: number }).sequence),
          chainHash: String((existing as { chain_hash: string }).chain_hash),
          deduped: true,
        };
      }

      if (!privateKeyPem) {
        throw new Core1CommandError('timeline_signing_not_configured', 503);
      }

      const occurredAt = input.occurredAt ?? now().toISOString();
      const eventId = stableCore1Uuid(['timeline', input.familyId, input.dedupeKey]);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const { data: head, error: headErr } = await db
          .from('timeline_stream_heads')
          .select('last_sequence,last_chain_hash')
          .eq('family_id', input.familyId)
          .maybeSingle();

        if (headErr) {
          throw new Core1CommandError('timeline_head_failed', 503);
        }

        const sequence = head ? Number((head as { last_sequence: number }).last_sequence) + 1 : 1;
        const previousHash = head && typeof (head as { last_chain_hash?: unknown }).last_chain_hash === 'string'
          ? (head as { last_chain_hash: string }).last_chain_hash
          : null;

        const signed = signTimelineEvent(
          {
            familyId: input.familyId,
            eventId,
            sequence,
            previousHash,
            dedupeKey: input.dedupeKey,
            eventType: input.eventType,
            entityId: input.entityId,
            humanLine: input.humanLine,
            occurredAt,
            keyId,
            payload: input.payload,
          },
          privateKeyPem,
        );

        const { error: rpcErr } = await db.rpc('append_timeline_event', {
          p_event: signed.envelope,
          p_payload_canonical: canonicalJson(input.payload),
          p_chain_hash: signed.chainHash,
          p_signature: signed.signature,
        });

        if (!rpcErr) {
          return { sequence, chainHash: signed.chainHash, deduped: false };
        }
        if (rpcErr.code !== '40001') {
          if (rpcErr.code === '23505') {
            const { data: reRead } = await db
              .from('timeline_events')
              .select('sequence,chain_hash')
              .eq('family_id', input.familyId)
              .eq('dedupe_key', input.dedupeKey)
              .maybeSingle();
            if (reRead) {
              return {
                sequence: Number((reRead as { sequence: number }).sequence),
                chainHash: String((reRead as { chain_hash: string }).chain_hash),
                deduped: true,
              };
            }
          }
          throw new Core1CommandError('timeline_append_failed', 503);
        }
      }
      throw new Core1CommandError('timeline_head_contention', 503);
    },
  };
}

export function createSupabaseCore1OutboxPort(
  db: SupabaseClientLike,
  encryptionKeyHex: string | undefined,
): Core1OutboxPort {
  return {
    assertRouteAvailable(kind) {
      if (kind !== 'core1.missed_call_push') throw new Core1CommandError('authorized_dispatch_route_unavailable', 503);
    },
    async enqueue(input: Core1OutboxEnqueueInput): Promise<Core1OutboxEnqueueResult> {
      // A vendor is not a provider contact person. Until a vendor dispatch contract exists,
      // refuse instead of creating an undeliverable row or reusing an already consumed refill grant.
      if (input.kind !== 'core1.missed_call_push' || input.action !== 'missed_call_nudge') {
        throw new Core1CommandError('authorized_dispatch_route_unavailable', 503);
      }
      const p = input.payload;
      if (typeof p.callerPersonId !== 'string' || typeof p.recipientPersonId !== 'string'
        || typeof p.nudgeId !== 'string') {
        throw new Core1CommandError('authorized_send_binding_missing', 503);
      }
      const sent = await enqueueAuthorizedSend(db, encryptionKeyHex, { familyId: input.familyId,
        subjectId: p.callerPersonId, recipientId: p.recipientPersonId, sourceId: p.nudgeId,
        kind: 'core1.missed_call_push', dedupeKey: input.dedupeKey });
      return { outboxId: sent.id, deduped: sent.duplicate };
    },
  };
}

export function decryptCore1RawPayload(
  ciphertext: string,
  encryptionKeyHex: string,
  source: string,
  providerEventId: string,
): Record<string, unknown> {
  const buf = decryptWebhook(ciphertext, encryptionKeyHex, `${source}:${providerEventId}`);
  const parsed = JSON.parse(buf.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_decrypted_payload');
  }
  return parsed as Record<string, unknown>;
}
