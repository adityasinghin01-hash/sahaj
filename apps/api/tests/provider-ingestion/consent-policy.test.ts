import { describe, expect, it } from "vitest";
import { CONSENT_MAX_AGE_MS, consentExpiresAtMs, consentWithinPolicy } from "../../src/lib/provider-ingestion/consent-policy";
import { effectiveConsent } from "../../src/lib/provider-ingestion/gateway";
import { CALL_ID, consent, FAMILY, PERSON } from "./helpers";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const want = { familyId: FAMILY, personId: PERSON, callId: CALL_ID, purpose: "call_recording" as const, version: "consent-v1" };
const at = (ms: number) => new Date(ms).toISOString();

describe("shared consent policy", () => {
  it("matches Phase 3: 365 days, strictly younger, never in the future", () => {
    expect(CONSENT_MAX_AGE_MS).toBe(365 * 86_400_000);
    expect(consentWithinPolicy(at(NOW), NOW)).toBe(true);
    expect(consentWithinPolicy(at(NOW - CONSENT_MAX_AGE_MS + 1), NOW)).toBe(true);
    expect(consentWithinPolicy(at(NOW - CONSENT_MAX_AGE_MS), NOW)).toBe(false);
    expect(consentWithinPolicy(at(NOW + 1), NOW)).toBe(false);
    expect(consentWithinPolicy("not a date", NOW)).toBe(false);
    expect(consentExpiresAtMs("2026-11-14T10:00:00.000Z")).toBe(Date.parse("2026-11-14T10:00:00.000Z") + CONSENT_MAX_AGE_MS);
  });
  it("the ingestion gateway applies it to call-scoped grants, so no event is queued on an expired consent", () => {
    expect(effectiveConsent([consent({ createdAt: at(NOW - 1000) })], want, NOW)).toBeTruthy();
    expect(effectiveConsent([consent({ createdAt: at(NOW - CONSENT_MAX_AGE_MS) })], want, NOW)).toBeNull();
    expect(effectiveConsent([consent({ createdAt: at(NOW + 5000) })], want, NOW)).toBeNull();
  });
  it("revocation, wrong purpose, wrong call and wrong version still fail", () => {
    const yes = consent({ createdAt: at(NOW - 5000) });
    expect(effectiveConsent([yes, consent({ id: "r", callId: null, answer: false, createdAt: at(NOW - 1000) })], want, NOW)).toBeNull();
    expect(effectiveConsent([consent({ purpose: "call_transcript", createdAt: at(NOW - 5000) })], want, NOW)).toBeNull();
    expect(effectiveConsent([consent({ callId: "99999999-9999-4999-8999-999999999999", createdAt: at(NOW - 5000) })], want, NOW)).toBeNull();
    expect(effectiveConsent([consent({ version: "old", createdAt: at(NOW - 5000) })], want, NOW)).toBeNull();
  });
});
