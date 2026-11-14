import { WebhookError } from "./webhook-security";
import type { StoredInput } from "./event-store";

type Json = Record<string, unknown>;
const object = (v: unknown): Json => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new WebhookError("invalid_payload", 400);
  return v as Json;
};
const text = (v: unknown): string => {
  if (typeof v !== "string" || !v.length || v.length > 256) throw new WebhookError("invalid_payload", 400);
  return v;
};
const array = (v: unknown): unknown[] => {
  if (!Array.isArray(v) || v.length > 100) throw new WebhookError("invalid_payload", 400);
  return v;
};
export interface IngestionStore {
  resolve(source: string, account: string, sender: string): Promise<{ familyId: string; personId: string }>;
  /** The recipient this system sent a WhatsApp message to: the 'message' identity binding written by complete_dispatch for
   * exactly this configured account and message id. Null when this system did not send it (or the binding is revoked). */
  findMessageBinding(account: string, messageId: string): Promise<{ familyId: string; personId: string } | null>;
  ingest(event: StoredInput): Promise<void>;
}

/** Meta delivery statuses this system understands. Anything else is stored as 'unsupported' and can never become proof. */
const KNOWN_STATUSES = new Set(["sent", "delivered", "read", "failed"]);
const MESSAGE_ID = /^[A-Za-z0-9_.:=+\/-]{1,256}$/;

/** Validate all identities before writing. A retry safely revisits any already persisted items. */
export async function ingestWhatsApp(payload: unknown, configuredAccount: string, store: IngestionStore): Promise<number> {
  const root = object(payload);
  if (root.object !== "whatsapp_business_account") throw new WebhookError("invalid_payload", 400);
  const events: StoredInput[] = [];
  for (const rawEntry of array(root.entry)) {
    for (const rawChange of array(object(rawEntry).changes)) {
      const change = object(rawChange);
      if (change.field !== "messages") throw new WebhookError("unsupported_webhook_field", 400);
      const value = object(change.value);
      const account = text(object(value.metadata).phone_number_id);
      if (account !== configuredAccount) throw new WebhookError("wrong_provider_account", 403);
      for (const [field, kind] of [["messages", "message"], ["statuses", "status"]] as const) {
        if (value[field] === undefined) continue;
        for (const rawEvent of array(value[field])) {
          const event = object(rawEvent);
          const eventId = text(event.id);
          // Meta may omit statuses.recipient_id (users identified only by a business-scoped user id). A status is still
          // attributable through OUR record of who this account sent that message to; without either it is unregistered.
          let identity: { familyId: string; personId: string };
          if (kind === "status" && (event.recipient_id === undefined || event.recipient_id === null)) {
            const sent = MESSAGE_ID.test(eventId) ? await store.findMessageBinding(account, eventId) : null;
            if (!sent) throw new WebhookError("unregistered_sender", 403);
            identity = sent;
          } else {
            identity = await store.resolve("whatsapp", account, text(kind === "message" ? event.from : event.recipient_id));
          }
          const suffix = kind === "status" ? `:${text(event.status)}:${text(event.timestamp)}` : "";
          const id = `${account}:${eventId}${suffix}`;
          if (id.length > 256) throw new WebhookError("invalid_event_id", 400);
          let metadata: Record<string, string> | undefined;
          if (kind === "status") {
            // Narrow, verified status facts for the delivery-proof normalizer. provider_ref is attached ONLY when this configured
            // account sent that exact message to this same family and person; otherwise the event stays raw and unprovable.
            const status = KNOWN_STATUSES.has(text(event.status)) ? String(event.status) : "unsupported";
            metadata = { status };
            if (MESSAGE_ID.test(eventId)) {
              const sent = await store.findMessageBinding(account, eventId);
              if (sent && sent.familyId === identity.familyId && sent.personId === identity.personId) metadata.provider_ref = eventId;
              else metadata.binding = "unverified";
            } else metadata.binding = "unverified";
          }
          events.push({ source: "whatsapp", id, type: `whatsapp.${kind}`, ...identity, payload: { account, event }, ...(metadata ? { metadata } : {}) });
          if (events.length > 100) throw new WebhookError("too_many_events", 413);
        }
      }
    }
  }
  if (!events.length) throw new WebhookError("no_supported_events", 400);
  for (const event of events) await store.ingest(event);
  return events.length;
}
