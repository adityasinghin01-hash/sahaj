import { Icon } from '@/components/ui/icon';
import { Card, Chip, Pop, Screen, T, TopBar, Waveform } from '@/components/sahaj/ui';
import { family } from '@/lib/demo';
import { cn } from '@/lib/utils';
import * as Haptics from 'expo-haptics';
import { Check, CheckCheck, Mic, Phone, Smartphone } from 'lucide-react-native';
import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSpring, withTiming } from 'react-native-reanimated';

type Stage = 'idle' | 'recording' | 'sent' | 'delivered' | 'heard';

export default function Voice() {
  const [stage, setStage] = React.useState<Stage>('idle');
  const [secs, setSecs] = React.useState(0);
  const [seed, setSeed] = React.useState(5);
  const pulse = useSharedValue(1);
  const ring = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }], opacity: 2 - pulse.value }));

  React.useEffect(() => {
    if (stage !== 'recording') return;
    const id = setInterval(() => {
      setSecs((s) => s + 1);
      setSeed((x) => x + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [stage]);

  React.useEffect(() => {
    if (stage === 'sent') {
      const a = setTimeout(() => setStage('delivered'), 1400);
      const b = setTimeout(() => setStage('heard'), 3400);
      return () => {
        clearTimeout(a);
        clearTimeout(b);
      };
    }
  }, [stage]);

  const start = () => {
    setSecs(0);
    setStage('recording');
    pulse.value = withRepeat(withTiming(1.35, { duration: 900 }), -1, true);
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };
  const stop = () => {
    pulse.value = withSpring(1);
    setStage(secs > 0 ? 'sent' : 'idle');
    if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <Screen>
      <TopBar title="Voice for Maa" />
      <T v="title">Say it in your voice</T>
      <T v="body" className="mt-2">
        Maa hears your real voice on her {family.parent.phone}. If she replies, you get her voice back.
      </T>

      <View className="mt-4 flex-row">
        <Chip icon={Phone} label="Plays as a call on the keypad" tone="brand" />
      </View>
      <View className="mt-2 flex-row">
        <Chip icon={Smartphone} label="Or ▶ in her app" tone="teal" />
      </View>

      {/* recorder */}
      <View className="mt-10 items-center">
        <View className="h-14 w-full flex-row items-center px-2">
          {stage === 'recording' ? <Waveform seed={seed} n={40} progress={1} height={48} /> : <View className="h-px flex-1 bg-sand-line" />}
        </View>
        <T v="num" className="mt-4" style={{ fontVariant: ['tabular-nums'] }}>
          0:{String(secs).padStart(2, '0')}
        </T>
        <T v="small" className="mt-1">{stage === 'recording' ? 'Release to send' : 'Hold the button and talk'}</T>

        <View className="mt-8 h-40 w-40 items-center justify-center">
          <Animated.View style={ring} className="absolute h-32 w-32 rounded-full bg-brand/20" />
          <Pressable onPressIn={start} onPressOut={stop}>
            <View className={cn('h-28 w-28 items-center justify-center rounded-full', stage === 'recording' ? 'bg-brand-deep' : 'bg-brand')}>
              <Icon as={Mic} size={40} className="text-white" />
            </View>
          </Pressable>
        </View>
      </View>

      {stage === 'sent' || stage === 'delivered' || stage === 'heard' ? (
        <Pop>
          <Card className="mt-6">
            <T v="label">Your message · 0:{String(secs).padStart(2, '0')}</T>
            <Step done label="Sent to Sahaj" />
            <Step done={stage !== 'sent'} label="Played to Maa on a call" />
            <Step done={stage === 'heard'} label="Maa heard it" icon={CheckCheck} />
            {stage === 'heard' ? <T v="small" className="mt-3 text-ok-ink">If Maa replies, her voice arrives here and on WhatsApp.</T> : null}
          </Card>
        </Pop>
      ) : null}
    </Screen>
  );
}

function Step({ done, label, icon = Check }: { done: boolean; label: string; icon?: typeof Check }) {
  return (
    <View className="mt-3 flex-row items-center">
      <View className={cn('h-6 w-6 items-center justify-center rounded-full', done ? 'bg-ok' : 'bg-sand')}>
        {done ? <Icon as={icon} size={13} className="text-white" /> : null}
      </View>
      <T v="body" className={cn('ml-3', done ? 'text-ink' : 'text-ink-muted')}>{label}</T>
    </View>
  );
}
