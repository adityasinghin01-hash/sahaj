import { createHmac, timingSafeEqual } from "node:crypto";
import { AdapterError } from "./contracts";

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Verify bytes before parsing JSON. A reserialized body is not equivalent. */
export function verifyWhatsAppSignature(rawBody: string | Uint8Array, signature: string | null, appSecret: string): boolean {
  if (!appSecret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  return equal(signature, `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`);
}

/** Only application/x-www-form-urlencoded callbacks. URL must be the configured public URL. */
export function verifyTwilioFormSignature(publicUrl: string, params: URLSearchParams, signature: string | null, authToken: string): boolean {
  if (!authToken || !signature || !publicUrl.startsWith("https://")) return false;
  let value = publicUrl;
  // Twilio Node SDK toFormUrlEncodedParam: unique repeated values, sorted.
  for (const key of [...new Set(params.keys())].sort()) {
    for (const item of [...new Set(params.getAll(key))].sort()) value += key + item;
  }
  return equal(signature, createHmac("sha1", authToken).update(value).digest("base64"));
}

export interface ButtonClaims { personId: string; from: string; action: string; objectId: string; nonce: string; expiresAt: number }
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
// Bindings are not embedded in the token (a 256-char button id cannot hold them, and phone numbers must not be exposed).
// They are covered by the MAC instead, so the verifier must supply the same values from its own trusted context.
const mac = (c: ButtonClaims, secret: string) =>
  createHmac("sha256", secret).update(JSON.stringify(["sahaj-wa-button-v1", c.personId, c.from, c.action, c.objectId, c.nonce, c.expiresAt])).digest("base64url");

/** Token format: `<nonce>.<expiresAt base36>.<mac>` (about 80 chars). */
export function signWhatsAppButton(claims: ButtonClaims, secret: string): string {
  if (secret.length < 32 || !claims.personId || !claims.from || !claims.action || !claims.objectId || !NONCE.test(claims.nonce) || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= 0) throw new AdapterError("invalid_payload");
  return `${claims.nonce}.${claims.expiresAt.toString(36)}.${mac(claims, secret)}`;
}
/**
 * Caller MUST atomically consume the returned nonce (e.g. INSERT ... ON CONFLICT DO NOTHING on a unique
 * nonce column, treating zero inserted rows as replay) before acting. This function cannot detect replay.
 */
export function verifyWhatsAppButton(token: string, expected: { personId: string; from: string; action: string; objectId: string }, secret: string, now = Date.now()): { nonce: string; expiresAt: number } {
  if (secret.length < 32 || typeof token !== "string" || token.length > 256) throw new AdapterError("invalid_signature");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AdapterError("invalid_signature");
  const [nonce, exp, tag] = parts as [string, string, string];
  const expiresAt = /^[0-9a-z]{1,12}$/.test(exp) ? parseInt(exp, 36) : NaN;
  if (!NONCE.test(nonce) || !Number.isSafeInteger(expiresAt)) throw new AdapterError("invalid_signature");
  const claims: ButtonClaims = { ...expected, nonce, expiresAt };
  if (!Number.isFinite(now) || !expected.personId || !expected.from || !expected.action || !expected.objectId || !equal(tag, mac(claims, secret)) || expiresAt <= now) throw new AdapterError("invalid_signature");
  return { nonce, expiresAt };
}
