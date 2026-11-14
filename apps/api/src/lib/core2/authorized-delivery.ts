import type { SupabaseClient } from '@supabase/supabase-js';
import { dispatchOutbound } from '../provider-dispatch/dispatch';
import { stableUuid } from '../atlas-runtime/db';
import { enqueueAuthorizedSend, type AuthorizedSendInput, type CareSendKind } from '../core1/authorized-send';
import { createSupabaseVoiceNotifyDeps, type VoiceNotifyDeps } from '../core1/voice-notify';
import { canonicalJson } from '../timeline';
import type { CareDeliveryInput, Core2TimelinePort, Core2TimelineAppendInput } from './contracts';

const KINDS = new Set<string>(['core2.sos_alert','core2.watch_escalation','core2.watch_checkin',
  'core2.reassurance','core2.device_handover','gentle_news.circle_offer','core1.refill_notice']);
export function careNoticeBody(kind: string, details: Record<string, unknown>): string {
  if (kind === 'core2.reassurance') return `Parivar ka sandesh: ${String(details.statusLabel || 'Naya status update aaya hai.')}`;
  if (kind === 'core1.refill_notice') return `Gupta Medical ko order bhej diya — ₹${Number(details.amountMinor) / 100}`;
  if (kind === 'gentle_news.circle_offer') return "Kripya Maa ke paas jaakar baithiye. Parivar ko apne pahunchne ki soochna dein.";
  if (kind === 'core2.watch_checkin') return 'Sahaj: kripya apna safe status update karein.';
  if (kind === 'core2.device_handover') return 'Parivar ke phone se naye update ka intezar hai. Kripya sampark karein.';
  return 'Parivar se madad ka anurodh aaya hai. Kripya seedhe sampark karein. Sandesh milna madad sweekar karna nahi hai.';
}

async function appendCareTimeline(db: SupabaseClient, timeline: Core2TimelinePort, input: Core2TimelineAppendInput) {
  const read = () => db.from('timeline_events').select('event_type,entity_id,payload_canonical')
    .eq('family_id', input.familyId).eq('dedupe_key', input.dedupeKey).maybeSingle();
  const matches = (row: Record<string, unknown>) => row.event_type === input.eventType
    && row.entity_id === input.entityId && row.payload_canonical === canonicalJson(input.payload);
  const { data: prior, error } = await read();
  if (error) throw new Error('care_timeline_lookup_failed');
  if (prior) {
    if (!matches(prior)) throw new Error('care_timeline_conflict');
    return;
  }
  try { await timeline.append(input); }
  catch (error) {
    // A concurrent identical request may have signed the same intent after our first read.
    const { data: winner, error: readError } = await read();
    if (readError || !winner || !matches(winner)) throw error;
  }
}

/** Source contains only routing facts and a bounded calm status, never notes/location/phone numbers. */
export async function prepareCareDelivery(db: SupabaseClient, timeline: Core2TimelinePort, input: CareDeliveryInput,
  encryptionKey = process.env.WEBHOOK_ENCRYPTION_KEY): Promise<{ send: AuthorizedSendInput; id: string; duplicate: boolean; channel: 'expo' | 'twilio' }> {
  if (!KINDS.has(input.outboxKind)) throw new Error('unsupported_care_send');
  const sourceId = stableUuid(['care-source', input.familyId, input.dedupeKey]);
  const rawStatus = typeof input.payload.status_label === 'string' ? input.payload.status_label : '';
  const statusLabel = rawStatus.replace(/\+?\d[\d ().-]{6,}\d/g, '<PHONE>').replace(/\d{4,}/g, '******').slice(0, 240);
  const details = { trustedContactId: input.trustedContactId ?? null, watchId: input.watchId ?? null,
    sosId: input.sosId ?? null, incidentId: input.payload.incident_id ?? null,
    assignmentId: input.payload.assignment_id ?? null, voicePostId: input.payload.voice_post_id ?? null, errandId: input.payload.errandId ?? null,
    handoverId: input.payload.handover_id ?? null, statusLabel, amountMinor: input.payload.amountMinor ?? null };
  const payload = { kind: input.outboxKind, subjectId: input.actorPersonId, recipientId: input.targetPersonId, details };
  await appendCareTimeline(db, timeline, { familyId: input.familyId, eventId: sourceId, entityId: sourceId,
    eventType: 'care.send.requested', dedupeKey: `care:source:${sourceId}`, occurredAt: new Date().toISOString(),
    humanLine: 'Care notification requested; recipient authorization is checked separately.', payload });
  // SQL compares the exact signed payload to these details, including on replay.
  const send: AuthorizedSendInput = { familyId: input.familyId, subjectId: input.actorPersonId,
    recipientId: input.targetPersonId, kind: input.outboxKind as CareSendKind, sourceId, dedupeKey: input.dedupeKey, details };
  const result = await enqueueAuthorizedSend(db, encryptionKey, send);
  return { send, id: result.id, duplicate: result.duplicate, channel: result.channel };
}

