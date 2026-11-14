/**
 * Shared Core 1 app-push notification helper (Expo Push API via app_push_tokens),
 * timer scaling (DEMO_TIMER_SCALE), and strict PII scrubbing.
 *
 * WhatsApp is intentionally NOT supported in Core 1 urgent/check-in flows.
 */

import { randomUUID } from 'node:crypto';
import type { ActionAuthorization } from '@sahaj/adapters';
import type { DispatchDeps } from '../provider-dispatch';
import type { SupabaseClientLike } from './wiring-common';

export const DEFAULT_EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

export type PushFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface AppPushMessage {
  familyId: string;
  title: string;
  body: string;
  data: Record<string, string>;
}

export interface AppPushResult {
  sent: boolean;
  tokenCount: number;
  reason?: string;
}

/** Strips any 4+ digit run so OTPs, pins, or phone numbers can never appear in pushes or timeline text. */
export function sanitizeNoDigitsRun(text: string, maxLen = 280): string {
  const cleaned = text
    .replace(/\+?\d[\d\s\-().]{2,}\d/g, (match) => {
      const digitsOnly = match.replace(/\D/g, '');
      return digitsOnly.length >= 4 ? '<redacted>' : match;
    })
    .replace(/\d{4,}/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, maxLen) || 'Sahaj update';
}

/**
 * Parses DEMO_TIMER_SCALE from env. Default is 1; missing, non-numeric, or <= 0 evaluates to 1.
 */
export function parseDemoTimerScale(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.DEMO_TIMER_SCALE;
  if (!raw) return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(parsed, 3600);
}

export function scaleDurationSeconds(baseMinutes: number, scale: number): number {
  const safeBase = Number.isFinite(baseMinutes) && baseMinutes > 0 ? baseMinutes : 3;
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.max(1, Math.round((safeBase * 60) / safeScale));
}

export function scaleDurationMs(baseMs: number, scale: number): number {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.max(1000, Math.round(baseMs / safeScale));
}

export async function sendAppPushTokens(params: {
  tokens: readonly string[];
  message: AppPushMessage;
  fetchImpl?: PushFetch;
  endpoint?: string;
}): Promise<AppPushResult> {
  const uniqueTokens = [...new Set(params.tokens.map((t) => t.trim()).filter((t) => t.length > 0))];
  if (uniqueTokens.length === 0) {
    return { sent: false, tokenCount: 0, reason: 'no_push_tokens' };
  }

  const title = sanitizeNoDigitsRun(params.message.title, 120);
  const body = sanitizeNoDigitsRun(params.message.body, 280);
  const endpoint = params.endpoint ?? process.env.EXPO_PUSH_ENDPOINT ?? DEFAULT_EXPO_PUSH_ENDPOINT;
  const fetchFn: PushFetch = params.fetchImpl ?? (globalThis.fetch as PushFetch);

  try {
    const messages = uniqueTokens.map((to) => ({
      to,
      sound: 'default',
      title,
      body,
      data: params.message.data,
    }));

    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });

    if (!res.ok) {
      return { sent: false, tokenCount: uniqueTokens.length, reason: `expo_http_${res.status}` };
    }
    return { sent: true, tokenCount: uniqueTokens.length };
  } catch {
    return { sent: false, tokenCount: uniqueTokens.length, reason: 'expo_network_error' };
  }
}

export async function listFamilyChildPushTokens(
  db: SupabaseClientLike,
  familyId: string,
): Promise<string[]> {
  const { data: members } = await db
    .from('family_memberships')
    .select('user_id')
    .eq('family_id', familyId)
    .eq('role', 'child')
    .is('revoked_at', null);

  const userIds = ((members ?? []) as Array<{ user_id: string | null }>)
    .map((m) => m.user_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  let query = db.from('app_push_tokens').select('expo_token').eq('family_id', familyId);
  if (userIds.length > 0) {
    query = query.in('user_id', userIds);
  }
  const { data: tokens } = await query;
  return ((tokens ?? []) as Array<{ expo_token: string | null }>)
    .map((t) => t.expo_token)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
}

export async function claimOutboxRowForDirectDispatch(
  db: SupabaseClientLike,
  outboxId: string,
  workerId: string,
): Promise<{ leaseToken: string; attempt: number } | null> {
  const leaseToken = randomUUID();
  const leaseUntil = new Date(Date.now() + 120_000).toISOString();
  const { data: current } = await db
    .from('outbox')
    .select('id,status,attempt_count')
    .eq('id', outboxId)
    .in('status', ['pending', 'failed'])
    .maybeSingle();
  if (!current) return null;
  const attempt = Number((current as { attempt_count?: number }).attempt_count ?? 0) + 1;
  const { data: updated, error } = await db
    .from('outbox')
    .update({
      status: 'processing',
      lease_token: leaseToken,
      lease_until: leaseUntil,
      worker_id: workerId,
      attempt_count: attempt,
    })
    .eq('id', outboxId)
    .in('status', ['pending', 'failed'])
    .select('id')
    .maybeSingle();
  if (error || !updated) return null;
  return { leaseToken, attempt };
}

export function createSupabaseDispatchAuthorizer(
  db: SupabaseClientLike,
): DispatchDeps['authorize'] {
  return async (cmd, key): Promise<ActionAuthorization | null> => {
    const { data, error } = await db.rpc('recheck_dispatch_authorization', {
      p_outbox_id: cmd.outboxId,
      p_lease_token: cmd.outboxLease,
    });
    const r = (error ? null : data) as
      | { ok?: boolean; personId?: string; providerAction?: string; callId?: string | null }
      | null;
    if (
      !r?.ok ||
      r.personId !== cmd.personId ||
      r.providerAction !== cmd.payload.action ||
      (r.callId ?? undefined) !== cmd.callId
    ) {
      return null;
    }
    return {
      decision: 'allow',
      consent: true,
      personId: cmd.personId,
      action: cmd.payload.action as ActionAuthorization['action'],
      idempotencyKey: key,
      expiresAt: Date.now() + 60_000,
    };
  };
}

