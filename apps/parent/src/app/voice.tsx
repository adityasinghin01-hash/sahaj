// Riya's latest voice message (play with waveform), then a big hold-to-reply mic.
// Demo: playback and recording are simulated (no audio file / no microphone permission yet).
import { CheckCheck, Mic, Pause, Play } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { BackBar, M, MaaScreen, TILE_SHADOW, softHaptic, successHaptic, useFont } from '@/components/sahaj/maa';
import { Face, Tap, Waveform } from '@/components/sahaj/ui';
import { Icon } from '@/components/ui/icon';
import { latestVoice } from '@/lib/demo';
import { useT } from '@/lib/prefs';
import { cn } from '@/lib/utils';

const clock = (s: number) => `0:${String(Math.max(0, Math.round(s))).padStart(2, '0')}`;

export default function Voice() {
  const { t, pick } = useT();
  return (
    <MaaScreen>
      <BackBar />
      <View className="flex-row items-center">
        <Face name="Riya" size={64} tone={0} />
        <View className="ml-4 flex-1">
          <M v="title">{t('riyas_voice')}</M>
          <M v="small">{pick(latestVoice.sentAt)}</M>
        </View>
      </View>
      <Player />
      <M v="small" className="mt-4 text-center">{t('demo_voice')}</M>
      <View className="flex-1" />
      <Reply />
    </MaaScreen>
  );
}

function Player() {
  const { t } = useT();
  const font = useFont();
  const [playing, setPlaying] = React.useState(false);
  const [p, setP] = React.useState(0);
  const secs = latestVoice.seconds;
  React.useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setP((v) => {
        const nv = v + 0.1 / secs;
        if (nv >= 1) {
          setPlaying(false);
          return 0;
        }
        return nv;
      });
    }, 100);
    return () => clearInterval(id);
  }, [playing, secs]);
  return (
    <View className="mt-6 flex-row items-center rounded-[36px] bg-brand-soft p-3 pr-5">
      <Tap
        onPress={() => setPlaying((x) => !x)}
        haptic="medium"
        accessibilityRole="button"
        accessibilityLabel={playing ? t('pause') : t('play')}
        className="h-[88px] w-[88px] items-center justify-center rounded-full bg-brand">
        <Icon as={playing ? Pause : Play} size={40} className="text-white" style={{ marginLeft: playing ? 0 : 4 }} />
      </Tap>
      <View className="ml-4 flex-1">
        <Waveform progress={p} seed={latestVoice.seed} n={26} color="bg-brand" track="bg-brand/25" height={52} />
      </View>
      <M v="strong" weight="bold" className="ml-4 text-brand-ink" style={[font(22, 'bold'), { fontVariant: ['tabular-nums'] }]}>
        {clock(playing ? secs * (1 - p) : secs)}
      </M>
    </View>
  );
}

function Reply() {
  const { t } = useT();
  const [state, setState] = React.useState<'idle' | 'rec' | 'sent'>('idle');
  const [secs, setSecs] = React.useState(0);
  const [tick, setTick] = React.useState(1);
  const started = React.useRef(0);
  const pulse = useSharedValue(0);

  React.useEffect(() => {
    if (state !== 'rec') return;
    const id = setInterval(() => {
      setSecs((Date.now() - started.current) / 1000);
      setTick((x) => x + 1);
    }, 160);
    return () => clearInterval(id);
  }, [state]);

  const ring = useAnimatedStyle(() => ({ opacity: 0.45 * (1 - pulse.value), transform: [{ scale: 1 + pulse.value * 0.5 }] }));

  const down = () => {
    softHaptic();
    started.current = Date.now();
    setSecs(0);
    setState('rec');
    pulse.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.out(Easing.quad) }), -1, false);
  };
  const up = () => {
    cancelAnimation(pulse);
    pulse.value = 0;
    if ((Date.now() - started.current) / 1000 >= 1) {
      successHaptic();
      setState('sent');
    } else {
      setState('idle');
    }
  };

  const rec = state === 'rec';
  return (
    <View className="items-center">
      <View className="mb-4 h-[60px] w-full items-center justify-center">
        {rec ? (
          <View className="w-full flex-row items-center rounded-full bg-teal-soft px-5 py-2">
            <Waveform seed={tick} n={26} color="bg-teal" track="bg-teal" height={36} />
            <M v="strong" weight="bold" className="ml-4 text-teal-ink">{clock(secs)}</M>
          </View>
        ) : state === 'sent' ? (
          <View className="flex-row items-center rounded-full bg-ok-soft px-5 py-3">
            <Icon as={CheckCheck} size={28} className="text-ok-ink" />
            <M v="strong" weight="bold" className="ml-2 text-ok-ink">{t('sent_to_riya')}</M>
          </View>
        ) : null}
      </View>
      <View className="h-[150px] w-[150px] items-center justify-center">
        <Animated.View style={ring} className="absolute h-[140px] w-[140px] rounded-full bg-teal" />
        <Pressable
          onPressIn={down}
          onPressOut={up}
          accessibilityRole="button"
          accessibilityLabel={t('hold_to_reply')}
          className={cn('h-[140px] w-[140px] items-center justify-center rounded-full', rec ? 'bg-teal-ink' : 'bg-teal')}
          style={TILE_SHADOW}>
          <Icon as={Mic} size={60} className="text-white" />
        </Pressable>
      </View>
      <M v="h" className="mt-3 text-center">{rec ? t('recording') : t('hold_to_reply')}</M>
    </View>
  );
}
