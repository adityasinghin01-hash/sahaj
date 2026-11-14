/**
 * POST /api/shield/event: a signed, masked ShieldEvent from a paired parent phone.
 * The five webhook steps: verify → validate → idempotent insert → hand off (waitUntil) → respond.
 */
import { SHIELD_HEADERS, SHIELD_MAX_SKEW_MS, ShieldEvent } from "@sahaj/shared";
import { constantTimeEqual, deriveDeviceSecret, sha256Hex, signShieldBody } from "./crypto";
import { background, json, readBodyBytes } from "./http";
import { assertPairingSecret } from "./pairing";
import type { NewShieldEventRow, ShieldServerDeps } from "./types";

/** masked_text is ≤ 2000 chars; 16 KB leaves room for the rest of the event. */
export const SHIELD_EVENT_MAX_BODY_BYTES = 16 * 1024;

const UNAUTHORIZED = { error: "unauthorized" } as const;
const TS_PATTERN = /^\d{1,16}$/;
const SIG_PATTERN = /^[0-9a-fA-F]{64}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * True if the text holds a run of 4+ decimal digits in any script, counting digits split by up to two
 * separators (space, dash, dot, comma, slash, bracket) as one run. Same rule as maskDigits, so any
 * text maskDigits left alone passes.
 */
export function hasUnmaskedDigits(text: string): boolean {
  return /\p{Nd}(?:[\s\-.,/()]{0,2}\p{Nd}){3,}/u.test(text);
}

export async function handleShieldEvent(req: Request, deps: ShieldServerDeps): Promise<Response> {
  try {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    assertPairingSecret(deps);

    // 1. verify (nothing is written before this passes)
    const deviceId = req.headers.get(SHIELD_HEADERS.device);
    const ts = req.headers.get(SHIELD_HEADERS.ts);
    const sig = req.headers.get(SHIELD_HEADERS.sig);
    if (!deviceId || !ts || !sig) return json(401, UNAUTHORIZED);
    if (!DEVICE_ID_PATTERN.test(deviceId) || !TS_PATTERN.test(ts) || !SIG_PATTERN.test(sig)) {
      return json(401, UNAUTHORIZED);
    }
    const now = deps.clock.now();
    if (Math.abs(now.getTime() - Number(ts)) > SHIELD_MAX_SKEW_MS) return json(401, UNAUTHORIZED);

    const raw = await readBodyBytes(req, SHIELD_EVENT_MAX_BODY_BYTES);
    if (!raw) return json(413, { error: "body_too_large" });

    const device = await deps.db.getDevice(deviceId);
    if (!device) return json(401, UNAUTHORIZED);
    const deviceSecret = await deriveDeviceSecret(deps.env.SHIELD_DEVICE_PAIRING_SECRET, device.id);
    // The row's hash must match the derived secret (catches a rotated pairing secret or a tampered row).
    if (!constantTimeEqual(await sha256Hex(deviceSecret), device.device_secret_hash.toLowerCase())) {
      return json(401, UNAUTHORIZED);
    }
    const expectedSig = await signShieldBody(deviceSecret, ts, raw);
    if (!constantTimeEqual(sig.toLowerCase(), expectedSig)) return json(401, UNAUTHORIZED);

    // 2. validate
    let event: ShieldEvent;
    try {
      const result = ShieldEvent.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
      if (!result.success) return json(400, { error: "invalid_event" });
      event = result.data;
    } catch {
      return json(400, { error: "invalid_event" });
    }
    if (event.family_id !== device.family_id || event.device_id !== device.id || event.parent_id !== device.person_id) {
      return json(401, UNAUTHORIZED);
    }
    if (event.masked_text !== undefined && hasUnmaskedDigits(event.masked_text)) {
      return json(400, { error: "unmasked_digits" });
    }

    // Valid event from a live device.
    background(deps, "shield.event.heartbeat_failed", () => deps.db.touchHeartbeat(device.id, now), {
      deviceId: device.id,
    });

    // 3. idempotency
    const row: NewShieldEventRow = {
      idempotency_key: event.idempotency_key,
      family_id: event.family_id,
      parent_id: event.parent_id,
      device_id: device.id,
      channel: event.channel,
      kind: event.kind,
      occurred_at: event.occurred_at,
      masked_text: event.masked_text ?? null,
      sender_type: event.sender_type ?? null,
      caller_type: event.caller_type ?? null,
      link_domains: event.link_domains,
      matched_rules: event.matched_rules,
      local_level: event.local_level ?? null,
      context: event.context,
    };
    const inserted = await deps.db.insertEvent(row);
    if ("duplicate" in inserted) return json(200, { ok: true, duplicate: true });

    // 4. hand off without waiting for the brain
    const handoff = { eventId: inserted.id, familyId: event.family_id, parentId: event.parent_id };
    background(deps, "shield.event.enqueue_failed", () => deps.atlas.enqueueShieldEvent(handoff), {
      eventId: inserted.id,
    });

    // 5. respond
    return json(200, { ok: true, event_id: inserted.id });
  } catch (err) {
    const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : undefined;
    deps.log?.error("shield.event.failed", { error: err instanceof Error ? err.name : "unknown", ...(code ? { code } : {}) });
    return json(500, { error: "server_error" });
  }
}
