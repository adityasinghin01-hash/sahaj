import { describe, expect, it } from 'vitest';
import { routeForPush } from '../lib/push-routes';

// Payloads copied from what the servers send (see lib/push-routes.ts header). Synthetic ids only.
describe('routeForPush', () => {
  it('opens the Shield alert for red and yellow verdicts', () => {
    for (const level of ['red', 'yellow']) {
      expect(routeForPush({ verdict_id: 'v_123', route: '/alert', level })).toEqual({
        pathname: '/alert',
        params: { id: 'v_123' },
        needsSession: true,
      });
    }
  });

  it('opens the alarm self-test without a session', () => {
    expect(routeForPush({ alarm_test: true })).toEqual({
      pathname: '/alert',
      params: { alarm_test: 'true' },
      needsSession: false,
    });
  });

  it('opens the urgent incident for every urgent-help stage', () => {
    expect(
      routeForPush({ kind: 'urgent_help', stage: 'offered', incidentId: 'inc-1', assignmentId: 'a-1' })
        .pathname
    ).toBe('/incident');
    expect(routeForPush({ kind: 'urgent_escalated', incidentId: 'inc-1' }).pathname).toBe(
      '/incident'
    );
  });

  it('opens voice for voice posts and Maa-words transcripts', () => {
    expect(routeForPush({ route: '/voice', voice_post_id: 'vp-1' }).pathname).toBe('/voice');
    expect(routeForPush({ kind: 'ai_transcript', message_id: 'm-1' }).pathname).toBe('/voice');
  });

  it('opens refills for refill proposals', () => {
    expect(routeForPush({ kind: 'refill_approval_card' }).pathname).toBe('/refills');
    expect(routeForPush({ kind: 'medicine_refill' }).pathname).toBe('/refills');
  });

  it("opens Maa's day for missed-call, check-in and matcher nudges", () => {
    expect(routeForPush({ kind: 'core1.missed_call_push' }).pathname).toBe('/maa-day');
    expect(routeForPush({ kind: 'missed_call_single' }).pathname).toBe('/maa-day');
    expect(
      routeForPush({ kind: 'check_in_unanswered', personId: 'p-1', localDate: '2026-11-15' })
        .pathname
    ).toBe('/maa-day');
    expect(
      routeForPush({ route: '/free-times', kind: 'core1.both_free_nudge', family_id: 'f-1' })
        .pathname
    ).toBe('/maa-day');
  });

  it('opens the matching Core 2 screen', () => {
    expect(routeForPush({ kind: 'core2.watch_escalation' }).pathname).toBe('/watch');
    expect(routeForPush({ kind: 'core2.watch_checkin', watch_id: 'w-1' }).pathname).toBe('/watch');
    expect(routeForPush({ kind: 'core2.device_handover' }).pathname).toBe('/watch');
    expect(routeForPush({ kind: 'core2.sos_alert', sos_id: 's-1' }).pathname).toBe('/sos');
    expect(routeForPush({ kind: 'core2.reassurance', status_label: 'Reached home' }).pathname).toBe(
      '/safe'
    );
  });

  it('opens proof with the challenge id', () => {
    expect(routeForPush({ route: '/proof', challenge_id: 'c-1' })).toEqual({
      pathname: '/proof',
      params: { challenge_id: 'c-1' },
      needsSession: true,
    });
    expect(routeForPush({ route: '/proof', challenge_id: '../x' })).toEqual({
      pathname: '/proof',
      needsSession: true,
    });
  });

  it('falls back to home for unknown or malformed data and never throws', () => {
    const home = { pathname: '/', needsSession: false };
    for (const data of [
      undefined,
      null,
      'x',
      42,
      [],
      {},
      { kind: 'something_new' },
      { route: '/sign-in' },
      { route: 'https://evil.example' },
      { verdict_id: 'bad id with spaces' },
      { route: '/alert' },
      { kind: 7, route: {} },
    ]) {
      expect(routeForPush(data)).toEqual(home);
    }
  });
});
