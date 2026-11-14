import '@/global.css';
import { PushNotifications } from '@/lib/notifications';
import { Btn, Card, T, palette } from '@/components/sahaj/ui';

import {
  NotoSansDevanagari_400Regular,
  NotoSansDevanagari_600SemiBold,
} from '@expo-google-fonts/noto-sans-devanagari';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/plus-jakarta-sans';
import { setWatchStage, updateDemo, useDemo, watch, today } from '@/lib/demo';
import { View } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as React from 'react';

export { ErrorBoundary } from 'expo-router';

SplashScreen.preventAutoHideAsync().catch(() => {});

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
  if (!loaded) return null;
  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: palette.cream },
          animation: 'slide_from_right',
        }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="sos" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
      </Stack>
      <PushNotifications />
      <PortalHost />
      <DemoOverlay />
    </>
  );
}

function DemoOverlay() {
  const demo = useDemo();
  React.useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      if (demo.watch.stage === 'active' && now >= demo.watch.deadline) setWatchStage('asking');
      else if (
        demo.watch.stage === 'asking' &&
        now >= demo.watch.deadline + watch.promptSeconds * 1000
      )
        setWatchStage('escalated');
    }, 500);
    return () => clearInterval(timer);
  }, [demo.watch.stage, demo.watch.deadline]);
  React.useEffect(() => {
    if (!demo.toast) return;
    const timer = setTimeout(() => updateDemo({ toast: null }), 3500);
    return () => clearTimeout(timer);
  }, [demo.toast]);
  return (
    <>
      {demo.call ? (
        <View
          className="absolute inset-0 items-center justify-center bg-ink/40 px-6"
          accessibilityViewIsModal>
          <Card className="w-full">
            <T v="h2">Demo · Maa is on the line</T>
            <T v="body" className="mt-2">
              {today.callQuote}
            </T>
            <Btn
              label="End call"
              kind="dark"
              className="mt-5"
              onPress={() => updateDemo({ call: false })}
            />
          </Card>
        </View>
      ) : null}
      {demo.toast ? (
        <View
          pointerEvents="none"
          className="absolute bottom-28 left-5 right-5 rounded-2xl bg-ink px-4 py-3">
          <T v="small" accessibilityLiveRegion="polite" className="text-white">
            {demo.toast}
          </T>
        </View>
      ) : null}
    </>
  );
}
