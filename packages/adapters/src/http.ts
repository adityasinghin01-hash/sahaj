import { AdapterError, type FetchTransport, type ProviderName } from "./contracts";

export interface HttpOptions {
  provider: ProviderName;
  transport: FetchTransport;
  timeoutMs?: number;
  maxBytes?: number;
  /** true: a failed call is safe to repeat (reads). false: side effect, failure after sending is delivery-unknown. */
  readOnly: boolean;
}
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_JSON_BYTES = 1_000_000;

/** Single bounded request. No redirects, no raw bodies in errors. */
export async function send(url: string, init: RequestInit, opts: HttpOptions): Promise<{ status: number; body: Uint8Array; contentType: string }> {
  const { provider } = opts;
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120_000 || !Number.isSafeInteger(limit) || limit <= 0 || limit > 100 * 1024 * 1024) throw new AdapterError("invalid_payload", provider);
  const unknown = () => new AdapterError(opts.readOnly ? "provider_unavailable" : "delivery_unknown", provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    let response: Response;
    try {
      response = await opts.transport(url, { ...init, redirect: "manual", signal: controller.signal });
    } catch {
      throw unknown();
    }
    const contentType = response.headers.get("content-type") ?? "";
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel().catch(() => undefined);
      throw new AdapterError("payload_too_large", provider, response.status);
    }
    let body: Uint8Array;
    try {
      body = await readBounded(response, limit, provider, controller.signal);
      if (controller.signal.aborted) throw unknown();
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw unknown();
    }
    if (response.status >= 300 && response.status < 400) throw new AdapterError("provider_rejected", provider, response.status);
    if (response.status >= 500) throw unknown();
    if (response.status === 429 && opts.readOnly) throw new AdapterError("provider_unavailable", provider, 429);
    if (response.status < 200 || response.status >= 300) throw new AdapterError("provider_rejected", provider, response.status);
    return { status: response.status, body, contentType };
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(response: Response, limit: number, provider: ProviderName, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) throw new Error("aborted");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new AdapterError("payload_too_large", provider, response.status);
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export function parseJson(body: Uint8Array, provider: ProviderName): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new AdapterError("provider_rejected", provider);
}

/** HTTPS only, no credentials, default port, no IP literals or localhost, host must match the allowlist. Entries: "host" or "*.suffix". */
export function assertSafeUrl(raw: string, allowedHosts: readonly string[], provider?: ProviderName): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AdapterError("unsafe_url", provider); }
  const host = url.hostname.toLowerCase();
  const isIp = /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[");
  const allowed = allowedHosts.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith("*.") ? host.endsWith(e.slice(1)) && host.length > e.length - 1 : host === e;
  });
  if (url.protocol !== "https:" || url.username || url.password || url.port || isIp || host === "localhost" || !host.includes(".") || !allowed) {
    throw new AdapterError("unsafe_url", provider);
  }
  return url;
}

const E164 = /^\+[1-9]\d{7,14}$/;
export function assertE164(value: unknown): string {
  if (typeof value !== "string" || !E164.test(value)) throw new AdapterError("invalid_payload");
  return value;
}
/** Digits-only form for comparing numbers that providers format inconsistently (number vs string, with/without +). */
export function digits(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value).replace(/\D/g, "") : "";
}
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown, max = 512): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
