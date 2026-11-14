/**
 * Core 1 Daily Check-In Scheduling, Sarvam Dispatch & "Maa's day" Post-Call Summary (J1)
 *
 * Flow:
 * 1. POST /api/core1/check-in creates/updates a check-in schedule, cancels, or wakes immediately.
 * 2. Evaluated through @sahaj/atlas `evaluateCheckInWake` (consent, no duplicate active/completed
 *    calls, quiet hours deferral via calculateQuietWindowEnd, finite retry max 2).
 * 3. Calls Maa via Phase 2 `dispatchOutbound` + `createContactResolver` (`sarvam.outbound_call`)
 *    passing `{ family_id, parent_id, address_form }` in Sarvam `agent_variables`.
 * 4. Cron tick runs `syncSarvamCheckInPostCalls` + `processCheckInTick`:
 *    - Recovers missed schedules (due `next_at <= now`, respecting quiet hours).
 *    - Retries once after `no_answer` / `busy` / `failed` (scaled by DEMO_TIMER_SCALE), then sends
 *      Riya an Expo app push (`app_push_tokens`, never WhatsApp) when exhausted.
 *    - Projects consented Sarvam post-call events (`sarvam.outbound` / `sarvam.inbound`) into
 *      `public.check_in_summaries` and signed `timeline_events` for "Maa's day" (`GET /api/core1/feed/check-ins`).
 */

import { randomUUID } from 'node:crypto';
import type { FetchTransport } from '@sahaj/adapters';
import {
  evaluateCheckInWake,
  getLocalDateString,
  getLocalTimeParts,
  localTimeToUtc,
} from '../../../../../packages/atlas/src/core1/check-in';
import type {
  CheckInAttempt,
  CheckInConsent,
  CheckInRetryPolicy,
  CheckInScheduleConfig,
  CheckInState,
  TimeWindow,
} from '../../../../../packages/atlas/src/core1/types';
import {
  dispatchOutbound,
  type DispatchDeps,
  type DispatchOutcome,
} from '../provider-dispatch';
import { createContactResolver } from '../provider-dispatch/contacts';
import { dispatchStore } from '../provider-dispatch/supabase-store';
import { encryptWebhook } from '../webhook-security';
import { canonicalJson } from '../timeline';
import { serviceDatabase } from '../database';
import { Core1CommandError } from './errors';
import { assertCommandCapability } from './capabilities';
import {
  extractIdempotencyKey,
  validateCheckInPayload,
} from './validation';
import {
  clockAt,
  createSupabaseCore1AuthPort,
  createSupabaseCore1TimelinePort,
  decryptCore1RawPayload,
  parseOptionalFamilyId,
  readCore1JsonRequest,
  sha256Hex,
  stableCore1Uuid,
  toFamilyMembership,
  type Core1Actor,
  type Core1AuthPort,
  type Core1TimelinePort,
  type SupabaseClientLike,
} from './wiring-common';
import {
  claimOutboxRowForDirectDispatch,
  createSupabaseDispatchAuthorizer,
  listFamilyChildPushTokens,
  parseDemoTimerScale,
  sanitizeNoDigitsRun,
  scaleDurationMs,
  sendAppPushTokens,
  type PushFetch,
} from './push-notify';

export const DEFAULT_CHECKIN_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_CHECKIN_PREFERRED_TIME = '09:00';
export const DEFAULT_QUIET_WINDOWS: TimeWindow[] = [{ start: '22:00', end: '07:00' }];
export const DEFAULT_RETRY_POLICY: CheckInRetryPolicy = {
  maxAttempts: 2,
  retryIntervalMinutes: 15,
};

export interface SarvamAgentVariables {
  family_id: string;
  parent_id: string;
  address_form: string;
  call_id?: string;
  attempt_number?: string;
}

/**
 * Formats an address form (e.g. "Meena Maa" -> "Meena ji", "Meena ji" -> "Meena ji")
 * without leaking phone numbers or 4+ digit identifiers.
 */
export function formatParentAddressForm(displayName: string): string {
  const safe = sanitizeNoDigitsRun(displayName || 'Maa', 60);
  if (/\bji$/i.test(safe)) return safe;
  const firstToken = safe.split(/\s+/)[0] || safe;
  if (/^maa$/i.test(firstToken)) return 'Maa ji';
  return `${firstToken} ji`;
}

/**
 * Wraps the Phase 2 HTTP transport to inject non-PII `agent_variables` (`family_id`,
 * `parent_id`, `address_form`) into Sarvam outbound calls without altering Phase 2 or
 * @sahaj/adapters source files.
 */
export function withSarvamAgentVariablesTransport(
  baseTransport: FetchTransport,
  variables: SarvamAgentVariables,
): FetchTransport {
  return async (url: string, init?: RequestInit) => {
    if (init && typeof init.body === 'string' && /\/outbounds(?:$|\?)/.test(url)) {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && parsed.app_config && typeof parsed.app_config === 'object') {
          const appCfg = parsed.app_config as Record<string, unknown>;
          const existingVars =
            appCfg.agent_variables && typeof appCfg.agent_variables === 'object'
              ? (appCfg.agent_variables as Record<string, unknown>)
              : {};
          parsed.app_config = {
            ...appCfg,
            agent_variables: {
              ...existingVars,
              family_id: variables.family_id,
              parent_id: variables.parent_id,
              address_form: sanitizeNoDigitsRun(variables.address_form, 60),
              ...(variables.call_id ? { call_id: variables.call_id } : {}),
              ...(variables.attempt_number ? { attempt_number: variables.attempt_number } : {}),
            },
          };
          return baseTransport(url, { ...init, body: JSON.stringify(parsed) });
        }
      } catch {
        // Fall through with original body if JSON parsing fails.
      }
    }
    return baseTransport(url, init ?? {});
  };
}

export interface CheckInScheduleRow {
  id: string;
  familyId: string;
  personId: string;
  kind: string;
  nextAt: string;
  timezone: string;
  enabled: boolean;
}

