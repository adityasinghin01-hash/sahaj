import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceDatabase } from '@/lib/database';
import { Core1CommandError } from '@/lib/core1/errors';
import { createDefaultAuthPort } from '@/lib/core1/handler';
import { createSupabaseCore1Repository } from '@/lib/core1/repository';
import { defaultSendExpoPush } from '@/lib/core1/voice-notify';
import { createSupabaseVoiceTimelinePort } from '@/lib/core1/voice-auth';
import { createSupabaseCore1OutboxPort } from '@/lib/core1/wiring-common';
import { isValidUuid, validateUuid } from '@/lib/core1/validation';
import { normalizeQuietWindows, resolveSafeTimeZone } from './matcher';
import type {
  Core1MatcherDeps,
  Core1MatcherStore,
  FreeWindowKind,
  FreeWindowRecord,
  FreeWindowSource,
  MatcherAuthPort,
  MatcherNudgeLogRecord,
  PersonScheduleContext,
} from './types';

function mapWindowRow(row: Record<string, unknown>): FreeWindowRecord {
  return {
    id: String(row.id),
    familyId: String(row.family_id),
    personId: String(row.person_id),
    timezone: resolveSafeTimeZone(typeof row.timezone === 'string' ? row.timezone : 'Asia/Kolkata'),
    startMinute: Number(row.start_minute),
    endMinute: Number(row.end_minute),
    kind: row.kind === 'ad_hoc' ? 'ad_hoc' : 'recurring',
    daysOfWeek: Array.isArray(row.days_of_week)
      ? row.days_of_week.map((n) => Number(n)).filter((n) => Number.isInteger(n))
      : null,
    expiresAt: typeof row.expires_at === 'string' ? row.expires_at : null,
    source: (['app', 'sarvam_checkin', 'free_now'].includes(String(row.source))
      ? String(row.source)
      : 'app') as FreeWindowSource,
    label: typeof row.label === 'string' ? row.label : '',
    active: Boolean(row.active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapPersonRow(row: Record<string, unknown>): PersonScheduleContext {
  return {
    id: String(row.id),
    familyId: String(row.family_id),
    displayName: typeof row.display_name === 'string' ? row.display_name : 'Family member',
    role: (['parent', 'child', 'circle', 'vendor'].includes(String(row.role))
      ? String(row.role)
      : 'circle') as PersonScheduleContext['role'],
    timezone: resolveSafeTimeZone(typeof row.timezone === 'string' ? row.timezone : 'Asia/Kolkata'),
    quietWindows: normalizeQuietWindows(row.quiet_windows),
  };
}

function mapNudgeLogRow(row: Record<string, unknown>): MatcherNudgeLogRecord {
  return {
    id: String(row.id),
    familyId: String(row.family_id),
    parentPersonId: String(row.parent_person_id),
    childPersonId: String(row.child_person_id),
    localDate: String(row.local_date),
    nudgeId: typeof row.nudge_id === 'string' ? row.nudge_id : null,
    outboxId: typeof row.outbox_id === 'string' ? row.outbox_id : null,
    childAlertId: typeof row.child_alert_id === 'string' ? row.child_alert_id : null,
    status: (['sent', 'skipped', 'failed'].includes(String(row.status))
      ? String(row.status)
      : 'sent') as MatcherNudgeLogRecord['status'],
    matchedAt: String(row.matched_at),
  };
}

export function createSupabaseMatcherAuthPort(db: SupabaseClient): MatcherAuthPort {
  const auth = createDefaultAuthPort();
  const repo = createSupabaseCore1Repository(db);

  return {
    async authenticate(request: Request, requestedFamilyId?: string) {
      const authHeader = request.headers.get('authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new Core1CommandError('unauthorized_missing_bearer_token', 401);
      }
      const token = authHeader.slice('Bearer '.length).trim();
      if (!token) {
        throw new Core1CommandError('unauthorized_missing_bearer_token', 401);
      }
      const user = await auth.getUser(token);
      if (!user?.id || !isValidUuid(user.id)) {
        throw new Core1CommandError('unauthorized_invalid_bearer_token', 401);
      }
      const membership = await repo.getMembership(user.id, requestedFamilyId);
      if (membership.role === 'circle') {
        const circle = await repo.getCircleRecord(membership.familyId, membership.personId);
        if (!circle || !circle.active || circle.revokedAt || !circle.consentAt) {
          throw new Core1CommandError('circle_member_unauthorized', 403);
        }
      }
      return {
        userId: user.id,
        familyId: membership.familyId,
        personId: membership.personId,
        role: membership.role,
      };
    },
  };
}

export function createSupabaseMatcherStore(db: SupabaseClient): Core1MatcherStore {
  return {
    async getPerson(familyId, personId) {
      const { data, error } = await db
        .from('people')
        .select('id,family_id,display_name,role,timezone,quiet_windows')
        .eq('family_id', familyId)
        .eq('id', personId)
        .maybeSingle();
      if (error) throw new Core1CommandError('person_lookup_failed', 503);
      return data ? mapPersonRow(data as Record<string, unknown>) : null;
    },

    async listFamilyPeople(familyId) {
      const { data, error } = await db
        .from('people')
        .select('id,family_id,display_name,role,timezone,quiet_windows')
        .eq('family_id', familyId)
        .order('created_at', { ascending: true });
      if (error) throw new Core1CommandError('people_lookup_failed', 503);
      return ((data ?? []) as Array<Record<string, unknown>>).map(mapPersonRow);
    },

    async listCandidateFamilyIds(requestedFamilyId) {
      if (requestedFamilyId) {
        validateUuid(requestedFamilyId, 'family_id');
        return [requestedFamilyId];
      }
      const { data, error } = await db
        .from('core1_free_windows')
        .select('family_id')
        .eq('active', true);
      if (error) throw new Core1CommandError('matcher_family_lookup_failed', 503);
      const unique = new Set<string>();
      for (const row of (data ?? []) as Array<{ family_id?: unknown }>) {
        if (typeof row.family_id === 'string' && isValidUuid(row.family_id)) {
          unique.add(row.family_id);
        }
      }
      return [...unique];
    },

    async listActiveWindowsForFamily(familyId) {
      const { data, error } = await db
        .from('core1_free_windows')
        .select('*')
        .eq('family_id', familyId)
        .eq('active', true)
        .order('start_minute', { ascending: true });
      if (error) throw new Core1CommandError('free_windows_lookup_failed', 503);
      return ((data ?? []) as Array<Record<string, unknown>>).map(mapWindowRow);
    },

    async listActiveWindowsForPerson(familyId, personId) {
      const { data, error } = await db
        .from('core1_free_windows')
        .select('*')
        .eq('family_id', familyId)
        .eq('person_id', personId)
        .eq('active', true)
        .order('start_minute', { ascending: true });
      if (error) throw new Core1CommandError('free_windows_lookup_failed', 503);
      return ((data ?? []) as Array<Record<string, unknown>>).map(mapWindowRow);
    },

    async createWindow(input, options) {
      if (options?.deactivateSource) {
        const { error: deactErr } = await db
          .from('core1_free_windows')
          .update({ active: false, updated_at: new Date().toISOString() })
          .eq('family_id', input.familyId)
          .eq('person_id', input.personId)
          .eq('source', options.deactivateSource)
          .eq('active', true);
        if (deactErr) {
          throw new Core1CommandError('free_window_update_failed', 503);
        }
      }

      const { data, error } = await db
        .from('core1_free_windows')
        .insert({
          id: input.id,
          family_id: input.familyId,
          person_id: input.personId,
          timezone: input.timezone,
          start_minute: input.startMinute,
          end_minute: input.endMinute,
          kind: input.kind satisfies FreeWindowKind,
          days_of_week: input.daysOfWeek,
          expires_at: input.expiresAt,
          source: input.source,
          label: input.label,
          raw_said: input.rawSaid ?? null,
          active: true,
        })
        .select('*')
        .single();

      if (error || !data) {
        throw new Core1CommandError('free_window_persist_failed', 503);
      }
      return mapWindowRow(data as Record<string, unknown>);
    },

    async deactivateWindow(familyId, personId, windowId) {
      const { data, error } = await db
        .from('core1_free_windows')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('id', windowId)
        .eq('family_id', familyId)
        .eq('person_id', personId)
        .eq('active', true)
        .select('id');
      if (error) throw new Core1CommandError('free_window_delete_failed', 503);
      return Array.isArray(data) && data.length > 0;
    },

    async getMatcherNudgeForDay(familyId, parentPersonId, localDate) {
      const { data, error } = await db
        .from('core1_matcher_nudge_log')
        .select('*')
        .eq('family_id', familyId)
        .eq('parent_person_id', parentPersonId)
        .eq('local_date', localDate)
        .maybeSingle();
      if (error) throw new Core1CommandError('matcher_nudge_lookup_failed', 503);
      return data ? mapNudgeLogRow(data as Record<string, unknown>) : null;
    },

    async claimMatcherNudgeForDay(input) {
      const { data, error } = await db
        .from('core1_matcher_nudge_log')
        .insert({
          id: input.id,
          family_id: input.familyId,
          parent_person_id: input.parentPersonId,
          child_person_id: input.childPersonId,
          local_date: input.localDate,
          nudge_id: input.nudgeId,
          outbox_id: input.outboxId,
          child_alert_id: input.childAlertId,
          status: 'sent',
          matched_at: input.matchedAt,
        })
        .select('*')
        .single();

      if (error) {
        if ((error as { code?: string }).code === '23505') {
          const existing = await this.getMatcherNudgeForDay(
            input.familyId,
            input.parentPersonId,
            input.localDate,
          );
          return { claimed: false, existing: existing ?? undefined };
        }
        throw new Core1CommandError('matcher_nudge_claim_failed', 503);
      }

      if (!data) {
        return { claimed: false };
      }
      return { claimed: true };
    },

    async hasTalkedToday({
      familyId,
      parentPersonId,
      childPersonId,
      dayStartUtcIso,
      dayEndUtcIso,
    }) {
      // 1. Check real voice messages between parent and child today
      const { data: voiceRows, error: voiceErr } = await db
        .from('voice_posts')
        .select('id,sender_id,recipient_id,state,created_at')
        .eq('family_id', familyId)
        .neq('state', 'failed')
        .gte('created_at', dayStartUtcIso)
        .lt('created_at', dayEndUtcIso)
        .limit(20);
      if (voiceErr) throw new Core1CommandError('voice_history_lookup_failed', 503);

      for (const row of (voiceRows ?? []) as Array<Record<string, unknown>>) {
        const s = String(row.sender_id);
        const r = String(row.recipient_id);
        if (
          (s === parentPersonId && r === childPersonId) ||
          (s === childPersonId && r === parentPersonId)
        ) {
          return true;
        }
      }

      // 2. Check connected/completed non-AI calls for this family today.
      // Exclude automated AI check-in calls (`provider = 'sarvam'`) so Maa's morning check-in
      // does not suppress the evening both-free nudge.
      const { data: callRows, error: callErr } = await db
        .from('calls')
        .select('id,person_id,provider,status,started_at,ended_at,created_at')
        .eq('family_id', familyId)
        .in('status', ['connected', 'completed'])
        .neq('provider', 'sarvam')
        .gte('created_at', dayStartUtcIso)
        .lt('created_at', dayEndUtcIso)
        .limit(20);
      if (callErr) throw new Core1CommandError('call_history_lookup_failed', 503);

      for (const row of (callRows ?? []) as Array<Record<string, unknown>>) {
        const pid = String(row.person_id);
        if (pid === parentPersonId || pid === childPersonId) {
          return true;
        }
      }

      return false;
    },

    async listPushTokens(familyId, personId) {
      const { data: memberships, error: memErr } = await db
        .from('family_memberships')
        .select('user_id')
        .eq('family_id', familyId)
        .eq('person_id', personId)
        .is('revoked_at', null);
      if (memErr) throw new Core1CommandError('push_token_lookup_failed', 503);

      const userIds = (memberships ?? [])
        .map((m: Record<string, unknown>) => m.user_id)
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
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
    },

    async recordNudge(input) {
      const { error } = await db.from('nudges').upsert(
        {
          id: input.id,
          family_id: input.familyId,
          person_id: input.recipientPersonId,
          kind: input.kind,
          scheduled_at: input.scheduledAt,
          status: input.status,
        },
        { onConflict: 'id' },
      );
      if (error) throw new Core1CommandError('nudge_persist_failed', 503);
    },

    async recordChildAlert(input) {
      const { error } = await db.from('child_alerts').upsert(
        {
          id: input.id,
          family_id: input.familyId,
          person_id: input.recipientPersonId,
          incident_id: null,
          kind: input.kind,
        },
        { onConflict: 'id' },
      );
      if (error) throw new Core1CommandError('child_alert_persist_failed', 503);
    },
  };
}

export function createProductionMatcherDeps(
  env: Record<string, string | undefined> = process.env,
): Core1MatcherDeps {
  const db = serviceDatabase();
  const encryptionKeyHex = env.WEBHOOK_ENCRYPTION_KEY;
  const privateKeyPem = env.TIMELINE_SIGNING_PRIVATE_KEY ?? env.SIGNING_PRIVATE_KEY;
  const keyId = env.TIMELINE_SIGNING_KEY_ID ?? env.SIGNING_KEY_ID ?? 'core1-matcher';
  const voiceTimeline = createSupabaseVoiceTimelinePort(db, { privateKeyPem, keyId });

  return {
    auth: createSupabaseMatcherAuthPort(db),
    store: createSupabaseMatcherStore(db),
    outbox: createSupabaseCore1OutboxPort(db, encryptionKeyHex),
    timeline: {
      async append(input) {
        return voiceTimeline.append({
          familyId: input.familyId,
          eventId: randomUUID(),
          dedupeKey: input.dedupeKey,
          eventType: input.eventType,
          entityId: input.entityId,
          humanLine: input.humanLine,
          payload: input.payload,
          occurredAt: input.occurredAt,
        });
      },
    },
    sendPush: defaultSendExpoPush,
    env,
  };
}
