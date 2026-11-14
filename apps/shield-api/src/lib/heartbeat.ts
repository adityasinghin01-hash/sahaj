import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import { SHIELD_HEADERS, SHIELD_MAX_SKEW_MS } from "@sahaj/shared";
import {
  deriveDeviceSecret,
  SHIELD_EVENT_MAX_BODY_BYTES,
  signShieldBody,
  type ShieldDeviceRow,
  type ShieldProtections,
} from "@sahaj/shield";
import { constantTimeEqual } from "./auth";

const TS_PATTERN = /^\d{1,16}$/;
const SIG_PATTERN = /^[0-9a-fA-F]{64}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const PAIRING_SECRET_MIN_BYTES = 32;

export const HeartbeatProtectionsSchema = z
  .object({
    sms: z.boolean(),
    screening: z.boolean(),
    redirection: z.boolean(),
    usage: z.boolean(),
    notifications: z.boolean(),
    overlay: z.boolean(),
  })
  .strict();

export const HeartbeatBodySchema = z.object({
  device_id: z.string().min(1).max(64),
  protections: HeartbeatProtectionsSchema,
  android_version: z.string().min(1).max(32),
  app_version: z.string().min(1).max(64),
  sent_at: z.string().datetime({ offset: true }),
});

export type HeartbeatBody = z.infer<typeof HeartbeatBodySchema>;

export interface UpdatedDeviceHeartbeat {
  id: string;
  protections: ShieldProtections;
  android_version: string | null;
  app_version: string | null;
  last_heartbeat_at: string;
}

export interface HeartbeatStore {
  getDevice: (deviceId: string) => Promise<ShieldDeviceRow | null>;
  updateDeviceHeartbeat: (input: {
    deviceId: string;
    protections: ShieldProtections;
    androidVersion: string;
    appVersion: string;
    sentAt: Date;
  }) => Promise<UpdatedDeviceHeartbeat | null>;
}

export function createPgHeartbeatStore(auxSql: Sql): HeartbeatStore {
  return {
    async getDevice(deviceId) {
      const rows = await auxSql<ShieldDeviceRow[]>`
        select id, family_id, person_id, device_secret_hash
        from public.shield_devices
        where id = ${deviceId}
        limit 1`;
      return rows[0] ?? null;
    },
    async updateDeviceHeartbeat(input) {
      const sentIso = input.sentAt.toISOString();
      const rows = await auxSql<UpdatedDeviceHeartbeat[]>`
        update public.shield_devices
        set protections = ${auxSql.json(input.protections)},
            android_version = ${input.androidVersion},
            app_version = ${input.appVersion},
            last_heartbeat_at = ${sentIso}::timestamptz
        where id = ${input.deviceId}
          and (last_heartbeat_at is null or last_heartbeat_at <= ${sentIso}::timestamptz)
        returning id, protections, android_version, app_version, last_heartbeat_at::text as last_heartbeat_at`;
      return rows[0] ?? null;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function readLimitedBodyBytes(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return null;
  const bytes = new Uint8Array(await req.arrayBuffer());
  return bytes.length > maxBytes ? null : bytes;
}

function sha256Utf8Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Verifies device HMAC headers using the exact same rules and crypto helpers as handleShieldEvent
 * in packages/shield/src/server/event.ts, then updates shield_devices on valid heartbeat JSON.
 */
export async function handleShieldHeartbeat(
  req: Request,
  deps: {
    store: HeartbeatStore;
    pairingSecret: string | undefined;
    clock: { now(): Date };
  },
): Promise<Response> {
  try {
    if (req.method !== "POST") return jsonResponse(405, { error: "method_not_allowed" });

    const secret = deps.pairingSecret ?? "";
    if (secret.length < PAIRING_SECRET_MIN_BYTES) {
      throw new Error("SHIELD_DEVICE_PAIRING_SECRET is missing or shorter than 32 characters");
    }

    const deviceId = req.headers.get(SHIELD_HEADERS.device);
    const ts = req.headers.get(SHIELD_HEADERS.ts);
    const sig = req.headers.get(SHIELD_HEADERS.sig);
    if (!deviceId || !ts || !sig) return jsonResponse(401, { error: "unauthorized" });
    if (!DEVICE_ID_PATTERN.test(deviceId) || !TS_PATTERN.test(ts) || !SIG_PATTERN.test(sig)) {
      return jsonResponse(401, { error: "unauthorized" });
    }

    const now = deps.clock.now();
    if (Math.abs(now.getTime() - Number(ts)) > SHIELD_MAX_SKEW_MS) {
      return jsonResponse(401, { error: "unauthorized" });
    }

    const raw = await readLimitedBodyBytes(req, SHIELD_EVENT_MAX_BODY_BYTES);
    if (!raw) return jsonResponse(413, { error: "body_too_large" });

    const device = await deps.store.getDevice(deviceId);
    if (!device) return jsonResponse(401, { error: "unauthorized" });

    const deviceSecret = await deriveDeviceSecret(secret, device.id);
    if (!constantTimeEqual(sha256Utf8Hex(deviceSecret), device.device_secret_hash.toLowerCase())) {
      return jsonResponse(401, { error: "unauthorized" });
    }
    const expectedSig = await signShieldBody(deviceSecret, ts, raw);
    if (!constantTimeEqual(sig.toLowerCase(), expectedSig)) {
      return jsonResponse(401, { error: "unauthorized" });
    }

    let body: HeartbeatBody;
    try {
      const parsed = HeartbeatBodySchema.safeParse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
      );
      if (!parsed.success) return jsonResponse(400, { error: "invalid_heartbeat" });
      body = parsed.data;
    } catch {
      return jsonResponse(400, { error: "invalid_heartbeat" });
    }

    if (body.device_id !== device.id) {
      return jsonResponse(401, { error: "unauthorized" });
    }

    const sentAt = new Date(body.sent_at);
    if (Number.isNaN(sentAt.getTime())) {
      return jsonResponse(400, { error: "invalid_heartbeat" });
    }

    const updated = await deps.store.updateDeviceHeartbeat({
      deviceId: device.id,
      protections: body.protections,
      androidVersion: body.android_version,
      appVersion: body.app_version,
      sentAt,
    });

    if (!updated) {
      return jsonResponse(200, { ok: true, device_id: device.id, stale: true });
    }

    return jsonResponse(200, {
      ok: true,
      device_id: updated.id,
      protections: updated.protections,
      android_version: updated.android_version,
      app_version: updated.app_version,
      last_heartbeat_at: updated.last_heartbeat_at,
    });
  } catch {
    return jsonResponse(500, { error: "server_error" });
  }
}

