import { serviceDatabase } from "../database";
import { DispatchError, type DispatchStore } from "./types";

/** The slice of supabase-js the store needs; lets tests script RPC results without a database. */
export interface RpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

function failure(error: { code?: string; message?: string }): DispatchError {
  switch (error.code) {
    case "23505": return new DispatchError("dispatch_conflict");
    case "40001": return new DispatchError("stale_lease");
    case "42501": return new DispatchError(error.message === "contact_identity_not_current" || error.message === "contact_identity_required" ? "contact_not_current" : "identity_mismatch");
    case "22023": return new DispatchError("invalid_dispatch");
    default: return new DispatchError("dispatch_store_unavailable");
  }
}

/** Service role only. Each method is exactly one SQL function, so each state change is one transaction. */
export function dispatchStore(db: RpcClient = serviceDatabase() as unknown as RpcClient): DispatchStore {
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const { data, error } = await db.rpc(name, args);
    if (error) throw failure(error);
    return data;
  };
  return {
    async claimOutbox(workerId, limit, leaseSeconds) {
      const data = await call("claim_outbox", { p_worker_id: workerId, p_limit: limit, p_lease_seconds: leaseSeconds });
      if (!Array.isArray(data)) throw new DispatchError("dispatch_store_unavailable");
      return data.flatMap((r: Record<string, unknown>) => (typeof r.id === "string" && typeof r.family_id === "string" && Number.isSafeInteger(r.attempt_count) && typeof r.lease_token === "string"
        ? [{ id: r.id, familyId: r.family_id, attempt: r.attempt_count as number, lease: r.lease_token }] : []));
    },
    async getBinding(familyId, outboxId) {
      const d = await call("get_dispatch_binding", { p_family_id: familyId, p_outbox_id: outboxId }) as Record<string, unknown> | null;
      if (!d || typeof d.person_id !== "string" || typeof d.provider !== "string" || typeof d.action !== "string") return null;
      return {
        familyId, outboxId, personId: d.person_id, provider: d.provider as never, action: d.action as never,
        callId: typeof d.call_id === "string" ? d.call_id : undefined, incidentId: typeof d.incident_id === "string" ? d.incident_id : undefined,
        assignmentId: typeof d.assignment_id === "string" ? d.assignment_id : undefined,
        actionRequestId: typeof d.action_request_id === "string" ? d.action_request_id : null, outboxAction: typeof d.outbox_action === "string" ? d.outbox_action : null,
      };
    },
    async bindOutbox(i) {
      return (await call("bind_outbox_dispatch", {
        p_family_id: i.familyId, p_outbox_id: i.outboxId, p_person_id: i.personId, p_provider: i.provider, p_action: i.action,
        p_call_id: i.callId ?? null, p_incident_id: i.incidentId ?? null, p_assignment_id: i.assignmentId ?? null,
      })) === true;
    },
    async recordDeliveryProof(familyId, sourceEventId, outcome) {
      try {
        const d = await call("record_delivery_proof", { p_family_id: familyId, p_source_event_id: sourceEventId, p_outcome: outcome }) as Record<string, unknown> | null;
        if (!d || typeof d.proof_event_id !== "string" || typeof d.dispatch_key !== "string" || typeof d.outbox_id !== "string") return null;
        return { proofEventId: d.proof_event_id, dispatchKey: d.dispatch_key, outboxId: d.outbox_id, outcome };
      } catch (error) {
        // Unprovable evidence (identity/status/binding refused) stays pending. Infrastructure failures are rethrown for retry.
        if (error instanceof DispatchError && (error.code === "identity_mismatch" || error.code === "dispatch_conflict")) return null;
        throw error;
      }
    },
    async reconcileOutbox(outboxId, proofEventId, outcome) {
      return (await call("reconcile_outbox", { p_outbox_id: outboxId, p_provider_event_id: proofEventId, p_outcome: outcome })) === true;
    },
    async claim(i) {
      const data = await call("claim_dispatch_contact", {
        p_family_id: i.familyId, p_person_id: i.personId, p_key: i.key, p_provider: i.provider, p_action: i.action,
        p_outbox_id: i.outboxId, p_outbox_lease: i.outboxLease, p_call_id: i.callId ?? null,
        p_contact_identity_id: i.contact.identityId, p_contact_account_id: i.contact.accountId, p_contact_identity_hash: i.contact.identityHash,
      });
      if (data !== "claimed" && data !== "duplicate") throw new DispatchError("dispatch_store_unavailable");
      return data;
    },
    async complete(i) {
      const data = await call("complete_dispatch", {
        p_family_id: i.familyId, p_key: i.key, p_provider_ref: i.providerRef, p_account_id: i.accountId ?? null,
        p_identity_hash: i.identityHash ?? null, p_ai_disclosed: i.aiDisclosed,
      });
      if (data !== "dispatched") throw new DispatchError("dispatch_store_unavailable");
    },
    async bindIdentity(i) {
      return (await call("bind_dispatch_identity", {
        p_family_id: i.familyId, p_key: i.key, p_account_id: i.accountId ?? null, p_identity_hash: i.identityHash ?? null, p_ai_disclosed: i.aiDisclosed,
      })) === true;
    },
    async fail(familyId, key, code) {
      return (await call("mark_dispatch_failed", { p_family_id: familyId, p_key: key, p_error_code: code })) === true;
    },
    async unknown(familyId, key, code, providerRef) {
      return (await call("mark_dispatch_unknown", { p_family_id: familyId, p_key: key, p_error_code: code, p_provider_ref: providerRef ?? null })) === true;
    },
    async sweepStale(seconds) {
      const n = await call("sweep_stale_dispatch_claims", { p_older_than_seconds: seconds });
      return typeof n === "number" ? n : 0;
    },
    async reconcile(familyId, key, eventId, outcome) {
      return (await call("reconcile_dispatch", { p_family_id: familyId, p_key: key, p_provider_event_id: eventId, p_outcome: outcome })) === true;
    },
    async acceptAssignment(familyId, assignmentId, eventId) {
      return (await call("accept_assignment_verified", { p_family_id: familyId, p_assignment_id: assignmentId, p_provider_event_id: eventId })) === true;
    },
    async finishOutbox(outboxId, lease, success, errorCode) {
      return (await call("finish_outbox", { p_outbox_id: outboxId, p_lease_token: lease, p_success: success, p_error_code: errorCode ?? null })) === true;
    },
  };
}