export interface CheckInCallRow {
  id: string;
  familyId: string;
  personId: string;
  provider: string;
  externalId: string | null;
  status: 'scheduled' | 'ringing' | 'connected' | 'completed' | 'failed' | 'cancelled';
  aiDisclosedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface SarvamRawEventRow {
  id: string;
  familyId: string;
  source: string;
  providerEventId: string;
  eventType: string;
  metadata: Record<string, unknown>;
  payloadCiphertext: string;
  receivedAt: string;
}

export interface CheckInSummaryRecord {
  id: string;
  familyId: string;
  personId: string;
  callId: string | null;
  scheduleId: string | null;
  rawEventId: string | null;
  localDate: string;
  attemptNumber: number;
  outcome: 'answered' | 'no_answer' | 'busy' | 'failed' | 'escalated';
  shortSummary: string;
  dedupeKey: string;
}

export interface PrepareCheckInDispatchResult {
  status: 'ready' | 'existing' | 'denied';
  outboxId?: string;
  callId?: string;
  actionRequestId?: string;
  reason?: string;
}

export interface CheckInStore {
  verifyFamilyPerson(familyId: string, personId: string): Promise<boolean>;
  getPersonDisplayName(familyId: string, personId: string): Promise<string>;
  getCircleMember(familyId: string, personId: string): Promise<{
    id: string;
    familyId: string;
    personId: string;
    rank: number;
    consentAt: string | null;
    revokedAt: string | null;
  } | null>;
  getLatestCheckInConsent(familyId: string, personId: string): Promise<CheckInConsent>;
  getScheduleById(familyId: string, scheduleId: string): Promise<CheckInScheduleRow | null>;
  findPersonCheckInSchedule(familyId: string, personId: string): Promise<CheckInScheduleRow | null>;
  upsertSchedule(params: {
    id?: string;
    familyId: string;
    personId: string;
    nextAt: string;
    timezone: string;
    enabled: boolean;
  }): Promise<CheckInScheduleRow>;
  updateScheduleNextAt(scheduleId: string, nextAt: string, enabled?: boolean): Promise<void>;
  listDueSchedules(nowIso: string, limit?: number): Promise<CheckInScheduleRow[]>;
  listCallsForPersonBetween(
    familyId: string,
    personId: string,
    fromIso: string,
    toIso: string,
  ): Promise<CheckInCallRow[]>;
  findCallByExternalId(provider: string, externalId: string): Promise<CheckInCallRow | null>;
  findCallById(familyId: string, callId: string): Promise<CheckInCallRow | null>;
  createInboundCallRow(params: {
    id: string;
    familyId: string;
    personId: string;
    externalId: string;
    status: CheckInCallRow['status'];
    startedAt: string | null;
    endedAt: string | null;
  }): Promise<CheckInCallRow>;
  updateCallStatus(params: {
    callId: string;
    status: CheckInCallRow['status'];
    startedAt?: string | null;
    endedAt?: string | null;
  }): Promise<void>;
  prepareCheckInDispatch(params: {
    familyId: string;
    personId: string;
    dedupeKey: string;
    payloadCiphertext: string;
    payloadHash: string;
  }): Promise<PrepareCheckInDispatchResult>;
  claimOutboxForDirectDispatch(outboxId: string, workerId: string): Promise<{ leaseToken: string; attempt: number } | null>;
  finishOutboxDispatch(outboxId: string, leaseToken: string, success: boolean, errorCode?: string | null): Promise<void>;
  listChildPushTokens(familyId: string): Promise<string[]>;
  recordNudge(params: {
    id: string;
    familyId: string;
    personId: string;
    kind: string;
    scheduledAt: string;
  }): Promise<void>;
  recordChildAlert(params: {
    id: string;
    familyId: string;
    personId: string;
    kind: string;
  }): Promise<void>;
  upsertCheckInSummary(record: CheckInSummaryRecord): Promise<boolean>;
  hasSummaryDedupe(familyId: string, dedupeKey: string): Promise<boolean>;
  listUnprojectedSarvamEvents(limit?: number): Promise<SarvamRawEventRow[]>;
  findCommandDedupe(familyId: string, dedupeKey: string): Promise<{ payloadHash: string; result: Record<string, unknown> } | null>;
  saveCommandDedupe(params: {
    eventId: string;
    familyId: string;
    dedupeKey: string;
    payloadHash: string;
    result: Record<string, unknown>;
  }): Promise<void>;
}

export interface CheckInDispatchRuntime {
  deps: DispatchDeps;
  dispatchFn?: typeof dispatchOutbound;
}

export interface CheckInServiceDeps {
  auth: Core1AuthPort;
  store: CheckInStore;
  timeline: Core1TimelinePort;
  dispatch?: CheckInDispatchRuntime | null;
  pushFetch?: PushFetch;
  encryptionKeyHex?: string;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  quietWindows?: TimeWindow[];
  retryPolicy?: CheckInRetryPolicy;
}

function getNow(deps: CheckInServiceDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function computeNextDayScheduledUtc(now: Date, preferredTime: string, timezone: string): Date {
  const localToday = getLocalDateString(now, timezone);
  const [y, m, d] = localToday.split('-').map(Number);
  const [hh, mm] = preferredTime.split(':').map(Number);
  const candidate = localTimeToUtc(y, m, d, hh, mm, timezone);
  if (candidate.getTime() > now.getTime()) return candidate;
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  return localTimeToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    hh,
    mm,
    timezone,
  );
}

function formatPreferredTimeFromSchedule(nextAtIso: string, timezone: string): string {
  const d = new Date(nextAtIso);
  if (Number.isNaN(d.getTime())) return DEFAULT_CHECKIN_PREFERRED_TIME;
  const parts = getLocalTimeParts(d, timezone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

function buildAttemptsFromCalls(calls: CheckInCallRow[]): CheckInAttempt[] {
  const sorted = [...calls].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return sorted.map((c, idx) => ({
    attemptNumber: idx + 1,
    scheduledAt: c.startedAt ?? c.createdAt,
    status: c.status,
    completedAt: c.status === 'completed' ? (c.endedAt ?? c.createdAt) : undefined,
    failureReason: c.status === 'failed' ? 'no_answer' : undefined,
  }));
}

function buildDailyWindowBounds(now: Date, timezone: string): { fromIso: string; toIso: string; localDate: string } {
  const localDate = getLocalDateString(now, timezone);
  const [y, m, d] = localDate.split('-').map(Number);
  const startUtc = localTimeToUtc(y, m, d, 0, 0, timezone);
  const nextDate = new Date(Date.UTC(y, m - 1, d + 1));
  const endUtc = localTimeToUtc(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(),
    0,
    0,
    timezone,
  );
  return {
    localDate,
    fromIso: startUtc.toISOString(),
    toIso: endUtc.toISOString(),
  };
}

async function notifyRiyaCheckInExhausted(
  deps: CheckInServiceDeps,
  params: {
    familyId: string;
    personId: string;
    personName: string;
    localDate: string;
    attemptsCount: number;
  },
): Promise<{ sent: boolean; tokenCount: number; reason?: string }> {
  const now = getNow(deps);
  const tokens = await deps.store.listChildPushTokens(params.familyId);
  const nudgeId = stableCore1Uuid(['checkin_nudge', params.familyId, params.personId, params.localDate]);
  const alertId = stableCore1Uuid(['checkin_alert', params.familyId, params.personId, params.localDate]);

  await deps.store.recordNudge({
    id: nudgeId,
    familyId: params.familyId,
    personId: params.personId,
    kind: 'check_in_no_answer',
    scheduledAt: now.toISOString(),
  });
  await deps.store.recordChildAlert({
    id: alertId,
    familyId: params.familyId,
    personId: params.personId,
    kind: 'check_in_unanswered',
  });

  const summaryLine = sanitizeNoDigitsRun(
    `${params.personName} did not answer daily check-in after ${params.attemptsCount} tries.`,
  );
  await deps.store.upsertCheckInSummary({
    id: stableCore1Uuid(['checkin_summary', params.familyId, params.personId, params.localDate, 'exhausted']),
    familyId: params.familyId,
    personId: params.personId,
    callId: null,
    scheduleId: null,
    rawEventId: null,
    localDate: params.localDate,
    attemptNumber: params.attemptsCount,
    outcome: 'escalated',
    shortSummary: summaryLine,
    dedupeKey: `checkin_exhausted:${params.familyId}:${params.personId}:${params.localDate}`,
  });

  await deps.timeline.append({
    familyId: params.familyId,
    eventType: 'check_in.unanswered',
    entityId: alertId,
    dedupeKey: `checkin_unanswered:${params.familyId}:${params.personId}:${params.localDate}`,
    humanLine: summaryLine,
    payload: {
      personId: params.personId,
      localDate: params.localDate,
      attemptsCount: params.attemptsCount,
    },
    occurredAt: now.toISOString(),
  });

  return sendAppPushTokens({
    tokens,
    fetchImpl: deps.pushFetch,
    message: {
      familyId: params.familyId,
      title: `${params.personName}'s daily check-in missed`,
      body: `${params.personName} didn't pick up today's check-in call — please check in`,
      data: {
        kind: 'check_in_unanswered',
        personId: params.personId,
        localDate: params.localDate,
      },
    },
  });
}

async function dispatchSarvamCheckInCall(
  deps: CheckInServiceDeps,
  params: {
    familyId: string;
    personId: string;
    scheduleId: string;
    addressForm: string;
    localDate: string;
    attemptNumber: number;
    wakeToken: string;
  },
): Promise<{
  prepared: PrepareCheckInDispatchResult;
  outcome?: DispatchOutcome;
  skippedReason?: string;
  agentVariables: SarvamAgentVariables;
}> {
  const encKey = deps.encryptionKeyHex ?? deps.env?.WEBHOOK_ENCRYPTION_KEY ?? process.env.WEBHOOK_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
    throw new Core1CommandError('encryption_not_configured', 503);
  }

  const dedupeKey = `check_in:${params.familyId}:${params.personId}:${params.localDate}:attempt_${params.attemptNumber}`;
  const outboxPayload = {
    v: 1,
    action: 'check_in',
    scheduleId: params.scheduleId,
    personId: params.personId,
    localDate: params.localDate,
    attemptNumber: params.attemptNumber,
    wakeToken: params.wakeToken,
  };
  const canonical = canonicalJson(outboxPayload);
  const payloadHash = sha256Hex(canonical);
  const payloadCiphertext = encryptWebhook(
    Buffer.from(canonical, 'utf8'),
    encKey,
    `outbox:${params.familyId}:${dedupeKey}`,
  );

  const prepared = await deps.store.prepareCheckInDispatch({
    familyId: params.familyId,
    personId: params.personId,
    dedupeKey,
    payloadCiphertext,
    payloadHash,
  });

  const agentVariables: SarvamAgentVariables = {
    family_id: params.familyId,
    parent_id: params.personId,
    address_form: params.addressForm,
    ...(prepared.callId ? { call_id: prepared.callId } : {}),
    attempt_number: String(params.attemptNumber),
  };

  if (prepared.status === 'denied' || !prepared.outboxId) {
    return {
      prepared,
      skippedReason: prepared.reason ?? 'prepare_denied',
      agentVariables,
    };
  }

  if (!deps.dispatch || !deps.dispatch.deps.providers.sarvam) {
    return {
      prepared,
      skippedReason: 'sarvam_not_configured',
      agentVariables,
    };
  }

  const workerId = `checkin-worker-${randomUUID().slice(0, 8)}`;
  const claimed = await deps.store.claimOutboxForDirectDispatch(prepared.outboxId, workerId);
  if (!claimed) {
    return { prepared, skippedReason: 'outbox_not_claimable', agentVariables };
  }

  const wrappedTransport = withSarvamAgentVariablesTransport(
    deps.dispatch.deps.transport,
    agentVariables,
  );
  const dispatchFn = deps.dispatch.dispatchFn ?? dispatchOutbound;

  const outcome = await dispatchFn(
    {
      ...deps.dispatch.deps,
      transport: wrappedTransport,
    },
    {
      familyId: params.familyId,
      personId: params.personId,
      outboxId: prepared.outboxId,
      outboxLease: claimed.leaseToken,
      attempt: claimed.attempt,
      callId: prepared.callId,
      aiDisclosureAttested: true,
      payload: {
        action: 'sarvam.outbound_call',
        language: 'Hindi',
        openingMessage: `Namaste ${agentVariables.address_form}`,
      },
    },
  );

  if (outcome.status === 'dispatched') {
    await deps.store.finishOutboxDispatch(prepared.outboxId, claimed.leaseToken, true, null);
  } else {
    const errorCode = 'code' in outcome ? outcome.code : outcome.status;
    await deps.store.finishOutboxDispatch(prepared.outboxId, claimed.leaseToken, false, errorCode);
  }

  return { prepared, outcome, agentVariables };
}

async function evaluateAndExecuteCheckIn(
  deps: CheckInServiceDeps,
  params: {
    schedule: CheckInScheduleRow;
    preferredTime: string;
    wakeToken: string;
    wakeTimeIso: string;
  },
): Promise<{
  decisionAction: string;
  outboxId?: string | null;
  callId?: string | null;
  callStatus?: string;
  deferredUntil?: string;
  reason?: string;
  agentVariables?: SarvamAgentVariables;
  pushSent?: boolean;
}> {
  const now = getNow(deps);
  const scale = parseDemoTimerScale(deps.env ?? process.env);
  const baseRetry = deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
  const scaledRetryMinutes = Math.max(0.01, baseRetry.retryIntervalMinutes / scale);
  const retryPolicy: CheckInRetryPolicy = {
    maxAttempts: baseRetry.maxAttempts,
    retryIntervalMinutes: scaledRetryMinutes,
  };

  const bounds = buildDailyWindowBounds(now, params.schedule.timezone);
  const [consent, todaysCalls, displayName] = await Promise.all([
    deps.store.getLatestCheckInConsent(params.schedule.familyId, params.schedule.personId),
    deps.store.listCallsForPersonBetween(
      params.schedule.familyId,
      params.schedule.personId,
      bounds.fromIso,
      bounds.toIso,
    ),
    deps.store.getPersonDisplayName(params.schedule.familyId, params.schedule.personId),
  ]);

  const sarvamCalls = todaysCalls.filter((c) => c.provider === 'sarvam');
  const attempts = buildAttemptsFromCalls(sarvamCalls);

  // If the retry interval hasn't elapsed yet after a failed attempt 1, wait until it is due.
  const failedAttempts = attempts.filter((a) => a.status === 'failed');
  const activeOrCompleted = attempts.some(
    (a) => a.status === 'scheduled' || a.status === 'ringing' || a.status === 'connected' || a.status === 'completed',
  );
  if (!activeOrCompleted && failedAttempts.length > 0 && failedAttempts.length < retryPolicy.maxAttempts) {
    const lastFailed = sarvamCalls.filter((c) => c.status === 'failed').at(-1);
    const failedAtMs = Date.parse(lastFailed?.endedAt ?? lastFailed?.createdAt ?? now.toISOString());
    const retryWaitMs = scaleDurationMs(baseRetry.retryIntervalMinutes * 60_000, scale);
    const retryDueAt = new Date(failedAtMs + retryWaitMs);
    if (now.getTime() < retryDueAt.getTime()) {
      await deps.store.updateScheduleNextAt(params.schedule.id, retryDueAt.toISOString(), true);
      return {
        decisionAction: 'retry_pending',
        deferredUntil: retryDueAt.toISOString(),
      };
    }
  }

  const scheduleConfig: CheckInScheduleConfig = {
    id: params.schedule.id,
    familyId: params.schedule.familyId,
    personId: params.schedule.personId,
    preferredTime: params.preferredTime,
    timezone: params.schedule.timezone,
    enabled: params.schedule.enabled,
    quietWindows: deps.quietWindows ?? DEFAULT_QUIET_WINDOWS,
    retryPolicy,
  };

  const currentState: CheckInState = {
    scheduleId: params.schedule.id,
    familyId: params.schedule.familyId,
    personId: params.schedule.personId,
    localDate: bounds.localDate,
    attempts,
  };

  const decision = evaluateCheckInWake({
    schedule: scheduleConfig,
    currentState,
    consent,
    wake: { wakeToken: params.wakeToken, wakeTime: params.wakeTimeIso },
    clock: clockAt(now),
  });

  if (decision.action === 'defer_quiet_hours') {
    await deps.store.updateScheduleNextAt(params.schedule.id, decision.deferredUntil, true);
    return {
      decisionAction: 'defer_quiet_hours',
      deferredUntil: decision.deferredUntil,
    };
  }

  if (decision.action === 'already_completed') {
    const tomorrowUtc = computeNextDayScheduledUtc(
      new Date(Date.parse(bounds.toIso) + 60_000),
      params.preferredTime,
      params.schedule.timezone,
    );
    await deps.store.updateScheduleNextAt(params.schedule.id, tomorrowUtc.toISOString(), true);
    return { decisionAction: 'already_completed' };
  }

  if (decision.action === 'exhausted') {
    const push = await notifyRiyaCheckInExhausted(deps, {
      familyId: params.schedule.familyId,
      personId: params.schedule.personId,
      personName: displayName,
      localDate: bounds.localDate,
      attemptsCount: decision.alert.attemptsCount,
    });
    const tomorrowUtc = computeNextDayScheduledUtc(
      new Date(Date.parse(bounds.toIso) + 60_000),
      params.preferredTime,
      params.schedule.timezone,
    );
    await deps.store.updateScheduleNextAt(params.schedule.id, tomorrowUtc.toISOString(), true);
    return { decisionAction: 'exhausted', pushSent: push.sent };
  }

  if (decision.action !== 'schedule_call') {
    return {
      decisionAction: decision.action,
      reason: 'reason' in decision ? decision.reason : undefined,
    };
  }

  const addressForm = formatParentAddressForm(displayName);
  const dispatchRes = await dispatchSarvamCheckInCall(deps, {
    familyId: params.schedule.familyId,
    personId: params.schedule.personId,
    scheduleId: params.schedule.id,
    addressForm,
    localDate: bounds.localDate,
    attemptNumber: decision.intent.attemptNumber,
    wakeToken: params.wakeToken,
  });

  if (dispatchRes.outcome?.status === 'dispatched') {
    const entityCallId = dispatchRes.prepared.callId ?? params.schedule.id;
    await deps.timeline.append({
      familyId: params.schedule.familyId,
      eventType: 'check_in.dispatched',
      entityId: entityCallId,
      dedupeKey: `checkin_dispatched:${params.schedule.familyId}:${params.schedule.personId}:${bounds.localDate}:${decision.intent.attemptNumber}`,
      humanLine: sanitizeNoDigitsRun(`Daily check-in call placed to ${addressForm} (attempt ${decision.intent.attemptNumber}).`),
      payload: {
        scheduleId: params.schedule.id,
        callId: dispatchRes.prepared.callId ?? null,
        outboxId: dispatchRes.prepared.outboxId ?? null,
        providerRef: dispatchRes.outcome.providerRef,
        attemptNumber: decision.intent.attemptNumber,
      },
      occurredAt: now.toISOString(),
    });
  }

  // Move next_at forward briefly so cron doesn't immediately re-fire every second; retry logic re-checks failure.
  const retryWaitMs = scaleDurationMs(baseRetry.retryIntervalMinutes * 60_000, scale);
  const nextCheckAt = new Date(now.getTime() + retryWaitMs);
  await deps.store.updateScheduleNextAt(params.schedule.id, nextCheckAt.toISOString(), true);

  return {
    decisionAction: 'schedule_call',
    outboxId: dispatchRes.prepared.outboxId ?? null,
    callId: dispatchRes.prepared.callId ?? null,
    callStatus: dispatchRes.outcome?.status ?? dispatchRes.skippedReason ?? 'pending',
    agentVariables: dispatchRes.agentVariables,
  };
}

/**
 * Executes POST /api/core1/check-in: schedules, cancels, or immediately triggers
 * Maa's daily check-in through Phase 2 Sarvam outbound dispatch.
 */
export async function executeCheckInCommand(
  request: Request,
  deps: CheckInServiceDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const bodyObj = await readCore1JsonRequest(request);
  const requestedFamilyId = parseOptionalFamilyId(request, bodyObj);
  const actor: Core1Actor = await deps.auth.authenticate(request, requestedFamilyId);
  const idempotencyKey = extractIdempotencyKey(request, bodyObj);

  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bodyObj)) {
    if (!['command', 'command_type', 'familyId', 'family_id', 'idempotencyKey', 'idempotency_key'].includes(k)) {
      cleaned[k] = v;
    }
  }

