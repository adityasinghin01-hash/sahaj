import { useSession } from '@/lib/session';
import { LiveHome, LiveLoading } from '@/components/sahaj/live';
import { Icon } from '@/components/ui/icon';
import {
  Btn,
  Card,
  Chip,
  ClipPlayer,
  Face,
  Hero,
  IconTile,
  LevelPill,
  LiveDot,
  Pop,
  Section,
  Screen,
  T,
  Tap,
} from '@/components/sahaj/ui';
import {
  approvals,
  done,
  family,
  incident,
  shield,
  today,
  demoCall,
  updateDemo,
  useDemo,
} from '@/lib/demo';
import { router } from 'expo-router';
import {
  Activity,
  ArrowUpRight,
  BellRing,
  Check,
  ChevronRight,
  Home as HomeIcon,
  Mic,
  Moon,
  Phone,
  Pill,
  ShieldCheck,
  Siren,
  Sparkles,
  type LucideIcon,
} from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

const lineIcon: Record<string, LucideIcon> = { moon: Moon, pill: Pill, activity: Activity };

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function DemoHome() {
  const demo = useDemo();
  const approved = demo.approval;
  const setApproved = (approval: 'yes' | 'no') => updateDemo({ approval });
  const tapCount = React.useRef(0);
  React.useEffect(() => {
    tapCount.current = 0;
  }, [demo.revision]);

  return (
    <Screen>
      <Btn label="Connect live Shield" kind="ghost" onPress={() => router.push('/sign-in')} />
      {/* Header */}
      <View className="mb-5 mt-2 flex-row items-center justify-between">
        <View>
          <T v="small">{greeting()}</T>
          <T v="title">{family.child.name}</T>
        </View>
        <View className="flex-row items-center">
          <View className="mr-3 flex-row items-center rounded-full bg-teal-soft px-3 py-1.5">
            <LiveDot color="bg-teal" size={7} />
            <T v="small" className="ml-2 font-jk-bold text-teal-ink">
              Demo mode
            </T>
          </View>
          {/* hidden demo panel: tap the face 5 times */}
          <Tap
            accessibilityLabel="Riya’s profile"
            onPress={() => {
              tapCount.current += 1;
              if (tapCount.current >= 5) {
                tapCount.current = 0;
                router.push('/demo');
              }
            }}>
            <Face name={family.child.name} size={42} tone={0} />
          </Tap>
        </View>
      </View>

      {/* Live incident banner (only when one is open) */}
      <Pop>
        <Tap onPress={() => router.push('/incident')} haptic="medium">
          <View className="mb-4 flex-row items-center overflow-hidden rounded-2xl bg-danger px-4 py-3.5">
            <View className="h-9 w-9 items-center justify-center rounded-full bg-white/20">
              <Icon as={Siren} size={18} className="text-white" />
            </View>
            <View className="ml-3 flex-1">
              <T v="bodyStrong" className="text-white">
                {incident.title}
              </T>
              <T v="small" className="text-white/85">
                {incident.chain.find((person) => person.state === 'done')?.who} accepted ·{' '}
                {incident.startedAt}
              </T>
            </View>
            <Icon as={ChevronRight} size={20} className="text-white" />
          </View>
        </Tap>
      </Pop>

      {/* Maa today — hero */}
      <Pop delay={60}>
        <View className="overflow-hidden rounded-3xl">
          <Hero tone="brand">
            <View className="flex-row items-start justify-between">
              <View className="mr-2 flex-1 flex-row items-center">
                <View className="h-[52px] w-[52px] items-center justify-center rounded-full bg-white">
                  <T v="h2" className="text-brand-ink">
                    M
                  </T>
                </View>
                <View className="ml-3 flex-1">
                  <T v="label" className="text-brand-ink">
                    Maa today
                  </T>
                  <T v="h2" className="mt-0.5">
                    {today.headline}
                  </T>
                </View>
              </View>
              <LevelPill level={today.level} />
            </View>

            <View className="mt-5">
              {today.lines.map((l, i) => (
                <View key={i} className="mb-2.5 flex-row items-center">
                  <View className="h-7 w-7 items-center justify-center rounded-full bg-white/80">
                    <Icon as={lineIcon[l.icon] ?? Activity} size={14} className="text-brand-ink" />
                  </View>
                  <T v="body" className="ml-3 text-ink">
                    {l.text}
                  </T>
                </View>
              ))}
            </View>

            <View className="mt-3">
              <T v="small" className="mb-2">
                Her own voice · from the {today.checkin.time} check-in
              </T>
              <ClipPlayer seconds={today.clip.seconds} seed={11} />
              <T v="small" className="mt-2 italic text-ink-2">
                {today.clip.quote}
              </T>
            </View>

            <View className="mt-5 flex-row">
              <Btn label="Call Maa" icon={Phone} className="mr-2 flex-1" onPress={demoCall} />
              <Btn
                label="Send voice"
                icon={Mic}
                kind="dark"
                className="flex-1"
                onPress={() => router.push('/voice')}
              />
            </View>
            <T v="small" className="mt-3 text-center">
              Next check-in · {today.nextCheckin}
            </T>
          </Hero>
        </View>
      </Pop>

      {/* Needs your yes */}
      <Section
        title="Needs your yes"
        action="Permissions"
        onAction={() => router.push('/permissions')}>
        {approvals.map((a) => (
          <Card key={a.id}>
            <View className="flex-row items-start">
              <IconTile icon={HomeIcon} tone="watch" />
              <View className="ml-3.5 flex-1">
                <View className="flex-row items-center justify-between">
                  <T v="h3">{a.title}</T>
                  <T v="h3">{a.amount}</T>
                </View>
                <T v="small" className="mt-0.5">
                  {a.detail}
                </T>
                <T v="small" className="mt-2 text-ink-2">
                  {a.why}
                </T>
              </View>
            </View>
            {approved ? (
              <View className="mt-4 flex-row items-center rounded-full bg-ok-soft px-4 py-3">
                <Icon as={Check} size={16} className="text-ok-ink" />
                <T v="small" className="ml-2 font-jk-bold text-ok-ink">
                  {approved === 'yes'
                    ? 'You said yes · Sahaj will ask Maa on her next call'
                    : 'Declined · Maa will be told gently'}
                </T>
              </View>
            ) : (
              <View className="mt-4 flex-row">
                <Btn
                  label="Approve"
                  kind="teal"
                  className="mr-2 flex-1"
                  onPress={() => setApproved('yes')}
                />
                <Btn
                  label="Decline"
                  kind="ghost"
                  className="flex-1"
                  onPress={() => setApproved('no')}
                />
              </View>
            )}
          </Card>
        ))}
        {done.map((d) => (
          <View key={d.id} className="mt-3 flex-row items-center rounded-2xl bg-sand px-4 py-3">
            <Icon as={Check} size={16} className="text-ok-ink" />
            <T v="small" className="ml-2 flex-1 text-ink-2">
              <T v="small" className="font-jk-bold text-ink">
                {d.title}
              </T>{' '}
              · {d.detail} · {d.amount}
            </T>
            <Chip label={`allowed by ${d.rule}`} />
          </View>
        ))}
      </Section>

      {/* Quick actions */}
      <Section title="For you">
        <View className="flex-row flex-wrap justify-between">
          <Quick
            icon={HomeIcon}
            tone="teal"
            title="Going home"
            sub="Late-night watch"
            onPress={() => router.push('/watch')}
          />
          <Quick
            icon={Sparkles}
            tone="brand"
            title="I’m safe"
            sub="Maa hears your voice"
            onPress={() => router.push('/safe')}
          />
          <Quick
            icon={BellRing}
            tone="danger"
            title="SOS"
            sub="Hold to alert circle"
            onPress={() => router.push('/sos')}
          />
          <Quick
            icon={ShieldCheck}
            tone="brand"
            title="Shield"
            sub={`${shield.week.stopped} scams stopped`}
            onPress={() => router.push('/shield')}
          />
        </View>
      </Section>

      {/* Shield one-liner */}
      <Tap
        onPress={() => router.push({ pathname: '/alert', params: { id: shield.alerts[0].id } })}
        className="mt-1">
        <Card tone="sand" className="flex-row items-center">
          <IconTile icon={ShieldCheck} tone="brand" size={40} />
          <View className="ml-3 flex-1">
            <T v="h3">{`Shield stopped a ${shield.alerts[0].type}`}</T>
            <T v="small">{shield.alerts[0].time} · on Maa’s phone · she was warned in Hindi</T>
          </View>
          <Icon as={ArrowUpRight} size={18} className="text-ink-muted" />
        </Card>
      </Tap>
    </Screen>
  );
}

function Quick({
  icon,
  tone,
  title,
  sub,
  onPress,
}: {
  icon: LucideIcon;
  tone: 'teal' | 'ok' | 'danger' | 'brand';
  title: string;
  sub: string;
  onPress?: () => void;
}) {
  return (
    <View className="mb-3 w-[48.5%]">
      <Tap onPress={onPress}>
        <Card className="p-4">
          <IconTile icon={icon} tone={tone} size={40} />
          <T v="h3" className="mt-3">
            {title}
          </T>
          <T v="small" className="mt-0.5">
            {sub}
          </T>
        </Card>
      </Tap>
    </View>
  );
}

export default function Home() {
  const {ready,session}=useSession();
  if(!ready) return <LiveLoading/>;
  return session ? <LiveHome/> : <DemoHome/>;
}
