/**
 * Shield phone pairing (Core 3 Step 1.3).
 *  - createPairingCode: called from the logged-in child app route. Returns a 6-digit code once.
 *  - handleShieldPair: POST from the parent phone during setup. Exchanges the code for {device_id, device_secret}.
 */
import { z } from "zod";
import { deriveDeviceSecret, sha256Hex } from "./crypto";
import { json, readBodyBytes } from "./http";
import type { ShieldServerDeps } from "./types";

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const PAIRING_MAX_ACTIVE_CODES = 5;
export const PAIRING_MAX_FAILURES = 5;
export const PAIRING_FAILURE_WINDOW_MS = 10 * 60 * 1000;
export const PAIRING_LOCK_MS = 10 * 60 * 1000;
const PAIR_MAX_BODY_BYTES = 8 * 1024;

/** The one error a phone sees for a wrong, expired or used code (no hint which). */
export const PAIRING_GENERIC_ERROR = "invalid_or_expired_code";

export type CreatePairingCodeResult =
  | { ok: true; code: string; expires_at: string }
  | { ok: false; reason: "too_many_active_codes" | "locked" };

/** Uniform 6-digit code from crypto.getRandomValues (rejection sampling, no modulo bias). */
export function randomSixDigitCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    const n = buf[0]!;
    if (n < limit) return String(n % 1_000_000).padStart(6, "0");
  }
}

/** Refuse to run with a missing or weak SHIELD_DEVICE_PAIRING_SECRET (every device secret derives from it). */
export function assertPairingSecret(deps: ShieldServerDeps): void {
  const secret = deps.env.SHIELD_DEVICE_PAIRING_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("SHIELD_DEVICE_PAIRING_SECRET is missing or shorter than 32 characters");
  }
}

async function lockedUntil(deps: ShieldServerDeps, familyId: string, now: Date): Promise<Date | null> {
  const until = await deps.db.getPairingLockedUntil(familyId);
  return until && until.getTime() > now.getTime() ? until : null;
}

export async function createPairingCode(
  deps: ShieldServerDeps,
  input: { familyId: string; userId: string },
): Promise<CreatePairingCodeResult> {
  const now = deps.clock.now();
  if (await lockedUntil(deps, input.familyId, now)) return { ok: false, reason: "locked" };
  if ((await deps.db.countActivePairingCodes(input.familyId, now)) >= PAIRING_MAX_ACTIVE_CODES) {
    return { ok: false, reason: "too_many_active_codes" };
  }
  const code = randomSixDigitCode();
  const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);
  await deps.db.insertPairingCode({
    family_id: input.familyId,
    created_by_user_id: input.userId,
    code_hash: await sha256Hex(code),
    expires_at: expiresAt,
  });
  return { ok: true, code, expires_at: expiresAt.toISOString() };
}

export const ShieldPairRequest = z.object({
  code: z.string(),
  parent_person_id: z.string().min(1).max(64),
  label: z.string().max(100).nullish(),
  platform: z.literal("android"),
  android_version: z.string().max(32).nullish(),
  protections: z.record(z.string().max(64), z.boolean()).default({}),
});
export type ShieldPairRequest = z.infer<typeof ShieldPairRequest>;

/** POST /api/shield/pair. Responds 200 {device_id, device_secret} exactly once per code. */
export async function handleShieldPair(req: Request, deps: ShieldServerDeps): Promise<Response> {
  try {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    assertPairingSecret(deps);
    const raw = await readBodyBytes(req, PAIR_MAX_BODY_BYTES);
    if (!raw) return json(413, { error: "body_too_large" });

    let parsed: ShieldPairRequest;
    try {
      const result = ShieldPairRequest.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
      if (!result.success) return json(400, { error: "invalid_request" });
      parsed = result.data;
    } catch {
      return json(400, { error: "invalid_request" });
    }

    const now = deps.clock.now();
    const person = await deps.db.getPerson(parsed.parent_person_id);
    // Unknown person: same answer as a wrong code, and nothing to count it against.
    if (!person) return json(400, { error: PAIRING_GENERIC_ERROR });
    const familyId = person.family_id;

    if (await lockedUntil(deps, familyId, now)) return json(429, { error: "too_many_attempts" });

    const claimed = /^\d{6}$/.test(parsed.code)
      ? await deps.db.claimPairingCode({ familyId, codeHash: await sha256Hex(parsed.code), now })
      : null;

    if (!claimed) {
      await deps.db.recordPairingFailure(familyId, now);
      const since = new Date(now.getTime() - PAIRING_FAILURE_WINDOW_MS);
      if ((await deps.db.countPairingFailures(familyId, since)) >= PAIRING_MAX_FAILURES) {
        await deps.db.setPairingLockedUntil(familyId, new Date(now.getTime() + PAIRING_LOCK_MS));
        // A guessed code must not still work once the lock lifts.
        await deps.db.expireActivePairingCodes(familyId, now);
      }
      return json(400, { error: PAIRING_GENERIC_ERROR });
    }

    const deviceId = globalThis.crypto.randomUUID();
    const deviceSecret = await deriveDeviceSecret(deps.env.SHIELD_DEVICE_PAIRING_SECRET, deviceId);
    await deps.db.insertDevice({
      id: deviceId,
      family_id: familyId,
      person_id: person.id,
      label: parsed.label ?? null,
      platform: "android",
      android_version: parsed.android_version ?? null,
      protections: parsed.protections,
      paired_at: now,
      device_secret_hash: await sha256Hex(deviceSecret),
    });
    return json(200, { device_id: deviceId, device_secret: deviceSecret });
  } catch (err) {
    deps.log?.error("shield.pair.failed", { error: err instanceof Error ? err.message : String(err) });
    return json(500, { error: "server_error" });
  }
}
