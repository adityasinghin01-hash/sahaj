import { groupMissedCalls } from '../../../../../packages/atlas/src/core1/missed-calls';
import type {
  MissedCallEvent,
  MissedCallNudgeIntent,
  MissedCallTier,
} from '../../../../../packages/atlas/src/core1/types';
import { Core1CommandError } from './errors';
import { assertCommandCapability } from './capabilities';
import {
  validateMissedCallNudgePayload,
  extractIdempotencyKey,
  validateUuid,
} from './validation';
import {
  clockAt,
  createSupabaseCore1AuthPort,
  createSupabaseCore1OutboxPort,
  createSupabaseCore1TimelinePort,
  decryptCore1RawPayload,
  parseOptionalFamilyId,
  readCore1JsonRequest,
  sha256Hex,
  stableCore1Uuid,
  toFamilyMembership,
  type Core1AuthPort,
  type Core1OutboxPort,
  type Core1TimelinePort,
  type SupabaseClientLike,
} from './wiring-common';
import { serviceDatabase } from '../database';

export interface PushTarget {
  userId: string;
  expoToken: string;
}

export interface MissedCallNudgeStore {
  verifyFamilyPerson(familyId: string, personId: string): Promise<boolean>;
  findDefaultChildRecipient(familyId: string): Promise<string | null>;
  listPushTokens(familyId: string, personId: string): Promise<string[]>;
  listRecentCallsInWindow(
    familyId: string,
    callerPersonId: string,
    recipientPersonId: string,
    sinceIso: string,
  ): Promise<MissedCallEvent[]>;
  hasProcessedCallKey(dedupeKey: string, familyId: string): Promise<boolean>;
  recordNudge(input: {
    id: string;
    familyId: string;
    recipientPersonId: string;
    kind: string;
    scheduledAt: string;
  }): Promise<{ nudgeId: string }>;
  recordChildAlert(input: {
    id: string;
    familyId: string;
    recipientPersonId: string;
    kind: string;
  }): Promise<void>;
  listPendingTeleCmiRawEvents(familyId: string): Promise<
    Array<{
      id: string;
      familyId: string;
      source: string;
      providerEventId: string;
      callerPersonId: string | null;
      payloadCiphertext: string;
      receivedAt: string;
    }>
  >;
  markRawEventProcessed(rawEventId: string): Promise<void>;
}

export interface MissedCallNudgeDeps {
  auth: Core1AuthPort;
  store: MissedCallNudgeStore;
  outbox: Core1OutboxPort;
  timeline: Core1TimelinePort;
  encryptionKeyHex?: string;
  now?: () => Date;
  windowSeconds?: number;
}

export interface NudgeCopy {
  title: string;
  body: string;
  englishHint: string;
}

/**
 * Formats Maa -> Riya push notification copy by missed-call tier.
 * WhatsApp is intentionally excluded across all tiers; delivery uses app push + outbox only.
 */
export function formatMissedCallPushCopy(tier: MissedCallTier, callCount: number): NudgeCopy {
  if (tier === 'single') {
    return {
      title: 'Maa missed call',
      body: 'Maa ne missed call di — free ho toh call karo',
      englishHint: 'Call me when free',
    };
  }
  if (tier === 'repeated') {
    return {
      title: 'Maa called again',
      body: `Maa ne ${callCount} missed calls diye — free ho toh call karo`,
      englishHint: 'Repeated missed calls — call when free',
    };
  }
  return {
    title: 'Urgent: Maa missed calls',
    body: `Urgent: Maa ne ${callCount} missed calls diye — abhi call karo`,
    englishHint: 'Urgent — multiple missed calls',
  };
}

export function buildCallDedupeKey(event: MissedCallEvent): string {
  const account = event.providerAccountId ?? 'default';
  return `telecmi_call:${event.familyId}:${event.recipientPersonId}:${account}:${event.providerCallId}`;
}

export function buildNudgeOutboxDedupeKey(intent: MissedCallNudgeIntent, account = 'default'): string {
  const sortedIds = [...intent.callIds].sort().join(',');
  const clusterDigest = sha256Hex(`${account}|${intent.tier}|${sortedIds}`).slice(0, 24);
  return `missed_call_push:${intent.familyId}:${intent.recipientPersonId}:${clusterDigest}`;
}

