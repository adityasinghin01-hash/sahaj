import * as React from 'react';
import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import { router, usePathname, useRootNavigationState } from 'expo-router';
import { createApi } from './api';
import { useSession, type Session } from './session';
import { routeForPush, type PushRoute } from './push-routes';

import type { Notification } from 'expo-notifications';
import { offerDndAccessOnce, prepareShieldChannels } from './shield-alarm';
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
    await prepareShieldChannels(notifications);
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
    void offerDndAccessOnce();
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
  const [pending, setPending] = React.useState<PushRoute | null>(null);
  const handled = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (Platform.OS === 'web') return;
    let active = true;
    const subscriptions: { remove(): void }[] = [];
    const receive = (notification: Notification) => {
      if (!active) return;
      const key = `${notification.request.identifier}:${notification.date}`;
      if (key === handled.current) return;
      handled.current = key;
      // Unknown or malformed data opens home; routeForPush never throws.
      setPending(routeForPush(notification.request.content.data));
    };
    void import('expo-notifications').then(async (notifications) => {
      if (!active) return;
      notifications.setNotificationHandler({
        handleNotification: async (notification) => ({
          shouldShowBanner: true, shouldShowList: true,
          shouldPlaySound: notification.request.content.data?.level === 'red',
          shouldSetBadge: false,
        }),
      });
      subscriptions.push(notifications.addNotificationReceivedListener((notification) => {
        if (notification.request.content.data?.level === 'red') receive(notification);
      }));
      subscriptions.push(notifications.addNotificationResponseReceivedListener((response) => receive(response.notification)));
      subscriptions.push(AppState.addEventListener('change', (state) => {
        if (state === 'active') void prepareShieldChannels(notifications).catch(() => {});
      }));
      // Create channels even before sign-in, so local testing never needs a server.
      await prepareShieldChannels(notifications);
      if (!active) return;
      const last = await notifications.getLastNotificationResponseAsync();
      if (last) receive(last.notification);
    }).catch(() => {
      if (active) setNote('Push alerts need an installed build with notifications support.');
    });
    return () => { active = false; subscriptions.forEach((subscription) => subscription.remove()); };
  }, []);
  React.useEffect(() => {
    if (!pending || !ready || !navigation?.key) return;
    const done = () => {
      setPending(null);
      void import('expo-notifications').then((notifications) => notifications.clearLastNotificationResponseAsync()).catch(() => {});
    };
    if (pending.needsSession) {
      if (!session) {
        if (pathname !== '/sign-in') router.push('/sign-in');
        return;
      }
      // Let sign-in finish its storage write and default redirect before opening the screen.
      if (pathname === '/sign-in') return;
    }
    if (pending.pathname === '/') router.navigate('/');
    else router.push({ pathname: pending.pathname, params: pending.params });
    done();
  }, [pending, ready, session, navigation?.key, pathname]);
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
