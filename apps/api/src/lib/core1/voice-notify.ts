/**
 * Phase 2 / Expo Push notification fanout when a Core 1 voice post is created.
 * - Smartphone recipient (`people.device = 'smartphone'`): sends Expo push
 *   ("Riya ka sandesh aaya hai" or "<Sender> ka sandesh aaya hai") to tokens
 *   registered in `public.app_push_tokens`. Never includes phone numbers/OTPs.
 * - Keypad recipient (`people.device = 'keypad'`): creates a `calls` row +
 *   binds an outbox row + dispatches via Phase 2 `dispatchOutbound`.
 *   CALL_PROVIDER=sarvam (default): `sarvam.outbound_call` with the CALLBACK agent, purpose=voice_message and
 *   line/callback_line = "<Sender> ka sandesh: <masked AI transcript>" (or the fixed "awaaz bheji hai" line when no
 *   transcript exists). Heard only from that call's Sarvam post-call event (connected, >= 10 s).
 *   CALL_PROVIDER=twilio: `twilio.create_call` pointing to the consented AI-disclosed TwiML URL.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FetchTransport } from '@sahaj/adapters';
import { dispatchOutbound, type DispatchDeps } from '@/lib/provider-dispatch/dispatch';
import { dispatchStore } from '@/lib/provider-dispatch/supabase-store';
import { createContactResolver, type ContactDb } from '@/lib/provider-dispatch/contacts';
import type { DispatchStore } from '@/lib/provider-dispatch/types';
import { enqueueAuthorizedSend, claimAuthorizedSend, claimAuthorizedPush, type SendClaim } from './authorized-send';
import { createDispatchAuthorizer } from '../atlas-runtime/bridge';
import { createSupabaseVoiceTimelinePort, type VoiceTimelinePort } from './voice-auth';
import {
  SARVAM_AI_INTRODUCTION,
  buildSarvamAgentVariables,
  callProvider,
  createSarvamCallRuntime,
  voiceNoteLine,
  withSarvamAgentTransport,
  type CallProvider,
  type SarvamCallRuntime,
} from './sarvam-calls';

export interface VoiceNotifyInput {
  familyId: string;
  voicePostId: string;
  senderId: string;
  recipientId: string;
  replyToId?: string | null;
  /** AI transcript of the voice note, when one exists. Masked before it reaches the call. */
  transcript?: string | null;
}

export interface PersonDeviceInfo {
  id: string;
  familyId: string;
  displayName: string;
  device: 'keypad' | 'smartphone';
  language: string;
}

export interface VoiceNotifyResult {
  channel: 'smartphone_push' | 'keypad_call';
  outboxId: string;
  dispatched: boolean;
  providerRef?: string;
  pushCount?: number;
  reason?: string;
  provider?: CallProvider;
}

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound?: 'default';
  data?: Record<string, string>;
}

export interface VoiceNotifyRepo {
  getPerson: (familyId: string, personId: string) => Promise<PersonDeviceInfo | null>;
  enqueueAuthorized: (input: VoiceNotifyInput, callProvider?: CallProvider) => Promise<{ id: string; duplicate: boolean }>;
  claim: (familyId: string, outboxId: string) => Promise<SendClaim | null>;
  claimPush: (familyId: string, outboxId: string, lease: string) => Promise<string[] | null>;
  updateOutboxStatus: (outboxId: string, lease: string, status: 'completed' | 'failed' | 'delivery_unknown', lastErrorCode?: string | null) => Promise<void>;
}

export interface VoiceNotifyDeps {
  repo: VoiceNotifyRepo;
  timeline?: VoiceTimelinePort;
  pushEnabled?: boolean;
  sendPush?: (messages: ExpoPushMessage[]) => Promise<{ sent: number; failed: number }>;
  encryptionKeyHex?: string;
  keypadBaseUrl?: string;
  dispatch?: {
    store: DispatchStore;
    deps: Omit<DispatchDeps, 'store'>;
  };
  /** Keypad call provider. Omitted = 'twilio' (pre-K-SARVAMCALL behaviour). Production: CALL_PROVIDER, default sarvam. */
  callProvider?: CallProvider;
  /** Sarvam CALLBACK-agent runtime (null/undefined = not configured; the authorized row stays pending). */
  sarvam?: SarvamCallRuntime | null;
  newId?: () => string;
}

const DEFAULT_EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

export function formatVoicePushBody(senderDisplayName: string, isReply: boolean): string {
  const clean = senderDisplayName.trim() || 'Family';
  if (/^riya\b/i.test(clean)) {
    return isReply ? 'Riya ka jawab aaya hai' : 'Riya ka sandesh aaya hai';
  }
  return isReply ? `${clean} ka jawab aaya hai` : `${clean} ka sandesh aaya hai`;
}

