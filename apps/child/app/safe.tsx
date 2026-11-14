import { Icon } from '@/components/ui/icon';
import {
  Btn,
  Card,
  ClipPlayer,
  Face,
  Notice,
  Pop,
  Screen,
  T,
  Tap,
  TopBar,
  palette,
  Waveform,
} from '@/components/sahaj/ui';
import { circle, family, safeClip, markSafe, useDemo, watch } from '@/lib/demo';
import { CheckCheck, Mic, Send } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

export default function Safe() {
  const demo = useDemo();
  const [stage, setStage] = React.useState<'idle' | 'recording' | 'sending' | 'heard'>(
    demo.safeSent ? 'heard' : 'idle'
  );
  const [seconds, setSeconds] = React.useState(0);
  const [error, setError] = React.useState('');
  const started = React.useRef<number | null>(null);
  const pulse = useSharedValue(1);
  const ring = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
    opacity: 2 - pulse.value,
  }));
  const friend = circle.find((person) => person.id === watch.friendId)!;
  React.useEffect(() => {
    started.current = null;
    setStage(demo.safeSent ? 'heard' : 'idle');
    setSeconds(0);
    setError('');
    pulse.value = 1;
  }, [demo.revision]);
  const finish = React.useCallback(() => {
    if (started.current === null) return;
    const length = Math.min(safeClip.maxSeconds, Math.floor((Date.now() - started.current) / 1000));
    started.current = null;
    pulse.value = withSpring(1);
    setSeconds(length);
    if (length < safeClip.minSeconds) {
      setStage('idle');
      setError('Hold for 3–5 seconds, or use your saved clip.');
      return;
    }
    setStage('sending');
  }, [pulse]);
  React.useEffect(() => {
    if (stage !== 'recording') return;
    const timer = setInterval(() => {
      if (started.current === null) return;
      const length = Math.floor((Date.now() - started.current) / 1000);
      setSeconds(length);
      if (length >= safeClip.maxSeconds) finish();
    }, 100);
    return () => clearInterval(timer);
  }, [stage, finish]);
  React.useEffect(() => {
    if (stage !== 'sending') return;
    const timer = setTimeout(() => {
      setStage('heard');
      markSafe();
    }, 2200);
    return () => clearTimeout(timer);
  }, [stage]);
  return (
    <Screen>
      <TopBar title="I’m safe" />
      <Pop>
        <T v="title">Main safe hoon.</T>
        <T v="body" className="mt-2">
          Let Maa hear it in your voice.
        </T>
      </Pop>
      {stage === 'heard' ? (
        <Pop>
          <Card tone="teal" className="mt-6">
            <View className="h-14 w-14 items-center justify-center rounded-full bg-teal">
              <Icon as={CheckCheck} size={28} className="text-white" />
            </View>
            <T v="title" className="mt-5 text-teal-deep">
              Maa heard your voice ✓✓
            </T>
            <T v="body" className="mt-3 text-teal-deep">
              Your circle was told you’re safe.
            </T>
            <View className="mt-5 flex-row items-center">
              <Face name={friend.name} />
              <View className="ml-3 flex-1">
                <T v="h3">{friend.name} knows too</T>
                <T v="small">Your safety contact · any open watch is closed</T>
              </View>
            </View>
          </Card>
          <Notice tone="sand">Demo delivery · no audio or notification was sent.</Notice>
          <Btn
            label="Send another"
            kind="ghost"
            className="mt-5"
            onPress={() => {
              setStage('idle');
              setSeconds(0);
            }}
          />
        </Pop>
      ) : stage === 'sending' ? (
        <Pop>
          <Card tone="teal" className="mt-8 items-center">
            <Icon as={Send} size={30} className="text-teal-ink" />
            <T v="h2" className="mt-4">
              On its way to Maa
            </T>
            <T v="small" className="mt-2">
              Demo clip · {seconds} seconds
            </T>
            <T v="body" className="mt-3 text-center">
              Sahaj is playing your voice on a call.
            </T>
          </Card>
        </Pop>
      ) : (
        <>
          <Pop delay={80}>
            <Card className="mt-6 items-center">
              <T v="label">Your voice, her reassurance</T>
              <View className="mt-6 h-12 w-full flex-row items-center">
                {stage === 'recording' ? (
                  <Waveform seed={seconds + 5} progress={1} n={32} height={40} />
                ) : (
                  <View className="h-px flex-1 bg-sand-line" />
                )}
              </View>
              <T v="num" className="mt-4">
                0:{String(seconds).padStart(2, '0')}
              </T>
              <T v="small" className="mt-1">
                {stage === 'recording'
                  ? 'Recording · release to send'
                  : 'Hold to record · 3–5 seconds'}
              </T>
              <View className="mt-4 h-40 w-40 items-center justify-center">
                <Animated.View
                  style={[
                    ring,
                    {
                      position: 'absolute',
                      width: 112,
                      height: 112,
                      borderRadius: 56,
                      backgroundColor: palette.brandSoft,
                    },
                  ]}
                />
                <Tap
                  accessibilityLabel="Hold to record a safety message"
                  onPressIn={() => {
                    setError('');
                    setSeconds(0);
                    started.current = Date.now();
                    setStage('recording');
                    pulse.value = withRepeat(withTiming(1.35, { duration: 900 }), -1, true);
                  }}
                  onPressOut={finish}
                  haptic="medium"
                  className="h-28 w-28 items-center justify-center rounded-full bg-brand">
                  <Icon as={Mic} size={38} className="text-white" />
                </Tap>
              </View>
              <T v="small" className="text-center">
                Stops and sends automatically at 5 seconds
              </T>
            </Card>
          </Pop>
          {error ? <Notice tone="sand">{error}</Notice> : null}
          <Card tone="brand" className="mt-4">
            <T v="label">Or use your saved clip</T>
            <T v="h2" className="mt-3 text-brand-deep">
              {safeClip.quote}
            </T>
            <T v="small" className="mt-2">
              {safeClip.translation}
            </T>
            <View className="mt-4">
              <ClipPlayer seconds={safeClip.seconds} seed={19} />
            </View>
            <Btn
              label="Use saved"
              className="mt-4"
              onPress={() => {
                setSeconds(safeClip.seconds);
                setStage('sending');
                setError('');
              }}
            />
          </Card>
          <T v="small" className="mt-4 text-center">
            Demo recorder · previews the flow without microphone access.
          </T>
        </>
      )}
      <T v="small" className="mt-6 text-center">
        A familiar voice on {family.parent.called}’s {family.parent.phone}.
      </T>
    </Screen>
  );
}