  const payload = validateCheckInPayload(cleaned);
  const personOk = await deps.store.verifyFamilyPerson(actor.familyId, payload.personId);
  if (!personOk) {
    throw new Core1CommandError('foreign_person_reference', 403);
  }

  if (payload.scheduleId) {
    const ownedSched = await deps.store.getScheduleById(actor.familyId, payload.scheduleId);
    if (!ownedSched) {
      throw new Core1CommandError('foreign_schedule_reference', 403);
    }
  }

  const circleRecord =
    actor.role === 'circle' ? await deps.store.getCircleMember(actor.familyId, actor.personId) : null;
  assertCommandCapability(
    'check_in',
    toFamilyMembership(actor),
    circleRecord
      ? {
          familyId: circleRecord.familyId,
          personId: circleRecord.personId,
          rank: circleRecord.rank,
          active: circleRecord.consentAt != null && circleRecord.revokedAt == null,
          approvedAt: null,
          consentAt: circleRecord.consentAt,
          revokedAt: circleRecord.revokedAt,
        }
      : null,
    payload.personId,
  );

  const canonicalReqHash = sha256Hex(canonicalJson(JSON.parse(JSON.stringify(payload))));
  const scopedKey = sha256Hex(`${actor.familyId}:${actor.personId}:check_in:${idempotencyKey}`);
  const dedupe = await deps.store.findCommandDedupe(actor.familyId, scopedKey);
  if (dedupe) {
    if (dedupe.payloadHash !== canonicalReqHash) {
      throw new Core1CommandError('idempotency_conflict_payload_mismatch', 409);
    }
    return {
      status: 200,
      body: { ...dedupe.result, deduped: true },
    };
  }

