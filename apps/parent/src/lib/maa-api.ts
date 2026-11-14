import { shield, shieldAvailable } from './shield';

const REQUEST_TIMEOUT_MS = 12_000;
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export type MaaVoiceItem = {
  id: string;
  from_person_id: string;
  from_display_name: string;
  to_person_id: string;
  to_display_name: string;
  state: 'queued' | 'sent' | 'delivered' | 'heard' | 'failed';
  created_at: string;
  duration_s: number | null;
  played_at: string | null;
  reply_to: string | null;
  media_url: string | null;
  media_expires_in: number | null;
};

export type MaaUrgentStatus = {
  ok: true;
  id: string;
  family_id: string;
  subject_person_id: string;
  subject_display_name: string;
  state: 'open' | 'offered' | 'accepted' | 'escalated' | 'resolved' | 'cancelled';
  severity: 'routine' | 'urgent' | 'critical';
  responder: {
    person_id: string;
    display_name: string;
    promised_at: string | null;
  } | null;
  promised_at: string | null;
  created_at: string;
  eta_minutes: number | null;
  status_line_hi: string;
  status_line_en: string;
};

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'not_paired' | 'network_unreachable' | 'http_error'; status?: number; code?: string };

export function isLivePaired(): boolean {
  if (!shieldAvailable) return false;
  const status = shield.getStatus();
  const baseUrl = shield.getServerAddress();
  return Boolean(status?.paired && baseUrl);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = hasB1 ? bytes[i + 1]! : 0;
    const b2 = hasB2 ? bytes[i + 2]! : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_CHARS[(n >>> 18) & 63];
    out += BASE64_CHARS[(n >>> 12) & 63];
    out += hasB1 ? BASE64_CHARS[(n >>> 6) & 63] : '=';
    out += hasB2 ? BASE64_CHARS[n & 63] : '=';
  }
  return out;
}

export function makeIdempotencyKey(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now()}-${rand}`;
}

async function signedFetch<T>(
  path: string,
  method: 'GET' | 'POST',
  bodyObj?: Record<string, unknown>,
): Promise<ApiResult<T>> {
  const baseUrl = shield.getServerAddress().replace(/\/+$/, '');
  if (!shieldAvailable || !baseUrl) {
    return { ok: false, kind: 'not_paired' };
  }

  const rawBody = method === 'POST' ? JSON.stringify(bodyObj ?? {}) : '';
  const signedHeaders = shield.signRequest(rawBody);
  if (!signedHeaders) {
    return { ok: false, kind: 'not_paired' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        ...signedHeaders,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: rawBody } : {}),
    });

    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      return {
        ok: false,
        kind: 'http_error',
        status: res.status,
        code: typeof json?.error === 'string' ? json.error : `http_${res.status}`,
      };
    }

    return { ok: true, data: json as T };
  } catch {
    return { ok: false, kind: 'network_unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchMaaVoiceList(): Promise<ApiResult<{ family_id: string; person_id: string; items: MaaVoiceItem[] }>> {
  return signedFetch('/api/core1/maa/voice?limit=10', 'GET');
}

export async function markMaaVoicePlayed(postId: string): Promise<ApiResult<{ ok: true; id: string; state: 'heard'; played_at: string }>> {
  return signedFetch(`/api/core1/maa/voice/${encodeURIComponent(postId)}/played`, 'POST', {});
}

export async function sendMaaVoiceReply(params: {
  replyTo?: string | null;
  audioBase64: string;
  contentType: string;
  durationS: number;
  idempotencyKey: string;
}): Promise<ApiResult<{ ok: true; id: string; state: string; created_at: string }>> {
  return signedFetch('/api/core1/maa/voice/reply', 'POST', {
    ...(params.replyTo ? { reply_to: params.replyTo } : {}),
    audio_base64: params.audioBase64,
    content_type: params.contentType,
    duration_s: Math.min(30, Math.max(1, Math.round(params.durationS))),
    consent_granted: true,
    consent_version: 'v1',
    idempotency_key: params.idempotencyKey,
  });
}

export async function triggerMaaUrgent(idempotencyKey: string): Promise<ApiResult<MaaUrgentStatus>> {
  return signedFetch('/api/core1/maa/urgent', 'POST', {
    severity: 'urgent',
    idempotency_key: idempotencyKey,
  });
}

export async function fetchMaaUrgentStatus(incidentId: string): Promise<ApiResult<MaaUrgentStatus>> {
  return signedFetch(`/api/core1/maa/urgent/${encodeURIComponent(incidentId)}`, 'GET');
}
