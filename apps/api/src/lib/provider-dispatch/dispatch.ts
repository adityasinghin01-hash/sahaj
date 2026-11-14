import {
  AdapterError, createSarvamOutboundCall, createTwilioCall, requireAuthorization, sendWhatsAppText,
  type DispatchLedger, type FetchTransport, type ProviderName, type ProviderRequest, type SarvamOutboundDeps,
  type TwilioCallDeps, type WhatsAppSendDeps,
} from "@sahaj/adapters";
import { identityHash } from "../webhook-security";
import {
  ACTION_PROVIDER, CALL_ACTIONS, DispatchError, type Authorizer, type DispatchAction, type DispatchCommand, type DispatchOutcome,
  type DispatchStore,
} from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Stable per outbox row and attempt: a crashed worker or a replay derives the same key, so the ledger can refuse it. */
export const dispatchKey = (outboxId: string, attempt: number) => `dispatch:${outboxId}:a${attempt}`;

export interface DispatchDeps {
  store: DispatchStore;
  /** Trusted re-authorization (Cedar/permission gate). Evaluated at dispatch time, never read from a request or the outbox payload. */
  authorize: Authorizer;
  /** Server-side contact lookup. Returns E.164 or null. The number never enters the command, outbox payload or logs. */
  resolveDestination(familyId: string, personId: string, provider: "sarvam" | "twilio" | "whatsapp"): Promise<string | null>;
  transport: FetchTransport;
  identitySecret: string;
  providers: {
    sarvam?: Omit<SarvamOutboundDeps, "ledger" | "transport">;
    twilio?: Omit<TwilioCallDeps, "ledger" | "transport">;
    whatsapp?: Omit<WhatsAppSendDeps, "ledger" | "transport">;
  };
  now?: () => number;
}

interface LedgerContext {
  store: DispatchStore; familyId: string; identity: (providerRef: string) => { accountId?: string; identityHash?: string };
  aiDisclosed: boolean;
}

/**
 * DispatchLedger bound to one family and one claimed outbox row. `claim` is the single point where a call may
 * become external: it returns true only after the database committed the claim. If bookkeeping fails after the
 * provider answered, the provider reference is kept so the row is marked delivery_unknown WITH that reference.
 */
class BoundLedger implements DispatchLedger {
  claimed = false;
  private ref: string | undefined;
  constructor(private readonly ctx: LedgerContext, private readonly claim_: (key: string, provider: ProviderName, action: string) => Promise<boolean>) {}
  async claim(key: string, provider: ProviderName, action: string): Promise<boolean> {
    const ok = await this.claim_(key, provider, action);
    this.claimed = ok;
    return ok;
  }
  async markDispatched(key: string, providerRef: string): Promise<void> {
    this.ref = providerRef;
    await this.ctx.store.complete({ familyId: this.ctxFamily, key, providerRef, aiDisclosed: this.ctx.aiDisclosed, ...this.ctx.identity(providerRef) });
  }
  async markFailed(key: string): Promise<void> {
    await this.ctx.store.fail(this.ctxFamily, key, "provider_rejected");
  }
  async markDeliveryUnknown(key: string): Promise<void> {
    await this.ctx.store.unknown(this.ctxFamily, key, this.ref ? "bookkeeping_failed" : "delivery_unknown", this.ref);
  }
  private get ctxFamily() { return this.ctx.familyId; }
}

function validate(cmd: DispatchCommand): DispatchAction {
  const action = cmd?.payload?.action;
  if (!action || !Object.prototype.hasOwnProperty.call(ACTION_PROVIDER, action)) throw new DispatchError("unsupported_action");
  if (![cmd.familyId, cmd.personId, cmd.outboxId, cmd.outboxLease].every((v) => typeof v === "string" && UUID_RE.test(v))) throw new DispatchError("invalid_command");
  if (!Number.isSafeInteger(cmd.attempt) || cmd.attempt < 1 || cmd.attempt > 20) throw new DispatchError("invalid_command");
  const isCall = CALL_ACTIONS.includes(action);
  if (isCall && !(typeof cmd.callId === "string" && UUID_RE.test(cmd.callId))) throw new DispatchError("call_required");
  if (!isCall && cmd.callId !== undefined) throw new DispatchError("invalid_command");
  return action;
}

async function finish(deps: DispatchDeps, cmd: DispatchCommand, success: boolean, code?: string): Promise<void> {
  // Best effort. An unfinished outbox row expires into delivery_unknown, which is safe: it is never resent.
  try { await deps.store.finishOutbox(cmd.outboxId, cmd.outboxLease, success, code); } catch { /* lease expiry covers it */ }
}

/**
 * One outbound side effect: reauthorize, claim durably, call the provider through the adapter, persist the result.
 * Nothing here retries. After a claim, every failure that is not a clean provider refusal is delivery_unknown.
 * Real providers are reached only through `deps.transport`; tests inject a scripted one.
 */
