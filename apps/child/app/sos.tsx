import { Core2Gate } from '@/components/core2/common';
import { LiveSos } from '@/components/core2/sos';
import { Icon } from '@/components/ui/icon';
import {
  Btn,
  Card,
  Face,
  LiveDot,
  Notice,
  Pop,
  Screen,
  T,
  Tap,
  TopBar,
  palette,
} from '@/components/sahaj/ui';
import { cancelPendingSos, circle, showToast, sos, updateDemo, useDemo } from '@/lib/demo';
import { Check, Phone, ShieldCheck, Siren } from 'lucide-react-native';
import * as React from 'react';
import { AppState, Linking, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const radius = 100;
const circumference = 2 * Math.PI * radius;

function DemoSOS() {
  const demo = useDemo();
  const [holding, setHolding] = React.useState(false);
  const [seconds, setSeconds] = React.useState(sos.cancelSeconds);
  const holdTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdStarted = React.useRef(0);
  const progress = useSharedValue(0);
  const ring = useAnimatedProps(() => ({ strokeDashoffset: circumference * (1 - progress.value) }));
  const friend = circle.find((p) => p.id === sos.friendId)!;
  const stopHold = React.useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdStarted.current = 0;
    cancelAnimation(progress);
    progress.value = 0;
    setHolding(false);
  }, [progress]);
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (status) => {
      if (status !== 'active') stopHold();
    });
    return () => {
      sub.remove();
      stopHold();
    };
  }, [stopHold]);
  React.useEffect(() => {
    stopHold();
  }, [demo.revision, stopHold]);
  React.useEffect(() => {
    if (demo.sosStage !== 'countdown') return;
    setSeconds(sos.cancelSeconds);
    const deadline = Date.now() + sos.cancelSeconds * 1000;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSeconds(left);
      if (!left) {
        clearInterval(timer);
        updateDemo({ sosStage: 'alerted' });
      }
    }, 100);
    return () => {
      clearInterval(timer);
    };
  }, [demo.sosStage]);
  // Leaving the modal during the grace period cancels the pending demo alert.
  React.useEffect(
    () => () => {
      cancelPendingSos();
    },
    []
  );
  const beginHold = () => {
    if (demo.sosStage !== 'idle' || holdTimer.current) return;
    holdStarted.current = Date.now();
    setHolding(true);
    progress.value = withTiming(1, { duration: sos.holdSeconds * 1000, easing: Easing.linear });
    holdTimer.current = setTimeout(() => {
      if (Date.now() - holdStarted.current >= sos.holdSeconds * 1000)
        updateDemo({ sosStage: 'countdown' });
      holdTimer.current = null;
      setHolding(false);
    }, sos.holdSeconds * 1000);
  };
  const callEmergency = () =>
    Linking.openURL(`tel:${sos.emergencyNumber}`).catch(() =>
      showToast('Open your phone and dial 112.')
    );
  return (
    <Screen>
      <TopBar title="SOS" />
      <Pop>
        <T v="label" className="text-center">
          Your safety circle
        </T>
        <T v="title" className="mt-3 text-center">
          {demo.sosStage === 'alerted'
            ? 'You’re not on your own.'
            : demo.sosStage === 'safe'
              ? 'You’re safe now.'
              : 'Help is a hold away.'}
        </T>
        <T v="body" className="mt-3 text-center">
          {demo.sosStage === 'idle'
            ? `Hold for ${sos.holdSeconds} seconds. Release early to stop.`
            : demo.sosStage === 'countdown'
              ? 'A moment to cancel before your circle is told.'
              : demo.sosStage === 'safe'
                ? 'Your circle has been told. Take your time.'
                : 'Your circle can see you need help.'}
        </T>
      </Pop>
      {demo.sosStage === 'idle' ? (
        <Pop>
          <View className="my-8 items-center">
            <View style={{ width: 232, height: 232 }} className="items-center justify-center">
              <Svg width={232} height={232} style={{ position: 'absolute' }}>
                <Circle
                  cx={116}
                  cy={116}
                  r={radius}
                  stroke={palette.dangerSoft}
                  strokeWidth={8}
                  fill="none"
                />
                <AnimatedCircle
                  cx={116}
                  cy={116}
                  r={radius}
                  stroke={palette.danger}
                  strokeWidth={8}
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  animatedProps={ring}
                  transform="rotate(-90 116 116)"
                />
              </Svg>
              <Tap
                accessibilityLabel="Hold to alert circle for 3 seconds"
                onPressIn={beginHold}
                onPressOut={stopHold}
                haptic="heavy"
                className="h-44 w-44 items-center justify-center rounded-full bg-danger">
                <Icon as={Siren} size={42} className="text-white" />
                <T v="h2" className="mt-3 text-white">
                  {holding ? 'Keep holding' : 'Hold to alert'}
                </T>
                <T v="small" className="mt-1 text-white/85">
                  {sos.holdSeconds} seconds
                </T>
              </Tap>
            </View>
          </View>
          <Card tone="sand">
            <T v="bodyStrong">{friend.name} is your first contact</T>
            <T v="small" className="mt-2">
              The circle gets a request for help, then a follow-up when you’re safe.
            </T>
          </Card>
        </Pop>
      ) : demo.sosStage === 'countdown' ? (
        <Pop>
          <Card tone="danger" className="mt-8 items-center">
            <T v="display" className="text-[64px] leading-[72px] text-danger-ink">
              {seconds}
            </T>
            <T v="bodyStrong" className="mt-2">
              seconds until your circle is alerted
            </T>
            <Btn
              label="Cancel alert"
              kind="dark"
              size="lg"
              className="mt-6 w-full"
              onPress={() => {
                updateDemo({ sosStage: 'idle' });
                progress.value = 0;
                showToast('Demo alert cancelled · nobody was told.');
              }}
            />
          </Card>
        </Pop>
      ) : (
        <Pop>
          <Card tone={demo.sosStage === 'safe' ? 'teal' : 'danger'} className="mt-8">
            <View className="flex-row items-center">
              {demo.sosStage === 'safe' ? (
                <Icon as={Check} size={20} className="text-teal-ink" />
              ) : (
                <LiveDot color="bg-danger" />
              )}
              <T v="h2" className="ml-3 flex-1">
                {demo.sosStage === 'safe'
                  ? 'Circle told · you’re safe'
                  : `Circle alerted · ${friend.name} is coming`}
              </T>
            </View>
            <View className="mt-5 flex-row items-center">
              <Face name={friend.name} />
              <View className="ml-3">
                <T v="h3">{friend.name}</T>
                <T v="small">
                  {friend.role} · {friend.city}
                </T>
              </View>
            </View>
            <T v="small" className="mt-4">
              Demo response · no real alert has been sent.
            </T>
          </Card>
          {demo.sosStage === 'alerted' ? (
            <>
              <Btn
                label="Call 112"
                icon={Phone}
                kind="danger"
                size="lg"
                className="mt-6"
                onPress={callEmergency}
              />
              <Btn
                label="I’m safe now"
                icon={ShieldCheck}
                kind="ghost"
                size="lg"
                className="mt-3"
                onPress={() => updateDemo({ sosStage: 'safe' })}
              />
            </>
          ) : (
            <Btn
              label="Back to SOS"
              kind="ghost"
              className="mt-5"
              onPress={() => updateDemo({ sosStage: 'idle' })}
            />
          )}
        </Pop>
      )}
      <Notice tone="sand">
        Demo SOS · “Call 112” opens your phone’s dialler for a real emergency call.
      </Notice>
    </Screen>
  );
}

export default function SOS() {
  return <Core2Gate title="sos" demo={<DemoSOS />}><LiveSos /></Core2Gate>;
}
