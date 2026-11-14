import { classifyProviderStatus } from "./dispatch";
import type { DispatchStore } from "./types";

export type NormalizeResult =
  /** Status is unsupported or ambiguous (for example a connected or completed call). Nothing was written. */
  | { status: "pending"; reason: "unsupported_status" | "unprovable" }
  | { status: "proved"; outcome: "delivered" | "confirmed_not_sent"; proofEventId: string; dispatchReconciled: boolean; outboxReconciled: boolean };

/**
 * Turn one durably processed raw provider callback into verified delivery proof and apply it to a delivery_unknown dispatch.
 * Linkage (outbox, request, action, dispatch key, provider reference) is derived by SQL from stored records. The caller passes
 * only the raw event id, the provider and the status already stored on that event; nothing from the callback body is trusted
 * for identity. `delivered` for a call is never produced: only WhatsApp delivered/read can prove delivery.
 */
export async function normalizeDeliveryOutcome(
  store: DispatchStore, input: { familyId: string; sourceEventId: string; provider: "sarvam" | "twilio" | "whatsapp"; status: string },
): Promise<NormalizeResult> {
  const outcome = classifyProviderStatus(input.provider, input.status);
  if (!outcome) return { status: "pending", reason: "unsupported_status" };
  const proof = await store.recordDeliveryProof(input.familyId, input.sourceEventId, outcome);
  if (!proof) return { status: "pending", reason: "unprovable" };
  // Ledger first, then outbox: the outbox reconciler requires the ledger to be reconciled with this exact proof.
  const dispatchReconciled = await store.reconcile(input.familyId, proof.dispatchKey, proof.proofEventId, outcome);
  const outboxReconciled = dispatchReconciled ? await store.reconcileOutbox(proof.outboxId, proof.proofEventId, outcome) : false;
  return { status: "proved", outcome, proofEventId: proof.proofEventId, dispatchReconciled, outboxReconciled };
}
