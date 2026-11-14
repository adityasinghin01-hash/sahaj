import { useSession } from '@/lib/session';
import { LiveTimeline, LiveLoading } from '@/components/sahaj/live';
import { Icon } from '@/components/ui/icon';
import { Card, IconTile, Pop, Screen, Section, T, Tap } from '@/components/sahaj/ui';
import { timeline, useDemo, type TimelineKind } from '@/lib/demo';
import { router } from 'expo-router';
import {
  Check,
  ChevronRight,
  Heart,
  LockKeyhole,
  Mic,
  Phone,
  Pill,
  ShieldCheck,
  Siren,
  type LucideIcon,
} from 'lucide-react-native';
import { View } from 'react-native';
const icons: Record<TimelineKind, LucideIcon> = {
  checkin: Phone,
  shield: ShieldCheck,
  voice: Mic,
  order: Pill,
  urgent: Siren,
  safe: Heart,
};
function DemoTimeline() {
  const demo = useDemo();
  return (
    <Screen>
      <T v="title" className="mb-2 mt-2">
        Timeline
      </T>
      <T v="body">The little things, kept together.</T>
      <Pop>
        <Tap className="mt-5" onPress={() => router.push('/verify')}>
          <Card tone="teal" className="flex-row items-center">
            <IconTile icon={LockKeyhole} tone="teal" />
            <View className="ml-3 flex-1">
              <T v="h2" className="text-teal-deep">
                Verified record
              </T>
              <T v="small" className="mt-1">
                {timeline.length} signed steps · check the chain
              </T>
            </View>
            <Icon as={ChevronRight} size={20} className="text-teal-ink" />
          </Card>
        </Tap>
      </Pop>
      {demo.safeSent ? (
        <Card tone="brand" className="mt-4">
          <T v="bodyStrong">Maa heard your safety message ✓✓</T>
          <T v="small" className="mt-1">
            Just now · demo delivery
          </T>
        </Card>
      ) : null}
      {[...new Set(timeline.map((row) => row.day))].map((day) => (
        <Section key={day} title={day}>
          <Card>
            {timeline
              .filter((row) => row.day === day)
              .map((row, i, entries) => (
                <Pop key={row.id} delay={i * 45}>
                  <View className="flex-row">
                    <View className="mr-4 items-center">
                      <View className="h-8 w-8 items-center justify-center rounded-full bg-sand">
                        <Icon as={icons[row.kind]} size={16} className="text-ink-2" />
                      </View>
                      {i !== entries.length - 1 ? (
                        <View className="my-1 w-px flex-1 bg-sand-line" />
                      ) : null}
                    </View>
                    <View className="flex-1 pb-6">
                      <View className="flex-row items-center justify-between">
                        <T v="small">{row.time}</T>
                        <View className="flex-row items-center">
                          <T v="small" className="text-teal-ink">
                            signed
                          </T>
                          <Icon as={Check} size={12} className="ml-1 text-teal-ink" />
                        </View>
                      </View>
                      <T v="bodyStrong" className="mt-1.5">
                        {row.text}
                      </T>
                    </View>
                  </View>
                </Pop>
              ))}
          </Card>
        </Section>
      ))}
      <T v="small" className="mt-4 text-center">
        Synthetic demo record · not a live audit
      </T>
    </Screen>
  );
}

export default function Timeline() {
  const {ready,session}=useSession();
  if(!ready) return <LiveLoading/>;
  return session ? <LiveTimeline/> : <DemoTimeline/>;
}
