// After holding Madad 2 s: help is on the way. Calm, one message, two buttons.
import { router } from 'expo-router';
import { House, Phone } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { BigBtn, M, MaaScreen, successHaptic } from '@/components/sahaj/maa';
import { Face } from '@/components/sahaj/ui';
import { family } from '@/lib/demo';
import { useT } from '@/lib/prefs';
import { useCall } from '@/lib/call';

export default function Madad() {
  const { t } = useT();
  const call = useCall();
  const ring = useSharedValue(0);
  React.useEffect(() => {
    successHaptic();
    ring.value = withRepeat(withTiming(1, { duration: 2200, easing: Easing.out(Easing.quad) }), -1, false);
  }, [ring]);
  const ringStyle = useAnimatedStyle(() => ({ opacity: 0.5 * (1 - ring.value), transform: [{ scale: 1 + ring.value * 0.6 }] }));

  return (
    <MaaScreen bg="bg-ok-soft">
      <View className="flex-1 items-center justify-center">
        <View className="h-44 w-44 items-center justify-center">
          <Animated.View style={ringStyle} className="absolute h-40 w-40 rounded-full bg-ok" />
          <View className="rounded-full border-4 border-white">
            <Face name="Sharma" size={140} tone={1} />
          </View>
        </View>
        <M v="hero" className="mt-8 text-center text-ok-ink">{t('helper_coming')}</M>
        <M v="h" className="mt-3 text-center text-ink-2">{t('minutes_away')}</M>
        <M v="body" className="mt-2 text-center">{t('demo_notice')}</M>
      </View>
      <BigBtn kind="ok" icon={Phone} label={t('call_helper')} onPress={() => call(family.helper.phone)} />
      <BigBtn className="mt-4" kind="soft" icon={House} label={t('home')} onPress={() => router.dismissTo('/')} />
    </MaaScreen>
  );
}
