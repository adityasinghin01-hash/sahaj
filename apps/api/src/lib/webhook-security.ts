import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

export class WebhookError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); }
}

/** Read bytes before decoding: signatures must cover exactly what the provider sent. */
export async function readWebhookBody(request: Request, maxBytes = 262144): Promise<Buffer> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new WebhookError("payload_too_large", 413);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new WebhookError("payload_too_large", 413); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function encryptionKey(hex: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(hex)) throw new WebhookError("invalid_encryption_configuration", 503);
  return Buffer.from(hex, "hex");
}

/** Store raw events encrypted; bind ciphertext to the source and provider event ID. */
export function encryptWebhook(body: Buffer, keyHex: string, context: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyHex), nonce);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(body), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptWebhook(value: string, keyHex: string, context: string): Buffer {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new WebhookError("invalid_ciphertext", 400);
  const nonce = Buffer.from(parts[1], "base64url"), tag = Buffer.from(parts[2], "base64url");
  if (nonce.length !== 12 || tag.length !== 16) throw new WebhookError("invalid_ciphertext", 400);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(keyHex), nonce);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]);
}

/** HMAC prevents enumeration of phone numbers from a leaked identity index. */
export function identityHash(source: string, account: string, externalId: string, secret: string): string {
  if (secret.length < 32) throw new WebhookError("invalid_identity_configuration", 503);
  return createHmac("sha256", secret).update(JSON.stringify([source, account, externalId])).digest("hex");
}

export const payloadHash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
