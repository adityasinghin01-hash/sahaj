import { createHash, randomUUID } from 'node:crypto';
export type WebhookAttempt = { attemptId: string; payloadHash: string };
/** Optional integrations have a hard deadline even if an injected transport ignores AbortSignal. */
export async function postRedactedWebhook(input: {
  url: string; payload: unknown; audit: (attempt: WebhookAttempt) => Promise<void>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; timeoutMs?: number;
}): Promise<{ ok: boolean; status: number | null; error?: string }> {
  let url: URL;
  try { url = new URL(input.url); } catch { return { ok: false, status: null, error: 'invalid_url' }; }
  if (!['https:', 'http:'].includes(url.protocol)) return { ok: false, status: null, error: 'invalid_url' };
  const body = JSON.stringify(input.payload);
  const payloadHash = createHash('sha256').update(body).digest('hex');
  const attemptId = randomUUID();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async () => {
    try {
      // No HTTP request if its signed audit row cannot be written first.
      await input.audit({ attemptId, payloadHash });
      if (controller.signal.aborted) return { ok: false, status: null, error: 'timeout' };
      const response = await (input.fetchImpl ?? fetch)(url.toString(), { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sahaj-idempotency-key': payloadHash },
        body, signal: controller.signal, redirect: 'error' });
      return { ok: response.ok, status: response.status, ...(!response.ok ? { error: 'http_error' } : {}) };
    } catch { return { ok: false, status: null, error: controller.signal.aborted ? 'timeout' : 'webhook_failed' }; }
  };
  try {
    return await Promise.race([work(), new Promise<{ ok: boolean; status: null; error: string }>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ ok: false, status: null, error: 'timeout' }); },
        Math.min(3000, Math.max(1, input.timeoutMs ?? 3000)));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
