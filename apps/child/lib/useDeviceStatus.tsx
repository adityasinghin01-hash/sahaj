import * as React from 'react';
import { AppState } from 'react-native';
import * as Battery from 'expo-battery';
import { createCore2 } from './core2';
import { createDeviceReporter, normalizeBattery, type BatterySample } from './device-reporter';
import { useSession, type Session } from './session';

let snapshot: BatterySample = { battery_level: null, is_charging: null };
const listeners = new Set<() => void>();
function publish(next: BatterySample) { snapshot = next; listeners.forEach((fn) => fn()); }
export function useDeviceBattery() {
  return React.useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => snapshot, () => snapshot);
}
/** Root owns the only reporter. Session/family changes tear down listeners and requests. */
export function DeviceStatusReporting() {
  const { session } = useSession();
  return session ? <SignedInDeviceStatus key={`${session.url}|${session.token}|${session.familyId ?? ''}`} session={session} /> : null;
}
function SignedInDeviceStatus({ session }: { session: Session }) {
  React.useEffect(() => {
    let disposed = false;
    let reading = false;
    const controllers = new Set<AbortController>();
    const api = createCore2(session);
    const reporter = createDeviceReporter(async (input, key) => {
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 12000);
      try { return await api.reportDeviceStatus(input, key, controller.signal); }
      finally { clearTimeout(timeout); controllers.delete(controller); }
    });
    async function read() {
      if (disposed || reading) return;
      reading = true;
      try {
        const available = await Battery.isAvailableAsync();
        const sample = available
          ? normalizeBattery(await Battery.getBatteryLevelAsync(), await Battery.getBatteryStateAsync())
          : { battery_level: null, is_charging: null };
        if (!disposed) { publish(sample); reporter.update(sample); }
      } catch {
        if (!disposed) { const unknown = { battery_level: null, is_charging: null }; publish(unknown); reporter.update(unknown); }
      } finally { reading = false; }
    }
    void read();
    // Android battery events are sparse; sample as well to catch the 10% crossing.
    const timer = setInterval(() => { if (AppState.currentState === 'active') void read(); }, 15000);
    const level = Battery.addBatteryLevelListener(() => { void read(); });
    const charging = Battery.addBatteryStateListener(() => { void read(); });
    const appState = AppState.addEventListener('change', (state) => { if (state === 'active') void read(); });
    return () => {
      disposed = true; reporter.stop(); clearInterval(timer); level.remove(); charging.remove(); appState.remove();
      controllers.forEach((c) => c.abort()); publish({ battery_level: null, is_charging: null });
    };
  }, [session]);
  return null;
}
