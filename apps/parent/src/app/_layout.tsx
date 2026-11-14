import '../../global.css';
import '@/lib/interop';

import { NotoSansDevanagari_400Regular, NotoSansDevanagari_600SemiBold } from '@expo-google-fonts/noto-sans-devanagari';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/plus-jakarta-sans';
import { PortalHost } from '@rn-primitives/portal';
import { router, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';

import { PrefsProvider } from '@/lib/prefs';
import { shield } from '@/lib/shield';

export { ErrorBoundary } from 'expo-router';

SplashScreen.preventAutoHideAsync().catch(() => {});

/** A RED verdict while the app is open → in-app red screen (the native overlay may also show). */
function useRedVerdicts() {
  React.useEffect(
    () =>
      shield.onVerdict((v) => {
        if (v.level !== 'red') return;
        router.push({ pathname: '/warning', params: { scamType: v.scamType, reason: v.reasons[0] ?? '' } });
      }),
    []
  );
}

export default function RootLayout() {
  const [loaded] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
    NotoSansDevanagari_400Regular,
    NotoSansDevanagari_600SemiBold,
  });
  React.useEffect(() => {
    if (loaded) SplashScreen.hideAsync().catch(() => {});
  }, [loaded]);
  useRedVerdicts();
  if (!loaded) return null;
  return (
    <PrefsProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#FDF9F8' }, animation: 'slide_from_right' }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="warning" options={{ presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false, contentStyle: { backgroundColor: '#C62828' } }} />
        <Stack.Screen name="after-call" options={{ presentation: 'fullScreenModal', animation: 'fade', gestureEnabled: false }} />
        <Stack.Screen name="madad" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
      </Stack>
      <PortalHost />
    </PrefsProvider>
  );
}