export function createSupabaseMissedCallNudgeStore(db: SupabaseClientLike): MissedCallNudgeStore {
  return {
    async verifyFamilyPerson(familyId, personId) {
      const { data, error } = await db
        .from('people')
        .select('id,active')
        .eq('family_id', familyId)
        .eq('id', personId)
        .maybeSingle();
      if (error) throw new Core1CommandError('person_lookup_failed', 503);
      return Boolean(data && (data as { active?: boolean }).active !== false);
    },

    async findDefaultChildRecipient(familyId) {
      const { data, error } = await db
        .from('family_memberships')
        .select('person_id,role,created_at')
        .eq('family_id', familyId)
        .eq('role', 'child')
        .is('revoked_at', null)
        .order('created_at', { ascending: true })
        .limit(1);
      if (error) throw new Core1CommandError('recipient_lookup_failed', 503);
      const row = (data ?? [])[0] as { person_id?: string } | undefined;
      return row?.person_id ?? null;
    },

    async listPushTokens(familyId, personId) {
      const { data: memberships, error: memErr } = await db
        .from('family_memberships')
        .select('auth_user_id')
        .eq('family_id', familyId)
        .eq('person_id', personId)
        .is('revoked_at', null);
      if (memErr) throw new Core1CommandError('push_token_lookup_failed', 503);
      const userIds = (memberships ?? [])
        .map((m: Record<string, unknown>) => m.auth_user_id)
        .filter((v): v is string => typeof v === 'string');
      if (userIds.length === 0) return [];

      const { data: tokens, error: tokErr } = await db
        .from('app_push_tokens')
        .select('expo_token')
        .eq('family_id', familyId)
        .in('user_id', userIds);
      if (tokErr) throw new Core1CommandError('push_token_lookup_failed', 503);
      return (tokens ?? [])
        .map((t: Record<string, unknown>) => t.expo_token)
        .filter((v): v is string => typeof v === 'string');
    },

    async listRecentCallsInWindow(familyId, callerPersonId, recipientPersonId, sinceIso) {
      const { data, error } = await db
        .from('raw_events')
        .select('provider_event_id,metadata,received_at')
        .eq('family_id', familyId)
        .eq('event_type', 'telecmi.missed_call')
        .gte('received_at', sinceIso);
      if (error) throw new Core1CommandError('missed_call_history_failed', 503);
      const events: MissedCallEvent[] = [];
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const meta = (row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) as Record<string, unknown>;
        const metaCaller = typeof meta.person_id === 'string' ? meta.person_id : callerPersonId;
        const metaRecipient = typeof meta.recipient_person_id === 'string' ? meta.recipient_person_id : recipientPersonId;
        if (metaCaller !== callerPersonId || metaRecipient !== recipientPersonId) continue;
        const callId = typeof meta.call_id === 'string' ? meta.call_id : String(row.provider_event_id ?? '');
        if (!callId) continue;
        events.push({
          providerCallId: callId,
          providerAccountId: typeof meta.app_id === 'string' || typeof meta.app_id === 'number' ? String(meta.app_id) : 'telecmi',
          familyId,
          callerPersonId,
          recipientPersonId,
          timestamp: typeof meta.occurred_at === 'string' ? meta.occurred_at : String(row.received_at),
        });
      }
      return events;
    },

    async hasProcessedCallKey(dedupeKey, familyId) {
      const { data, error } = await db
        .from('timeline_events')
        .select('id')
        .eq('family_id', familyId)
        .eq('dedupe_key', dedupeKey)
        .maybeSingle();
      if (error) throw new Core1CommandError('dedupe_lookup_failed', 503);
      return Boolean(data);
    },

    async recordNudge(input) {
      const { data, error } = await db
        .from('nudges')
        .insert({
          id: input.id,
          family_id: input.familyId,
          person_id: input.recipientPersonId,
          kind: input.kind,
          scheduled_at: input.scheduledAt,
          status: 'pending',
        })
        .select('id')
        .single();
      if (error || !data) throw new Core1CommandError('nudge_persist_failed', 503);
      return { nudgeId: String((data as { id: string }).id) };
    },

    async recordChildAlert(input) {
      const { error } = await db.from('child_alerts').insert({
        id: input.id,
        family_id: input.familyId,
        person_id: input.recipientPersonId,
        incident_id: null,
        kind: input.kind,
      });
      if (error) throw new Core1CommandError('child_alert_persist_failed', 503);
    },

    async listPendingTeleCmiRawEvents(familyId) {
      const { data, error } = await db
        .from('raw_events')
        .select('id,family_id,source,provider_event_id,payload_ciphertext,metadata,received_at,status')
        .eq('family_id', familyId)
        .eq('source', 'telecmi')
        .eq('event_type', 'telecmi.missed_call')
        .eq('status', 'pending')
        .order('received_at', { ascending: true });
      if (error) throw new Core1CommandError('raw_event_lookup_failed', 503);
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
        const meta = (r.metadata && typeof r.metadata === 'object' ? r.metadata : {}) as Record<string, unknown>;
        return {
          id: String(r.id),
          familyId: String(r.family_id),
          source: String(r.source),
          providerEventId: String(r.provider_event_id),
          callerPersonId: typeof meta.person_id === 'string' ? meta.person_id : null,
          payloadCiphertext: String(r.payload_ciphertext),
          receivedAt: String(r.received_at),
        };
      });
    },

    async markRawEventProcessed(rawEventId) {
      const { error } = await db
        .from('raw_events')
        .update({ status: 'processed', processed_at: new Date().toISOString() })
        .eq('id', rawEventId);
      if (error) throw new Core1CommandError('raw_event_update_failed', 503);
    },
  };
}

