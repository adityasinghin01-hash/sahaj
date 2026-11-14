import { createHash } from 'node:crypto';
import { isAuthorized } from '@cedar-policy/cedar-wasm/nodejs';

export type GateAction = 'check_in' | 'urgent_responder' | 'voice_message' | 'medicine_refill' |
  'missed_call_nudge' | 'send_alert' | 'family_report' | 'record_audio' | 'share_data' |
  'payment' | 'collect_otp' | 'medical_diagnosis';

export interface GateRequest {
  id: string;
  familyId: string;
  action: GateAction;
  /** Integer minor currency units; never floating point rupees. */
  amountMinor?: number;
  vendorId?: string;
  itemIds?: string[];
  consentSubjectId?: string;
  /** Durable target/recipient identifier, never a raw phone number. */
  targetId: string;
}
export interface SetupPermission {
  id: string;
  familyId: string;
  actorId: string;
  action: GateAction;
  validFrom: string;
  expiresAt: string;
  revokedAt?: string | null;
  maxAmountMinor: number;
  vendorIds: string[];
  itemIds: string[];
  targetIds: string[];
  /** Every permission has a finite usage window, including free actions. */
  periodStart: string;
  periodEnd: string;
  maxUses: number;
  usedCount: number;
  approvalMode: 'setup' | 'two_person';
}
export interface GateApproval {
  id: string;
  requestId: string;
  requestFingerprint: string;
  permissionId: string;
  familyId: string;
  approverId: string;
  /** Loaded from authenticated family membership, never request-body claims. */
  approverActive: boolean;
  approverCanApprove: boolean;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string | null;
}
export interface GateConsent {
  familyId: string;
  subjectId: string;
  targetId: string;
  scope: 'record_audio' | 'share_data';
  grantedAt: string;
  expiresAt: string;
  revokedAt?: string | null;
}
export interface GateInput {
  actor: { id: string; familyId: string; active: boolean };
  request: GateRequest;
  permissions: SetupPermission[];
  approvals: GateApproval[];
  consents: GateConsent[];
  now: string;
}
export type GateReason = 'allowed' | 'invalid_input' | 'prohibited_action' | 'wrong_family' |
  'no_permission' | 'permission_inactive' | 'limits_exceeded' | 'consent_required' |
  'approval_required' | 'invalid_approval' | 'cedar_error';
export interface GateDecision {
  decision: 'allow' | 'deny' | 'ask';
  reason: GateReason;
  permissionId?: string;
  approvalRequired?: number;
}

/** Fixed policy, never supplied by callers or language model output. */
export const AUTHORIZATION_POLICY = `
permit(principal, action, resource)
when {
  principal.active &&
  principal.familyId == resource.familyId &&
  principal.id == resource.actorId &&
  context.familyId == resource.familyId &&
  context.actionName == resource.actionName &&
  resource.targetIds.contains(context.targetId) &&
  !resource.revoked &&
  context.now >= resource.validFrom && context.now < resource.expiresAt &&
  context.now >= resource.periodStart && context.now < resource.periodEnd &&
  resource.usedCount < resource.maxUses &&
  context.amountMinor <= resource.maxAmountMinor &&
  (context.vendorId == "" || resource.vendorIds.contains(context.vendorId)) &&
  resource.itemIds.containsAll(context.itemIds)
};
forbid(principal, action, resource)
when { ["payment", "collect_otp", "medical_diagnosis"].contains(context.actionName) };
`;

const actions = new Set<string>(['check_in', 'urgent_responder', 'voice_message', 'medicine_refill',
  'missed_call_nudge', 'send_alert', 'family_report', 'record_audio', 'share_data',
  'payment', 'collect_otp', 'medical_diagnosis']);
const prohibited = new Set<string>(['payment', 'collect_otp', 'medical_diagnosis']);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(text);
const time = (value: unknown): number => typeof value === 'string' ? Date.parse(value) : NaN;
const interval = (start: unknown, end: unknown) => Number.isFinite(time(start)) && Number.isFinite(time(end)) && time(start) < time(end);
const live = (start: string, end: string, now: number) => interval(start, end) && now >= time(start) && now < time(end);

/** Bind approval to immutable action details, including consent subject, cost and items. */
export function requestFingerprint(request: GateRequest): string {
  return createHash('sha256').update(JSON.stringify({
    id: request.id, familyId: request.familyId, action: request.action,
    amountMinor: request.amountMinor ?? 0, vendorId: request.vendorId ?? '',
    itemIds: [...new Set(request.itemIds ?? [])].sort(), consentSubjectId: request.consentSubjectId ?? '', targetId: request.targetId ?? '',
  })).digest('hex');
}

