/**
 * Maps a push `data` payload to the screen Riya's app should open.
 * Pure (no React / Expo imports) so it can be unit-tested and never throws.
 *
 * Shapes our servers send today (grep in apps/api, apps/shield-api):
 * - Shield (apps/shield-api ports/push.ts): { verdict_id, route: '/alert', level }
 * - Alarm self-test (lib/shield-alarm): { alarm_test: true }
 * - Urgent help (core1/urgent-help-service.ts): { kind: 'urgent_help', stage, incidentId, assignmentId? }
 * - Voice (core1/voice-notify.ts): { route: '/voice', voice_post_id }
 * - Maa's words transcript (core1/sarvam-tools/production.ts): { kind: 'ai_transcript', message_id }
 * - Check-in missed (core1/check-in-service.ts): { kind: 'check_in_unanswered', personId, localDate }
 * - Both-free matcher (core1-matcher/service.ts): { route: '/free-times', kind: 'core1.both_free_nudge', ... }
 * - Proof of life (core2-proof/service.ts): { route: '/proof', challenge_id }
 * - Outbox kinds with no app-push sender yet, routed by `kind` for when one forwards them:
 *   core1.missed_call_push, refill_approval_card, core2.watch_escalation, core2.watch_checkin,
 *   core2.sos_alert, core2.reassurance, core2.device_handover.
 * Anything else opens home.
 */

export type PushRoute = {
  pathname:
    | '/'
    | '/alert'
    | '/incident'
    | '/voice'
    | '/refills'
    | '/maa-day'
    | '/free-times'
    | '/watch'
    | '/sos'
    | '/safe'
    | '/proof';
  params?: Record<string, string>;
  /** Live data screens need a signed-in session; the alarm self-test does not. */
  needsSession: boolean;
};

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HOME: PushRoute = { pathname: '/', needsSession: false };

function str(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key];
  return typeof v === 'string' && ID.test(v) ? v : undefined;
}

function byKind(kind: string): PushRoute['pathname'] | null {
  if (kind === 'urgent_help' || kind === 'urgent_escalated') return '/incident';
  if (kind === 'ai_transcript' || kind === 'core1.voice_notify') return '/voice';
  if (kind === 'refill_approval_card' || kind === 'medicine_refill' || kind.includes('refill'))
    return '/refills';
  // Missed-call and matcher nudges open Maa's day, which has the "Call Maa" button.
  if (
    kind === 'check_in_unanswered' ||
    kind === 'core1.missed_call_push' ||
    kind.startsWith('missed_call') ||
    kind === 'core1.both_free_nudge' ||
    kind === 'both_free_nudge'
  )
    return '/maa-day';
  if (
    kind === 'core2.watch_escalation' ||
    kind === 'core2.watch_checkin' ||
    kind === 'core2.device_handover'
  )
    return '/watch';
  if (kind === 'core2.sos_alert') return '/sos';
  if (kind === 'core2.reassurance') return '/safe';
  return null;
}

const ROUTE_HINTS: Record<string, PushRoute['pathname']> = {
  '/alert': '/alert',
  '/incident': '/incident',
  '/voice': '/voice',
  '/refills': '/refills',
  '/maa-day': '/maa-day',
  '/free-times': '/free-times',
  '/watch': '/watch',
  '/sos': '/sos',
  '/safe': '/safe',
  '/proof': '/proof',
};

export function routeForPush(raw: unknown): PushRoute {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return HOME;
  const data = raw as Record<string, unknown>;
  if (data.alarm_test === true) {
    return { pathname: '/alert', params: { alarm_test: 'true' }, needsSession: false };
  }
  const verdictId = str(data, 'verdict_id');
  if (verdictId) return { pathname: '/alert', params: { id: verdictId }, needsSession: true };

  const kind = typeof data.kind === 'string' ? data.kind : '';
  const hint = typeof data.route === 'string' ? ROUTE_HINTS[data.route] : undefined;
  // A known kind wins over the server's route hint (the matcher hints /free-times; the card wants Maa's day).
  const pathname = byKind(kind) ?? hint;
  if (!pathname || pathname === '/alert') return HOME; // /alert without a valid verdict id has nothing to show.

  if (pathname === '/proof') {
    const challengeId = str(data, 'challenge_id');
    return {
      pathname,
      ...(challengeId ? { params: { challenge_id: challengeId } } : {}),
      needsSession: true,
    };
  }
  return { pathname, needsSession: true };
}