export async function defaultSendExpoPush(
  messages: ExpoPushMessage[],
): Promise<{ sent: number; failed: number }> {
  if (messages.length === 0) return { sent: 0, failed: 0 };
  const enabled =
    process.env.EXPO_PUSH_ENABLED === 'true' || process.env.EXPO_PUSH_ENABLED === '1';
  if (!enabled) {
    return { sent: 0, failed: 0 };
  }
  const res = await fetch(process.env.EXPO_PUSH_URL || DEFAULT_EXPO_PUSH_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(messages),
  });
  if (!res.ok) {
    return { sent: 0, failed: messages.length };
  }
  return { sent: messages.length, failed: 0 };
}

function defaultFetchTransport(): FetchTransport {
  return (url, init) => fetch(url, init);
}

function resolveTwilioConfigFromEnv() {
  if (process.env.PROVIDER_DISPATCH_ENABLED !== 'true' || process.env.TWILIO_OUTBOUND_ENABLED !== 'true') return null;
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const fromNumber = process.env.TWILIO_FROM_NUMBER?.trim();
  const baseUrl = process.env.TWILIO_VOICE_BASE_URL?.trim()?.replace(/\/+$/, '');
  const statusCallbackUrl =
    process.env.TWILIO_STATUS_CALLBACK_URL?.trim() ||
    (baseUrl ? `${baseUrl}/api/providers/twilio/status` : undefined);
  if (!accountSid || !authToken || !fromNumber || !baseUrl || !statusCallbackUrl) {
    return null;
  }
  const hosts = [new URL(baseUrl).host];
  const allowedWebhookHosts = process.env.TWILIO_ALLOWED_WEBHOOK_HOSTS
    ? process.env.TWILIO_ALLOWED_WEBHOOK_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)
    : hosts;

  return {
    baseUrl,
    twilio: {
      accountSid,
      authToken,
      fromNumber,
      statusCallbackUrl,
      allowedWebhookHosts,
    },
  };
}

export function createSupabaseVoiceNotifyDeps(db: SupabaseClient): VoiceNotifyDeps {
  const encryptionKeyHex = process.env.WEBHOOK_ENCRYPTION_KEY?.trim();
  const identitySecret = process.env.IDENTITY_HASH_SECRET?.trim();
  const contactEncryptionKey = process.env.CONTACT_ENCRYPTION_KEY?.trim();
  const twilioEnv = resolveTwilioConfigFromEnv();
  const store = dispatchStore(db as unknown as Parameters<typeof dispatchStore>[0]);

  const repo: VoiceNotifyRepo = {
    async getPerson(familyId, personId) {
      const { data, error } = await db
        .from('people')
        .select('id,family_id,display_name,device,language')
        .eq('family_id', familyId)
        .eq('id', personId)
        .maybeSingle();
      if (error || !data) return null;
      const row = data as Record<string, unknown>;
      return {
        id: String(row.id),
        familyId: String(row.family_id),
        displayName: String(row.display_name ?? 'Family'),
        device: row.device === 'smartphone' ? 'smartphone' : 'keypad',
        language: String(row.language ?? 'Hindi'),
      };
    },
    async enqueueAuthorized(input, provider) {
      return enqueueAuthorizedSend(db, encryptionKeyHex, { familyId: input.familyId, subjectId: input.senderId,
        recipientId: input.recipientId, sourceId: input.voicePostId, kind: 'core1.voice_notify', dedupeKey: `voice_notify:${input.voicePostId}`,
        ...(provider === 'sarvam' ? { callProvider: 'sarvam' as const } : {}) });
    },
    claim: (familyId, outboxId) => claimAuthorizedSend(db, familyId, outboxId),
    claimPush: (familyId, outboxId, lease) => claimAuthorizedPush(db, familyId, outboxId, lease),
    async updateOutboxStatus(outboxId, lease, status, lastErrorCode) {
      const { error } = await db.from('outbox').update({ status, last_error_code: lastErrorCode ?? null,
        completed_at: status === 'completed' ? new Date().toISOString() : null })
        .eq('id', outboxId).eq('lease_token', lease).eq('status', 'processing');
      if (error) throw new Error('voice_outbox_finish_failed');
    },
  };

  let dispatch: VoiceNotifyDeps['dispatch'] | undefined;
  if (twilioEnv && identitySecret && contactEncryptionKey) {
    dispatch = {
      store,
      deps: {
        identitySecret,
        transport: defaultFetchTransport(),
        providers: { twilio: twilioEnv.twilio },
        authorize: createDispatchAuthorizer(db),
        // Phase 2 contact registry (provider_identities, binding_kind='contact', versioned AAD, identity hash).
        // The dispatcher only dispatches through `resolveIdentity`, which binds the exact registry row into the claim.
        resolveDestination: createContactResolver(db as unknown as ContactDb, {
          encryptionKeyHex: contactEncryptionKey,
          identitySecret,
          accounts: { twilio: twilioEnv.twilio.accountSid },
        }),
      },
    };
  }

  return {
    repo,
    timeline: createSupabaseVoiceTimelinePort(db),
    pushEnabled: process.env.EXPO_PUSH_ENABLED === 'true' || process.env.EXPO_PUSH_ENABLED === '1',
    sendPush: defaultSendExpoPush,
    encryptionKeyHex,
    keypadBaseUrl: twilioEnv?.baseUrl,
    dispatch,
    callProvider: callProvider(process.env),
    sarvam: callProvider(process.env) === 'sarvam' ? createSarvamCallRuntime(db, process.env, 'CALLBACK') : null,
  };
}

