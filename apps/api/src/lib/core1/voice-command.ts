/**
 * Orchestrates `POST /api/core1/voice-message` while keeping its request and
 * response shapes completely unchanged.
 *
 * Step 1: Delegates to `handleCore1ApiRoute(request, ports, 'voice_message')`
 *         for strict Bearer auth, payload validation, encryption, idempotency,
 *         and `raw_events` enqueueing.
 * Step 2: When queued freshly (`status === 202 && !deduped`), creates the
 *         `voice_posts` + `sahaj_private.voice_content` row via
 *         `create_family_voice_post` RPC and triggers Phase 2 notification
 *         (`notifyVoicePost`: Expo push for smartphone, Twilio call for keypad).
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { handleCore1ApiRoute } from './handler';
import type { Core1ServicePorts } from './types';
import { validateVoiceMessagePayload } from './validation';
import {
  createSupabaseVoiceAuthPorts,
  createSupabaseVoiceTimelinePort,
  resolveVoiceActor,
  tryServiceDatabase,
  type VoiceAuthPorts,
  type VoiceTimelinePort,
} from './voice-auth';
import {
  createSupabaseVoiceNotifyDeps,
  notifyVoicePost,
  type VoiceNotifyInput,
  type VoiceNotifyResult,
} from './voice-notify';

export interface VoiceCommandFinalizeDeps {
  auth: VoiceAuthPorts;
  timeline?: VoiceTimelinePort;
  createVoicePost: (input: {
    familyId: string;
    senderId: string;
    recipientId: string;
    mediaObjectPath: string;
    consentId: string;
    replyToId?: string;
  }) => Promise<{ voicePostId: string }>;
  notify: (input: VoiceNotifyInput) => Promise<VoiceNotifyResult>;
}

export function createSupabaseVoiceCommandFinalizeDeps(
  db: SupabaseClient,
): VoiceCommandFinalizeDeps {
  const notifyDeps = createSupabaseVoiceNotifyDeps(db);
  return {
    auth: createSupabaseVoiceAuthPorts(db),
    timeline: createSupabaseVoiceTimelinePort(db),
    async createVoicePost(input) {
      const { data, error } = await db.rpc('create_family_voice_post', {
        p_family_id: input.familyId,
        p_sender_id: input.senderId,
        p_recipient_id: input.recipientId,
        p_object_path: input.mediaObjectPath,
        p_consent_id: input.consentId,
        p_reply_to: input.replyToId ?? null,
      });
      if (error || !data || typeof (data as { voice_post_id?: string }).voice_post_id !== 'string') {
        throw new Error('create_family_voice_post_failed');
      }
      return { voicePostId: (data as { voice_post_id: string }).voice_post_id };
    },
    notify: (input) => notifyVoicePost(notifyDeps, input),
  };
}

export async function handleVoiceCommandRoute(
  request: Request,
  ports?: Core1ServicePorts,
  finalizeDeps?: VoiceCommandFinalizeDeps,
): Promise<Response> {
  const rawBodyText = await request.text();
  const forwarded = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: rawBodyText,
  });

  const baseResponse = await handleCore1ApiRoute(forwarded, ports, 'voice_message');
  if (baseResponse.status !== 202) {
    return baseResponse;
  }

  let parsedRes: {
    eventId?: string;
    commandType?: string;
    status?: string;
    deduped?: boolean;
  };
  try {
    parsedRes = (await baseResponse.clone().json()) as typeof parsedRes;
  } catch {
    return baseResponse;
  }

  if (parsedRes.deduped) {
    return baseResponse;
  }

  let activeFinalize = finalizeDeps;
  if (!activeFinalize && !ports) {
    const db = tryServiceDatabase();
    if (db) {
      activeFinalize = createSupabaseVoiceCommandFinalizeDeps(db);
    }
  }
  if (!activeFinalize) {
    return baseResponse;
  }

  try {
    const bodyObj = JSON.parse(rawBodyText) as Record<string, unknown>;
    const actor = await resolveVoiceActor(request, activeFinalize.auth);
    const payload = validateVoiceMessagePayload(bodyObj, actor.familyId);

    const { voicePostId } = await activeFinalize.createVoicePost({
      familyId: actor.familyId,
      senderId: actor.personId,
      recipientId: payload.recipientPersonId,
      mediaObjectPath: payload.mediaObjectPath,
      consentId: payload.consentId,
      replyToId: payload.replyToId,
    });

    if (activeFinalize.timeline) {
      await activeFinalize.timeline
        .append({
          familyId: actor.familyId,
          eventId: parsedRes.eventId ?? voicePostId,
          dedupeKey: `voice_post_created:${voicePostId}`,
          eventType: 'voice_post.created',
          entityId: voicePostId,
          humanLine: 'Queued family voice message for delivery.',
          payload: {
            senderId: actor.personId,
            recipientId: payload.recipientPersonId,
            replyToId: payload.replyToId ?? null,
          },
        })
        .catch(() => undefined);
    }

    await activeFinalize
      .notify({
        familyId: actor.familyId,
        voicePostId,
        senderId: actor.personId,
        recipientId: payload.recipientPersonId,
        replyToId: payload.replyToId ?? null,
      })
      .catch(() => undefined);
  } catch {
    // Request was durably queued in raw_events; response contract remains 202.
  }

  return NextResponse.json(parsedRes, { status: 202 });
}
