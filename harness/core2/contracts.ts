import type { Core2SharingPreferencesFixture, Core2TrustedContactFixture } from './fixtures';

export type Core2WatchState = 'active' | 'checking_in' | 'escalated' | 'safe' | 'cancelled';

export interface Core2WatchStateMachine {
  id: string;
  familyId: string;
  subjectPersonId: string;
  state: Core2WatchState;
  version: number;
  deadlineAtMs: number;
  graceUntilMs: number;
  safeAtMs: number | null;
}

/**
 * Models the Core 2 transactional Safe-vs-Timeout invariant (`CORE2-API.md` section 2.2):
 * If `safe` commits first, a concurrent overdue timeout tick sees `state='safe'` (version changed)
 * and CANNOT re-escalate or create a dispatch.
 */
export function resolveWatchSafeContract(
  watch: Core2WatchStateMachine,
  expectedVersion: number,
  nowMs: number,
):
  | { status: 200; watch: Core2WatchStateMachine; dispatchReassuranceOnlyIfEscalated: boolean }
  | { status: 409; error: 'stale_version' | 'watch_cancelled' } {
  if (watch.state === 'cancelled') return { status: 409, error: 'watch_cancelled' };
  if (watch.version !== expectedVersion) return { status: 409, error: 'stale_version' };
  const wasEscalatedOrChecking = watch.state === 'checking_in' || watch.state === 'escalated';
  return {
    status: 200,
    watch: {
      ...watch,
      state: 'safe',
      safeAtMs: nowMs,
      version: watch.version + 1,
    },
    dispatchReassuranceOnlyIfEscalated: wasEscalatedOrChecking,
  };
}

export function applyWatchOverdueTickContract(
  watch: Core2WatchStateMachine,
  claimedVersion: number,
  nowMs: number,
): { transitioned: boolean; watch: Core2WatchStateMachine } {
  if (watch.version !== claimedVersion) return { transitioned: false, watch };
  if (watch.state !== 'active' && watch.state !== 'checking_in') {
    return { transitioned: false, watch };
  }
  if (nowMs >= watch.graceUntilMs) {
    return {
      transitioned: true,
      watch: { ...watch, state: 'escalated', version: watch.version + 1 },
    };
  }
  if (nowMs >= watch.deadlineAtMs && watch.state === 'active') {
    return {
      transitioned: true,
      watch: { ...watch, state: 'checking_in', version: watch.version + 1 },
    };
  }
  return { transitioned: false, watch };
}

/**
 * Trusted contact resolver per `CORE2-API.md` section 2.3:
 * Same-family membership alone is never a grant; requires active state, consentApproved,
 * matching scope, unrevoked, and effective window.
 */
export function selectEligibleTrustedContacts(
  contacts: readonly Core2TrustedContactFixture[],
  params: {
    familyId: string;
    subjectPersonId: string;
    scope: 'sos' | 'watch_escalation' | 'reassurance';
    nowMs: number;
  },
): Core2TrustedContactFixture[] {
  return contacts
    .filter((c) => {
      if (c.familyId !== params.familyId || c.subjectPersonId !== params.subjectPersonId) return false;
      if (c.state !== 'active' || !c.consentApproved || c.revokedAtIso !== null) return false;
      if (!c.scopes.includes(params.scope)) return false;
      const from = Date.parse(c.effectiveFromIso);
      const until = c.effectiveUntilIso === null ? Infinity : Date.parse(c.effectiveUntilIso);
      return Number.isFinite(from) && params.nowMs >= from && params.nowMs < until;
    })
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
}

export interface RedactedReassuranceProjection {
  statusLabel: string;
  deliveryVerified: boolean;
  locationIncluded: boolean;
  healthIncluded: boolean;
  narrativeIncluded: boolean;
  routeText: string | null;
  healthNote: string | null;
  narrativeText: string | null;
}

/** Enforces read-time redaction based on live sharing preferences (private by default). */
export function projectReassuranceForReader(params: {
  statusLabel: string;
  deliveryVerified: boolean;
  preferences: Core2SharingPreferencesFixture;
  privateRouteText: string;
  privateHealthNote: string;
  privateNarrative: string;
}): RedactedReassuranceProjection {
  const { preferences } = params;
  return {
    statusLabel: preferences.shareStatusWithParent ? params.statusLabel : 'private',
    deliveryVerified: params.deliveryVerified,
    locationIncluded: preferences.allowLocationShare,
    healthIncluded: preferences.allowHealthShare,
    narrativeIncluded: preferences.allowNarrativeShare,
    routeText: preferences.allowLocationShare ? params.privateRouteText : null,
    healthNote: preferences.allowHealthShare ? params.privateHealthNote : null,
    narrativeText: preferences.allowNarrativeShare ? params.privateNarrative : null,
  };
}