export async function notifyVoicePost(
  deps: VoiceNotifyDeps,
  input: VoiceNotifyInput,
): Promise<VoiceNotifyResult> {
  const newId = deps.newId ?? randomUUID;
  const recipient = await deps.repo.getPerson(input.familyId, input.recipientId);
  if (!recipient) {
    throw new Error('recipient_not_found');
  }
  const sender = await deps.repo.getPerson(input.familyId, input.senderId);
  const senderName = sender?.displayName ?? 'Family';
  const channel: 'smartphone_push' | 'keypad_call' =
    recipient.device === 'smartphone' ? 'smartphone_push' : 'keypad_call';

  const provider: CallProvider = deps.callProvider ?? 'twilio';
  const inserted = channel === 'keypad_call' && provider === 'sarvam'
    ? await deps.repo.enqueueAuthorized(input, 'sarvam')
    : await deps.repo.enqueueAuthorized(input);
  const outboxId = inserted.id;
  // Configuration gaps leave the authorized row pending without consuming a dispatch attempt.
  if (channel === 'keypad_call' && provider === 'sarvam' && !deps.sarvam) {
    return { channel, outboxId, dispatched: false, reason: 'sarvam_not_configured', provider };
  }
  if (channel === 'keypad_call' && provider === 'twilio' && (!deps.dispatch || !deps.keypadBaseUrl)) {
    return { channel, outboxId, dispatched: false, reason: 'twilio_not_configured' };
  }
  if (channel === 'smartphone_push' && deps.pushEnabled === false) {
    return { channel, outboxId, dispatched: false, reason: 'push_disabled' };
  }
  const claim = await deps.repo.claim(input.familyId, outboxId);
  if (!claim) return { channel, outboxId, dispatched: false, reason: 'duplicate' };

  if (channel === 'smartphone_push') {
    const tokens = await deps.repo.claimPush(input.familyId, outboxId, claim.lease);
    const bodyText = formatVoicePushBody(senderName, Boolean(input.replyToId));
    if (!tokens?.length) {
      return { channel, outboxId, dispatched: false, pushCount: 0, reason: 'no_push_tokens' };
    }

    const messages: ExpoPushMessage[] = tokens.map((token) => ({
      to: token,
      title: 'Sahaj',
      body: bodyText,
      sound: 'default',
      data: { route: '/voice', voice_post_id: input.voicePostId },
    }));

    const pushSender = deps.sendPush ?? defaultSendExpoPush;
    let pushOutcome: { sent: number; failed: number };
    try { pushOutcome = await pushSender(messages); }
    catch {
      await deps.repo.updateOutboxStatus(outboxId, claim.lease, 'delivery_unknown', 'push_delivery_unknown');
      return { channel, outboxId, dispatched: false, reason: 'push_delivery_unknown' };
    }
    if (pushOutcome.sent > 0) {
      await deps.repo.updateOutboxStatus(outboxId, claim.lease, 'completed', null);
      if (deps.timeline) {
        await deps.timeline.append({
          familyId: input.familyId,
          eventId: newId(),
          dedupeKey: `voice_notify_push:${input.voicePostId}`,
          eventType: 'voice_post.notified',
          entityId: input.voicePostId,
          humanLine: 'Sent smartphone push notification for family voice message.',
          payload: { channel: 'smartphone_push', pushCount: pushOutcome.sent },
        });
      }
      return { channel, outboxId, dispatched: true, pushCount: pushOutcome.sent };
    }

    const reason = pushOutcome.failed > 0 ? 'push_send_failed' : 'push_disabled';
    await deps.repo.updateOutboxStatus(outboxId, claim.lease, 'failed', reason);
    return { channel, outboxId, dispatched: false, pushCount: 0, reason };
  }

  if (provider === 'sarvam') return dispatchSarvamVoiceNote(deps, input, senderName, outboxId, claim, newId);

  // The atomic enqueue already created and bound the recipient's scheduled call.
  if (!deps.dispatch || !deps.keypadBaseUrl || !claim.callId) throw new Error('voice_dispatch_binding_missing');
  const callId = claim.callId;
  const twimlUrl = `${deps.keypadBaseUrl.replace(/\/+$/, '')}/api/core1/voice-messages/twilio/twiml?postId=${encodeURIComponent(input.voicePostId)}`;
  const outcome = await dispatchOutbound(
    { ...deps.dispatch.deps, store: deps.dispatch.store },
    {
      familyId: input.familyId,
      personId: input.recipientId,
      outboxId,
      outboxLease: claim.lease,
      attempt: claim.attempt,
      callId,
      aiDisclosureAttested: true,
      payload: {
        action: 'twilio.create_call',
        twimlUrl,
      },
    },
  );

  if (outcome.status === 'dispatched') {
    if (deps.timeline) {
      await deps.timeline.append({
        familyId: input.familyId,
        eventId: newId(),
        dedupeKey: `voice_notify_call:${input.voicePostId}`,
        eventType: 'voice_post.notified',
        entityId: input.voicePostId,
        humanLine: 'Placed keypad call to deliver family voice message.',
        payload: { channel: 'keypad_call', providerRef: outcome.providerRef },
      });
    }
    return {
      channel,
      outboxId,
      dispatched: true,
      providerRef: outcome.providerRef,
    };
  }

  const reason = 'code' in outcome ? outcome.code : outcome.status;
  return { channel, outboxId, dispatched: false, reason };
}

