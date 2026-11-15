import { describe, expect, it, vi, afterEach } from 'vitest';
import { createDeviceReporter, normalizeBattery } from '../lib/device-reporter';
import { createCore2 } from '../lib/core2';
import { core2Text } from '../lib/core2-strings';
afterEach(() => vi.unstubAllGlobals());
const drain = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
describe('device reporting', () => {
  it.each([[0.1, 1, 10, false], [0.109, 1, 11, false], [0.15, 2, 15, true], [1, 3, 100, true], [-1, 0, null, null], [NaN, 0, null, null]])(
    'normalizes Expo %s / %s without making unknown battery critical', (level, state, battery_level, is_charging) => {
      expect(normalizeBattery(level as number, state as number)).toEqual({ battery_level, is_charging });
    });
  it('throttles changes but sends a critical crossing immediately and maintains heartbeat', async () => {
    let now = 0;
    const send = vi.fn().mockResolvedValue({});
    const reporter = createDeviceReporter(send, () => now);
    reporter.update({ battery_level: 20, is_charging: false }); await drain();
    now = 1000; reporter.update({ battery_level: 15, is_charging: true }); await drain();
    expect(send).toHaveBeenCalledTimes(1);
    now = 2000; reporter.update({ battery_level: 10, is_charging: false }); await drain();
    expect(send).toHaveBeenCalledTimes(2);
    now = 3000; reporter.update({ battery_level: 9, is_charging: false }); await drain();
    expect(send).toHaveBeenCalledTimes(2);
    now = 62000; reporter.update({ battery_level: 9, is_charging: false }); await drain();
    expect(send).toHaveBeenCalledTimes(3);
  });
  it('retries identical payload and key after a lost response', async () => {
    let now = 0;
    const send = vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue({});
    const reporter = createDeviceReporter(send, () => now);
    reporter.update({ battery_level: 20, is_charging: false }); await drain();
    now = 60000; reporter.update({ battery_level: 19, is_charging: true }); await drain();
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  });
  it('does not overlap a send and promptly reports a critical change seen during it', async () => {
    let resolve!: () => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; })).mockResolvedValue({});
    const reporter = createDeviceReporter(send, () => 0);
    reporter.update({ battery_level: 20, is_charging: false });
    reporter.update({ battery_level: 10, is_charging: false });
    expect(send).toHaveBeenCalledTimes(1);
    resolve(); await drain();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].battery_level).toBe(10);
  });
  it('stops reporting after sign-out/unmount', async () => {
    const send = vi.fn().mockResolvedValue({});
    const reporter = createDeviceReporter(send);
    reporter.stop(); reporter.update({ battery_level: 0, is_charging: false }); await drain();
    expect(send).not.toHaveBeenCalled();
  });
  it('throttles failed retries and replaces an obsolete failed sample at the critical crossing', async () => {
    let now = 0;
    const send = vi.fn().mockRejectedValue(new Error('offline'));
    const reporter = createDeviceReporter(send, () => now);
    reporter.update({ battery_level: 20, is_charging: false }); await drain();
    now = 1000; reporter.update({ battery_level: 19, is_charging: true }); await drain();
    expect(send).toHaveBeenCalledTimes(1);
    now = 2000; reporter.update({ battery_level: 10, is_charging: false }); await drain();
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][0].battery_level).toBe(10);
    now = 3000; reporter.update({ battery_level: 9, is_charging: false }); await drain();
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('uses Core 2 bearer, family and mutation headers and exposes the own GET', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{"device_status":null}'));
    vi.stubGlobal('fetch', fetcher);
    const api = createCore2({ url: 'https://synthetic.example', token: 'synthetic', familyId: '10000000-0000-4000-8000-000000000001' });
    await api.reportDeviceStatus({ battery_level: 10, is_charging: false, sampled_at: '2026-11-15T00:00:00.000Z' }, 'device-key');
    expect(fetcher.mock.calls[0][0]).toContain('/api/core2/device-status');
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer synthetic', 'Idempotency-Key': 'device-key' });
    await api.deviceStatus();
    expect(fetcher.mock.calls[1][1].method).toBe('GET');
  });
  it('includes the prescribed English and Hindi banner strings', () => {
    expect(core2Text('en', 'phoneLow')).toBe('Phone low — Priya and Maa will be told calmly if it dies');
    expect(core2Text('hi', 'phoneLow')).toContain('प्रिया और माँ');
  });
});

import { safeSubscribe } from '../lib/device-reporter';
describe('battery listeners on web', () => {
  it('a subscribe that throws (expo-battery on web) becomes a no-op instead of crashing the app', () => {
    const sub = safeSubscribe(() => { throw new TypeError('u.default.addListener is not a function'); });
    expect(() => sub.remove()).not.toThrow();
    const remove = vi.fn();
    safeSubscribe(() => ({ remove })).remove();
    expect(remove).toHaveBeenCalledOnce();
  });
});
