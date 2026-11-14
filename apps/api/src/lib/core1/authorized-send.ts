import { createHash } from 'node:crypto';
import { evaluateGate, requestFingerprint, type GateApproval, type GateConsent, type GateRequest, type SetupPermission } from '@sahaj/gate';
import { call, stableUuid, type RpcDb } from '../atlas-runtime/db';
import { encryptWebhook } from '../webhook-security';

export type CareSendKind = 'core2.sos_alert' | 'core2.watch_escalation' | 'core2.watch_checkin' | 'core2.reassurance' | 'core2.device_handover' | 'gentle_news.circle_offer' | 'core1.refill_notice';
export const careSendAction = (kind: string): GateRequest['action'] => kind === 'core2.reassurance' ? 'share_data' : 'send_alert';

export interface AuthorizedSendInput {
  familyId: string;
  subjectId: string;
  recipientId: string;
  kind: 'core1.voice_notify' | 'core1.missed_call_push' | 'core1.sarvam_message_push' | CareSendKind;
  details?: Record<string, unknown>;
  sourceId: string;
  dedupeKey: string;
}
export interface AuthorizedSendResult { id: string; duplicate: boolean; channel: 'expo' | 'twilio' }
interface Snapshot {
  found: boolean; now: string; revision: string; actorActive: boolean; block: string | null;
  request: { actorId: string; fingerprint: string; consumed: boolean; expired: boolean; hasDenial: boolean; status: string };
  permissions: SetupPermission[];
  approvals: Array<Omit<GateApproval, 'requestId' | 'requestFingerprint' | 'permissionId' | 'familyId'>>;
  consents: GateConsent[];
}

/** Prepare a durable request, evaluate Cedar over SQL facts, then atomically recheck and enqueue.
 * Neither caller-supplied permission IDs nor an HTTP retry can stand in for a gate grant. */
export async function enqueueAuthorizedSend(db: RpcDb, encryptionKeyHex: string | undefined, input: AuthorizedSendInput): Promise<AuthorizedSendResult> {
  if (!encryptionKeyHex || !/^[a-f0-9]{64}$/i.test(encryptionKeyHex)) throw new Error('send_encryption_not_configured');
  const ids = [input.familyId, input.dedupeKey];
  const jobId = stableUuid(['authorized-send-job', ...ids]);
  const requestId = stableUuid(['authorized-send-request', ...ids]);
  const eventId = stableUuid(['authorized-send-event', ...ids]);
  const care = input.details !== undefined;
  const action = care ? careSendAction(input.kind) : input.kind === 'core1.missed_call_push' ? 'missed_call_nudge' : 'voice_message';
  const request: GateRequest = { id: requestId, familyId: input.familyId,
    action, targetId: input.recipientId,
    ...(['voice_message', 'share_data'].includes(action) ? { consentSubjectId: input.subjectId } : {}) };
  const prepared = await call<{ lease: string; channel: 'expo' | 'twilio' }>(db, care ? 'prepare_care_send' : 'prepare_authorized_send', {
    p_family_id: input.familyId, p_job_id: jobId, p_request_id: requestId, p_event_id: eventId,
    p_subject_id: input.subjectId, p_recipient_id: input.recipientId, p_kind: input.kind, p_source_id: input.sourceId,
    p_fingerprint: requestFingerprint(request), ...(care ? { p_details: input.details } : {}),
  }, 'send_prepare_failed');
  // The prepare RPC opens a one-shot workflow job (state 'processing', 2 min lease) only to fence the enqueue. No runner
  // claims these kinds, so close it here once the enqueue is decided; otherwise it stays 'processing' forever.
  try {
    const out = await gateAndEnqueue(db, encryptionKeyHex, input, { jobId, requestId, eventId, request, lease: prepared.lease });
    await finishSendJob(db, jobId, prepared.lease, 'completed', null);
    return { ...out, channel: prepared.channel };
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'send_failed';
    await finishSendJob(db, jobId, prepared.lease, 'failed', code);
    throw error;
  }
}

/** Best effort: the outbox row (or the refusal) is already decided, so a finish problem must not change the result. */
async function finishSendJob(db: RpcDb, jobId: string, lease: string, state: 'completed' | 'failed', code: string | null) {
  try {
    const finished = await call<boolean>(db, 'finish_workflow_job', { p_job_id: jobId, p_lease_token: lease, p_state: state, p_error_code: code }, 'send_job_finish_failed');
    if (finished === false) console.warn('[authorized-send] send job not finished: stale_lease');
  } catch (error) {
    console.warn(`[authorized-send] send job not finished: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}

async function gateAndEnqueue(db: RpcDb, encryptionKeyHex: string, input: AuthorizedSendInput,
  ids: { jobId: string; requestId: string; eventId: string; request: GateRequest; lease: string }): Promise<Omit<AuthorizedSendResult, 'channel'>> {
  const { jobId, requestId, eventId, request } = ids;
  const snapshot = await call<Snapshot>(db, 'load_gate_snapshot', {
    p_family_id: input.familyId, p_job_id: jobId, p_request_id: requestId,
  }, 'send_snapshot_failed');
  if (!snapshot.found || snapshot.request.fingerprint !== requestFingerprint(request)) throw new Error('send_request_mismatch');
  if (!snapshot.request.consumed) {
    if (snapshot.block === 'deny' || snapshot.request.hasDenial) throw new Error('send_permission_denied');
    if (snapshot.block || snapshot.request.expired || !['pending', 'approved'].includes(snapshot.request.status)) throw new Error('send_not_authorized');
    const allowed = snapshot.permissions.some(permission => evaluateGate({
      actor: { id: snapshot.request.actorId, familyId: input.familyId, active: snapshot.actorActive }, request,
      permissions: [permission], approvals: snapshot.approvals.map(a => ({ ...a, requestId, requestFingerprint: snapshot.request.fingerprint,
        permissionId: permission.id, familyId: input.familyId })), consents: snapshot.consents, now: snapshot.now,
    }).decision === 'allow');
    if (!allowed) throw new Error('send_not_authorized');
  }
  const plain = Buffer.from(JSON.stringify({ v: 1, action: request.action, requestId, eventId }));
  const result = await call<{ status: string; outbox_id?: string; recovered?: boolean; reason?: string }>(db, 'enqueue_authorized_command', {
    p_family_id: input.familyId, p_job_id: jobId, p_lease_token: ids.lease, p_action_request_id: requestId,
    p_action: request.action, p_dedupe_key: input.dedupeKey,
    p_payload_ciphertext: encryptWebhook(plain, encryptionKeyHex, `outbox:${input.familyId}:${input.dedupeKey}`),
    p_payload_hash: createHash('sha256').update(plain).digest('hex'), p_revision: snapshot.revision,
    p_incident_id: null, p_assignment_id: null,
  }, 'send_enqueue_failed');
  if (result.status !== 'enqueued' || !result.outbox_id) throw new Error(result.reason === 'consent_required' ? 'send_consent_required' : 'send_not_authorized');
  return { id: result.outbox_id, duplicate: result.recovered === true };
}

export interface SendClaim { lease: string; attempt: number; callId: string | null; personId: string }
export const claimAuthorizedSend = (db: RpcDb, familyId: string, outboxId: string) => call<SendClaim | null>(db,
  'claim_authorized_send', { p_family_id: familyId, p_outbox_id: outboxId }, 'send_claim_failed');
export const claimAuthorizedPush = (db: RpcDb, familyId: string, outboxId: string, lease: string) => call<string[] | null>(db,
  'claim_authorized_push', { p_family_id: familyId, p_outbox_id: outboxId, p_lease: lease }, 'push_claim_failed');