/**
 * Keypad voice note through the Sarvam CALLBACK agent. The agent reads `line` / `callback_line`: the masked AI transcript
 * (said to be an AI-read transcript) or, with no transcript, the fixed "awaaz bheji hai" line. No family voice is imitated.
 * Placing the call is not "heard": only the post-call event for this call (connected, >= 10 s) marks it heard.
 */
async function dispatchSarvamVoiceNote(
  deps: VoiceNotifyDeps,
  input: VoiceNotifyInput,
  senderName: string,
  outboxId: string,
  claim: SendClaim,
  newId: () => string,
): Promise<VoiceNotifyResult> {
  const sarvam = deps.sarvam;
  if (!sarvam || !claim.callId) throw new Error('voice_dispatch_binding_missing');
  const line = voiceNoteLine(senderName, input.transcript);
  const variables = buildSarvamAgentVariables({
    purpose: 'voice_message',
    introduction: SARVAM_AI_INTRODUCTION,
    callback_reason: 'voice_message',
    line,
    callback_line: line,
    family_id: input.familyId,
    parent_id: input.recipientId,
    call_id: claim.callId,
    voice_post_id: input.voicePostId,
  });
  const outcome = await dispatchOutbound(
    { ...sarvam.deps, transport: withSarvamAgentTransport(sarvam.deps.transport, { agentId: sarvam.agentId, variables }) },
    {
      familyId: input.familyId,
      personId: input.recipientId,
      outboxId,
      outboxLease: claim.lease,
      attempt: claim.attempt,
      callId: claim.callId,
      payload: { action: 'sarvam.outbound_call', language: 'Hindi' },
    },
  );
  if (outcome.status === 'dispatched') {
    if (deps.timeline) {
      await deps.timeline.append({
        familyId: input.familyId,
        eventId: newId(),
        dedupeKey: `voice_notify_call:${input.voicePostId}`,
        eventType: 'voice_post.notified',
        entityId: input.voicePostId,
        humanLine: 'Placed Sarvam keypad call to read the family voice message (AI-read; not yet heard).',
        payload: { channel: 'keypad_call', provider: 'sarvam', callId: claim.callId, providerRef: outcome.providerRef },
      });
    }
    return { channel: 'keypad_call', outboxId, dispatched: true, providerRef: outcome.providerRef, provider: 'sarvam' };
  }
  const reason = 'code' in outcome ? outcome.code : outcome.status;
  return { channel: 'keypad_call', outboxId, dispatched: false, reason, provider: 'sarvam' };
}
