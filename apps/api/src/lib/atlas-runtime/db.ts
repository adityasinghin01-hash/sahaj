import { createHash } from "node:crypto";

/** Narrow service-role RPC surface. Tests inject fakes; production passes the Supabase service client. */
export interface RpcResult { data: unknown; error: { code?: string; message?: string } | null }
export interface RpcDb { rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult> }

export class RuntimeError extends Error {
  constructor(public readonly code: string) { super(code); }
}

/** Only code strings leave this module; database messages may carry identifiers. */
export async function call<T = unknown>(db: RpcDb, name: string, args: Record<string, unknown>, code: string): Promise<T> {
  let result: RpcResult;
  try { result = await db.rpc(name, args); } catch { throw new RuntimeError(code); }
  if (result.error) throw new RuntimeError(result.error.code === "40001" ? "stale_lease" : code);
  return result.data as T;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Deterministic RFC 4122-shaped id so retries and checkpoint replays reuse the same row. */
export function stableUuid(parts: readonly string[]): string {
  const h = createHash("sha256").update(JSON.stringify(parts)).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export interface JobLease { familyId: string; jobId: string; token: string }