export async function dispatchCareDelivery(deps: VoiceNotifyDeps, send: AuthorizedSendInput, id: string,
  channel: 'expo' | 'twilio'): Promise<void> {
  if (channel === 'expo' && deps.pushEnabled === false) return;
  if (channel === 'twilio' && (!deps.dispatch || !deps.keypadBaseUrl)) return;
  const claim = await deps.repo.claim(send.familyId, id);
  if (!claim) return;
  if (channel === 'expo') {
    const tokens = await deps.repo.claimPush(send.familyId, id, claim.lease);
    if (!tokens?.length) return;
    try {
      const result = await deps.sendPush!(tokens.map(to => ({ to, title: 'Sahaj',
        body: careNoticeBody(send.kind, send.details ?? {}), sound: 'default',
        data: { route: send.details?.voicePostId ? '/voice' : '/core2', outbox_id: id, kind: send.kind,
          ...(typeof send.details?.voicePostId === 'string' ? { voice_post_id: send.details.voicePostId } : {}) } })));
      await deps.repo.updateOutboxStatus(id, claim.lease, result.sent > 0 ? 'completed' : 'failed', result.sent > 0 ? null : 'push_send_failed');
    } catch {
      await deps.repo.updateOutboxStatus(id, claim.lease, 'delivery_unknown', 'push_delivery_unknown');
    }
    return;
  }
  if (!claim.callId || !deps.dispatch) throw new Error('care_call_binding_missing');
  await dispatchOutbound({ ...deps.dispatch.deps, store: deps.dispatch.store }, {
    familyId: send.familyId, personId: send.recipientId, outboxId: id, outboxLease: claim.lease,
    attempt: claim.attempt, callId: claim.callId, aiDisclosureAttested: true,
    payload: { action: 'twilio.create_call', twimlUrl: typeof send.details?.voicePostId === 'string'
      ? `${deps.keypadBaseUrl}/api/core1/voice-messages/twilio/twiml?postId=${encodeURIComponent(send.details.voicePostId)}`
      : `${deps.keypadBaseUrl}/api/core2/notices/twiml?outboxId=${encodeURIComponent(id)}` },
  });
}
export const isCareAuthorizationRefusal = (error: unknown) => error instanceof Error && ['send_not_authorized', 'send_consent_required', 'send_permission_denied'].includes(error.message);

export function createCareDelivery(db: SupabaseClient, timeline: Core2TimelinePort, encryptionKey = process.env.WEBHOOK_ENCRYPTION_KEY) {
  return async (input: CareDeliveryInput) => {
    let prepared: Awaited<ReturnType<typeof prepareCareDelivery>>;
    try { prepared = await prepareCareDelivery(db, timeline, input, encryptionKey); }
    catch (error) {
      if (isCareAuthorizationRefusal(error)) return { decision: (error instanceof Error && error.message === 'send_permission_denied' ? 'deny' : 'ask') as 'deny' | 'ask', outboxId: null };
      throw error;
    }
    const dedupeKey = `care:queued:${prepared.id}`;
    await appendCareTimeline(db, timeline, { familyId: input.familyId, eventId: stableUuid(['care-queued', prepared.id]),
      entityId: prepared.id, eventType: 'care.send.enqueued', dedupeKey, occurredAt: new Date().toISOString(),
      humanLine: input.outboxKind === 'core1.refill_notice' ? careNoticeBody(input.outboxKind, prepared.send.details ?? {})
        : 'Care notification authorized and queued for its recipient.',
      payload: { recipientId: input.targetPersonId, outboxId: prepared.id, channel: prepared.channel,
        deliveryStatus: 'queued', ...(input.outboxKind === 'core1.refill_notice' ? { vendorCall: false } : {}) } });
    await dispatchCareDelivery(createSupabaseVoiceNotifyDeps(db), prepared.send, prepared.id, prepared.channel);
    return { decision: 'allow' as const, outboxId: prepared.id, duplicate: prepared.duplicate };
  };
}
