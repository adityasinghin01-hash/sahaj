import { postRedactedWebhook } from '../redacted-webhook';
import { Core2Error } from "@/lib/core2/contracts";
import type { ZapierDispatcher, ZapierZ3Payload } from "./contracts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TS_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const FORBIDDEN_LOCATION_AND_CONTACT_KEYS = new Set([
  "phone", "phone_number", "phonenumber", "otp", "otp_code", "pin", "passcode", "password", "bank_account", "account_number", "gps",
  "phone_e164",
  "mobile",
  "msisdn",
  "caller",
  "from_number",
  "to_number",
  "from_label",
  "to_label",
  "route_ciphertext",
  "cab_note",
  "latitude",
  "longitude",
  "lat",
  "lng",
  "location",
  "locations",
  "location_trail",
  "coordinates",
  "address",
  "pickup",
  "dropoff",
  "zapier_url",
  "webhook_url",
]);

const GRAPHIC_TERMS_RE =
  /\b(bloodied|bleeding\s+profusely|severed|bone\s+sticking|unconscious\s+pool|corpse|mutilat|gore)\b/i;

/**
 * Redacts phone numbers, formatted numbers, and 4+ digit numeric runs (OTP/PIN)
 * while preserving short clock times like 01:12, UUIDs, and ISO timestamps.
 */
export function redactProseText(raw: string): string {
  if (!raw) return raw;
  if (UUID_RE.test(raw) || ISO_TS_RE.test(raw)) return raw;
  return raw
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "<PHONE>")
    .replace(/\b\d{4,}\b/g, "******")
    .trim();
}

export function sanitizeCalmSummary(raw: string): string {
  const cleaned = redactProseText(raw).replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 400) {
    throw new Core2Error("invalid_request", 400, "Calm summary must be between 1 and 400 characters");
  }
  if (GRAPHIC_TERMS_RE.test(cleaned)) {
    throw new Core2Error(
      "invalid_request",
      400,
      "Calm summary must stay gentle and never include graphic details",
    );
  }
  return cleaned;
}

export function toShortCalmVersion(summary: string, maxChars = 200): string {
  const safe = redactProseText(summary).replace(/\s+/g, " ").trim();
  if (safe.length <= maxChars) return safe;
  return `${safe.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Recursively strips forbidden location/phone keys and redacts phone/digit runs
 * from all prose strings before persisting or returning G9 / Zapier Z3 outputs.
 */
export function sanitizeReportValue<T>(input: T): T {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") {
    return redactProseText(input) as T;
  }
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map((item) => sanitizeReportValue(item)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (FORBIDDEN_LOCATION_AND_CONTACT_KEYS.has(key.toLowerCase())) {
      continue;
    }
    out[key] = sanitizeReportValue(value);
  }
  return out as T;
}

export function createDefaultZapierDispatcher(): ZapierDispatcher {
  return {
    async postZ3(
      hookUrl: string,
      payload: ZapierZ3Payload,
      timeoutMs: number,
    ): Promise<{ ok: boolean; status: number | null }> {
      // closeIncident writes the signed attempt before invoking this transport.
      const result = await postRedactedWebhook({ url: hookUrl, payload: sanitizeReportValue(payload),
        timeoutMs, audit: async () => {} });
      return { ok: result.ok, status: result.status };
    },
  };
}
