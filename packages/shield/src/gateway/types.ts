/** Dependencies for the SMS gateway route (Core 3 Step 3.4). Everything is injected. */

/** A row for public.shield_events written by the gateway (no device: device_id is null). */
export interface NewGatewayEventRow {
  idempotency_key: string;
  family_id: string;
  parent_id: string;
  channel: "gateway_sms";
  kind: "sms";
  occurred_at: string;
  /** Already masked with the rules mask(); never holds a run of 4+ digits. */
  masked_text: string;
  link_domains: string[];
  context: Record<string, string | number | boolean>;
}

export interface SmsGatewayDb {
  /** phoneHash = hex(SHA-256(last 10 digits)). Returns the registered keypad parent, or null. */
  findParentByPhoneHash(phoneHash: string): Promise<{ family_id: string; parent_id: string } | null>;
  /** Insert; a unique violation on idempotency_key must resolve to `{ duplicate: true }`, not throw. */
  insertGatewayEvent(row: NewGatewayEventRow): Promise<{ id: string } | { duplicate: true }>;
}

export interface SmsGatewayDeps {
  db: SmsGatewayDb;
  /** Runs the brain for a stored event. Called through waitUntil, never awaited by the handler. */
  brain: { runForEvent(eventId: string): Promise<unknown> };
  /** Vercel's waitUntil: keeps the function alive for `promise` after the response is sent. */
  waitUntil(promise: Promise<unknown>): void;
  env: { SMS_GATEWAY_SECRET?: string };
  /** Optional error sink. Never receives secrets, phone numbers or message text. */
  log?: { error(message: string, meta?: Record<string, unknown>): void };
}