export async function dispatchMissedCallCluster(
  intent: MissedCallNudgeIntent,
  account: string,
  deps: MissedCallNudgeDeps,
) {
  const outboxDedupeKey = buildNudgeOutboxDedupeKey(intent, account);
  const nudgeId = stableCore1Uuid(['core1-nudge', outboxDedupeKey]);
  const alertId = stableCore1Uuid(['core1-child-alert', outboxDedupeKey]);
  const pushCopy = formatMissedCallPushCopy(intent.tier, intent.callCount);
  const expoTokens = await deps.store.listPushTokens(intent.familyId, intent.recipientPersonId);

  const outboxRes = await deps.outbox.enqueue({
    familyId: intent.familyId,
    kind: 'core1.missed_call_push',
    action: 'missed_call_nudge',
    dedupeKey: outboxDedupeKey,
    payload: {
      channel: 'app_push',
      whatsappDropped: true,
      familyId: intent.familyId,
      callerPersonId: intent.callerPersonId,
      recipientPersonId: intent.recipientPersonId,
      tier: intent.tier,
      urgency: intent.proposedNudge.urgency,
      kind: intent.proposedNudge.kind,
      callCount: intent.callCount,
      callIds: intent.callIds,
      expoTokens,
      notification: {
        title: pushCopy.title,
        body: pushCopy.body,
        englishHint: pushCopy.englishHint,
      },
    },
  });

  if (!outboxRes.deduped) {
    await deps.store.recordNudge({
      id: nudgeId,
      familyId: intent.familyId,
      recipientPersonId: intent.recipientPersonId,
      kind: intent.proposedNudge.kind,
      scheduledAt: intent.proposedNudge.scheduledAt,
    });
    await deps.store.recordChildAlert({
      id: alertId,
      familyId: intent.familyId,
      recipientPersonId: intent.recipientPersonId,
      kind: intent.proposedNudge.kind,
    });
  }

  const timelineRes = await deps.timeline.append({
    familyId: intent.familyId,
    eventType: `core1.missed_call_nudge.${intent.tier}`,
    entityId: nudgeId,
    humanLine: `Missed call nudge queued (${intent.tier}, ${intent.callCount} call${intent.callCount === 1 ? '' : 's'}): ${pushCopy.body}`,
    payload: {
      nudgeId,
      outboxId: outboxRes.outboxId,
      channel: 'app_push',
      tier: intent.tier,
      urgency: intent.proposedNudge.urgency,
      callCount: intent.callCount,
      callIds: intent.callIds,
    },
    dedupeKey: `timeline:${outboxDedupeKey}`,
    occurredAt: (deps.now ?? (() => new Date()))().toISOString(),
  });

  return {
    nudgeId,
    outboxId: outboxRes.outboxId,
    deduped: outboxRes.deduped,
    channel: 'app_push' as const,
    tier: intent.tier,
    urgency: intent.proposedNudge.urgency,
    kind: intent.proposedNudge.kind,
    callCount: intent.callCount,
    callIds: intent.callIds,
    expoTokensCount: expoTokens.length,
    notification: pushCopy,
    timelineSequence: timelineRes.sequence,
  };
}

/**
 * Handles POST /api/core1/missed-call-nudge:
 * Authenticates caller/member, enforces family scoping & dedupe per
 * (familyId, recipientPersonId, providerAccountId, providerCallId),
 * clusters within window using `@sahaj/atlas` `groupMissedCalls`,
 * and dispatches Riya app-push via outbox (no WhatsApp).
 */
