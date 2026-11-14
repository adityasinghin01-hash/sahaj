/**
 * Shared Bearer auth, family membership resolution, and signed timeline append
 * helpers for Core 1 voice endpoints.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceDatabase } from '@/lib/database';
import { supabaseAuth } from '@/lib/media/supabase';
import { canonicalJson, signTimelineEvent } from '@/lib/timeline';

export class VoiceApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'VoiceApiError';
  }
}

export function voiceJsonError(error: unknown): NextResponse {
  if (error instanceof VoiceApiError) {
    return NextResponse.json(
      { error: error.code, message: error.message },
      { status: error.status },
    );
  }
  return NextResponse.json(
    { error: 'internal_voice_error', message: 'Voice operation failed.' },
    { status: 500 },
  );
}

export interface VoiceActor {
  userId: string;
  familyId: string;
  personId: string;
  role: string;
}

export interface VoiceAuthPorts {
  verifyBearer: (token: string) => Promise<{ userId: string } | null>;
  listMemberships: (
    userId: string,
    familyId?: string,
  ) => Promise<Array<{ familyId: string; personId: string; role: string }>>;
}

export function createSupabaseVoiceAuthPorts(db: SupabaseClient): VoiceAuthPorts {
  const auth = supabaseAuth(db);
  return {
    verifyBearer: (token) => auth.verifyBearer(token),
    async listMemberships(userId, familyId) {
      let query = db
        .from('family_memberships')
        .select('family_id,person_id,role')
        .eq('user_id', userId)
        .is('revoked_at', null);
      if (familyId) {
        query = query.eq('family_id', familyId);
      }
      const { data, error } = await query;
      if (error) {
        throw new VoiceApiError('membership_lookup_failed', 503);
      }
      return ((data ?? []) as Array<{ family_id: string; person_id: string; role: string }>).map(
        (row) => ({
          familyId: row.family_id,
          personId: row.person_id,
          role: row.role,
        }),
      );
    },
  };
}

export async function resolveVoiceActor(
  request: Request,
  ports: VoiceAuthPorts,
): Promise<VoiceActor> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new VoiceApiError('missing_bearer_token', 401);
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    throw new VoiceApiError('missing_bearer_token', 401);
  }
  const verified = await ports.verifyBearer(token);
  if (!verified) {
    throw new VoiceApiError('invalid_bearer_token', 401);
  }

  const requestedFamilyId = request.headers.get('x-sahaj-family-id')?.trim() || undefined;
  const memberships = await ports.listMemberships(verified.userId, requestedFamilyId);
  if (memberships.length === 0) {
    throw new VoiceApiError('family_membership_not_found', 403);
  }
  if (!requestedFamilyId && memberships.length > 1) {
    throw new VoiceApiError('ambiguous_family_membership_family_id_required', 400);
  }
  const chosen = memberships[0];
  return {
    userId: verified.userId,
    familyId: chosen.familyId,
    personId: chosen.personId,
    role: chosen.role,
  };
}

export interface TimelineAppendRequest {
  familyId: string;
  eventId: string;
  dedupeKey: string;
  eventType: string;
  entityId: string | null;
  humanLine: string;
  payload: unknown;
  occurredAt?: string;
}

export interface VoiceTimelinePort {
  append: (input: TimelineAppendRequest) => Promise<{ written: boolean; reason?: string }>;
}

export function createSupabaseVoiceTimelinePort(
  db: SupabaseClient,
  options?: { privateKeyPem?: string; keyId?: string },
): VoiceTimelinePort {
  const privateKeyPem = options?.privateKeyPem ?? process.env.TIMELINE_SIGNING_PRIVATE_KEY;
  const keyId = options?.keyId ?? process.env.TIMELINE_SIGNING_KEY_ID ?? 'core1-voice';

  return {
    async append(input) {
      if (!privateKeyPem) {
        return { written: false, reason: 'timeline_not_configured' };
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { data: head, error: headError } = await db
          .from('timeline_stream_heads')
          .select('last_sequence,last_chain_hash')
          .eq('family_id', input.familyId)
          .maybeSingle();

        if (headError) {
          throw new VoiceApiError('timeline_head_failed', 503);
        }

        const row = head as { last_sequence?: number; last_chain_hash?: string | null } | null;
        const sequence = row && typeof row.last_sequence === 'number' ? row.last_sequence + 1 : 1;
        const previousHash =
          row && typeof row.last_chain_hash === 'string' ? row.last_chain_hash : null;

        const signed = signTimelineEvent(
          {
            familyId: input.familyId,
            eventId: input.eventId,
            sequence,
            previousHash,
            dedupeKey: input.dedupeKey,
            eventType: input.eventType,
            entityId: input.entityId,
            humanLine: input.humanLine,
            occurredAt: input.occurredAt ?? new Date().toISOString(),
            keyId,
            payload: input.payload,
          },
          privateKeyPem,
        );

        const { error } = await db.rpc('append_timeline_event', {
          p_event: signed.envelope,
          p_payload_canonical: canonicalJson(input.payload),
          p_chain_hash: signed.chainHash,
          p_signature: signed.signature,
        });
        if (!error) return { written: true };
        if (error.code !== '40001') {
          throw new VoiceApiError('timeline_append_failed', 503);
        }
      }
      throw new VoiceApiError('timeline_contention', 503);
    },
  };
}

export function tryServiceDatabase(): SupabaseClient | null {
  try {
    return serviceDatabase();
  } catch {
    return null;
  }
}
