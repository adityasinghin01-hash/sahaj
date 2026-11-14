import * as React from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { router, usePathname, useRootNavigationState } from 'expo-router';
import { createApi } from './api';
import { useSession, type Session } from './session';

import type { NotificationResponse } from 'expo-notifications';
let note = Platform.OS === 'web' ? 'Push alerts are available in the installed phone app.' : '';
const listeners = new Set<() => void>();
const setNote = (value: string) => { note = value; listeners.forEach((fn) => fn()); };
export function usePushStatus() {
  return React.useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => note,
    () => note
  );
}
let askedThisRun = false;
const ASKED_KEY = 'sahaj.push.permission.asked.v1';
async function register(session: Session, current: () => boolean) {
  try {
    const notifications = await import('expo-notifications');
    if (!current()) return;
    if (Platform.OS === 'android') {
      await notifications.setNotificationChannelAsync('shield-alerts', {
        name: 'Shield alerts',
        importance: notifications.AndroidImportance.HIGH,
        lockscreenVisibility: notifications.AndroidNotificationVisibility.PRIVATE,
      });
    }
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) {
      if (current()) setNote('Push alerts are off: finish eas init for Riya’s app, then rebuild and sign in.');
      return;
    }
    let permission = await notifications.getPermissionsAsync();
    if (permission.status === 'undetermined' && permission.canAskAgain && !askedThisRun) {
      const store = await import('expo-secure-store');
      const available = await store.isAvailableAsync();
      const asked = available ? await store.getItemAsync(ASKED_KEY) : null;
      if (!asked && current()) {
        askedThisRun = true;
        if (available) await store.setItemAsync(ASKED_KEY, 'yes');
        permission = await notifications.requestPermissionsAsync();
      }
    }
    if (!current()) return;
    if (!permission.granted) {
      setNote('Push alerts are off. Enable notifications in phone Settings; Shield alerts remain available in the app.');
      return;
    }
    const token = (await notifications.getExpoPushTokenAsync({ projectId })).data;
    if (!current()) return;
    await createApi(session).push({ expo_token: token });
    if (current()) setNote('Push alerts are connected.');
  } catch {
    // Provider/native errors can include credentials. Show only fixed text.
    if (current()) setNote('Push registration is unavailable. Check the connection and Android FCM setup, then sign in again.');
  }
}

/** Mounted beside the router: handles running, background and cold-start taps. */
export function PushNotifications() {
  const { ready, session } = useSession();
  const navigation = useRootNavigationState();
  const pathname = usePathname();
  const [pendingId, setPendingId] = React.useState<string | null>(null);
  const handled = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (Platform.OS === 'web') return;
    let active = true;
    let subscription: { remove(): void } | undefined;
    const receive = (response: NotificationResponse) => {
      if (!active) return;
      const key = response.notification.request.identifier;
      const id = response.notification.request.content.data?.verdict_id;
      if (key === handled.current || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
      handled.current = key;
      setPendingId(id);
    };
    void import('expo-notifications').then(async (notifications) => {
      if (!active) return;
      notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false,
        }),
      });
      subscription = notifications.addNotificationResponseReceivedListener(receive);
      const last = await notifications.getLastNotificationResponseAsync();
      if (last) receive(last);
    }).catch(() => {
      if (active) setNote('Push alerts need an installed build with notifications support.');
    });
    return () => { active = false; subscription?.remove(); };
  }, []);
  React.useEffect(() => {
    if (!pendingId || !ready || !navigation?.key) return;
    if (!session) {
      if (pathname !== '/sign-in') router.push('/sign-in');
      return;
    }
    // Let sign-in finish its storage write and default redirect before opening the alert.
    if (pathname === '/sign-in') return;
    router.push({ pathname: '/alert', params: { id: pendingId } });
    setPendingId(null);
    void import('expo-notifications').then((notifications) => notifications.clearLastNotificationResponseAsync()).catch(() => {});
  }, [pendingId, ready, session, navigation?.key, pathname]);
  React.useEffect(() => {
    if (Platform.OS === 'web' || !ready) return;
    if (!session) { setNote('Sign in to connect push alerts.'); return; }
    let active = true;
    setNote('Connecting push alerts…');
    void register(session, () => active);
    return () => { active = false; };
  }, [ready, session]);
  return null;
}
