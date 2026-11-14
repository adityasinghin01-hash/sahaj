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
}

export interface ZapierZ5ReminderPayload {
  schema: 'sahaj.zapier.z5.v1';
  event: 'reminder.refill_due' | 'reminder.care_date';
  familyId: string;
  personId: string;
  entityId: string;
  label: string;
  dueAt: string;
  summary: string;
  occurredAt: string;
}

export interface ZapierDispatchOutcome {
  sent: boolean;
  hook: ZapierHookEnvKey;
  status?: number;
  skippedReason?: 'not_configured' | 'invalid_url';
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

  // No free-form labels or summaries cross this seam: they may contain an address or location.
  const p = params.payload;
  const safePayload = p.schema === 'sahaj.zapier.z1.v1' ? {
    schema: p.schema, event: p.event, familyId: p.familyId, personId: p.personId,
    medicineId: p.medicineId, vendorId: p.vendorId, actionRequestId: p.actionRequestId, errandId: p.errandId,
    medicineLabel: 'Medicine refill', reorderPacks: p.reorderPacks, amountMinor: p.amountMinor,
    status: ['authorized','dispatched','delivered','approval_requested'].includes(p.status) ? p.status : 'update', occurredAt: p.occurredAt,
  } : {
    schema: p.schema, event: p.event, familyId: p.familyId, personId: p.personId, entityId: p.entityId,
    label: 'Care reminder', dueAt: p.dueAt, summary: 'Care reminder due; details stay in Sahaj.', occurredAt: p.occurredAt,
  };
  const result = await postRedactedWebhook({ url: rawUrl, payload: sanitizeReportValue(safePayload),
    timeoutMs: params.timeoutMs, fetchImpl: params.fetchImpl,
    audit: params.audit ?? (async () => { throw new Error('audit_not_configured'); }) });
  return { sent: result.ok, hook: params.hook, ...(result.status !== null ? { status: result.status } : {}),
    ...(result.error ? { error: result.error } : {}) };
}
