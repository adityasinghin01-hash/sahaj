import { createHash } from "node:crypto";
import { WebhookError } from "@sahaj/adapters";
export { WebhookError, encryptWebhook, decryptWebhook, identityHash } from "@sahaj/adapters";

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

export const payloadHash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
