import { router } from 'expo-router';
import { CalendarClock, Check, Phone, PhoneMissed } from 'lucide-react-native';
import { View } from 'react-native';
import { LiveMaasDayScreen, LangToggle } from '@/components/sahaj/core1-screens';
import { LiveLoading } from '@/components/sahaj/live';
import {
  Btn,
  Card,
  Chip,
  Hero,
  IconTile,
  LevelPill,
  LiveDot,
  Screen,
  Section,
  T,
  TopBar,
} from '@/components/sahaj/ui';
import { CORE1_STRINGS, useCore1Lang } from '@/lib/core1';
import { demoCall, showToast, today } from '@/lib/demo';
import { useSession } from '@/lib/session';

function DemoMaasDay() {
  const [lang] = useCore1Lang();
  const s = CORE1_STRINGS[lang];
  return (
    <Screen>
      <TopBar title={s.maasDayTitle} right={<LangToggle />} />
      <View className="mb-4 flex-row items-center justify-between rounded-2xl bg-teal-soft px-4 py-2.5">
        <View className="flex-row items-center">
          <LiveDot color="bg-teal" size={7} />
          <T v="small" className="ml-2 font-jk-bold text-teal-ink">
            {s.demoLabel}
          </T>
        </View>
        <Chip label="Sign in for live" tone="sand" />
      </View>

      <Card tone="brand" className="mb-4">
        <View className="flex-row items-start">
          <IconTile icon={PhoneMissed} tone="brand" size={40} />
          <View className="ml-3 flex-1">
            <T v="label" className="text-brand-ink">
              {s.missedCallSub}
            </T>
            <T v="h3" className="mt-1">
              {s.missedCallTitle}
            </T>
          </View>
        </View>
        <Btn label={s.callMaa} icon={Phone} className="mt-4" onPress={demoCall} />
      </Card>

      <Hero tone="brand">
        <View className="flex-row items-center justify-between">
          <T v="label" className="text-brand-ink">
            {s.todayCheckin}
          </T>
          <LevelPill level={today.level} />
        </View>
        <T v="h2" className="mt-2">
          {today.headline}
        </T>
        <T v="small" className="mt-1">
          {today.checkin.time} · {today.checkin.by}
        </T>
        <View className="mt-4 gap-2">
          {today.lines.map((l) => (
            <View key={l.text} className="flex-row items-center">
              <IconTile icon={Check} tone="ok" size={26} />
              <T v="body" className="ml-2.5 text-ink">
                {l.text}
              </T>
            </View>
          ))}
        </View>
        <T v="small" className="mt-4">
          {s.nextCheckin}: {today.nextCheckin}
        </T>
      </Hero>

      <Section title="Family report">
        <Btn
          label={s.familyReportBtn}
          icon={CalendarClock}
          kind="dark"
          onPress={() => showToast('Demo mode · sign in to request a live family report.')}
        />
        <Btn
          label={s.signInPrompt}
          kind="ghost"
          className="mt-3"
          onPress={() => router.push('/sign-in')}
        />
      </Section>
    </Screen>
  );
}

export default function MaasDayRoute() {
  const { ready, session } = useSession();
  if (!ready) return <LiveLoading />;
  return session ? <LiveMaasDayScreen /> : <DemoMaasDay />;
}
