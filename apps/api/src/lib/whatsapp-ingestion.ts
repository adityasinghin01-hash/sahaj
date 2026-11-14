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
  ingest(event: StoredInput): Promise<void>;
}

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
          const sender = text(kind === "message" ? event.from : event.recipient_id);
          const identity = await store.resolve("whatsapp", account, sender);
          const eventId = text(event.id);
          const suffix = kind === "status" ? `:${text(event.status)}:${text(event.timestamp)}` : "";
          const id = `${account}:${eventId}${suffix}`;
          if (id.length > 256) throw new WebhookError("invalid_event_id", 400);
          events.push({ source: "whatsapp", id, type: `whatsapp.${kind}`, ...identity, payload: { account, event } });
          if (events.length > 100) throw new WebhookError("too_many_events", 413);
        }
      }
    }
  }
  if (!events.length) throw new WebhookError("no_supported_events", 400);
  for (const event of events) await store.ingest(event);
  return events.length;
}
