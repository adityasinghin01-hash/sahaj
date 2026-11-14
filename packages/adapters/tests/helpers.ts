import { expect } from "vitest";
import { AdapterError, type ActionAuthorization, type DispatchLedger, type FetchTransport, type ProviderRequest } from "../src/contracts";

export const SECRET = "synthetic-secret-synthetic-secret-0123456789";
export const PERSON = "11111111-1111-4111-8111-111111111111";
export const OTHER_PERSON = "22222222-2222-4222-8222-222222222222";
export const KEY = "idem-0001";
export const PHONE = "+919000000001"; // synthetic, not a real subscriber

export function auth(action: string, over: Partial<ActionAuthorization> = {}): ActionAuthorization {
  return { decision: "allow", consent: true, personId: PERSON, action, idempotencyKey: KEY, expiresAt: Date.now() + 60_000, ...over };
}
export function req<T>(action: string, payload: T, over: Partial<ProviderRequest<T>> = {}): ProviderRequest<T> {
  return { personId: PERSON, idempotencyKey: KEY, authorization: auth(action), payload, ...over };
}

export class MemoryLedger implements DispatchLedger {
  claims = new Set<string>();
  state = new Map<string, string>();
  async claim(key: string): Promise<boolean> { if (this.claims.has(key)) return false; this.claims.add(key); this.state.set(key, "claimed"); return true; }
  async markDispatched(key: string, ref: string) { this.state.set(key, `dispatched:${ref}`); }
  async markFailed(key: string) { this.state.set(key, "failed"); }
  async markDeliveryUnknown(key: string) { this.state.set(key, "unknown"); }
}

export interface Recorded { url: string; init: RequestInit }
/** Scripted transport. Never touches the network. */
export function scripted(...responses: Array<Response | Error | ((init: RequestInit) => Promise<Response>)>): { transport: FetchTransport; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const queue = [...responses];
  const transport: FetchTransport = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra call");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(init);
    return next;
  };
  return { transport, calls };
}
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Never resolves until aborted: simulates a network timeout. */
export const hang = (): ((init: RequestInit) => Promise<Response>) => (init) =>
  new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));

export async function code(promise: Promise<unknown> | (() => unknown)): Promise<string> {
  try { await (typeof promise === "function" ? promise() : promise); } catch (e) { expect(e).toBeInstanceOf(AdapterError); return (e as AdapterError).code; }
  throw new Error("expected AdapterError");
}