export async function executeMissedCallNudgeCommand(
  request: Request,
  deps: MissedCallNudgeDeps,
): Promise<Response> {
  try {
    const body = await readCore1JsonRequest(request);
    const idempotencyKey = extractIdempotencyKey(request, body);
    const requestedFamilyId = parseOptionalFamilyId(request, body);

    const sanitizedBody = { ...body };
    delete sanitizedBody.familyId;
    delete sanitizedBody.family_id;
    delete sanitizedBody.idempotencyKey;
    delete sanitizedBody.idempotency_key;

    const payload = validateMissedCallNudgePayload(sanitizedBody);
    const actor = await deps.auth.authenticate(request, requestedFamilyId);
    assertCommandCapability('missed_call_nudge', toFamilyMembership(actor), null);

    const [callerOk, recipientOk] = await Promise.all([
      deps.store.verifyFamilyPerson(actor.familyId, payload.callerPersonId),
      deps.store.verifyFamilyPerson(actor.familyId, payload.recipientPersonId),
    ]);
    if (!callerOk || !recipientOk) {
      throw new Core1CommandError('forbidden_cross_family_target', 403);
    }

    const nowDate = (deps.now ?? (() => new Date()))();
    const clock = clockAt(nowDate);
    const windowSeconds = deps.windowSeconds ?? 20;
    const occurredAt = payload.timestamp ?? nowDate.toISOString();
    const account = payload.providerAccountId ?? 'default';

    const incomingEvent: MissedCallEvent = {
      providerCallId: payload.providerCallId,
      providerAccountId: account,
      familyId: actor.familyId,
      callerPersonId: payload.callerPersonId,
      recipientPersonId: payload.recipientPersonId,
      timestamp: occurredAt,
    };

    const callDedupeKey = buildCallDedupeKey(incomingEvent);
    const alreadySeenCall = await deps.store.hasProcessedCallKey(callDedupeKey, actor.familyId);
    if (alreadySeenCall) {
      return Response.json(
        {
          status: 'deduped',
          commandType: 'missed_call_nudge',
          channel: 'app_push',
          providerCallId: payload.providerCallId,
          idempotencyKey,
        },
        { status: 200 },
      );
    }

    const sinceIso = new Date(new Date(occurredAt).getTime() - windowSeconds * 1000).toISOString();
    const priorCalls = await deps.store.listRecentCallsInWindow(
      actor.familyId,
      payload.callerPersonId,
      payload.recipientPersonId,
      sinceIso,
    );

    const grouped = groupMissedCalls([...priorCalls, incomingEvent], {
      windowSeconds,
      clock,
    });

    const targetCluster =
      grouped.clusters.find((c) => c.callIds.includes(payload.providerCallId)) ??
      grouped.clusters[grouped.clusters.length - 1];

    if (!targetCluster) {
      throw new Core1CommandError('missed_call_clustering_failed', 500);
    }

    const dispatched = await dispatchMissedCallCluster(targetCluster, account, deps);

    await deps.timeline.append({
      familyId: actor.familyId,
      eventType: 'core1.missed_call.ingested',
      entityId: dispatched.nudgeId,
      humanLine: `Processed missed call nudge (${dispatched.tier})`,
      payload: {
        providerCallId: payload.providerCallId,
        providerAccountId: account,
        nudgeId: dispatched.nudgeId,
      },
      dedupeKey: callDedupeKey,
      occurredAt,
    });

    return Response.json(
      {
        status: dispatched.deduped ? 'deduped' : 'queued',
        commandType: 'missed_call_nudge',
        ...dispatched,
        idempotencyKey,
      },
      { status: dispatched.deduped ? 200 : 202 },
    );
  } catch (error) {
    if (error instanceof Core1CommandError) {
      return Response.json({ error: error.code }, { status: error.status });
    }
    return Response.json({ error: 'internal_command_error' }, { status: 500 });
  }
}

/**
 * Processes pending `telecmi.missed_call` raw_events ingested via `/api/missed-call/[secret]`
 * through Core 1's domain grouping and Riya app-push outbox pipeline (no WhatsApp).
 */
