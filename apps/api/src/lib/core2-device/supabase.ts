import { prepareCareDelivery, dispatchCareDelivery, isCareAuthorizationRefusal } from '../core2/authorized-delivery';
import { createSupabaseTimelinePort } from '../core2/supabase';
import { createSupabaseVoiceNotifyDeps } from '../core1/voice-notify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceDatabase } from '../database';
import { Core2Error } from '../core2/contracts';
import { createProductionCore2Deps } from '../core2/supabase';
import { canonicalJson, signTimelineEvent } from '../timeline';
import type { DeviceState, DeviceStore, Handover } from './contracts';
import { createDeviceService } from './service';

function storageError(error: { message?: string } | null): never {
  if (error?.message?.includes('idempotency_conflict'))
    throw new Core2Error('idempotency_conflict', 409, 'Idempotency key reused with changed status.');
  throw new Core2Error('storage_unavailable', 503, 'Device status storage unavailable.');
}
export function createDeviceStore(db: SupabaseClient, signingKey: string, keyId: string): DeviceStore {
  return {
    async get(familyId, personId) {
      const { data, error } = await db.from('core2_device_status')
        .select('family_id,person_id,battery_level,is_charging,sampled_at,heartbeat_at')
        .eq('family_id', familyId).eq('person_id', personId).maybeSingle();
      if (error) storageError(error);
      return data as DeviceState | null;
    },
    async report(input) {
      const { data, error } = await db.rpc('core2_report_device_status', {
        p_family_id: input.familyId, p_person_id: input.personId, p_key_hash: input.keyHash,
        p_request_hash: input.requestHash, p_status: input.status, p_raw_event_id: input.rawEventId,
      });
      if (error || !data) storageError(error);
      return data;
    },
    async due(staleMs, familyId, personId) {
      const { data, error } = await db.rpc('core2_due_device_handovers', {
        p_stale_ms: staleMs, p_family_id: familyId ?? null, p_person_id: personId ?? null,
      });
      if (error || !Array.isArray(data)) storageError(error);
      return data as Handover[];
    },
    async complete(job, timeline, notices) {
      if (!job.id || !job.family_id || !job.person_id) throw new Core2Error('unavailable', 503, 'Device notice authorization source missing.');
      const prepared: Awaited<ReturnType<typeof prepareCareDelivery>>[] = [];
      const acceptedNotices: typeof notices = [];
      for (const notice of notices) {
        try {
          const result = await prepareCareDelivery(db, createSupabaseTimelinePort(db, signingKey, keyId), {
            familyId: job.family_id, actorPersonId: job.person_id, targetPersonId: notice.recipient,
            outboxKind: notice.parent ? 'core2.reassurance' : 'core2.device_handover',
            dedupeKey: notice.command.dedupeKey, trustedContactId: notice.command.trustedContactId,
            watchId: job.watch_id, sosId: job.sos_id,
            payload: { status_label: notice.statusLabel, handover_id: job.id },
          });
          prepared.push(result);
          acceptedNotices.push(notice);
        } catch (error) { if (!isCareAuthorizationRefusal(error)) throw error; }
      }
      const authorizedNotices = acceptedNotices.map((notice, i) => ({ ...notice, authorizedOutboxId: prepared[i].id }));
      for (let attempt = 0; attempt < 3; attempt++) {
        const { data: head, error: headError } = await db.from('timeline_stream_heads')
          .select('last_sequence,last_chain_hash').eq('family_id', job.family_id).maybeSingle();
        if (headError) storageError(headError);
        const effectiveTimeline = { ...timeline, payload: { ...timeline.payload, notices_queued: acceptedNotices.length } };
        const signed = signTimelineEvent({ ...effectiveTimeline, sequence: (head?.last_sequence ?? 0) + 1,
          previousHash: head?.last_chain_hash ?? null, keyId }, signingKey);
        const { error } = await db.rpc('core2_complete_device_handover', {
          p_job_id: job.id, p_event: signed.envelope, p_payload_canonical: canonicalJson(effectiveTimeline.payload),
          p_chain_hash: signed.chainHash, p_signature: signed.signature, p_notices: authorizedNotices,
        });
        if (!error) {
          for (const result of prepared) await dispatchCareDelivery(createSupabaseVoiceNotifyDeps(db), result.send, result.id, result.channel);
          return;
        }
        if (error.code !== '40001') storageError(error);
      }
      storageError(null);
    },
  };
}
export function productionDeviceService() {
  const deps = createProductionCore2Deps();
  return createDeviceService({ ...deps, timerScale: Number(process.env.DEMO_TIMER_SCALE ?? '1'),
    devices: createDeviceStore(serviceDatabase(), process.env.TIMELINE_SIGNING_PRIVATE_KEY!,
      process.env.TIMELINE_SIGNING_KEY_ID || 'core2-default') });
}