  const now = getNow(deps);
  const existingSchedule = payload.scheduleId
    ? await deps.store.getScheduleById(actor.familyId, payload.scheduleId)
    : await deps.store.findPersonCheckInSchedule(actor.familyId, payload.personId);

  const timezone = payload.timezone ?? existingSchedule?.timezone ?? DEFAULT_CHECKIN_TIMEZONE;
  const preferredTime =
    payload.preferredTime ??
    (existingSchedule ? formatPreferredTimeFromSchedule(existingSchedule.nextAt, timezone) : DEFAULT_CHECKIN_PREFERRED_TIME);

  if (payload.cancel) {
    const targetSchedule =
      existingSchedule ??
      (await deps.store.upsertSchedule({
        id: payload.scheduleId,
        familyId: actor.familyId,
        personId: payload.personId,
        nextAt: computeNextDayScheduledUtc(now, preferredTime, timezone).toISOString(),
        timezone,
        enabled: false,
      }));
    await deps.store.updateScheduleNextAt(targetSchedule.id, targetSchedule.nextAt, false);
    await deps.timeline.append({
      familyId: actor.familyId,
      eventType: 'check_in.cancelled',
      entityId: targetSchedule.id,
      dedupeKey: `checkin_cancelled:${scopedKey}`,
      humanLine: sanitizeNoDigitsRun(payload.cancellationReason ?? 'Daily check-in schedule paused.'),
      payload: { scheduleId: targetSchedule.id, personId: payload.personId },
      occurredAt: now.toISOString(),
    });
    const resBody = {
      ok: true,
      deduped: false,
      commandType: 'check_in',
      action: 'cancelled',
      scheduleId: targetSchedule.id,
      enabled: false,
    };
    await deps.store.saveCommandDedupe({
      eventId: randomUUID(),
      familyId: actor.familyId,
      dedupeKey: scopedKey,
      payloadHash: canonicalReqHash,
      result: resBody,
    });
    return { status: 200, body: resBody };
  }

