import { bearerToken as extractBearer } from "@/lib/media/handler";
import { Core2Error } from "./contracts";

export { extractBearer };

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: SECURITY_HEADERS,
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof Core2Error) {
    const headers =
      err.status === 401
        ? { ...SECURITY_HEADERS, "www-authenticate": "Bearer" }
        : SECURITY_HEADERS;
    return new Response(
      JSON.stringify({ error: err.code, message: err.message }),
      { status: err.status, headers },
    );
  }
  return new Response(
    JSON.stringify({ error: "unavailable", message: "Core 2 service unavailable." }),
    { status: 503, headers: SECURITY_HEADERS },
  );
}

export function extractAuthContext(request: Request): {
  bearerToken: string | null;
  familyIdHeader: string | null;
  idempotencyKeyHeader: string | null;
} {
  return {
    bearerToken: extractBearer(request),
    familyIdHeader: request.headers.get("x-sahaj-family-id"),
    idempotencyKeyHeader: request.headers.get("idempotency-key"),
  };
}

export async function readBoundedJson(request: Request, maxBytes = 65_536): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new Core2Error("invalid_request", 400, "Request body exceeds size limit.");
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new Core2Error("invalid_request", 400, "Request body exceeds size limit.");
  }
  if (!raw.trim()) {
    throw new Core2Error("invalid_request", 400, "Expected non-empty JSON body.");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Core2Error("invalid_request", 400, "Malformed JSON body.");
  }
}

export async function readOptionalJson(request: Request, maxBytes = 65_536): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    throw new Core2Error("invalid_request", 400, "Request body exceeds size limit.");
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    throw new Core2Error("invalid_request", 400, "Request body exceeds size limit.");
  }
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Core2Error("invalid_request", 400, "Malformed JSON body.");
  }
}

