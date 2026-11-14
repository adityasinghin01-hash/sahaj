import { postRedactedWebhook, type WebhookAttempt } from '../redacted-webhook';
import { sanitizeReportValue } from '../core2-news/redaction';
import { createHash, timingSafeEqual } from 'node:crypto';

export type ZapierHookEnvKey = 'ZAPIER_HOOK_Z1' | 'ZAPIER_HOOK_Z5';

export interface ZapierZ1RefillPayload {
  schema: 'sahaj.zapier.z1.v1';
  event: 'refill.authorized' | 'refill.dispatched' | 'refill.delivered' | 'refill.approval_requested';
  familyId: string;
  personId: string;
  medicineId: string;
  vendorId: string | null;
  actionRequestId: string;
  errandId: string;
  medicineLabel: string;
  reorderPacks: number;
  amountMinor: number;
  status: string;
  occurredAt: string;
  /** Permission row that authorised (or is being asked to authorise) this errand. */
  permissionId: string | null;
  /** chain_hash of the signed timeline row written for this step (64 hex chars). */
  chainHash: string;
}

export interface ZapierZ5ReminderPayload {
  schema: 'sahaj.zapier.z5.v1';
  event: 'reminder.refill_due' | 'reminder.care_date';
  familyId: string;
  personId: string;
  entityId: string;
  label: string;
  /** When the reminder is due (ISO). Becomes the Calendar event start. */
  dueAt: string;
  summary: string;
  occurredAt: string;
}

export interface ZapierDispatchOutcome {
  sent: boolean;
  hook: ZapierHookEnvKey;
  status?: number;
  skippedReason?: 'not_configured' | 'invalid_url' | 'invalid_payload';
  error?: string;
}

export type ZapierFetch = (input: string, init: RequestInit) => Promise<Response>;

const DIGEST = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * Constant-time verification of `x-sahaj-zap-secret` against `ZAPIER_REPORT_SECRET`.
 * Fails closed when the secret is unconfigured or header does not match.
 */
export function verifyZapierReportSecret(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): { ok: true } | { ok: false; status: 401 | 503; code: string } {
  const configured = env.ZAPIER_REPORT_SECRET?.trim();
  if (!configured) {
    return { ok: false, status: 503, code: 'zapier_secret_not_configured' };
  }
  const provided = request.headers.get('x-sahaj-zap-secret')?.trim();
  if (!provided) {
    return { ok: false, status: 401, code: 'missing_zapier_secret' };
  }
  if (!timingSafeEqual(DIGEST(provided), DIGEST(configured))) {
    return { ok: false, status: 401, code: 'invalid_zapier_secret' };
  }
  return { ok: true };
}

/**
 * Env-configured redacted webhook; not a security boundary. Signed attempts precede optional HTTP.
 */