  const scheduledUtc = computeNextDayScheduledUtc(now, preferredTime, timezone);
  const schedule = await deps.store.upsertSchedule({
    id: existingSchedule?.id ?? payload.scheduleId,
    familyId: actor.familyId,
    personId: payload.personId,
    nextAt: existingSchedule && !payload.preferredTime ? existingSchedule.nextAt : scheduledUtc.toISOString(),
    timezone,
    enabled: true,
  });

  // Wake immediately if wakeToken supplied, or if only updating schedule without preferredTime (explicit trigger),
  // OR if scheduledUtc was due now/past.
  const shouldWakeNow = Boolean(payload.wakeToken) || !payload.preferredTime || Date.parse(schedule.nextAt) <= now.getTime();
  if (!shouldWakeNow) {
    const resBody = {
      ok: true,
      deduped: false,
      commandType: 'check_in',
      action: 'scheduled',
      scheduleId: schedule.id,
      nextAt: schedule.nextAt,
      timezone: schedule.timezone,
    };
    await deps.store.saveCommandDedupe({
      eventId: randomUUID(),
      familyId: actor.familyId,
      dedupeKey: scopedKey,
      payloadHash: canonicalReqHash,
      result: resBody,
    });
    return { status: 201, body: resBody };
  }

  const wakeToken = payload.wakeToken ?? `cmd:${scopedKey.slice(0, 24)}`;
  const executed = await evaluateAndExecuteCheckIn(deps, {
    schedule,
    preferredTime,
    wakeToken,
    wakeTimeIso: now.toISOString(),
  });

  const resBody = {
    ok: true,
    deduped: false,
    commandType: 'check_in',
    action: executed.decisionAction,
    scheduleId: schedule.id,
    outboxId: executed.outboxId ?? null,
    callId: executed.callId ?? null,
    callStatus: executed.callStatus ?? null,
    deferredUntil: executed.deferredUntil ?? null,
    reason: executed.reason ?? null,
  };

  await deps.store.saveCommandDedupe({
    eventId: randomUUID(),
    familyId: actor.familyId,
    dedupeKey: scopedKey,
    payloadHash: canonicalReqHash,
    result: resBody,
  });

  return { status: 201, body: resBody };
}

/**
 * Cron tick runner for missed-cron recovery, due check-in calls, quiet hours deferral,
 * and failed check-in retry/exhaustion push.
 */
export async function processCheckInTick(deps: CheckInServiceDeps): Promise<{
  evaluated: number;
  dispatched: number;
  deferred: number;
  exhausted: number;
}> {
  const now = getNow(deps);
  const dueSchedules = await deps.store.listDueSchedules(now.toISOString(), 25);
  let evaluated = 0;
  let dispatched = 0;
  let deferred = 0;
  let exhausted = 0;

  for (const schedule of dueSchedules) {
    evaluated++;
    const preferredTime = formatPreferredTimeFromSchedule(schedule.nextAt, schedule.timezone);
    const localDate = getLocalDateString(now, schedule.timezone);
    const wakeToken = `cron:${schedule.id}:${localDate}:${Math.floor(now.getTime() / 1000)}`;

    const res = await evaluateAndExecuteCheckIn(deps, {
      schedule,
      preferredTime,
      wakeToken,
      wakeTimeIso: now.toISOString(),
    });

    if (res.decisionAction === 'schedule_call') dispatched++;
    else if (res.decisionAction === 'defer_quiet_hours' || res.decisionAction === 'retry_pending') deferred++;
    else if (res.decisionAction === 'exhausted') exhausted++;
  }

  return { evaluated, dispatched, deferred, exhausted };
}

function buildPostCallSummaryText(params: {
  addressForm: string;
  eventType: string;
  status: string;
  durationSeconds: number | null;
  variables: Record<string, unknown> | null;
  reviewRequired?: string;
}): { outcome: CheckInSummaryRecord['outcome']; callStatus: CheckInCallRow['status']; text: string } {
  const name = sanitizeNoDigitsRun(params.addressForm, 50);

  if (params.eventType === 'sarvam.inbound') {
    const mins = params.durationSeconds && params.durationSeconds >= 60 ? `${Math.round(params.durationSeconds / 60)}m` : null;
    return {
      outcome: 'answered',
      callStatus: 'completed',
      text: sanitizeNoDigitsRun(`${name} spoke on Sahaj helpline${mins ? ` (${mins})` : ''}.`),
    };
  }

  if (params.status === 'connected') {
    const mood =
      params.variables && typeof params.variables.mood === 'string'
        ? sanitizeNoDigitsRun(params.variables.mood, 40)
        : null;
    const medStatus =
      params.variables && typeof params.variables.medicines_taken === 'string'
        ? sanitizeNoDigitsRun(params.variables.medicines_taken, 40)
        : null;
    const extras = [mood ? `mood: ${mood}` : null, medStatus ? `medicines: ${medStatus}` : null]
      .filter(Boolean)
      .join(' · ');
    const mins = params.durationSeconds && params.durationSeconds >= 60 ? ` · ${Math.round(params.durationSeconds / 60)}m` : '';
    return {
      outcome: 'answered',
      callStatus: 'completed',
      text: sanitizeNoDigitsRun(
        extras ? `${name} completed check-in (${extras})${mins}` : `${name} answered today's check-in${mins}.`,
      ),
    };
  }

  if (params.status === 'busy') {
    return {
      outcome: 'busy',
      callStatus: 'failed',
      text: sanitizeNoDigitsRun(`${name}'s line was busy during daily check-in — will retry.`),
    };
  }
  if (params.status === 'no_answer') {
    return {
      outcome: 'no_answer',
      callStatus: 'failed',
      text: sanitizeNoDigitsRun(`${name} did not answer daily check-in — retry queued.`),
    };
  }
  return {
    outcome: 'failed',
    callStatus: 'failed',
    text: sanitizeNoDigitsRun(`Check-in call to ${name} could not connect.`),
  };
}

/**
 * Consumes Sarvam post-call events (`sarvam.outbound` and `sarvam.inbound`) written by
 * Phase 2 `handleSarvam` and updates `calls`, `check_in_summaries`, signed `timeline_events`
 * (used by "Maa's day"), and triggers retry / Riya push escalation on unanswered attempts.
 */
