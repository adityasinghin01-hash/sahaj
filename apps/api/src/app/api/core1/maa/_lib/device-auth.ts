import { SHIELD_HEADERS, SHIELD_MAX_SKEW_MS } from '@sahaj/shared';
import {
  constantTimeEqual,
  deriveDeviceSecret,
  sha256Hex,
  signShieldBody,
} from '../../../../../../../../packages/shield/src/server/crypto';
import type { MaaRepo } from './repo';
import { MaaRouteError, type VerifiedMaaDevice } from './types';

const DEVICE_ID_PATTERN = /^[a-zA-Z0-9_-]{3,80}$/;
const TS_PATTERN = /^\d{10,16}$/;
const SIG_PATTERN = /^[0-9a-f]{64}$/;
const MAX_REPLAY_CACHE_ENTRIES = 10_000;

export interface ReplayGuard {
  consume(nonce: string, nowMs: number, ttlMs: number): Promise<boolean> | boolean;
}

export function createMemoryReplayGuard(): ReplayGuard {
  const seen = new Map<string, number>();

  return {
    consume(nonce: string, nowMs: number, ttlMs: number): boolean {
      for (const [key, expiresAt] of seen.entries()) {
        if (expiresAt <= nowMs) {
          seen.delete(key);
        }
      }

      const existing = seen.get(nonce);
      if (existing !== undefined && existing > nowMs) {
        return false;
      }

      if (seen.size >= MAX_REPLAY_CACHE_ENTRIES) {
        const oldestKey = seen.keys().next().value;
        if (oldestKey !== undefined) {
          seen.delete(oldestKey);
        }
      }

      seen.set(nonce, nowMs + ttlMs);
      return true;
    },
  };
}

const defaultReplayGuard = createMemoryReplayGuard();

export interface VerifyMaaDeviceOptions {
  repo: MaaRepo;
  pairingSecret?: string;
  now?: () => Date;
  replayGuard?: ReplayGuard;
}

/**
 * Verifies a signed Shield paired-device request (GET or POST) and resolves it
 * fail-closed to a single `(familyId, personId)` where `person.role === 'parent'`.
 */
export async function verifyMaaDeviceRequest(
  request: Request,
  rawBody: Uint8Array,
  opts: VerifyMaaDeviceOptions,
): Promise<VerifiedMaaDevice> {
  const deviceId = request.headers.get(SHIELD_HEADERS.device)?.trim() ?? '';
  const ts = request.headers.get(SHIELD_HEADERS.ts)?.trim() ?? '';
  const sig = request.headers.get(SHIELD_HEADERS.sig)?.trim().toLowerCase() ?? '';

  if (!DEVICE_ID_PATTERN.test(deviceId) || !TS_PATTERN.test(ts) || !SIG_PATTERN.test(sig)) {
    throw new MaaRouteError('invalid_device_headers', 401);
  }

  const nowMs = (opts.now ? opts.now() : new Date()).getTime();
  const tsMs = Number(ts);
  if (!Number.isFinite(tsMs) || Math.abs(nowMs - tsMs) > SHIELD_MAX_SKEW_MS) {
    throw new MaaRouteError('timestamp_out_of_window', 401);
  }

  const pairingSecret = opts.pairingSecret ?? process.env.SHIELD_DEVICE_PAIRING_SECRET ?? '';
  if (!pairingSecret) {
    throw new MaaRouteError('pairing_secret_not_configured', 503);
  }

  const device = await opts.repo.getDevice(deviceId);
  if (!device || device.revoked) {
    throw new MaaRouteError('unknown_or_revoked_device', 401);
  }

  const expectedSecret = await deriveDeviceSecret(pairingSecret, deviceId);
  const expectedHash = await sha256Hex(expectedSecret);
  if (!constantTimeEqual(expectedHash, device.deviceSecretHash.toLowerCase())) {
    throw new MaaRouteError('invalid_device_secret', 401);
  }

  const expectedSig = await signShieldBody(expectedSecret, ts, rawBody);
  if (!constantTimeEqual(sig, expectedSig)) {
    throw new MaaRouteError('invalid_signature', 401);
  }

  const guard = opts.replayGuard ?? defaultReplayGuard;
  const fresh = await guard.consume(`${deviceId}:${ts}:${sig}`, nowMs, SHIELD_MAX_SKEW_MS);
  if (!fresh) {
    throw new MaaRouteError('replay_detected', 401);
  }

  const person = await opts.repo.getPersonInFamily(device.familyId, device.personId);
  if (!person || person.familyId !== device.familyId || person.role !== 'parent') {
    throw new MaaRouteError('parent_role_required', 403);
  }

  if (opts.repo.touchDeviceHeartbeat) {
    try {
      await opts.repo.touchDeviceHeartbeat(deviceId, new Date(nowMs).toISOString());
    } catch {
      // Heartbeat update is non-blocking for Core 1 requests.
    }
  }

  return {
    deviceId: device.deviceId,
    familyId: device.familyId,
    personId: device.personId,
    displayName: person.displayName,
  };
}