export async function postZapierHook(params: {
  hook: ZapierHookEnvKey;
  payload: ZapierZ1RefillPayload | ZapierZ5ReminderPayload;
  env?: Record<string, string | undefined>;
  fetchImpl?: ZapierFetch;
  timeoutMs?: number;
  audit?: (attempt: WebhookAttempt) => Promise<void>;
}): Promise<ZapierDispatchOutcome> {
  const env = params.env ?? process.env;
  const rawUrl = env[params.hook]?.trim();
  if (!rawUrl) {
    return { sent: false, hook: params.hook, skippedReason: 'not_configured' };
  }

  const p = params.payload;
  const body = p.schema === 'sahaj.zapier.z1.v1' ? buildZapierZ1Body(p) : buildZapierZ5Body(p);
  if (!body) {
    return { sent: false, hook: params.hook, skippedReason: 'invalid_payload' };
  }
  const result = await postRedactedWebhook({ url: rawUrl, payload: body,
    timeoutMs: params.timeoutMs, fetchImpl: params.fetchImpl,
    audit: params.audit ?? (async () => { throw new Error('audit_not_configured'); }) });
  return { sent: result.ok, hook: params.hook, ...(result.status !== null ? { status: result.status } : {}),
    ...(result.error ? { error: result.error } : {}) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAIN_HASH_RE = /^[0-9a-f]{64}$/;
const IST_OFFSET_MS = 330 * 60 * 1000;
const Z1_STATUSES = ['authorized', 'dispatched', 'delivered', 'approval_requested', 'awaiting_approval'];

/** Z5 calendar block length and popup lead time. */
export const Z5_EVENT_MINUTES = 15;
export const Z5_REMINDER_MINUTES_BEFORE = 60;
/** Local hour (Asia/Kolkata) used for refill-due reminders. */
export const Z5_REMINDER_HOUR_IST = 10;

/** `2026-11-15T11:30:00+05:30` — full timestamp with the Asia/Kolkata offset. */
export function toIstIso(input: string | number | Date): string | null {
  const ms = input instanceof Date ? input.getTime() : typeof input === 'number' ? input : Date.parse(input);
  if (!Number.isFinite(ms)) return null;
  return `${new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30`;
}

/** Next day at Z5_REMINDER_HOUR_IST:00 Asia/Kolkata, as a UTC ISO string. */
export function nextIstReminderAt(fromIso: string): string {
  const ms = Date.parse(fromIso);
  const base = Number.isFinite(ms) ? ms : Date.now();
  const ist = new Date(base + IST_OFFSET_MS);
  const nextDayIstMidnightAsUtc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1);
  return new Date(nextDayIstMidnightAsUtc + Z5_REMINDER_HOUR_IST * 3_600_000 - IST_OFFSET_MS).toISOString();
}

const uuidOrNull = (v: string | null | undefined) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

/**
 * Z1 body (errand ledger -> Google Sheets). Field names match the saved Zap's Hook tokens.
 * Explicit allowlist: no medicine label, phone, OTP, address or location crosses this seam.
 * Returns null if the timestamp is unusable.
 */
export function buildZapierZ1Body(p: ZapierZ1RefillPayload): Record<string, unknown> | null {
  const occurredAt = toIstIso(p.occurredAt);
  if (!occurredAt) return null;
  const status = Z1_STATUSES.includes(p.status) ? p.status : 'update';
  const decision = p.event === 'refill.approval_requested' ? 'awaiting_approval' : 'approved';
  const permissionRef = uuidOrNull(p.permissionId);
  const amountInr = Number.isFinite(p.amountMinor) && p.amountMinor >= 0 ? Math.round(p.amountMinor) / 100 : 0;
  const errandType = 'medicine_refill';
  const vendorLabel = 'Approved vendor';
  // Legacy camelCase fields are prose-redacted; ledger fields below are validated individually
  // (the prose redactor would mangle dates and digit runs inside the hex chain hash).
  const legacy = sanitizeReportValue({
    schema: p.schema, event: p.event, familyId: uuidOrNull(p.familyId), personId: uuidOrNull(p.personId),
    medicineId: uuidOrNull(p.medicineId), vendorId: uuidOrNull(p.vendorId),
    actionRequestId: uuidOrNull(p.actionRequestId), errandId: uuidOrNull(p.errandId),
    medicineLabel: 'Medicine refill', reorderPacks: Number.isInteger(p.reorderPacks) ? p.reorderPacks : 1,
    amountMinor: Math.round(amountInr * 100), status, occurredAt: p.occurredAt,
  });
  return {
    ...legacy,
    occurred_at: occurredAt,
    errand_type: errandType,
    vendor_label: vendorLabel,
    amount_inr: amountInr,
    permission_ref: permissionRef,
    decision,
    chain_hash: CHAIN_HASH_RE.test(p.chainHash) ? p.chainHash : null,
    // Back-compat with the Zap's original sample; prefer the fields above.
    event_date: occurredAt.slice(0, 10),
    errand: 'Medicine refill',
    vendor: vendorLabel,
    permission_id: permissionRef,
  };
}

/**
 * Z5 body (reminders -> Google Calendar). Times carry the +05:30 offset; the
 * reminder lead time is a number of minutes. Title/description are fixed text.
 */
export function buildZapierZ5Body(p: ZapierZ5ReminderPayload): Record<string, unknown> | null {
  const dueMs = Date.parse(p.dueAt);
  const startAt = toIstIso(dueMs);
  const endAt = toIstIso(dueMs + Z5_EVENT_MINUTES * 60_000);
  if (!startAt || !endAt) return null;
  const refill = p.event === 'reminder.refill_due';
  const title = refill ? 'Medicine refill due' : 'Care reminder';
  const description = refill
    ? 'Medicine stock is low. Open Sahaj to review the refill; details stay in Sahaj.'
    : 'Care reminder due. Details stay in Sahaj.';
  const legacy = sanitizeReportValue({
    schema: p.schema, event: p.event, familyId: uuidOrNull(p.familyId), personId: uuidOrNull(p.personId),
    entityId: uuidOrNull(p.entityId), label: 'Care reminder', dueAt: new Date(dueMs).toISOString(),
    summary: 'Care reminder due; details stay in Sahaj.', occurredAt: p.occurredAt,
  });
  return {
    ...legacy,
    title,
    description,
    start_at: startAt,
    end_at: endAt,
    reminder_minutes_before: Z5_REMINDER_MINUTES_BEFORE,
  };
}