export async function processTeleCmiRawMissedCallsForFamily(
  familyId: string,
  deps: Pick<MissedCallNudgeDeps, 'store' | 'outbox' | 'timeline' | 'encryptionKeyHex' | 'now' | 'windowSeconds'>,
) {
  validateUuid(familyId, 'family_id');
  const pending = await deps.store.listPendingTeleCmiRawEvents(familyId);
  if (pending.length === 0) {
    return { processed: 0, clusters: [] };
  }
  const defaultChild = await deps.store.findDefaultChildRecipient(familyId);
  if (!defaultChild) {
    throw new Core1CommandError('child_recipient_not_found', 422);
  }

  const events: MissedCallEvent[] = [];
  const rawIdsByCallKey = new Map<string, string[]>();
  const keyHex = deps.encryptionKeyHex;

  for (const row of pending) {
    if (!row.callerPersonId) continue;
    let occurredAt = row.receivedAt;
    let callId = row.providerEventId;
    let account = 'telecmi';
    if (keyHex && /^[0-9a-fA-F]{64}$/.test(keyHex)) {
      try {
        const plain = decryptCore1RawPayload(
          row.payloadCiphertext,
          keyHex,
          row.source,
          row.providerEventId,
        );
        if (typeof plain.call_id === 'string') callId = plain.call_id;
        if (typeof plain.app_id === 'string' || typeof plain.app_id === 'number') {
          account = String(plain.app_id);
        }
        if (typeof plain.occurred_at === 'string') occurredAt = plain.occurred_at;
      } catch {
        // Skip unreadable payload safely without inventing data.
        continue;
      }
    }
    const event: MissedCallEvent = {
      providerCallId: callId,
      providerAccountId: account,
      familyId,
      callerPersonId: row.callerPersonId,
      recipientPersonId: defaultChild,
      timestamp: occurredAt,
    };
    const key = buildCallDedupeKey(event);
    if (await deps.store.hasProcessedCallKey(key, familyId)) {
      await deps.store.markRawEventProcessed(row.id);
      continue;
    }
    events.push(event);
    const list = rawIdsByCallKey.get(key) ?? [];
    list.push(row.id);
    rawIdsByCallKey.set(key, list);
  }

  if (events.length === 0) {
    return { processed: 0, clusters: [] };
  }

  const nowDate = (deps.now ?? (() => new Date()))();
  const clock = clockAt(nowDate);
  const grouped = groupMissedCalls(events, {
    windowSeconds: deps.windowSeconds ?? 20,
    clock,
  });

  const results = [];
  const fullDeps: MissedCallNudgeDeps = {
    ...deps,
    auth: {
      authenticate: async () => {
        throw new Core1CommandError('internal_only', 500);
      },
    },
  };

  for (const cluster of grouped.clusters) {
    const matchingEvent = events.find((e) => cluster.callIds.includes(e.providerCallId));
    const account = matchingEvent?.providerAccountId ?? 'telecmi';
    const dispatched = await dispatchMissedCallCluster(cluster, account, fullDeps);
    results.push(dispatched);

    for (const cid of cluster.callIds) {
      const ev = events.find((e) => e.providerCallId === cid);
      if (!ev) continue;
      const callKey = buildCallDedupeKey(ev);
      await deps.timeline.append({
        familyId,
        eventType: 'core1.missed_call.ingested',
        entityId: dispatched.nudgeId,
        humanLine: `TeleCMI missed call ingested (${dispatched.tier})`,
        payload: { providerCallId: cid, providerAccountId: account, nudgeId: dispatched.nudgeId },
        dedupeKey: callKey,
        occurredAt: ev.timestamp,
      });
      const rawIds = rawIdsByCallKey.get(callKey) ?? [];
      for (const rawId of rawIds) {
        await deps.store.markRawEventProcessed(rawId);
      }
    }
  }

  return { processed: events.length, clusters: results };
}

export function createProductionMissedCallNudgeDeps(
  env: Record<string, string | undefined> = process.env,
): MissedCallNudgeDeps {
  const db = serviceDatabase();
  const encryptionKeyHex = env.WEBHOOK_ENCRYPTION_KEY;
  return {
    auth: createSupabaseCore1AuthPort(db),
    store: createSupabaseMissedCallNudgeStore(db),
    outbox: createSupabaseCore1OutboxPort(db, encryptionKeyHex),
    timeline: createSupabaseCore1TimelinePort(
      db,
      env.TIMELINE_SIGNING_PRIVATE_KEY ?? env.SIGNING_PRIVATE_KEY,
      env.TIMELINE_SIGNING_KEY_ID ?? env.SIGNING_KEY_ID ?? 'core1-default',
    ),
    encryptionKeyHex,
  };
}
