/**
 * K-SARVAMCALL heard proof for keypad voice notes read by the Sarvam CALLBACK agent.
 *
 * A voice note is "heard" only from the verified Sarvam post-call event for THAT call: the post-call route has already
 * checked the secret URL, app/agent and the stored attempt; here the attempt must be one of OUR calls, bound (outbox ->
 * authorized send context) to a `core1.voice_notify` send for that voice post and its recipient, and the call must have
 * connected for at least 10 seconds. No event, a short call or a different call is never heard.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseVoiceTimelinePort, type VoiceTimelinePort } from './voice-auth';
import { SARVAM_HEARD_MIN_SECONDS, sarvamCallHeard } from './sarvam-calls';

export interface SarvamHeardPort {
  /** Our Sarvam calls row for this provider attempt id, or null. */
  findCall(attemptId: string): Promise<{ callId: string; familyId: string; personId: string } | null>;
  /** The voice note whose authorized keypad send placed this call, or null for any other call. */
  voicePostForCall(familyId: string, callId: string): Promise<{ voicePostId: string; recipientId: string; state: string } | null>;
  markHeard(familyId: string, voicePostId: string): Promise<void>;
  timeline?: VoiceTimelinePort;
}

export type SarvamHeardOutcome = 'heard' | 'already_heard' | 'not_heard' | 'not_voice_note' | 'unknown_call';

export async function recordSarvamVoiceHeard(
  port: SarvamHeardPort,
  event: { attemptId: string; status: string | null; durationSeconds: number | null },
  newId: () => string = randomUUID,
): Promise<SarvamHeardOutcome> {
  const call = await port.findCall(event.attemptId);
  if (!call) return 'unknown_call';
  const post = await port.voicePostForCall(call.familyId, call.callId);
  if (!post || post.recipientId !== call.personId) return 'not_voice_note';
  if (!sarvamCallHeard(event.status, event.durationSeconds)) return 'not_heard';
  if (post.state === 'heard') return 'already_heard';
  await port.markHeard(call.familyId, post.voicePostId);
  await port.timeline?.append({
    familyId: call.familyId,
    eventId: newId(),
    dedupeKey: `voice_heard:${post.voicePostId}:${call.personId}`,
    eventType: 'voice_post.heard',
    entityId: post.voicePostId,
    humanLine: 'Recipient heard the AI-read family voice message on a keypad call.',
    payload: {
      recipientId: call.personId, state: 'heard', evidence: 'sarvam_post_call_connected',
      callId: call.callId, durationSeconds: event.durationSeconds, minSeconds: SARVAM_HEARD_MIN_SECONDS,
    },
  });
  return 'heard';
}

export function createSupabaseSarvamHeardPort(db: SupabaseClient): SarvamHeardPort {
  return {
    async findCall(attemptId) {
      const { data, error } = await db.from('calls').select('id,family_id,person_id')
        .eq('provider', 'sarvam').eq('external_id', attemptId).limit(2);
      if (error || !Array.isArray(data) || data.length !== 1) return null;
      const r = data[0] as Record<string, unknown>;
      return { callId: String(r.id), familyId: String(r.family_id), personId: String(r.person_id) };
    },
    async voicePostForCall(familyId, callId) {
      const { data: binding } = await db.from('dispatch_bindings').select('outbox_id,person_id,provider')
        .eq('family_id', familyId).eq('call_id', callId).eq('provider', 'sarvam').maybeSingle();
      if (!binding) return null;
      const b = binding as Record<string, unknown>;
      const { data: outbox } = await db.from('outbox').select('action_request_id')
        .eq('family_id', familyId).eq('id', String(b.outbox_id)).maybeSingle();
      const requestId = (outbox as Record<string, unknown> | null)?.action_request_id;
      if (typeof requestId !== 'string') return null;
      const { data: ctx } = await db.from('authorized_send_context').select('kind,source_id,channel')
        .eq('family_id', familyId).eq('request_id', requestId).maybeSingle();
      const c = ctx as Record<string, unknown> | null;
      if (!c || c.kind !== 'core1.voice_notify' || c.channel !== 'sarvam') return null;
      const { data: post } = await db.from('voice_posts').select('id,recipient_id,state')
        .eq('family_id', familyId).eq('id', String(c.source_id)).maybeSingle();
      const p = post as Record<string, unknown> | null;
      if (!p || String(p.recipient_id) !== String(b.person_id)) return null;
      return { voicePostId: String(p.id), recipientId: String(p.recipient_id), state: String(p.state) };
    },
    async markHeard(familyId, voicePostId) {
      const { error } = await db.from('voice_posts').update({ state: 'heard' }).eq('family_id', familyId).eq('id', voicePostId);
      if (error) throw new Error('voice_post_update_failed');
    },
    timeline: createSupabaseVoiceTimelinePort(db),
  };
}
