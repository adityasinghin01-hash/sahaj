import { vi } from "vitest";
import { SHIELD_HEADERS, type ShieldEvent } from "@sahaj/shared";
import type { NewPairingCode, NewShieldDevice, NewShieldEventRow, ShieldServerDeps } from "../../src/server";
import { signShieldBody } from "../../src/server";

export const PAIRING_SECRET = "sahaj-test-pairing-secret-0123456789abcdef";
export const START = new Date("2026-11-14T10:00:00.000Z");

export interface PairingCodeRow extends NewPairingCode {
  id: string;
  used_at: Date | null;
}

/** In-memory fake of every server dependency. No network. */
export function makeServerDeps(opts: { people?: Record<string, { id: string; family_id: string }> } = {}) {
  let nowMs = START.getTime();
  let seq = 0;
  const people = opts.people ?? { maa_1: { id: "maa_1", family_id: "fam_1" }, papa_2: { id: "papa_2", family_id: "fam_2" } };
  const devices = new Map<string, NewShieldDevice & { last_heartbeat_at: Date | null }>();
  const events = new Map<string, NewShieldEventRow & { id: string }>();
  const codes: PairingCodeRow[] = [];
  const failures: { family_id: string; at: Date }[] = [];
  const locks = new Map<string, Date>();
  const pending: Promise<unknown>[] = [];

  const active = (c: PairingCodeRow, now: Date) => c.used_at === null && c.expires_at.getTime() > now.getTime();

  const db = {
    getDevice: vi.fn(async (id: string) => {
      const d = devices.get(id);
      return d ? { id: d.id, family_id: d.family_id, person_id: d.person_id, device_secret_hash: d.device_secret_hash } : null;
    }),
    insertDevice: vi.fn(async (row: NewShieldDevice) => {
      devices.set(row.id, { ...row, last_heartbeat_at: null });
    }),
    insertEvent: vi.fn(async (row: NewShieldEventRow) => {
      if (events.has(row.idempotency_key)) return { duplicate: true as const };
      const id = `evt_${++seq}`;
      events.set(row.idempotency_key, { ...row, id });
      return { id };
    }),
    touchHeartbeat: vi.fn(async (deviceId: string, at: Date) => {
      const d = devices.get(deviceId);
      if (d) d.last_heartbeat_at = at;
    }),
    getPerson: vi.fn(async (personId: string) => people[personId] ?? null),
    countActivePairingCodes: vi.fn(async (familyId: string, now: Date) =>
      codes.filter((c) => c.family_id === familyId && active(c, now)).length),
    insertPairingCode: vi.fn(async (row: NewPairingCode) => {
      codes.push({ ...row, id: `code_${++seq}`, used_at: null });
    }),
    // Atomic like the single conditional UPDATE: check and set happen with no await in between.
    claimPairingCode: vi.fn(async ({ familyId, codeHash, now }: { familyId: string; codeHash: string; now: Date }) => {
      const c = codes.find((x) => x.family_id === familyId && x.code_hash === codeHash && active(x, now));
      if (!c) return null;
      c.used_at = now;
      return { id: c.id };
    }),
    expireActivePairingCodes: vi.fn(async (familyId: string, now: Date) => {
      for (const c of codes) if (c.family_id === familyId && active(c, now)) c.expires_at = now;
    }),
    recordPairingFailure: vi.fn(async (familyId: string, at: Date) => {
      failures.push({ family_id: familyId, at });
    }),
    countPairingFailures: vi.fn(async (familyId: string, since: Date) =>
      failures.filter((f) => f.family_id === familyId && f.at.getTime() >= since.getTime()).length),
    getPairingLockedUntil: vi.fn(async (familyId: string) => locks.get(familyId) ?? null),
    setPairingLockedUntil: vi.fn(async (familyId: string, until: Date) => {
      locks.set(familyId, until);
    }),
  };

  const atlas = { enqueueShieldEvent: vi.fn(async (_: { eventId: string; familyId: string; parentId: string }) => undefined) };
  const log = { error: vi.fn() };

  const deps: ShieldServerDeps = {
    db,
    atlas,
    waitUntil: vi.fn((p: Promise<unknown>) => {
      pending.push(p);
    }),
    env: { SHIELD_DEVICE_PAIRING_SECRET: PAIRING_SECRET },
    clock: { now: () => new Date(nowMs) },
    log,
  };

  return {
    deps,
    db,
    atlas,
    log,
    devices,
    events,
    codes,
    advance(ms: number) {
      nowMs += ms;
    },
    now: () => new Date(nowMs),
    flush: () => Promise.all(pending.splice(0)),
  };
}

export type Fake = ReturnType<typeof makeServerDeps>;

export function pairRequest(body: unknown): Request {
  return new Request("https://sahaj.test/api/shield/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function pairBody(code: string, overrides: Record<string, unknown> = {}) {
  return {
    code,
    parent_person_id: "maa_1",
    label: "Maa ka phone",
    platform: "android",
    android_version: "14",
    protections: { sms: true, screening: true, overlay: false },
    ...overrides,
  };
}

export function makeEvent(deviceId: string, overrides: Partial<ShieldEvent> = {}): ShieldEvent {
  return {
    idempotency_key: "evt-key-0001",
    family_id: "fam_1",
    parent_id: "maa_1",
    device_id: deviceId,
    channel: "device",
    kind: "sms",
    occurred_at: "2026-11-14T09:59:00.000Z",
    masked_text: "Aapka KYC block hoga, OTP <NUM> bataiye",
    sender_type: "mobile_10",
    link_domains: ["kyc-update.in"],
    matched_rules: ["P2"],
    local_level: "red",
    context: {},
    ...overrides,
  };
}

export async function signedEventRequest(input: {
  deviceId: string;
  deviceSecret: string;
  body: string;
  ts?: number;
  /** Sign this body instead of `body` (to simulate tampering in transit). */
  signedBody?: string;
}): Promise<Request> {
  const ts = String(input.ts ?? Date.now());
  const sig = await signShieldBody(input.deviceSecret, ts, input.signedBody ?? input.body);
  return new Request("https://sahaj.test/api/shield/event", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SHIELD_HEADERS.device]: input.deviceId,
      [SHIELD_HEADERS.ts]: ts,
      [SHIELD_HEADERS.sig]: sig,
    },
    body: input.body,
  });
}
