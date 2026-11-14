import { router } from 'expo-router';
import { Check, Pill } from 'lucide-react-native';
import { View } from 'react-native';
import { LiveRefillsScreen, LangToggle } from '@/components/sahaj/core1-screens';
import { LiveLoading } from '@/components/sahaj/live';
import {
  Btn,
  Card,
  Chip,
  IconTile,
  LiveDot,
  Screen,
  T,
  TopBar,
} from '@/components/sahaj/ui';
import { Icon } from '@/components/ui/icon';
import { CORE1_STRINGS, useCore1Lang } from '@/lib/core1';
import { approvals, done, updateDemo, useDemo } from '@/lib/demo';
import { useSession } from '@/lib/session';

function DemoRefills() {
  const [lang] = useCore1Lang();
  const s = CORE1_STRINGS[lang];
  const demo = useDemo();

  return (
    <Screen>
      <TopBar title={s.refillsTitle} right={<LangToggle />} />
      <View className="mb-4 flex-row items-center justify-between rounded-2xl bg-teal-soft px-4 py-2.5">
        <View className="flex-row items-center">
          <LiveDot color="bg-teal" size={7} />
          <T v="small" className="ml-2 font-jk-bold text-teal-ink">
            {s.demoLabel}
          </T>
        </View>
        <Chip label="Demo" tone="sand" />
      </View>

      {approvals.map((a) => (
        <Card key={a.id} className="mb-3">
          <View className="flex-row items-start">
            <IconTile icon={Pill} tone="watch" />
            <View className="ml-3 flex-1">
              <View className="flex-row items-center justify-between">
                <T v="h3">{a.title}</T>
                <T v="h3">{a.amount}</T>
              </View>
              <T v="small" className="mt-1">
                {a.detail}
              </T>
              <T v="small" className="mt-2 text-ink-2">
                {a.why}
              </T>
            </View>
          </View>
          {demo.approval ? (
            <View className="mt-4 flex-row items-center rounded-full bg-ok-soft px-4 py-2.5">
              <Icon as={Check} size={15} className="text-ok-ink" />
              <T v="small" className="ml-2 font-jk-bold text-ok-ink">
                {demo.approval === 'yes' ? 'Demo approved' : 'Demo declined'}
              </T>
            </View>
          ) : (
            <View className="mt-4 flex-row gap-2">
              <Btn
                label={s.approve}
                kind="teal"
                className="flex-1"
                onPress={() => updateDemo({ approval: 'yes' })}
              />
              <Btn
                label={s.decline}
                kind="ghost"
                className="flex-1"
                onPress={() => updateDemo({ approval: 'no' })}
              />
            </View>
          )}
        </Card>
      ))}

      {done.map((d) => (
        <Card key={d.id} tone="sand" className="mb-3">
          <T v="h3">
            {d.title} · {d.amount}
          </T>
          <T v="small" className="mt-1">
            {d.detail} · allowed by {d.rule}
          </T>
        </Card>
      ))}

      <Btn
        label={s.signInPrompt}
        kind="ghost"
        className="mt-3"
        onPress={() => router.push('/sign-in')}
      />
    </Screen>
  );
}

export default function RefillsRoute() {
  const { ready, session } = useSession();
  if (!ready) return <LiveLoading />;
  return session ? <LiveRefillsScreen /> : <DemoRefills />;
}