/**
 * Only accept trusted server snapshots. Recheck immediately before execution inside
 * the transaction that reserves usage and consumes approvals; this pure evaluator
 * cannot prevent concurrent executions or establish membership authenticity itself.
 */
export function evaluateGate(input: GateInput): GateDecision {
  const deny = (reason: GateReason, permissionId?: string): GateDecision => ({ decision: 'deny', reason, ...(permissionId ? { permissionId } : {}) });
  try {
    const { actor, request, permissions, approvals, consents } = input;
    const now = time(input.now);
    if (!Number.isFinite(now) || !text(actor.id) || !text(actor.familyId) || typeof actor.active !== 'boolean' ||
      !text(request.id) || !text(request.familyId) || !actions.has(request.action) ||
      !integer(request.amountMinor ?? 0) || (request.vendorId !== undefined && !text(request.vendorId)) ||
      !strings(request.itemIds ?? []) || (request.consentSubjectId !== undefined && !text(request.consentSubjectId)) ||
      !text(request.targetId) ||
      !Array.isArray(permissions) || !Array.isArray(approvals) || !Array.isArray(consents)) return deny('invalid_input');
    if (prohibited.has(request.action)) return deny('prohibited_action');
    if (request.action === 'medicine_refill' && (request.amountMinor === undefined || !request.vendorId || !request.itemIds?.length)) return deny('invalid_input');
    if (!actor.active || actor.familyId !== request.familyId) return deny('wrong_family');
    const candidates = permissions.filter(p => p.familyId === request.familyId && p.actorId === actor.id && p.action === request.action);
    if (!candidates.length) return { decision: 'ask', reason: 'no_permission' };
    let inactive = true;
    let selected: SetupPermission | undefined;
    for (const p of candidates) {
      if (!text(p.id) || !integer(p.maxAmountMinor) || !integer(p.maxUses) || !integer(p.usedCount) ||
        !strings(p.vendorIds) || !strings(p.itemIds) || !strings(p.targetIds) || !['setup', 'two_person'].includes(p.approvalMode) ||
        !interval(p.validFrom, p.expiresAt) || !interval(p.periodStart, p.periodEnd)) return deny('invalid_input');
      if (p.revokedAt || !live(p.validFrom, p.expiresAt, now) || !live(p.periodStart, p.periodEnd, now)) continue;
      inactive = false;
      const uid = { type: 'SAHAJ::Permission', id: p.id };
      const principal = { type: 'SAHAJ::Actor', id: actor.id };
      const result = isAuthorized({
        principal, action: { type: 'SAHAJ::Action', id: request.action }, resource: uid,
        context: { familyId: request.familyId, actionName: request.action, targetId: request.targetId, now,
          amountMinor: request.amountMinor ?? 0, vendorId: request.vendorId ?? '', itemIds: request.itemIds ?? [] },
        policies: { staticPolicies: AUTHORIZATION_POLICY },
        entities: [
          { uid: principal, attrs: { id: actor.id, familyId: actor.familyId, active: actor.active }, parents: [] },
          { uid, attrs: { actorId: p.actorId, familyId: p.familyId, actionName: p.action, revoked: Boolean(p.revokedAt),
            validFrom: time(p.validFrom), expiresAt: time(p.expiresAt), periodStart: time(p.periodStart), periodEnd: time(p.periodEnd),
            usedCount: p.usedCount, maxUses: p.maxUses, maxAmountMinor: p.maxAmountMinor, vendorIds: p.vendorIds, itemIds: p.itemIds, targetIds: p.targetIds }, parents: [] },
        ],
      });
      if (result.type !== 'success' || result.response.diagnostics.errors.length > 0) return deny('cedar_error');
      if (result.response.decision === 'allow') { selected = p; break; }
    }
    if (!selected) return deny(inactive ? 'permission_inactive' : 'limits_exceeded');
    const permissionId = selected.id;
    if (request.action === 'record_audio' || request.action === 'share_data') {
      if (!request.consentSubjectId || !consents.some(c => c.familyId === request.familyId &&
        c.subjectId === request.consentSubjectId && c.targetId === request.targetId && c.scope === request.action && !c.revokedAt && live(c.grantedAt, c.expiresAt, now))) {
        return { decision: 'ask', reason: 'consent_required', permissionId };
      }
    }
    const twoPerson = selected.approvalMode === 'two_person';
    if (twoPerson) {
      const relevant = approvals.filter(a => a.requestId === request.id);
      const approverIds = new Set<string>();
      const approvalIds = new Set<string>();
      const fingerprint = requestFingerprint(request);
      for (const a of relevant) {
        if (!text(a.id) || !text(a.approverId) || a.approverId === actor.id || a.familyId !== request.familyId || a.permissionId !== permissionId ||
          a.requestFingerprint !== fingerprint || a.approverActive !== true || a.approverCanApprove !== true ||
          a.revokedAt || !live(a.createdAt, a.expiresAt, now) || approverIds.has(a.approverId) || approvalIds.has(a.id)) return deny('invalid_approval', permissionId);
        approverIds.add(a.approverId); approvalIds.add(a.id);
      }
      if (approverIds.size < 2) return { decision: 'ask', reason: 'approval_required', permissionId, approvalRequired: 2 - approverIds.size };
    }
    return { decision: 'allow', reason: 'allowed', permissionId };
  } catch {
    return deny('invalid_input');
  }
}

