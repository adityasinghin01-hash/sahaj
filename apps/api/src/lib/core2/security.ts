import { createHash } from "node:crypto";
import { safeTokenEquals } from "@/lib/secrets";
import { canonicalJson } from "@/lib/timeline";
import { encryptWebhook, payloadHash } from "@/lib/webhook-security";
import {
  Core2Error,
  type Core2Actor,
  type Core2AuthPort,
  type Core2CryptoPort,
  type Core2Repository,
} from "./contracts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7E]{1,128}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashCanonicalRequest(payload: unknown): string {
  try {
    return sha256Hex(canonicalJson(payload));
  } catch {
    throw new Core2Error("invalid_request", 400, "Request body contains non-canonical JSON values.");
  }
}

export function assertPlainObject(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Core2Error("invalid_request", 400, "Expected JSON object body.");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Core2Error("invalid_request", 400, "Invalid object prototype.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Core2Error("invalid_request", 400, `Unexpected field "${key}".`);
    }
  }
  return record;
}

export function assertValidUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new Core2Error("invalid_request", 400, `Field "${field}" must be a valid UUID.`);
  }
  return value.toLowerCase();
}

export function assertOptionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return assertValidUuid(value, field);
}

export function assertSafeString(
  value: unknown,
  field: string,
  minLen: number,
  maxLen: number,
): string {
  if (typeof value !== "string") {
    throw new Core2Error("invalid_request", 400, `Field "${field}" must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < minLen || trimmed.length > maxLen) {
    throw new Core2Error(
      "invalid_request",
      400,
      `Field "${field}" length must be between ${minLen} and ${maxLen}.`,
    );
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f) {
      throw new Core2Error("invalid_request", 400, `Field "${field}" contains invalid control characters.`);
    }
  }
  return trimmed;
}

export function assertBoundedInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Core2Error(
      "invalid_request",
      400,
      `Field "${field}" must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

export function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Core2Error("invalid_request", 400, `Field "${field}" must be a boolean.`);
  }
  return value;
}

export function assertIanaTimezone(value: unknown, field = "timezone"): string {
  const tz = assertSafeString(value, field, 1, 80);
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date(0));
  } catch {
    throw new Core2Error("invalid_request", 400, `Field "${field}" must be a valid IANA timezone.`);
  }
  return tz;
}

export function assertIsoTimestamp(value: unknown, field: string): string {
  const raw = assertSafeString(value, field, 10, 40);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Core2Error("invalid_request", 400, `Field "${field}" must be a valid ISO-8601 timestamp.`);
  }
  return new Date(parsed).toISOString();
}

export function parseIdempotencyKey(rawKey: string | null | undefined): string {
  if (!rawKey || !IDEMPOTENCY_KEY_RE.test(rawKey)) {
    throw new Core2Error(
      "idempotency_key_required",
      400,
      "Idempotency-Key header is required (1..128 printable ASCII characters).",
    );
  }
  return rawKey;
}

export async function authenticateCore2Actor(
  auth: Core2AuthPort,
  repo: Core2Repository,
  bearerToken: string | null | undefined,
  requestedFamilyId?: string | null,
): Promise<Core2Actor> {
  if (!bearerToken) {
    throw new Core2Error("unauthenticated", 401, "Missing bearer token.");
  }

  const verified = await auth.verifyBearer(bearerToken);
  if (!verified?.userId || !isUuid(verified.userId)) {
    throw new Core2Error("unauthenticated", 401, "Invalid or expired bearer token.");
  }

  const memberships = (await repo.listActiveMemberships(verified.userId)).filter(
    (m) => m.revokedAt === null,
  );
  if (memberships.length === 0) {
    throw new Core2Error("forbidden", 403, "No active family membership.");
  }

  if (requestedFamilyId !== undefined && requestedFamilyId !== null && requestedFamilyId !== "") {
    if (!isUuid(requestedFamilyId)) {
      throw new Core2Error("invalid_request", 400, "X-Sahaj-Family-Id header must be a valid UUID.");
    }
    const targetFamily = requestedFamilyId.toLowerCase();
    const match = memberships.find((m) => m.familyId.toLowerCase() === targetFamily);
    if (!match) {
      throw new Core2Error("forbidden", 403, "Actor is not an active member of the requested family.");
    }
    return {
      userId: verified.userId,
      familyId: match.familyId,
      personId: match.personId,
      role: match.role,
    };
  }

  if (memberships.length > 1) {
    throw new Core2Error(
      "family_selection_required",
      409,
      "Multiple active family memberships exist; specify X-Sahaj-Family-Id.",
    );
  }

  const only = memberships[0];
  return {
    userId: verified.userId,
    familyId: only.familyId,
    personId: only.personId,
    role: only.role,
  };
}

export function createWebhookCryptoPort(encryptionKey: string | undefined): Core2CryptoPort {
  if (!encryptionKey || encryptionKey.trim().length === 0) {
    return {
      encryptPayload() {
        throw new Core2Error("storage_unavailable", 503, "Encrypted storage key is not configured.");
      },
      encryptSecretNote() {
        throw new Core2Error("storage_unavailable", 503, "Encrypted storage key is not configured.");
      },
    };
  }
  const key = encryptionKey;
  return {
    encryptPayload(familyId, eventId, source, payload) {
      const body = Buffer.from(canonicalJson({ family_id: familyId, ...payload }), "utf8");
      return {
        payloadHash: payloadHash(body),
        payloadCiphertext: encryptWebhook(body, key, `${source}:${eventId}`),
      };
    },
    encryptSecretNote(aad, note) {
      const body = Buffer.from(canonicalJson(note), "utf8");
      return encryptWebhook(body, key, aad);
    },
  };
}

export function assertPaginationLimit(raw: string | null | undefined, fallback = 20): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Core2Error("invalid_request", 400, "limit must be a positive integer <= 50.");
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > 50) {
    throw new Core2Error("invalid_request", 400, "limit must be between 1 and 50.");
  }
  return n;
}

/** DEMO_TIMER_SCALE divides Core 2 overdue timers cleanly; missing, invalid, or <= 0 counts as 1. */
export function getDemoTimerScale(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DEMO_TIMER_SCALE;
  if (!raw) return 1;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export function scaleDurationMs(
  baseMs: number,
  env: Record<string, string | undefined> = process.env,
  minMs = 1_000,
): number {
  const scale = getDemoTimerScale(env);
  if (scale === 1) return baseMs;
  return Math.max(minMs, Math.round(baseMs / scale));
}

export function assertCronSecret(
  cronHeader: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  const secret = env.CRON_SECRET;
  if (!secret) {
    throw new Core2Error("unavailable", 503, "Cron authentication is not configured.");
  }
  if (!safeTokenEquals(cronHeader ?? null, secret)) {
    throw new Core2Error("unauthenticated", 401, "Invalid or missing cron secret.");
  }
}

export function assertSarvamToolToken(
  bearerToken: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  const secret = env.SARVAM_TOOL_TOKEN || env.SARVAM_TOOL_BEARER;
  if (!secret) {
    throw new Core2Error("unavailable", 503, "Sarvam tool authentication is not configured.");
  }
  if (!safeTokenEquals(bearerToken ?? null, secret)) {
    throw new Core2Error("unauthenticated", 401, "Invalid or missing Sarvam tool bearer token.");
  }
}

