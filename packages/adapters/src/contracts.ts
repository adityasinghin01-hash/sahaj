export type ProviderName = "sarvam" | "twilio" | "whatsapp" | "telecmi";
export type FetchTransport = (url: string, init: RequestInit) => Promise<Response>;

/** Issued by the server's permission gate, never accepted from an HTTP client. */
export interface ActionAuthorization {
  decision: "allow" | "deny" | "ask";
  consent: boolean;
  personId: string;
  action: string;
  idempotencyKey: string;
  expiresAt: number;
}
export interface ProviderRequest<T> {
  personId: string;
  idempotencyKey: string;
  authorization: ActionAuthorization;
  payload: T;
}
export interface ProviderResult<T> {
  provider: ProviderName;
  idempotencyKey: string;
  data: T;
}
export type AdapterErrorCode =
  | "authorization_denied"
  | "invalid_payload"
  | "invalid_signature"
  | "provider_rejected"
  | "delivery_unknown"
  | "provider_unavailable"
  | "duplicate_dispatch"
  | "unknown_identity"
  | "unsafe_url"
  | "payload_too_large";
/** No raw responses, input payloads, phone numbers, or credentials in error messages. */
export class AdapterError extends Error {
  constructor(public readonly code: AdapterErrorCode, public readonly provider?: ProviderName, public readonly status?: number) {
    super(code);
    this.name = "AdapterError";
  }
}
export function requireAuthorization(request: ProviderRequest<unknown>, action: string, now = Date.now()): void {
  const grant = request.authorization;
  if (!Number.isFinite(now) || !grant || grant.decision !== "allow" || grant.consent !== true || grant.personId !== request.personId ||
      grant.action !== action || grant.idempotencyKey !== request.idempotencyKey || !request.personId ||
      !request.idempotencyKey || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= now) {
    throw new AdapterError("authorization_denied");
  }
}

/**
 * Durable dispatch ledger implemented by the backend (e.g. a unique-key row in Postgres).
 * `claim` MUST be atomic: exactly one caller per idempotencyKey gets `true`, and the claim
 * must be persisted BEFORE the provider is contacted.
 */
export interface DispatchLedger {
  claim(idempotencyKey: string, provider: ProviderName, action: string): Promise<boolean>;
  /** Provider accepted the action. `providerRef` is the provider's opaque id (attempt id, message id, call sid). */
  markDispatched(idempotencyKey: string, providerRef: string): Promise<void>;
  /** Provider definitively rejected it before acting, so nothing was delivered. */
  markFailed(idempotencyKey: string): Promise<void>;
  /** Outcome unknown (timeout, network error, 5xx). Do NOT retry; reconcile through provider status callbacks. */
  markDeliveryUnknown(idempotencyKey: string): Promise<void>;
}

/**
 * Run one external side effect: authorize, claim durably, call the provider, record the outcome.
 * A duplicate claim fails closed. A delivery-unknown outcome is recorded and surfaced, never retried here.
 */
export async function dispatchOnce<T>(
  ledger: DispatchLedger,
  request: ProviderRequest<unknown>,
  provider: ProviderName,
  action: string,
  run: () => Promise<{ data: T; providerRef: string }>,
  now = Date.now(),
): Promise<ProviderResult<T>> {
  requireAuthorization(request, action, now);
  if (!(await ledger.claim(request.idempotencyKey, provider, action))) throw new AdapterError("duplicate_dispatch", provider);
  try {
    const { data, providerRef } = await run();
    await ledger.markDispatched(request.idempotencyKey, providerRef);
    return { provider, idempotencyKey: request.idempotencyKey, data };
  } catch (error) {
    if (error instanceof AdapterError && error.code === "delivery_unknown") await ledger.markDeliveryUnknown(request.idempotencyKey);
    else if (error instanceof AdapterError && error.code === "provider_rejected") await ledger.markFailed(request.idempotencyKey);
    else await ledger.markDeliveryUnknown(request.idempotencyKey); // anything else after claim: assume the worst
    throw error;
  }
}
