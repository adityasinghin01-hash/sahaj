import { Core2Gate } from '@/components/core2/common';
import { LiveWatch } from '@/components/core2/watch';
import { Icon } from '@/components/ui/icon';
import {
  Btn,
  Card,
  Chip,
  Face,
  Field,
  Hero,
  LiveDot,
  Notice,
  Pop,
  Screen,
  T,
  Tap,
  TopBar,
} from '@/components/sahaj/ui';
import {
  circle,
  extendWatch,
  setWatchStage,
  showToast,
  startWatch,
  updateDemo,
  useDemo,
  watch,
} from '@/lib/demo';
import { useLocalSearchParams } from 'expo-router';
import { ArrowDown, Check, Home, MapPin, Phone } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

function DemoWatch() {
  const demo = useDemo();
  const { scene } = useLocalSearchParams<{ scene?: string }>();
  const [minutes, setMinutes] = React.useState<number | 'custom'>(30);
  const [custom, setCustom] = React.useState(String(watch.customMinutes));
  const [from, setFrom] = React.useState(demo.watch.from);
  const [to, setTo] = React.useState(demo.watch.to);
  const [cab, setCab] = React.useState(demo.watch.cab);
  const [error, setError] = React.useState('');
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  React.useEffect(() => {
    if (scene === 'late')
      updateDemo({ watch: { ...demo.watch, stage: 'asking', deadline: Date.now() } });
  }, [scene]);
  React.useEffect(() => {
    setMinutes(30);
    setCustom(String(watch.customMinutes));
    setError('');
    setFrom(watch.from);
    setTo(watch.to);
    setCab(watch.cabNote);
  }, [demo.revision]);
  const remaining = Math.max(0, Math.ceil((demo.watch.deadline - now) / 1000));
  const countdown = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  const friend = circle.find((p) => p.id === watch.friendId)!;
  const start = () => {
    const value = minutes === 'custom' ? Number(custom) : minutes;
    if (!Number.isInteger(value) || value < 1 || value > 240) {
      setError('Choose a whole number from 1 to 240 minutes.');
      return;
    }
    if (!from.trim() || !to.trim()) {
      setError('Add your starting place and destination.');
      return;
    }
    setError('');
    startWatch(value, from.trim(), to.trim(), cab.trim());
  };
  const reached = () => {
    setWatchStage('reached');
    showToast('Demo · you’ve reached. Your watch is closed.');
  };
  return (
    <Screen>
      <TopBar title="Going home" />
      <Pop>
        <T v="title">A little company,{'\n'}all the way home.</T>
        <T v="body" className="mt-2">
          Your own quiet safety net.
        </T>
      </Pop>
      {demo.watch.stage === 'idle' ? (
        <Pop delay={70}>
          <Card className="mt-6">
            <T v="label">How long will you need?</T>
            <View className="mt-3 flex-row flex-wrap gap-2">
              {watch.options.map((option) => (
                <Tap
                  key={option.label}
                  accessibilityState={{ selected: minutes === option.minutes }}
                  onPress={() => setMinutes(option.minutes)}
                  className="min-h-12 justify-center">
                  <Chip label={option.label} tone={minutes === option.minutes ? 'teal' : 'sand'} />
                </Tap>
              ))}
              <Tap
                onPress={() => setMinutes('custom')}
                accessibilityState={{ selected: minutes === 'custom' }}
                className="min-h-12 justify-center">
                <Chip label="Custom" tone={minutes === 'custom' ? 'teal' : 'sand'} />
              </Tap>
            </View>
            {minutes === 'custom' ? (
              <Field
                label="Minutes until you reach"
                value={custom}
                onChangeText={setCustom}
                keyboardType="number-pad"
                maxLength={3}
              />
            ) : null}
            <Field label="From" value={from} onChangeText={setFrom} />
            <View className="mt-4">
              <Icon as={ArrowDown} size={16} className="text-ink-muted" />
            </View>
            <Field label="To" value={to} onChangeText={setTo} />
            <Field label="Cab note (optional)" value={cab} onChangeText={setCab} />
          </Card>
          {error ? <Notice tone="sand">{error}</Notice> : null}
          <Btn label="Start watch" kind="teal" className="mt-5" size="lg" onPress={start} />
          <T v="small" className="mt-3 text-center">
            Nobody is told anything unless you’re late.
          </T>
        </Pop>
      ) : demo.watch.stage === 'reached' ? (
        <Pop>
          <Card tone="teal" className="mt-6 items-center">
            <View className="h-16 w-16 items-center justify-center rounded-full bg-teal">
              <Icon as={Check} size={30} className="text-white" />
            </View>
            <T v="title" className="mt-5 text-teal-deep">
              Home, safely.
            </T>
            <T v="body" className="mt-2 text-center">
              Your watch is closed. Take a breath.
            </T>
          </Card>
          <Btn
            label="New watch"
            kind="teal"
            className="mt-5"
            onPress={() => setWatchStage('idle')}
          />
        </Pop>
      ) : (
        <Pop>
          <View className="mt-6">
            <Hero>
              <View className="flex-row items-center">
                <LiveDot />
                <T v="bodyStrong" className="ml-3 text-teal-deep">
                  {demo.watch.stage === 'active' ? 'Watch is on' : 'Checking you’re safe'}
                </T>
              </View>
              <T
                v="display"
                className={
                  demo.watch.stage === 'active'
                    ? 'mt-6 text-[48px] leading-[56px] text-teal-deep'
                    : 'mt-6 text-[28px] leading-[34px] text-teal-deep'
                }
                style={{ fontVariant: ['tabular-nums'] }}>
                {demo.watch.stage === 'active' ? countdown : 'Time to check in'}
              </T>
              <T v="small" className="mt-2">
                {demo.watch.stage === 'active'
                  ? 'Minutes : seconds until your ETA'
                  : 'Your expected arrival time has passed'}
              </T>
              <T v="body" className="mt-5 text-teal-deep">
                Nobody is told anything unless you’re late.
              </T>
            </Hero>
          </View>
          <Card className="mt-4">
            <View className="flex-row items-start">
              <Icon as={MapPin} size={18} className="text-teal-ink" />
              <View className="ml-3 flex-1">
                <T v="small">From · {demo.watch.from}</T>
                <T v="bodyStrong" className="mt-2">
                  To · {demo.watch.to}
                </T>
                {demo.watch.cab ? (
                  <T v="small" className="mt-2">
                    {demo.watch.cab}
                  </T>
                ) : null}
              </View>
            </View>
          </Card>
          {demo.watch.stage === 'asking' ? (
            <Card tone="brand" className="mt-4">
              <View className="flex-row items-center">
                <LiveDot color="bg-brand" />
                <T v="h3" className="ml-3">
                  Sahaj is asking you…
                </T>
              </View>
              <T v="body" className="mt-2">
                {watch.prompt}
              </T>
              <T v="small" className="mt-2">
                No response? {friend.name} is asked after {watch.promptSeconds} seconds in this
                demo.
              </T>
            </Card>
          ) : null}
          {demo.watch.stage === 'escalated' ? (
            <Card tone="brand" className="mt-4">
              <View className="flex-row items-center">
                <Face name={friend.name} />
                <View className="ml-3 flex-1">
                  <T v="h2">{friend.name} is checking on you</T>
                  <T v="small">
                    {friend.role} · {friend.city}
                  </T>
                </View>
              </View>
              <T v="body" className="mt-3">
                You didn’t answer, so your safety contact was alerted.
              </T>
              <T v="small" className="mt-2">
                Demo alert · no real notification sent
              </T>
              <Btn
                label={`Call ${friend.name}`}
                icon={Phone}
                kind="ghost"
                className="mt-4"
                onPress={() => showToast(`Demo call · ${friend.name} is checking you’re safe.`)}
              />
            </Card>
          ) : null}
          <View className="mt-5 gap-3">
            <Btn label="I’ve reached" icon={Home} kind="teal" size="lg" onPress={reached} />
            <Btn label="+15 min" kind="ghost" onPress={extendWatch} />
          </View>
          {demo.watch.stage === 'active' ? (
            <Tap
              className="mt-6 min-h-12 items-center justify-center"
              onPress={() =>
                updateDemo({ watch: { ...demo.watch, stage: 'asking', deadline: Date.now() } })
              }>
              <T v="small" className="text-brand-ink">
                Preview late scene · demo
              </T>
            </Tap>
          ) : null}
        </Pop>
      )}
      <T v="small" className="mt-6 text-center">
        Demo watch · no location is tracked or shared.
      </T>
    </Screen>
  );
}

export default function Watch() {
  return <Core2Gate title="watch" demo={<DemoWatch />}><LiveWatch /></Core2Gate>;
}
