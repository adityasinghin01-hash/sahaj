import type { MediaDeps, MediaOptions, MediaResult } from "./contracts";
import { createMediaService } from "./service";

const HEADERS = { "cache-control": "no-store", "content-type": "application/json", "referrer-policy": "no-referrer" };

export function bearerToken(request: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : null;
}

function respond(result: MediaResult): Response {
  if (result.ok) return new Response(JSON.stringify({ url: result.url, expires_in: result.expiresInSeconds }), { status: 200, headers: HEADERS });
  const headers = result.status === 401 ? { ...HEADERS, "www-authenticate": "Bearer" } : HEADERS;
  return new Response(JSON.stringify({ error: result.code }), { status: result.status, headers });
}

/** Builds a GET handler. `kind` selects the lookup; the id comes from the route segment only. */
export function createMediaHandler(kind: "voicePost" | "callRecording", makeDeps: () => MediaDeps, options?: MediaOptions) {
  return async function handle(request: Request, id: string): Promise<Response> {
    let service;
    try { service = createMediaService(makeDeps(), options); }
    catch { return respond({ ok: false, code: "unavailable", status: 503 }); }
    return respond(await service[kind](bearerToken(request), id));
  };
}
