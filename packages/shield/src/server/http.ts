export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Reads the body as raw bytes, refusing anything over `maxBytes`. Returns null if too large. */
export async function readBodyBytes(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return null;
  const bytes = new Uint8Array(await req.arrayBuffer());
  return bytes.length > maxBytes ? null : bytes;
}

/** Fire-and-forget through waitUntil, with errors sent to the optional log (never thrown). */
export function background(
  deps: { waitUntil(p: Promise<unknown>): void; log?: { error(m: string, meta?: Record<string, unknown>): void } },
  label: string,
  work: () => Promise<unknown>,
  meta: Record<string, unknown> = {},
): void {
  let p: Promise<unknown>;
  try {
    p = work();
  } catch (err) {
    p = Promise.reject(err);
  }
  deps.waitUntil(
    p.catch((err: unknown) => {
      deps.log?.error(label, { ...meta, error: err instanceof Error ? err.message : String(err) });
    }),
  );
}
