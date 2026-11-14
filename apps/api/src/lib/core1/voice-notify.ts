/**
 * Phase 2 / Expo Push notification fanout when a Core 1 voice post is created.
 * - Smartphone recipient (`people.device = 'smartphone'`): sends Expo push
 *   ("Riya ka sandesh aaya hai" or "<Sender> ka sandesh aaya hai") to tokens
 *   registered in `public.app_push_tokens`. Never includes phone numbers/OTPs.
 * - Keypad recipient (`people.device = 'keypad'`): creates a `calls` row +
 *   binds an outbox row + dispatches via Phase 2 `dispatchOutbound`
 *   (`twilio.create_call`) pointing to the consented AI-disclosed TwiML URL.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ActionAuthorization, FetchTransport } from '@sahaj/adapters';
import { dispatchOutbound, type DispatchDeps } from '@/lib/provider-dispatch/dispatch';
import { dispatchStore } from '@/lib/provider-dispatch/supabase-store';
import { createContactResolver, type ContactDb } from '@/lib/provider-dispatch/contacts';
import type { DispatchStore } from '@/lib/provider-dispatch/types';
import { encryptWebhook } from '@/lib/webhook-security';
import { createSupabaseVoiceTimelinePort, type VoiceTimelinePort } from './voice-auth';

export interface VoiceNotifyInput {
  familyId: string;
  voicePostId: string;
  senderId: string;
  recipientId: string;
  replyToId?: string | null;
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
  listPushTokensForPerson: (familyId: string, personId: string) => Promise<string[]>;
  insertOutbox: (input: {
    id: string;
    familyId: string;
    dedupeKey: string;
    payloadCiphertext: string;
  }) => Promise<{ id: string; duplicate: boolean }>;
  updateOutboxStatus: (
    outboxId: string,
    status: 'pending' | 'completed' | 'failed' | 'delivery_unknown',
    lastErrorCode?: string | null,
  ) => Promise<void>;
  createScheduledTwilioCall: (input: {
    familyId: string;
    personId: string;
  }) => Promise<string>;
}

export interface VoiceNotifyDeps {
  repo: VoiceNotifyRepo;
  timeline?: VoiceTimelinePort;
  sendPush?: (messages: ExpoPushMessage[]) => Promise<{ sent: number; failed: number }>;
  encryptionKeyHex?: string;
  keypadBaseUrl?: string;
  dispatch?: {
    store: DispatchStore;
    deps: Omit<DispatchDeps, 'store'>;
  };
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
    async listPushTokensForPerson(familyId, personId) {
      const { data: members, error: mErr } = await db
        .from('family_memberships')
        .select('user_id')
        .eq('family_id', familyId)
        .eq('person_id', personId)
        .is('revoked_at', null);
      if (mErr || !members || members.length === 0) return [];
      const userIds = (members as Array<{ user_id: string }>).map((m) => m.user_id);
      const { data: tokens, error: tErr } = await db
        .from('app_push_tokens')
        .select('expo_push_token')
        .in('user_id', userIds);
      if (tErr || !tokens) return [];
      return (tokens as Array<{ expo_push_token: string }>)
        .map((t) => t.expo_push_token)
        .filter((t) => typeof t === 'string' && t.length > 0);
    },
    async insertOutbox(input) {
      const { data: existing } = await db
        .from('outbox')
        .select('id')
        .eq('family_id', input.familyId)
        .eq('dedupe_key', input.dedupeKey)
        .maybeSingle();
      if (existing && typeof (existing as { id?: string }).id === 'string') {
        return { id: (existing as { id: string }).id, duplicate: true };
      }
      const { data, error } = await db
        .from('outbox')
        .insert({
          id: input.id,
          family_id: input.familyId,
          kind: 'core1.voice_notify',
          dedupe_key: input.dedupeKey,
          payload_ciphertext: input.payloadCiphertext,
          status: 'pending',
        })
        .select('id')
        .single();
      if (error) {
        if ((error as { code?: string }).code === '23505') {
          return { id: input.id, duplicate: true };
        }
        throw new Error('voice_outbox_insert_failed');
      }
      return { id: String((data as { id: string }).id), duplicate: false };
    },
    async updateOutboxStatus(outboxId, status, lastErrorCode) {
      await db
        .from('outbox')
        .update({
          status,
          last_error_code: lastErrorCode ?? null,
          completed_at: status === 'completed' ? new Date().toISOString() : null,
        })
        .eq('id', outboxId);
    },
    async createScheduledTwilioCall({ familyId, personId }) {
      const { data, error } = await db
        .from('calls')
        .insert({
          family_id: familyId,
          person_id: personId,
          provider: 'twilio',
          status: 'scheduled',
        })
        .select('id')
        .single();
      if (error || !data) throw new Error('voice_call_insert_failed');
      return String((data as { id: string }).id);
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
        async authorize(cmd, key): Promise<ActionAuthorization> {
          const { data: post } = await db
            .from('voice_posts')
            .select('id,consent_id')
            .eq('family_id', cmd.familyId)
            .eq('recipient_id', cmd.personId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (!post) throw new Error('voice_post_not_found');
          return {
            decision: 'allow',
            consent: true,
            personId: cmd.personId,
            action: 'twilio.create_call',
            idempotencyKey: key,
            expiresAt: Date.now() + 120_000,
          };
        },
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
    sendPush: defaultSendExpoPush,
    encryptionKeyHex,
    keypadBaseUrl: twilioEnv?.baseUrl,
    dispatch,
  };
}

function buildEncryptedOutboxPayload(
  input: VoiceNotifyInput,
  channel: 'smartphone_push' | 'keypad_call',
  encryptionKeyHex?: string,
): string {
  const body = JSON.stringify({
    voicePostId: input.voicePostId,
    senderId: input.senderId,
    recipientId: input.recipientId,
    channel,
  });
  if (!encryptionKeyHex) {
    return 'unencrypted_unavailable';
  }
  return encryptWebhook(
    Buffer.from(body, 'utf8'),
    encryptionKeyHex,
    `voice_notify:${input.familyId}:${input.voicePostId}`,
  );
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

  const outboxIdCandidate = newId();
  const inserted = await deps.repo.insertOutbox({
    id: outboxIdCandidate,
    familyId: input.familyId,
    dedupeKey: `voice_notify:${input.voicePostId}`,
    payloadCiphertext: buildEncryptedOutboxPayload(input, channel, deps.encryptionKeyHex),
  });
  const outboxId = inserted.id;

  if (inserted.duplicate) {
    return { channel, outboxId, dispatched: false, reason: 'duplicate' };
  }

  if (channel === 'smartphone_push') {
    const tokens = await deps.repo.listPushTokensForPerson(input.familyId, input.recipientId);
    const bodyText = formatVoicePushBody(senderName, Boolean(input.replyToId));
    if (tokens.length === 0) {
      await deps.repo.updateOutboxStatus(outboxId, 'pending', 'no_push_tokens');
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
    const pushOutcome = await pushSender(messages);
    if (pushOutcome.sent > 0) {
      await deps.repo.updateOutboxStatus(outboxId, 'completed', null);
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
    await deps.repo.updateOutboxStatus(outboxId, pushOutcome.failed > 0 ? 'failed' : 'pending', reason);
    return { channel, outboxId, dispatched: false, pushCount: 0, reason };
  }

  // Keypad device: call via Phase 2 Twilio dispatch pointing to AI-disclosed TwiML
  if (!deps.dispatch || !deps.keypadBaseUrl) {
    await deps.repo.updateOutboxStatus(outboxId, 'pending', 'twilio_not_configured');
    return { channel, outboxId, dispatched: false, reason: 'twilio_not_configured' };
  }

  const callId = await deps.repo.createScheduledTwilioCall({
    familyId: input.familyId,
    personId: input.recipientId,
  });

  await deps.dispatch.store.bindOutbox({
    familyId: input.familyId,
    outboxId,
    personId: input.recipientId,
    provider: 'twilio',
    action: 'twilio.create_call',
    callId,
  });

  const outboxLease = newId();
  const twimlUrl = `${deps.keypadBaseUrl.replace(/\/+$/, '')}/api/core1/voice-messages/twilio/twiml?postId=${encodeURIComponent(input.voicePostId)}`;
  const outcome = await dispatchOutbound(
    { ...deps.dispatch.deps, store: deps.dispatch.store },
    {
      familyId: input.familyId,
      personId: input.recipientId,
      outboxId,
      outboxLease,
      attempt: 1,
      callId,
      aiDisclosureAttested: true,
      payload: {
        action: 'twilio.create_call',
        twimlUrl,
      },
    },
  );

  if (outcome.status === 'dispatched') {
    await deps.repo.updateOutboxStatus(outboxId, 'completed', null);
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
  await deps.repo.updateOutboxStatus(
    outboxId,
    outcome.status === 'delivery_unknown' ? 'delivery_unknown' : 'failed',
    reason,
  );
  return { channel, outboxId, dispatched: false, reason };
}
