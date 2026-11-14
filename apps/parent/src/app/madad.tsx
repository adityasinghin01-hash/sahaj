// After confirming Madad: live urgent-help status polling (calm, reassuring, zero scary words).
import { router, useLocalSearchParams } from 'expo-router';
import { House, Phone, RefreshCw } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { BigBtn, M, MaaScreen, successHaptic } from '@/components/sahaj/maa';
import { Face, Tap } from '@/components/sahaj/ui';
import { Icon } from '@/components/ui/icon';
import { useCall } from '@/lib/call';
import { family } from '@/lib/demo';
import { fetchMaaUrgentStatus, isLivePaired, type MaaUrgentStatus } from '@/lib/maa-api';
import { usePrefs, useT } from '@/lib/prefs';

const POLL_INTERVAL_MS = 5000;

export default function Madad() {
  const { t } = useT();
  const { lang } = usePrefs();
  const call = useCall();
  const params = useLocalSearchParams<{ id?: string; demo?: string }>();
  const incidentId = typeof params.id === 'string' ? params.id : null;
  const liveMode = Boolean(incidentId) && isLivePaired() && params.demo !== '1';

  const [status, setStatus] = React.useState<MaaUrgentStatus | null>(null);
  const [pollError, setPollError] = React.useState(false);

  const ring = useSharedValue(0);
  React.useEffect(() => {
    successHaptic();
    ring.value = withRepeat(withTiming(1, { duration: 2200, easing: Easing.out(Easing.quad) }), -1, false);
  }, [ring]);

  const pollOnce = React.useCallback(async () => {
    if (!incidentId || !liveMode) return;
    const res = await fetchMaaUrgentStatus(incidentId);
    if (!res.ok) {
      if (res.kind !== 'not_paired') setPollError(true);
      return;
    }
    setPollError(false);
    setStatus(res.data);
  }, [incidentId, liveMode]);

  React.useEffect(() => {
    if (!liveMode || !incidentId) return;
    let active = true;
    const fetchNow = async () => {
      const res = await fetchMaaUrgentStatus(incidentId);
      if (!active) return;
      if (!res.ok) {
        if (res.kind !== 'not_paired') setPollError(true);
        return;
      }
      setPollError(false);
      setStatus(res.data);
    };

    const initial = setTimeout(() => {
      void fetchNow();
    }, 0);
    const timer = setInterval(() => {
      if (status?.state === 'resolved' || status?.state === 'cancelled') return;
      void fetchNow();
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [incidentId, liveMode, status?.state]);

  const ringStyle = useAnimatedStyle(() => ({
    opacity: 0.5 * (1 - ring.value),
    transform: [{ scale: 1 + ring.value * 0.6 }],
  }));

  const responderName = status?.responder?.display_name ?? 'Sharma';
  const headline = liveMode
    ? status
      ? lang === 'hi'
        ? status.status_line_hi
        : status.status_line_en
      : t('madad_sent_waiting')
    : t('helper_coming');

  const subline = liveMode
    ? status?.responder && status.eta_minutes
      ? `${status.responder.display_name} · ${status.eta_minutes} min`
      : t('riya_told')
    : t('minutes_away');

  return (
    <MaaScreen bg="bg-ok-soft">
      <View className="flex-1 items-center justify-center">
        <View className="h-44 w-44 items-center justify-center">
          <Animated.View style={ringStyle} className="absolute h-40 w-40 rounded-full bg-ok" />
          <View className="rounded-full border-4 border-white">
            <Face name={responderName} size={140} tone={1} />
          </View>
        </View>
        <M v="hero" className="mt-8 text-center text-ok-ink">
          {headline}
        </M>
        <M v="h" className="mt-3 text-center text-ink-2">
          {subline}
        </M>
        {!liveMode ? (
          <M v="body" className="mt-2 text-center">
            {t('demo_notice')}
          </M>
        ) : null}

        {liveMode && pollError ? (
          <View className="mt-5 w-full rounded-3xl bg-watch-soft px-5 py-4">
            <M v="body" className="text-center text-watch-ink">
              {t('server_unreachable')}
            </M>
            <Tap
              onPress={() => void pollOnce()}
              accessibilityRole="button"
              className="mt-3 flex-row items-center self-center rounded-full bg-white px-5 py-2">
              <Icon as={RefreshCw} size={18} className="text-watch-ink" />
              <M v="strong" weight="bold" className="ml-2 text-watch-ink">
                {t('retry')}
              </M>
            </Tap>
          </View>
        ) : null}
      </View>

      <BigBtn kind="ok" icon={Phone} label={t('call_riya')} onPress={() => call(family.riya.phone)} />
      <BigBtn className="mt-4" kind="soft" icon={House} label={t('home')} onPress={() => router.dismissTo('/')} />
    </MaaScreen>
  );
}