export async function syncSarvamCheckInPostCalls(deps: CheckInServiceDeps): Promise<{
  projected: number;
  retriedOrEscalated: number;
}> {
  const encKey = deps.encryptionKeyHex ?? deps.env?.WEBHOOK_ENCRYPTION_KEY ?? process.env.WEBHOOK_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
    return { projected: 0, retriedOrEscalated: 0 };
  }

  const events = await deps.store.listUnprojectedSarvamEvents(25);
  let projected = 0;
  let retriedOrEscalated = 0;

  for (const ev of events) {
    const dedupeKey = `sarvam_summary:${ev.id}`;
    if (await deps.store.hasSummaryDedupe(ev.familyId, dedupeKey)) {
      continue;
    }

    let decrypted: Record<string, unknown>;
    try {
      decrypted = decryptCore1RawPayload(ev.payloadCiphertext, encKey, ev.source, ev.providerEventId);
    } catch {
      continue;
    }

    const personId = typeof ev.metadata.person_id === 'string'
      ? ev.metadata.person_id
      : typeof decrypted.person_id === 'string'
        ? decrypted.person_id
        : null;
    if (!personId) continue;

    const schedule = await deps.store.findPersonCheckInSchedule(ev.familyId, personId);
    const timezone = schedule?.timezone ?? DEFAULT_CHECKIN_TIMEZONE;
    const eventTime = new Date(Date.parse(ev.receivedAt) || getNow(deps).getTime());
    const localDate = getLocalDateString(eventTime, timezone);
    const displayName = await deps.store.getPersonDisplayName(ev.familyId, personId);
    const addressForm = formatParentAddressForm(displayName);

    const metaCallId = typeof ev.metadata.call_id === 'string' ? ev.metadata.call_id : null;
    const attemptId = typeof decrypted.attempt_id === 'string' ? decrypted.attempt_id : null;
    const interactionId = typeof decrypted.interaction_id === 'string' ? decrypted.interaction_id : null;

    let callRow: CheckInCallRow | null = null;
    if (metaCallId) {
      callRow = await deps.store.findCallById(ev.familyId, metaCallId);
    }
    if (!callRow && attemptId) {
      callRow = await deps.store.findCallByExternalId('sarvam', attemptId);
    }
    if (!callRow && ev.eventType === 'sarvam.inbound' && interactionId) {
      const existingInbound = await deps.store.findCallByExternalId('sarvam', interactionId);
      callRow =
        existingInbound ??
        (await deps.store.createInboundCallRow({
          id: stableCore1Uuid(['sarvam_inbound_call', ev.familyId, interactionId]),
          familyId: ev.familyId,
          personId,
          externalId: interactionId,
          status: 'completed',
          startedAt: typeof decrypted.started_at === 'string' ? decrypted.started_at : ev.receivedAt,
          endedAt: typeof decrypted.ended_at === 'string' ? decrypted.ended_at : ev.receivedAt,
        }));
    }

    const rawStatus =
      typeof ev.metadata.status === 'string'
        ? ev.metadata.status
        : typeof decrypted.status === 'string'
          ? decrypted.status
          : 'connected';
    const durationSeconds =
      typeof decrypted.duration_seconds === 'number' && Number.isFinite(decrypted.duration_seconds)
        ? decrypted.duration_seconds
        : null;
    const finalVars =
      decrypted.final_agent_variables && typeof decrypted.final_agent_variables === 'object'
        ? (decrypted.final_agent_variables as Record<string, unknown>)
        : null;
    const reviewRequired =
      typeof decrypted.review_required === 'string' ? decrypted.review_required : undefined;

    const summary = buildPostCallSummaryText({
      addressForm,
      eventType: ev.eventType,
      status: rawStatus,
      durationSeconds,
      variables: finalVars,
      reviewRequired,
    });

    if (callRow) {
      await deps.store.updateCallStatus({
        callId: callRow.id,
        status: summary.callStatus,
        startedAt: callRow.startedAt ?? ev.receivedAt,
        endedAt: ev.receivedAt,
      });
    }

    const bounds = buildDailyWindowBounds(eventTime, timezone);
    const todaysCalls = await deps.store.listCallsForPersonBetween(
      ev.familyId,
      personId,
      bounds.fromIso,
      bounds.toIso,
    );
    const attemptNumber = Math.max(
      1,
      Math.min(5, todaysCalls.filter((c) => c.provider === 'sarvam').length),
    );

    const inserted = await deps.store.upsertCheckInSummary({
      id: stableCore1Uuid(['checkin_summary', ev.familyId, ev.id]),
      familyId: ev.familyId,
      personId,
      callId: callRow?.id ?? null,
      scheduleId: schedule?.id ?? null,
      rawEventId: ev.id,
      localDate,
      attemptNumber,
      outcome: summary.outcome,
      shortSummary: summary.text,
      dedupeKey,
    });

    if (inserted) {
      projected++;
      if (callRow) {
        await deps.timeline.append({
          familyId: ev.familyId,
          eventType: summary.outcome === 'answered' ? 'check_in.completed' : 'check_in.attempt_failed',
          entityId: callRow.id,
          dedupeKey: `checkin_timeline_summary:${callRow.id}:${summary.outcome}`,
          humanLine: summary.text,
          payload: {
            callId: callRow.id,
            rawEventId: ev.id,
            outcome: summary.outcome,
            localDate,
            reviewRequired: reviewRequired ?? null,
          },
          occurredAt: ev.receivedAt,
        });
      }

      if (summary.outcome === 'answered' && schedule) {
        const preferredTime = formatPreferredTimeFromSchedule(schedule.nextAt, timezone);
        const tomorrowUtc = computeNextDayScheduledUtc(
          new Date(Date.parse(bounds.toIso) + 60_000),
          preferredTime,
          timezone,
        );
        await deps.store.updateScheduleNextAt(schedule.id, tomorrowUtc.toISOString(), true);
      } else if (summary.outcome !== 'answered' && schedule) {
        const failedCount = todaysCalls.filter((c) => c.provider === 'sarvam' && c.status === 'failed').length;
        const maxAttempts = (deps.retryPolicy ?? DEFAULT_RETRY_POLICY).maxAttempts;
        if (failedCount >= maxAttempts) {
          await notifyRiyaCheckInExhausted(deps, {
            familyId: ev.familyId,
            personId,
            personName: displayName,
            localDate,
            attemptsCount: failedCount,
          });
          retriedOrEscalated++;
        } else {
          const scale = parseDemoTimerScale(deps.env ?? process.env);
          const retryMs = scaleDurationMs((deps.retryPolicy ?? DEFAULT_RETRY_POLICY).retryIntervalMinutes * 60_000, scale);
          const nextTryAt = new Date(getNow(deps).getTime() + retryMs);
          await deps.store.updateScheduleNextAt(schedule.id, nextTryAt.toISOString(), true);
          retriedOrEscalated++;
        }
      }
    }
  }

  return { projected, retriedOrEscalated };
}

