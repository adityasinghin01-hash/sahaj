/** Rows and dependencies for the Shield server entry points (Core 3 Step 1.3). Everything is injected. */

export type ShieldProtections = Record<string, boolean>;

/** A row of public.shield_devices (only the columns these handlers need). */
export interface ShieldDeviceRow {
  id: string;
  family_id: string;
  person_id: string;
  /** hex(SHA-256(device_secret)). The device secret itself is never stored. */
  device_secret_hash: string;
}

export interface NewShieldDevice {
  id: string;
  family_id: string;
  person_id: string;
  label: string | null;
  platform: "android";
  android_version: string | null;
  protections: ShieldProtections;
  paired_at: Date;
  device_secret_hash: string;
}

/** A row for public.shield_events. `masked_text` has already been checked for 4+ digit runs. */
export interface NewShieldEventRow {
  idempotency_key: string;
  family_id: string;
  parent_id: string;
  device_id: string;
  channel: string;
  kind: string;
  occurred_at: string;
  masked_text: string | null;
  sender_type: string | null;
  caller_type: string | null;
  link_domains: string[];
  matched_rules: string[];
  local_level: string | null;
  context: Record<string, string | number | boolean>;
}

export interface NewPairingCode {
  family_id: string;
  created_by_user_id: string;
  /** hex(SHA-256(code)). The code itself is never stored. */
  code_hash: string;
  expires_at: Date;
}

export interface ShieldServerDb {
  getDevice(deviceId: string): Promise<ShieldDeviceRow | null>;
  insertDevice(row: NewShieldDevice): Promise<void>;
  /** Insert; a unique violation on idempotency_key must resolve to `{ duplicate: true }`, not throw. */
  insertEvent(row: NewShieldEventRow): Promise<{ id: string } | { duplicate: true }>;
  touchHeartbeat(deviceId: string, at: Date): Promise<void>;

  /** public.people lookup, used to find the family a pairing request is for. */
  getPerson(personId: string): Promise<{ id: string; family_id: string } | null>;
  /** Codes with used_at null and expires_at > now. */
  countActivePairingCodes(familyId: string, now: Date): Promise<number>;
  insertPairingCode(row: NewPairingCode): Promise<void>;
  /**
   * Atomically mark one code used and return it, or null if none matches. Must be a single
   * conditional statement so two concurrent requests cannot both win:
   *   update shield_pairing_codes set used_at = $now
   *   where family_id = $f and code_hash = $h and used_at is null and expires_at > $now
   *   returning id
   */
  claimPairingCode(input: { familyId: string; codeHash: string; now: Date }): Promise<{ id: string } | null>;
  /** Expire every active code of the family (set expires_at = now where used_at is null and expires_at > now). */
  expireActivePairingCodes(familyId: string, now: Date): Promise<void>;
  recordPairingFailure(familyId: string, at: Date): Promise<void>;
  countPairingFailures(familyId: string, since: Date): Promise<number>;
  getPairingLockedUntil(familyId: string): Promise<Date | null>;
  setPairingLockedUntil(familyId: string, until: Date): Promise<void>;
}

export interface ShieldServerDeps {
  db: ShieldServerDb;
  atlas: {
    enqueueShieldEvent(input: { eventId: string; familyId: string; parentId: string }): Promise<void>;
  };
  /** Vercel's waitUntil: keeps the function alive for `promise` after the response is sent. */
  waitUntil(promise: Promise<unknown>): void;
  env: { SHIELD_DEVICE_PAIRING_SECRET: string };
  clock: { now(): Date };
  /** Optional error sink for background work. Never receives secrets or event text. */
  log?: { error(message: string, meta?: Record<string, unknown>): void };
}
