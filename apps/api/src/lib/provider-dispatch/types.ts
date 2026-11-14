import type { ActionAuthorization } from "@sahaj/adapters/communication";

export type DispatchAction = "sarvam.outbound_call" | "twilio.create_call" | "whatsapp.send_text";
export type DispatchProvider = "sarvam" | "twilio" | "whatsapp";

export const ACTION_PROVIDER: Record<DispatchAction, DispatchProvider> = {
  "sarvam.outbound_call": "sarvam",
  "twilio.create_call": "twilio",
  "whatsapp.send_text": "whatsapp",
};
export const CALL_ACTIONS: readonly DispatchAction[] = ["sarvam.outbound_call", "twilio.create_call"];

/** Payloads never carry phone numbers: the destination is resolved server-side from the person's identity. */
export type DispatchPayload =
  | { action: "sarvam.outbound_call"; language?: "Hindi" | "English"; openingMessage?: string }
  | { action: "twilio.create_call"; twimlUrl: string }
  | { action: "whatsapp.send_text"; body: string };

/** One claimed outbox row, ready to dispatch. Produced by the outbox worker, never by an HTTP client. */
export interface DispatchCommand {
  familyId: string;
  personId: string;
  outboxId: string;
  /** lease_token returned by claim_outbox. */
  outboxLease: string;
  /** outbox.attempt_count from the claimed row (1-based). Part of the idempotency key. */
  attempt: number;
  /** Required for call actions: the scheduled `calls` row that will be bound to the provider reference. */
  callId?: string;
  /** Twilio only: the trusted caller attests the TwiML at twimlUrl speaks the AI disclosure. Sarvam always does. */
  aiDisclosureAttested?: boolean;
  payload: DispatchPayload;
}

export type DispatchOutcome =
  | { status: "dispatched"; providerRef: string; key: string }
  | { status: "delivery_unknown"; key: string; code: string }
  | { status: "failed"; key: string; code: string; reachedProvider: boolean }
  | { status: "denied"; key: string; code: string }
  | { status: "duplicate"; key: string };

export type ReconcileOutcome = "delivered" | "confirmed_not_sent";

export interface ClaimInput {
  familyId: string; personId: string; key: string; provider: DispatchProvider; action: DispatchAction;
  outboxId: string; outboxLease: string; callId?: string;
}
export interface BindInput {
  familyId: string; outboxId: string; personId: string; provider: DispatchProvider; action: DispatchAction;
  callId?: string; incidentId?: string; assignmentId?: string;
}
export interface DeliveryProof { proofEventId: string; dispatchKey: string; outboxId: string; outcome: ReconcileOutcome }
/** One row returned by claim_outbox. Only the fields the runner needs. */
export interface ClaimedOutbox { id: string; familyId: string; attempt: number; lease: string }
export interface StoredBinding extends BindInput { actionRequestId: string | null; outboxAction: string | null }
export interface CompleteInput {
  familyId: string; key: string; providerRef: string; accountId?: string; identityHash?: string; aiDisclosed: boolean;
}
/** Service-role persistence. Every method maps to one atomic SQL function in the phase2 migration. */
export interface DispatchStore {
  /** Phase 2 runner: claim ready outbox rows (existing claim_outbox, which also expires abandoned leases into delivery_unknown). */
  claimOutbox(workerId: string, limit: number, leaseSeconds: number): Promise<ClaimedOutbox[]>;
  getBinding(familyId: string, outboxId: string): Promise<StoredBinding | null>;
  /** Immutable target/provider/action/call binding of an outbox row. Called by the enqueue transaction owner. */
  bindOutbox(input: BindInput): Promise<boolean>;
  claim(input: ClaimInput): Promise<"claimed" | "duplicate">;
  complete(input: CompleteInput): Promise<void>;
  bindIdentity(input: Omit<CompleteInput, "providerRef">): Promise<boolean>;
  fail(familyId: string, key: string, code: string): Promise<boolean>;
  unknown(familyId: string, key: string, code: string, providerRef?: string): Promise<boolean>;
  sweepStale(olderThanSeconds: number): Promise<number>;
  reconcile(familyId: string, key: string, providerEventId: string, outcome: ReconcileOutcome): Promise<boolean>;
  /** Normalize a durably processed raw provider callback into verified proof, derived entirely from stored records. Null when unprovable. */
  recordDeliveryProof(familyId: string, sourceEventId: string, outcome: ReconcileOutcome): Promise<DeliveryProof | null>;
  reconcileOutbox(outboxId: string, proofEventId: string, outcome: ReconcileOutcome): Promise<boolean>;
  acceptAssignment(familyId: string, assignmentId: string, providerEventId: string): Promise<boolean>;
  finishOutbox(outboxId: string, lease: string, success: boolean, errorCode?: string): Promise<boolean>;
}

export type Authorizer = (command: DispatchCommand, key: string) => Promise<ActionAuthorization | null>;

/** Error codes only. Never carries payloads, numbers or provider response bodies. */
export class DispatchError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "DispatchError"; }
}
