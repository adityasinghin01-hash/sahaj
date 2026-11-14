import { createHash, timingSafeEqual } from 'node:crypto';
import { redactSensitiveText } from '../../../../../packages/atlas/src/core1/family-reports';

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

function sanitizeZapierValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeZapierValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeZapierValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Posts a redacted payload to a configured Zapier catch hook (`ZAPIER_HOOK_Z1` / `ZAPIER_HOOK_Z5`).
 * Never posts if the env var is unset, and never throws or blocks caller flow on delivery failure.
 */
export async function postZapierHook(params: {
  hook: ZapierHookEnvKey;
  payload: ZapierZ1RefillPayload | ZapierZ5ReminderPayload;
  env?: Record<string, string | undefined>;
  fetchImpl?: ZapierFetch;
  timeoutMs?: number;
}): Promise<ZapierDispatchOutcome> {
  const env = params.env ?? process.env;
  const rawUrl = env[params.hook]?.trim();
  if (!rawUrl) {
    return { sent: false, hook: params.hook, skippedReason: 'not_configured' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { sent: false, hook: params.hook, skippedReason: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { sent: false, hook: params.hook, skippedReason: 'invalid_url' };
  }

  const fetchFn = params.fetchImpl ?? (globalThis.fetch as ZapierFetch);
  const timeoutMs = params.timeoutMs ?? 3000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const redacted = sanitizeZapierValue(params.payload);
    const res = await fetchFn(parsed.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(redacted),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        sent: false,
        hook: params.hook,
        status: res.status,
        error: `http_${res.status}`,
      };
    }
    return { sent: true, hook: params.hook, status: res.status };
  } catch (err) {
    return {
      sent: false,
      hook: params.hook,
      error: err instanceof Error ? err.message : 'zapier_post_failed',
    };
  } finally {
    clearTimeout(timer);
  }
}
