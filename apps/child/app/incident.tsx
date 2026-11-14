import { Icon } from '@/components/ui/icon';
import { Btn, Card, ClipPlayer, Face, LevelPill, LiveDot, Pop, Screen, T, TopBar } from '@/components/sahaj/ui';
import { incident, type ChainState } from '@/lib/demo';
import { cn } from '@/lib/utils';
import { Check, Clock3, Phone, PhoneMissed, Radio } from 'lucide-react-native';
import { View } from 'react-native';

const stateStyle: Record<ChainState, { ring: string; icon: typeof Check; iconCls: string }> = {
  done: { ring: 'bg-ok', icon: Check, iconCls: 'text-white' },
  live: { ring: 'bg-teal', icon: Radio, iconCls: 'text-white' },
  skipped: { ring: 'bg-sand-2', icon: PhoneMissed, iconCls: 'text-ink-muted' },
  waiting: { ring: 'bg-sand', icon: Clock3, iconCls: 'text-ink-muted' },
};

export default function Incident() {
  return (
    <Screen>
      <TopBar title="Urgent call" right={<LiveDot color="bg-danger" />} />

      <Pop>
        <Card tone="danger">
          <LevelPill level="red" label="Open · someone is on it" />
          <T v="title" className="mt-3">{incident.title}</T>
          <T v="small" className="mt-1 text-ink-2">{incident.startedAt} · {incident.how}</T>
          <View className="mt-5">
            <T v="label" className="mb-2 text-danger-ink">Maa’s own words</T>
            <ClipPlayer seconds={incident.words.seconds} seed={3} tone="danger" />
            <T v="body" className="mt-2 italic text-ink">{incident.words.quote}</T>
            <T v="small">{incident.words.translation}</T>
          </View>
        </Card>
      </Pop>

      <Pop delay={80}>
        <Card className="mt-4 flex-row items-center">
          <View className="flex-1">
            <T v="num">{incident.acceptedIn}</T>
            <T v="small" className="mt-1">until someone said “I’m going”</T>
          </View>
          <View className="h-12 w-px bg-sand-line" />
          <View className="ml-5 flex-1">
            <T v="num" className="text-ok-ink">1</T>
            <T v="small" className="mt-1">person on the way</T>
          </View>
        </Card>
      </Pop>

      <T v="label" className="mb-3 mt-7">Who Sahaj asked, in order</T>
      <Card className="py-1">
        {incident.chain.map((c, i) => {
          const s = stateStyle[c.state];
          const last = i === incident.chain.length - 1;
          return (
            <View key={c.who} className="flex-row">
              <View className="mr-4 items-center pt-4">
                <View className={cn('h-8 w-8 items-center justify-center rounded-full', s.ring)}>
                  <Icon as={s.icon} size={15} className={s.iconCls} />
                </View>
                {!last ? <View className="mt-1 w-0.5 flex-1 bg-sand-line" /> : null}
              </View>
              <View className={cn('flex-1 py-4', !last && 'border-b border-sand-line')}>
                <View className="flex-row items-center justify-between">
                  <View className="flex-row items-center">
                    <Face name={c.who} size={28} />
                    <T v="h3" className="ml-2.5">{c.who}</T>
                  </View>
                  <T v="small" className="font-jk-semibold">{c.time}</T>
                </View>
                <T v="small" className="mt-1">{c.role}</T>
                <T v="body" className={cn('mt-1.5', c.state === 'done' ? 'font-jk-semibold text-ok-ink' : 'text-ink-2')}>{c.note}</T>
              </View>
            </View>
          );
        })}
      </Card>

      <Card tone="teal" className="mt-4 flex-row items-center">
        <LiveDot color="bg-teal" />
        <T v="body" className="ml-3 flex-1 text-teal-deep">{incident.next}</T>
      </Card>

      <View className="mt-6 flex-row">
        <Btn label="Call Maa" icon={Phone} className="mr-2 flex-1" size="lg" />
        <Btn label="Call uncle" icon={Phone} kind="dark" className="flex-1" size="lg" />
      </View>
      <T v="small" className="mt-3 text-center">If it gets worse, call 112</T>
    </Screen>
  );
}