/** Fixed policy for reading private media. All facts are proven by the media service from live rows beforehand. */
export const MEDIA_READ_POLICY = `
permit(principal, action, resource)
when {
  principal.active && principal.familyId == resource.familyId && context.familyId == resource.familyId &&
  context.actionName == resource.actionName &&
  resource.consentPurpose == resource.expectedPurpose &&
  context.now >= resource.consentGrantedAt && context.now < resource.objectExpiresAt &&
  ((resource.actionName == "read_voice_media" &&
      (principal.role == "parent" || principal.role == "child") &&
      (principal.personId == resource.senderId || principal.personId == resource.recipientId) &&
      resource.consentPersonId == resource.senderId) ||
   (resource.actionName == "read_call_recording" &&
      principal.role == "parent" && principal.personId == resource.subjectPersonId &&
      resource.consentPersonId == resource.subjectPersonId && resource.consentCallId == resource.subjectId))
};
`;

export interface MediaReadInput {
  action: 'read_voice_media' | 'read_call_recording';
  familyId: string;
  reader: { personId: string; role: 'parent' | 'child' | 'circle'; active: boolean };
  /** voice_post: sender/recipient. call: personId is the recorded person. */
  subject: { id: string; senderId?: string; recipientId?: string; personId?: string };
  consent: { personId: string; purpose: string; callId: string | null; grantedAt: string };
  objectExpiresAt: string;
  now: string;
}

/** Real Cedar decision for media reads. Anything malformed, missing or erroring is deny. */
export function evaluateMediaRead(input: MediaReadInput): 'allow' | 'deny' {
  try {
    const { reader, subject, consent } = input;
    const now = time(input.now), granted = time(consent.grantedAt), expires = time(input.objectExpiresAt);
    if (!['read_voice_media', 'read_call_recording'].includes(input.action) || !text(input.familyId) || !text(reader.personId) ||
      !['parent', 'child', 'circle'].includes(reader.role) || typeof reader.active !== 'boolean' || !text(subject.id) ||
      !text(consent.personId) || !text(consent.purpose) || ![now, granted, expires].every(Number.isFinite)) return 'deny';
    const voice = input.action === 'read_voice_media';
    if (voice ? !text(subject.senderId) || !text(subject.recipientId) : !text(subject.personId)) return 'deny';
    const principal = { type: 'SAHAJ::Reader', id: reader.personId };
    const resource = { type: 'SAHAJ::MediaObject', id: subject.id };
    const result = isAuthorized({
      principal, action: { type: 'SAHAJ::Action', id: input.action }, resource,
      context: { familyId: input.familyId, actionName: input.action, now },
      policies: { staticPolicies: MEDIA_READ_POLICY },
      entities: [
        { uid: principal, attrs: { active: reader.active, familyId: input.familyId, personId: reader.personId, role: reader.role }, parents: [] },
        { uid: resource, attrs: { familyId: input.familyId, actionName: input.action, senderId: subject.senderId ?? '', recipientId: subject.recipientId ?? '',
          subjectPersonId: subject.personId ?? '', subjectId: subject.id, consentPersonId: consent.personId, consentPurpose: consent.purpose,
          consentCallId: consent.callId ?? '', consentGrantedAt: granted, objectExpiresAt: expires,
          expectedPurpose: voice ? `voice_share:${subject.recipientId}` : 'call_recording' }, parents: [] },
      ],
    });
    return result.type === 'success' && result.response.diagnostics.errors.length === 0 && result.response.decision === 'allow' ? 'allow' : 'deny';
  } catch {
    return 'deny';
  }
}