export async function dispatchOutbound(deps: DispatchDeps, cmd: DispatchCommand): Promise<DispatchOutcome> {
  const action = validate(cmd);
  const provider = ACTION_PROVIDER[action];
  const key = dispatchKey(cmd.outboxId, cmd.attempt);
  const now = (deps.now ?? Date.now)();
  const preClaimFailure = async (code: string, status: "failed" | "denied"): Promise<DispatchOutcome> => {
    await finish(deps, cmd, false, code);
    return status === "denied" ? { status, key, code } : { status, key, code, reachedProvider: false };
  };

  // 1. Reauthorize with the trusted gate. The grant must name this person, action and key, allow, carry consent, and be unexpired.
  let authorization;
  try { authorization = await deps.authorize(cmd, key); } catch { return preClaimFailure("authorization_unavailable", "denied"); }
  const request: ProviderRequest<unknown> = { personId: cmd.personId, idempotencyKey: key, authorization: authorization as never, payload: {} };
  try { requireAuthorization(request, action, now); } catch { return preClaimFailure("authorization_denied", "denied"); }

  const config = deps.providers[provider];
  if (!config) return preClaimFailure("provider_not_configured", "failed");
  let destination: string | null;
  try { destination = await deps.resolveDestination(cmd.familyId, cmd.personId, provider); } catch { return preClaimFailure("identity_lookup_failed", "failed"); }
  if (!destination) return preClaimFailure("unknown_identity", "failed");

  // 2. Ledger bound to this family, outbox lease and call. The SQL claim re-verifies all three atomically.
  const ledger = new BoundLedger({
    store: deps.store, familyId: cmd.familyId,
    aiDisclosed: action === "sarvam.outbound_call" || (action === "twilio.create_call" && cmd.aiDisclosureAttested === true),
    identity: (ref) => action === "sarvam.outbound_call"
      ? { accountId: deps.providers.sarvam!.appId, identityHash: identityHash("sarvam", deps.providers.sarvam!.appId, ref, deps.identitySecret) }
      : {},
  }, async (k, p, a) => (await deps.store.claim({
    familyId: cmd.familyId, personId: cmd.personId, key: k, provider: p as never, action: a as DispatchAction,
    outboxId: cmd.outboxId, outboxLease: cmd.outboxLease, callId: cmd.callId,
  })) === "claimed");

  const authorized = { ...request, authorization: authorization! };
  try {
    let providerRef: string;
    const p = cmd.payload;
    if (p.action === "sarvam.outbound_call") {
      const r = await createSarvamOutboundCall({ ...deps.providers.sarvam!, transport: deps.transport, ledger },
        { ...authorized, payload: { userPhoneNumber: destination, language: p.language, openingMessage: p.openingMessage } });
      providerRef = r.data.attemptId;
    } else if (p.action === "twilio.create_call") {
      const r = await createTwilioCall({ ...deps.providers.twilio!, transport: deps.transport, ledger }, { ...authorized, payload: { to: destination, twimlUrl: p.twimlUrl } });
      providerRef = r.data.callSid;
    } else {
      const r = await sendWhatsAppText({ ...deps.providers.whatsapp!, transport: deps.transport, ledger }, { ...authorized, payload: { to: destination, body: p.body } });
      providerRef = r.data.messageId;
    }
    await finish(deps, cmd, true);
    return { status: "dispatched", providerRef, key };
  } catch (error) {
    const code = error instanceof AdapterError || error instanceof DispatchError ? error.code : "ledger_unavailable";
    // Duplicate claim: another worker owns this dispatch. Do nothing; the outbox lease expires into delivery_unknown.
    if (code === "duplicate_dispatch") return { status: "duplicate", key };
    if (!ledger.claimed) {
      // Failed before the ledger committed a claim, so nothing external happened (validation, config, ledger down).
      return preClaimFailure(code, code === "authorization_denied" ? "denied" : "failed");
    }
    if (code === "provider_rejected") {
      await finish(deps, cmd, false, "provider_rejected");
      return { status: "failed", key, code, reachedProvider: true };
    }
    await finish(deps, cmd, false, "delivery_unknown");
    return { status: "delivery_unknown", key, code: code === "delivery_unknown" ? code : "post_claim_failure" };
  }
}

/** Mark claims whose worker died before recording a result as delivery_unknown. Never resends. */
export const sweepStaleClaims = (store: DispatchStore, olderThanSeconds = 120) => store.sweepStale(olderThanSeconds);

/**
 * Provider callback statuses that are verified evidence of a call or message outcome.
 * `delivered` is returned only where the provider states a delivery to the recipient (WhatsApp delivered/read).
 * A connected or completed CALL says a call was answered or ended. It does not prove a person was reached or heard a
 * care message, so it returns null and the ledger stays delivery_unknown for a person or later evidence to resolve.
 */
export function classifyProviderStatus(provider: "sarvam" | "twilio" | "whatsapp", status: string): "delivered" | "confirmed_not_sent" | null {
  const s = status.toLowerCase();
  if (provider === "twilio") return ["busy", "no-answer", "failed", "canceled"].includes(s) ? "confirmed_not_sent" : null;
  if (provider === "sarvam") return ["no_answer", "busy", "failed"].includes(s) ? "confirmed_not_sent" : null;
  if (s === "delivered" || s === "read") return "delivered";
  if (s === "failed") return "confirmed_not_sent";
  return null;
}