export function createSupabaseCheckInStore(db: SupabaseClientLike): CheckInStore {
  return {
    async verifyFamilyPerson(familyId, personId) {
      const { data } = await db
        .from('people')
        .select('id')
        .eq('family_id', familyId)
        .eq('id', personId)
        .maybeSingle();
      return Boolean(data);
    },

    async getPersonDisplayName(familyId, personId) {
      const { data } = await db
        .from('people')
        .select('display_name')
        .eq('family_id', familyId)
        .eq('id', personId)
        .maybeSingle();
      const raw = data && typeof (data as { display_name?: unknown }).display_name === 'string'
        ? (data as { display_name: string }).display_name
        : 'Meena Maa';
      return sanitizeNoDigitsRun(raw, 60);
    },

    async getCircleMember(familyId, personId) {
      const { data } = await db
        .from('circle')
        .select('id,family_id,person_id,rank,consent_at,revoked_at')
        .eq('family_id', familyId)
        .eq('person_id', personId)
        .maybeSingle();
      if (!data) return null;
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id),
        familyId: String(r.family_id),
        personId: String(r.person_id),
        rank: Number(r.rank),
        consentAt: r.consent_at ? String(r.consent_at) : null,
        revokedAt: r.revoked_at ? String(r.revoked_at) : null,
      };
    },

    async getLatestCheckInConsent(familyId, personId) {
      const { data } = await db
        .from('consents')
        .select('answer,created_at')
        .eq('family_id', familyId)
        .eq('person_id', personId)
        .in('purpose', ['daily_checkin', 'check_in', 'permission_setup'])
        .order('created_at', { ascending: false })
        .limit(1);
      const row = Array.isArray(data) ? (data[0] as { answer?: unknown; created_at?: unknown } | undefined) : undefined;
      if (!row) return { hasConsent: false };
      if (row.answer === true) {
        return { hasConsent: true, grantedAt: String(row.created_at) };
      }
      return { hasConsent: false, revokedAt: String(row.created_at) };
    },

    async getScheduleById(familyId, scheduleId) {
      const { data } = await db
        .from('schedules')
        .select('id,family_id,person_id,kind,next_at,timezone,enabled')
        .eq('family_id', familyId)
        .eq('id', scheduleId)
        .maybeSingle();
      if (!data) return null;
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id),
        familyId: String(r.family_id),
        personId: String(r.person_id),
        kind: String(r.kind),
        nextAt: String(r.next_at),
        timezone: String(r.timezone),
        enabled: r.enabled === true,
      };
    },

    async findPersonCheckInSchedule(familyId, personId) {
      const { data } = await db
        .from('schedules')
        .select('id,family_id,person_id,kind,next_at,timezone,enabled')
        .eq('family_id', familyId)
        .eq('person_id', personId)
        .in('kind', ['check_in', 'daily_checkin'])
        .order('next_at', { ascending: true })
        .limit(1);
      const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
      if (!row) return null;
      return {
        id: String(row.id),
        familyId: String(row.family_id),
        personId: String(row.person_id),
        kind: String(row.kind),
        nextAt: String(row.next_at),
        timezone: String(row.timezone),
        enabled: row.enabled === true,
      };
    },

    async upsertSchedule(params) {
      if (params.id) {
        const { data, error } = await db
          .from('schedules')
          .update({
            next_at: params.nextAt,
            timezone: params.timezone,
            enabled: params.enabled,
          })
          .eq('family_id', params.familyId)
          .eq('id', params.id)
          .select('id,family_id,person_id,kind,next_at,timezone,enabled')
          .single();
        if (error || !data) throw new Core1CommandError('schedule_update_failed', 503);
        const r = data as Record<string, unknown>;
        return {
          id: String(r.id),
          familyId: String(r.family_id),
          personId: String(r.person_id),
          kind: String(r.kind),
          nextAt: String(r.next_at),
          timezone: String(r.timezone),
          enabled: r.enabled === true,
        };
      }

      const { data, error } = await db
        .from('schedules')
        .insert({
          family_id: params.familyId,
          person_id: params.personId,
          kind: 'check_in',
          next_at: params.nextAt,
          timezone: params.timezone,
          enabled: params.enabled,
        })
        .select('id,family_id,person_id,kind,next_at,timezone,enabled')
        .single();
      if (error || !data) throw new Core1CommandError('schedule_create_failed', 503);
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id),
        familyId: String(r.family_id),
        personId: String(r.person_id),
        kind: String(r.kind),
        nextAt: String(r.next_at),
        timezone: String(r.timezone),
        enabled: r.enabled === true,
      };
    },

    async updateScheduleNextAt(scheduleId, nextAt, enabled) {
      const updateObj: Record<string, unknown> = { next_at: nextAt };
      if (typeof enabled === 'boolean') updateObj.enabled = enabled;
      await db.from('schedules').update(updateObj).eq('id', scheduleId);
    },

    async listDueSchedules(nowIso, limit = 25) {
      const { data } = await db
        .from('schedules')
        .select('id,family_id,person_id,kind,next_at,timezone,enabled')
        .in('kind', ['check_in', 'daily_checkin'])
        .eq('enabled', true)
        .lte('next_at', nowIso)
        .order('next_at', { ascending: true })
        .limit(limit);
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        familyId: String(r.family_id),
        personId: String(r.person_id),
        kind: String(r.kind),
        nextAt: String(r.next_at),
        timezone: String(r.timezone),
        enabled: r.enabled === true,
      }));
    },

    async listCallsForPersonBetween(familyId, personId, fromIso, toIso) {
      const { data } = await db
        .from('calls')
        .select('id,family_id,person_id,provider,external_id,status,ai_disclosed_at,started_at,ended_at,created_at')
        .eq('family_id', familyId)
        .eq('person_id', personId)
        .gte('created_at', fromIso)
        .lt('created_at', toIso)
        .order('created_at', { ascending: true });
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        familyId: String(r.family_id),
        personId: String(r.person_id),
        provider: String(r.provider),
        externalId: typeof r.external_id === 'string' ? r.external_id : null,
        status: r.status as CheckInCallRow['status'],
        aiDisclosedAt: typeof r.ai_disclosed_at === 'string' ? r.ai_disclosed_at : null,
        startedAt: typeof r.started_at === 'string' ? r.started_at : null,
        endedAt: typeof r.ended_at === 'string' ? r.ended_at : null,
        createdAt: String(r.created_at),
      }));
    },

    async findCallByExternalId(provider, externalId) {
      const { data } = await db
        .from('calls')
        .select('id,family_id,person_id,provider,external_id,status,ai_disclosed_at,started_at,ended_at,created_at')
        .eq('provider', provider)
        .eq('external_id', externalId)
        .maybeSingle();
      if (!data) return null;
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id),
        familyId: String(r.family_id),
        personId: String(r.person_id),
        provider: String(r.provider),
        externalId: typeof r.external_id === 'string' ? r.external_id : null,
        status: r.status as CheckInCallRow['status'],
        aiDisclosedAt: typeof r.ai_disclosed_at === 'string' ? r.ai_disclosed_at : null,
        startedAt: typeof r.started_at === 'string' ? r.started_at : null,
        endedAt: typeof r.ended_at === 'string' ? r.ended_at : null,
        createdAt: String(r.created_at),
      };
    },

    async findCallById(familyId, callId) {
      const { data } = await db
        .from('calls')
        .select('id,family_id,person_id,provider,external_id,status,ai_disclosed_at,started_at,ended_at,created_at')
        .eq('family_id', familyId)
        .eq('id', callId)
        .maybeSingle();
      if (!data) return null;
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id),
        familyId: String(r.family_id),
        personId: String(r.person_id),
        provider: String(r.provider),
        externalId: typeof r.external_id === 'string' ? r.external_id : null,
        status: r.status as CheckInCallRow['status'],
        aiDisclosedAt: typeof r.ai_disclosed_at === 'string' ? r.ai_disclosed_at : null,
        startedAt: typeof r.started_at === 'string' ? r.started_at : null,
        endedAt: typeof r.ended_at === 'string' ? r.ended_at : null,
        createdAt: String(r.created_at),
      };
    },

    async createInboundCallRow(params) {
      const { data, error } = await db
        .from('calls')
        .insert({
          id: params.id,
          family_id: params.familyId,
          person_id: params.personId,
          provider: 'sarvam',
          external_id: params.externalId,
          status: params.status,
          ai_disclosed_at: params.startedAt ?? new Date().toISOString(),
          started_at: params.startedAt,
          ended_at: params.endedAt,
        })
        .select('id,family_id,person_id,provider,external_id,status,ai_disclosed_at,started_at,ended_at,created_at')
        .single();
      if (error || !data) throw new Core1CommandError('inbound_call_insert_failed', 503);
      const r = data as Record<string, unknown>;
      return {
        id: String(r.id),
        familyId: String(r.family_id),
        personId: String(r.person_id),
        provider: String(r.provider),
        externalId: typeof r.external_id === 'string' ? r.external_id : null,
        status: r.status as CheckInCallRow['status'],
        aiDisclosedAt: typeof r.ai_disclosed_at === 'string' ? r.ai_disclosed_at : null,
        startedAt: typeof r.started_at === 'string' ? r.started_at : null,
        endedAt: typeof r.ended_at === 'string' ? r.ended_at : null,
        createdAt: String(r.created_at),
      };
    },

    async updateCallStatus(params) {
      const patch: Record<string, unknown> = { status: params.status };
      if (params.startedAt) patch.started_at = params.startedAt;
      if (params.endedAt) patch.ended_at = params.endedAt;
      await db.from('calls').update(patch).eq('id', params.callId);
    },

    async prepareCheckInDispatch(params) {
      const { data, error } = await db.rpc('prepare_checkin_dispatch', {
        p_family_id: params.familyId,
        p_person_id: params.personId,
        p_dedupe_key: params.dedupeKey,
        p_payload_ciphertext: params.payloadCiphertext,
        p_payload_hash: params.payloadHash,
      });
      if (error || !data) {
        return { status: 'denied', reason: 'prepare_dispatch_failed' };
      }
      const d = data as Record<string, unknown>;
      return {
        status: (d.status as 'ready' | 'existing' | 'denied') ?? 'denied',
        outboxId: typeof d.outbox_id === 'string' ? d.outbox_id : undefined,
        callId: typeof d.call_id === 'string' ? d.call_id : undefined,
        actionRequestId: typeof d.action_request_id === 'string' ? d.action_request_id : undefined,
        reason: typeof d.reason === 'string' ? d.reason : undefined,
      };
    },

    async claimOutboxForDirectDispatch(outboxId, workerId) {
      return claimOutboxRowForDirectDispatch(db, outboxId, workerId);
    },

    async finishOutboxDispatch(outboxId, leaseToken, success, errorCode) {
      await db.rpc('finish_outbox', {
        p_outbox_id: outboxId,
        p_lease_token: leaseToken,
        p_success: success,
        p_error_code: errorCode ?? null,
      });
    },

    async listChildPushTokens(familyId) {
      return listFamilyChildPushTokens(db, familyId);
    },

    async recordNudge(params) {
      await db.from('nudges').upsert(
        {
          id: params.id,
          family_id: params.familyId,
          person_id: params.personId,
          kind: params.kind,
          scheduled_at: params.scheduledAt,
          status: 'sent',
        },
        { onConflict: 'id' },
      );
    },

    async recordChildAlert(params) {
      await db.from('child_alerts').upsert(
        {
          id: params.id,
          family_id: params.familyId,
          person_id: params.personId,
          kind: params.kind,
        },
        { onConflict: 'id' },
      );
    },

    async upsertCheckInSummary(record) {
      const { error } = await db.from('check_in_summaries').insert({
        id: record.id,
        family_id: record.familyId,
        person_id: record.personId,
        call_id: record.callId,
        schedule_id: record.scheduleId,
        raw_event_id: record.rawEventId,
        local_date: record.localDate,
        attempt_number: record.attemptNumber,
        outcome: record.outcome,
        short_summary: record.shortSummary,
        dedupe_key: record.dedupeKey,
      });
      if (!error) return true;
      if (error.code === '23505') return false;
      throw new Core1CommandError('checkin_summary_insert_failed', 503);
    },

    async hasSummaryDedupe(familyId, dedupeKey) {
      const { data } = await db
        .from('check_in_summaries')
        .select('id')
        .eq('family_id', familyId)
        .eq('dedupe_key', dedupeKey)
        .maybeSingle();
      return Boolean(data);
    },

    async listUnprojectedSarvamEvents(limit = 25) {
      const { data } = await db
        .from('raw_events')
        .select('id,family_id,source,provider_event_id,event_type,metadata,payload_ciphertext,received_at')
        .eq('source', 'sarvam')
        .in('event_type', ['sarvam.outbound', 'sarvam.inbound'])
        .not('family_id', 'is', null)
        .not('payload_ciphertext', 'is', null)
        .order('received_at', { ascending: true })
        .limit(limit);

      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        familyId: String(r.family_id),
        source: String(r.source),
        providerEventId: String(r.provider_event_id),
        eventType: String(r.event_type),
        metadata: (r.metadata ?? {}) as Record<string, unknown>,
        payloadCiphertext: String(r.payload_ciphertext),
        receivedAt: String(r.received_at),
      }));
    },

    async findCommandDedupe(familyId, dedupeKey) {
      const { data } = await db
        .from('raw_events')
        .select('metadata')
        .eq('family_id', familyId)
        .eq('source', 'core1_api')
        .eq('provider_event_id', dedupeKey)
        .maybeSingle();
      if (!data) return null;
      const meta = (data as { metadata?: Record<string, unknown> }).metadata;
      if (!meta || typeof meta.payload_hash !== 'string' || !meta.result || typeof meta.result !== 'object') {
        return null;
      }
      return {
        payloadHash: meta.payload_hash,
        result: meta.result as Record<string, unknown>,
      };
    },

    async saveCommandDedupe(params) {
      await db.from('raw_events').insert({
        id: params.eventId,
        family_id: params.familyId,
        source: 'core1_api',
        provider_event_id: params.dedupeKey,
        event_type: 'check_in',
        status: 'processed',
        processed_at: new Date().toISOString(),
        metadata: {
          payload_hash: params.payloadHash,
          result: params.result,
        },
      });
    },
  };
}

