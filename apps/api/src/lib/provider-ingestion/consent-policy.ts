/**
 * SHARED consent validity policy. `consents` has no expiry column, so the only finite validity is a maximum age, identical to
 * Phase 3's `sahaj_private.consent_max_age()` (365 days) and to this lane's SQL (`call_recording_consent`, `put_call_recording`,
 * purge). A grant counts only while it is not in the future and is STRICTLY younger than the maximum age. Refusals never age out.
 * Storage retention is capped at the grant's own expiry, so nothing is kept after the gate would refuse it.
 */
export const CONSENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export function consentWithinPolicy(createdAtIso: string, nowMs: number): boolean {
  const t = Date.parse(createdAtIso);
  return Number.isFinite(t) && t <= nowMs && t > nowMs - CONSENT_MAX_AGE_MS;
}
export const consentExpiresAtMs = (createdAtIso: string): number => Date.parse(createdAtIso) + CONSENT_MAX_AGE_MS;
