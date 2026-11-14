/**
 * Marks a Core 1 voice post as heard/played by its intended recipient and
 * appends a `voice_post.heard` timeline event so `GET /api/core1/feed/voice`
 * surfaces `played_at`.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  createSupabaseVoiceAuthPorts,
  createSupabaseVoiceTimelinePort,
  resolveVoiceActor,
  VoiceApiError,
  type VoiceAuthPorts,
  type VoiceTimelinePort,
} from './voice-auth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VoicePlayedRepo {
  getVoicePost: (
    familyId: string,
    postId: string,
  ) => Promise<{
    id: string;
    familyId: string;
    senderId: string;
    recipientId: string;
    state: string;
  } | null>;
  markHeard: (familyId: string, postId: string) => Promise<void>;
}

export interface VoicePlayedDeps {
  auth: VoiceAuthPorts;
  repo: VoicePlayedRepo;
  timeline?: VoiceTimelinePort;
  now?: () => Date;
  newId?: () => string;
}

export function createSupabaseVoicePlayedDeps(db: SupabaseClient): VoicePlayedDeps {
  return {
    auth: createSupabaseVoiceAuthPorts(db),
    timeline: createSupabaseVoiceTimelinePort(db),
    repo: {
      async getVoicePost(familyId, postId) {
        const { data, error } = await db
          .from('voice_posts')
          .select('id,family_id,sender_id,recipient_id,state')
          .eq('family_id', familyId)
          .eq('id', postId)
          .maybeSingle();
        if (error) throw new VoiceApiError('voice_post_lookup_failed', 503);
        if (!data) return null;
        const r = data as Record<string, unknown>;
        return {
          id: String(r.id),
          familyId: String(r.family_id),
          senderId: String(r.sender_id),
          recipientId: String(r.recipient_id),
          state: String(r.state),
        };
      },
      async markHeard(familyId, postId) {
        const { error } = await db
          .from('voice_posts')
          .update({ state: 'heard' })
          .eq('family_id', familyId)
          .eq('id', postId);
        if (error) throw new VoiceApiError('voice_post_update_failed', 503);
      },
    },
  };
}

export async function handleMarkVoicePlayed(
  request: Request,
  postId: string,
  deps: VoicePlayedDeps,
): Promise<{
  status: number;
  body: { ok: true; id: string; state: 'heard'; played_at: string };
}> {
  if (!UUID_RE.test(postId)) {
    throw new VoiceApiError('invalid_voice_post_id', 400);
  }
  const actor = await resolveVoiceActor(request, deps.auth);
  const post = await deps.repo.getVoicePost(actor.familyId, postId);
  if (!post) {
    throw new VoiceApiError('voice_post_not_found', 404);
  }
  if (post.recipientId !== actor.personId) {
    throw new VoiceApiError(
      'forbidden_not_recipient',
      403,
      'Only the voice message recipient can mark it heard.',
    );
  }

  const playedAt = (deps.now ?? (() => new Date()))().toISOString();
  if (post.state !== 'heard') {
    await deps.repo.markHeard(actor.familyId, postId);
  }

  if (deps.timeline) {
    await deps.timeline.append({
      familyId: actor.familyId,
      eventId: (deps.newId ?? randomUUID)(),
      dedupeKey: `voice_heard:${postId}:${actor.personId}`,
      eventType: 'voice_post.heard',
      entityId: postId,
      humanLine: 'Recipient played family voice message.',
      payload: { recipientId: actor.personId, state: 'heard' },
      occurredAt: playedAt,
    });
  }

  return {
    status: 200,
    body: {
      ok: true,
      id: postId,
      state: 'heard',
      played_at: playedAt,
    },
  };
}