export function createSupabaseCheckInDispatchRuntime(
  db: SupabaseClientLike,
  env: Record<string, string | undefined> = process.env,
  transport: FetchTransport = globalThis.fetch as FetchTransport,
): CheckInDispatchRuntime | null {
  const {
    SARVAM_API_KEY: apiKey,
    SARVAM_ORG_ID: orgId,
    SARVAM_WORKSPACE_ID: workspaceId,
    SARVAM_APP_ID: appId,
    SARVAM_APP_VERSION: appVersionRaw,
    SARVAM_CONNECTION_ID: connectionId,
    SARVAM_AGENT_NUMBER: agentPhoneNumber,
    SARVAM_OUTBOUND_WEBHOOK_URL: webhookUrl,
    CONTACT_ENCRYPTION_KEY: contactKey,
    IDENTITY_HASH_SECRET: identitySecret,
  } = env;

  const appVersion = Number(appVersionRaw ?? '1');
  if (
    !apiKey ||
    !orgId ||
    !workspaceId ||
    !appId ||
    !Number.isSafeInteger(appVersion) ||
    !connectionId ||
    !agentPhoneNumber ||
    !webhookUrl ||
    !contactKey ||
    !identitySecret
  ) {
    return null;
  }

  const store = dispatchStore(db as unknown as Parameters<typeof dispatchStore>[0]);
  const resolveDestination = createContactResolver(
    db as unknown as Parameters<typeof createContactResolver>[0],
    {
      encryptionKeyHex: contactKey,
      identitySecret,
      accounts: { sarvam: appId },
    },
  );

  const authorize = createSupabaseDispatchAuthorizer(db);

  return {
    deps: {
      store,
      authorize,
      transport,
      identitySecret,
      resolveDestination,
      providers: {
        sarvam: {
          apiKey,
          orgId,
          workspaceId,
          appId,
          appVersion,
          connectionId,
          agentPhoneNumber,
          webhookUrl,
        },
      },
    },
  };
}

export function createProductionCheckInDeps(
  env: Record<string, string | undefined> = process.env,
): CheckInServiceDeps {
  const db = serviceDatabase();
  return {
    auth: createSupabaseCore1AuthPort(db),
    store: createSupabaseCheckInStore(db),
    timeline: createSupabaseCore1TimelinePort(
      db,
      env.TIMELINE_SIGNING_PRIVATE_KEY ?? env.SIGNING_PRIVATE_KEY,
      env.TIMELINE_SIGNING_KEY_ID ?? env.SIGNING_KEY_ID ?? 'core1-default',
    ),
    dispatch: createSupabaseCheckInDispatchRuntime(db, env),
    encryptionKeyHex: env.WEBHOOK_ENCRYPTION_KEY,
    env,
  };
}
