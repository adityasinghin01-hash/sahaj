import { newCore2Key, type DeviceInput } from './core2';

export type BatterySample = { battery_level: number | null; is_charging: boolean | null };
export function normalizeBattery(level: number, state: number): BatterySample {
  return { battery_level: Number.isFinite(level) && level >= 0 && level <= 1 ? Math.ceil(level * 100 - 1e-6) : null,
    is_charging: state === 2 || state === 3 ? true : state === 1 ? false : null };
}
/** One regular report/minute, one immediate critical crossing; retries keep payload AND key. */
export function createDeviceReporter(send: (input: DeviceInput, key: string) => Promise<unknown>, now = Date.now) {
  let lastSent = -Infinity;
  let criticalSent = false;
  let running = false;
  let stopped = false;
  let pending: { input: DeviceInput; key: string; critical: boolean } | null = null;
  let latest: BatterySample | null = null;
  async function flush() {
    if (stopped || running || !latest) return;
    const critical = latest.battery_level !== null && latest.battery_level <= 10;
    if (!critical) criticalSent = false;
    if (pending && now() - lastSent < 60000) {
      if (!(critical && !criticalSent && !pending.critical)) return;
      // A failed older sample must not hold up the critical threshold report.
      pending = null;
    }
    if (!pending) {
      if (now() - lastSent < 60000 && !(critical && !criticalSent)) return;
      pending = { input: { ...latest, sampled_at: new Date(now()).toISOString() }, key: newCore2Key(), critical };
    }
    const job = pending;
    running = true;
    lastSent = now();
    if (job.critical) criticalSent = true;
    try { await send(job.input, job.key); pending = null; }
    catch { /* Preserve exact request for the next retry. Never fabricate success. */ }
    finally { running = false; }
    // A critical transition during an in-flight normal request must not wait a minute.
    if (!stopped && !pending && latest.battery_level !== null && latest.battery_level <= 10 && !criticalSent) void flush();
  }
  return {
    update(sample: BatterySample) { latest = sample; void flush(); },
    stop() { stopped = true; latest = null; },
  };
}

/** Battery listeners are optional (unsupported on web): a failed subscribe becomes a no-op subscription. */
export function safeSubscribe(subscribe: () => { remove(): void }): { remove(): void } {
  try { const sub = subscribe(); return sub && typeof sub.remove === 'function' ? sub : { remove() {} }; }
  catch { return { remove() {} }; }
}
