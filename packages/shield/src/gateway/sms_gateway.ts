/**
 * POST /api/sms/gateway: an SMS that a keypad parent forwarded to "1 Sahaj SMS", relayed by the
 * spare Android phone in gateway mode.
 *
 * Steps: verify the shared secret → validate → look up the sender by phone hash → mask →
 * idempotent insert → hand to the brain through waitUntil → respond. The handler awaits only
 * the lookup and the insert, so it answers well under a second.
 *
 * Nothing is stored for a sender that is not a registered keypad parent, and neither the phone
 * number nor the unmasked body is ever stored or logged.
 */
import { z } from "zod";
import { ShieldEvent } from "@sahaj/shared";
import { findLinks, mask } from "../rules";
import { constantTimeEqual, sha256Hex } from "../server/crypto";
import { background, json, readBodyBytes } from "../server/http";
import { maskDigits } from "../tools/mask";
import { numberFingerprint } from "../warnings/fingerprint";
import type { NewGatewayEventRow, SmsGatewayDeps } from "./types";

export const SMS_GATEWAY_SECRET_HEADER = "x-sahaj-gateway-secret";
export const SMS_GATEWAY_MIN_SECRET_LENGTH = 32;
/** A long concatenated SMS is a few KB; 16 KB leaves room for the JSON around it. */
export const SMS_GATEWAY_MAX_BODY_BYTES = 16 * 1024;
/** shield_events.masked_text limit. */
const MASKED_TEXT_MAX = 2000;

const UNAUTHORIZED = { error: "unauthorized" } as const;

export const SmsGatewayRequest = z.object({
  from: z.string().min(1).max(64),
  body: z.string().min(1).max(8000),
  /** ISO 8601 with an offset, or unix milliseconds. Stored as canonical UTC. */
  received_at: z.union([z.string().datetime({ offset: true }), z.number().int().nonnegative()]),
  gateway_id: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
});
export type SmsGatewayRequest = z.infer<typeof SmsGatewayRequest>;

/** Any run of 4+ digits in any script (digits split by up to two separators count as one run). */
const ANY_DIGIT_RUN = /\p{Nd}(?:[\s\-.,/()]{0,2}\p{Nd}){3,}/gu;

/**
 * The rules mask() first (URLs, OTPs, phone numbers), then the voice-tool digit mask as a second
 * pass, then a last catch-all for digits of other scripts. The result never holds 4+ digits.
 */
export function maskGatewayBody(body: string): string {
  return maskDigits(mask(body)).replace(ANY_DIGIT_RUN, "<NUM>").slice(0, MASKED_TEXT_MAX);
}

/** Registrable domains of the links in the body. 4+ digit runs in a host become "#", as in mask(). */
function linkDomains(body: string): string[] {
  const domains = findLinks(body).map((link) => link.registrableDomain.replace(/[0-9]{4,}/g, "#"));
  return [...new Set(domains)].filter((d) => d !== "").slice(0, 20);
}

/** Constant-time compare over SHA-256 digests, so the time does not depend on either length. */
async function secretMatches(given: string | null, expected: string): Promise<boolean> {
  if (given === null) return false;
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(expected)]);
  return constantTimeEqual(a, b);
}

export async function handleSmsGateway(req: Request, deps: SmsGatewayDeps): Promise<Response> {
  try {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    const secret = deps.env.SMS_GATEWAY_SECRET;
    if (typeof secret !== "string" || secret.length < SMS_GATEWAY_MIN_SECRET_LENGTH) {
      throw new Error("SMS_GATEWAY_SECRET is missing or shorter than 32 characters");
    }

    // 1. verify (nothing is read or written before this passes)
    if (!(await secretMatches(req.headers.get(SMS_GATEWAY_SECRET_HEADER), secret))) {
      return json(401, UNAUTHORIZED);
    }

    // 2. validate
    const raw = await readBodyBytes(req, SMS_GATEWAY_MAX_BODY_BYTES);
    if (!raw) return json(413, { error: "body_too_large" });
    let input: SmsGatewayRequest;
    try {
      const result = SmsGatewayRequest.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
      if (!result.success) return json(400, { error: "invalid_request" });
      input = result.data;
    } catch {
      return json(400, { error: "invalid_request" });
    }
    const occurredAt = new Date(input.received_at);
    if (Number.isNaN(occurredAt.getTime())) return json(400, { error: "invalid_request" });

    // 3. sender must be a registered keypad parent (lookup by hash only)
    const phoneHash = await numberFingerprint(input.from);
    const parent = phoneHash ? await deps.db.findParentByPhoneHash(phoneHash) : null;
    if (!parent) return json(200, { ignored: true });

    // 4. mask, then idempotent insert
    const maskedText = maskGatewayBody(input.body);
    const occurred = occurredAt.toISOString();
    // The key hashes the masked body, so an OTP cannot be recovered from it by brute force.
    const idempotencyKey = await sha256Hex(`${input.gateway_id}\n${occurred}\n${maskedText}`);
    const row: NewGatewayEventRow = {
      idempotency_key: idempotencyKey,
      family_id: parent.family_id,
      parent_id: parent.parent_id,
      channel: "gateway_sms",
      kind: "sms",
      occurred_at: occurred,
      masked_text: maskedText,
      link_domains: linkDomains(input.body),
      context: { via: "sms_gateway" },
    };
    // Same contract as a phone event; fails closed if the row would not be a valid ShieldEvent.
    ShieldEvent.parse(row);
    const inserted = await deps.db.insertGatewayEvent(row);
    if ("duplicate" in inserted) return json(200, { ok: true, duplicate: true });

    // 5. hand off without waiting for the brain
    background(deps, "shield.gateway.brain_failed", () => deps.brain.runForEvent(inserted.id), {
      eventId: inserted.id,
    });

    // 6. respond
    return json(200, { ok: true, event_id: inserted.id });
  } catch (err) {
    deps.log?.error("shield.gateway.failed", { error: err instanceof Error ? err.message : String(err) });
    return json(500, { error: "server_error" });
  }
}
