import { isLivePaired, type ApiResult } from './maa-api';
import { shield, shieldAvailable } from './shield';

const REQUEST_TIMEOUT_MS = 12_000;

export type MaaProofChallenge = {
  id: string;
  family_id: string;
  requester_person_id: string;
  subject_person_id: string;
  word_token: string;
  prompt_hi: string;
  prompt_en: string;
  status: 'pending' | 'verified' | 'word_mismatch' | 'expired' | 'escalated';
  ttl_seconds: number;
  expires_at: string;
  answered_at: string | null;
  verified_at: string | null;
  escalated_at: string | null;
  voice_media_id: string | null;
  voice_post_id: string | null;
  stt_matched: boolean;
  incident_id: string | null;
  offered_contact_name: string | null;
  freshness_seconds: number | null;
  freshness_stamp_hi: string | null;
  freshness_stamp_en: string | null;
  escalation_message_hi: string | null;
  escalation_message_en: string | null;
  media_url: string | null;
  media_expires_in: number | null;
  attempts: number;
  created_at: string;
};

export type MaaAnyPhoneAlert = {
  id: string;
  family_id: string;
  subject_person_id: string;
  incident_id: string;
  offered_contact_name: string | null;
  granted_powers: string[];
  denied_powers: string[];
  code_word_rotated: boolean;
  voice_post_id: string | null;
  media_url: string | null;
  media_expires_in: number | null;
  status_message_hi: string;
  status_message_en: string;
  created_at: string;
};

export type MaaProofDashboard = {
  ok: true;
  family_id: string;
  parent_person_id: string;
  proof: MaaProofChallenge | null;
  any_phone: MaaAnyPhoneAlert | null;
};

async function signedProofFetch<T>(
  path: string,
  method: 'GET' | 'POST',
  bodyObj?: Record<string, unknown>,
): Promise<ApiResult<T>> {
  if (!isLivePaired() || !shieldAvailable) {
    return { ok: false, kind: 'not_paired' };
  }
  const baseUrl = shield.getServerAddress().replace(/\/+$/, '');
  const rawBody = method === 'POST' ? JSON.stringify(bodyObj ?? {}) : '';
  const signedHeaders = shield.signRequest(rawBody);
  if (!signedHeaders || !baseUrl) {
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

export async function fetchMaaProofDashboard(): Promise<ApiResult<MaaProofDashboard>> {
  return signedProofFetch<MaaProofDashboard>('/api/core2/maa-proof', 'GET');
}

export async function requestMaaProofChallenge(): Promise<
  ApiResult<{ ok: true; challenge: MaaProofChallenge }>
> {
  return signedProofFetch<{ ok: true; challenge: MaaProofChallenge }>(
    '/api/core2/maa-proof',
    'POST',
    {},
  );
}

export function formatFreshnessDisplay(
  verifiedAtIso: string | null,
  fallbackHi: string | null,
  fallbackEn: string | null,
  lang: 'hi' | 'en',
  nowMs: number,
): string {
  if (!verifiedAtIso) {
    return (lang === 'hi' ? fallbackHi : fallbackEn) ?? '';
  }
  const verifiedMs = Date.parse(verifiedAtIso);
  if (!Number.isFinite(verifiedMs)) {
    return (lang === 'hi' ? fallbackHi : fallbackEn) ?? '';
  }
  const secs = Math.max(0, Math.round((nowMs - verifiedMs) / 1000));
  if (secs < 60) {
    return lang === 'hi'
      ? `Riya ne ${secs} second pehle ye kaha.`
      : `Riya said this ${secs} seconds ago.`;
  }
  const mins = Math.max(1, Math.round(secs / 60));
  return lang === 'hi'
    ? `Riya ne ${mins} minute pehle ye kaha.`
    : `Riya said this ${mins} minutes ago.`;
}
