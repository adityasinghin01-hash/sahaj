/**
 * Web Crypto helpers (crypto.subtle), so this runs on Vercel Node and Edge alike.
 *
 * Byte conventions (the Kotlin side must match; see test/server/vectors.json):
 *  - Every string key and message is UTF-8 encoded.
 *  - device_secret = hex(HMAC-SHA256(key = UTF-8(SHIELD_DEVICE_PAIRING_SECRET), msg = UTF-8(device_id)))
 *  - sig = hex(HMAC-SHA256(key = UTF-8(device_secret hex string, 64 chars), msg = UTF-8(ts) || "." || raw body bytes))
 *  - hex is lowercase.
 */

const enc = new TextEncoder();

type Bytes = Uint8Array<ArrayBuffer>;

export function utf8(text: string): Bytes {
  return enc.encode(text) as Bytes;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export async function sha256Hex(data: string | Bytes): Promise<string> {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return toHex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

export async function hmacSha256Hex(key: string, message: string | Bytes): Promise<string> {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    "raw",
    utf8(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const msg = typeof message === "string" ? utf8(message) : message;
  return toHex(await globalThis.crypto.subtle.sign("HMAC", cryptoKey, msg));
}

/** Constant-time compare of two strings. Time depends only on the length of `expected`. */
export function constantTimeEqual(actual: string, expected: string): boolean {
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    diff |= (actual.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/** device_secret = hex(HMAC-SHA256(SHIELD_DEVICE_PAIRING_SECRET, device_id)). Derived, never stored. */
export function deriveDeviceSecret(pairingSecret: string, deviceId: string): Promise<string> {
  return hmacSha256Hex(pairingSecret, deviceId);
}

/** sig = hex(HMAC-SHA256(device_secret, `${ts}.${rawBody}`)) over the raw body bytes. */
export function signShieldBody(deviceSecret: string, ts: string, rawBody: string | Uint8Array): Promise<string> {
  const body = typeof rawBody === "string" ? utf8(rawBody) : rawBody;
  return hmacSha256Hex(deviceSecret, concatBytes(utf8(`${ts}.`), body));
}
