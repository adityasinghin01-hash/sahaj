import { AlarmSettings } from '@/components/sahaj/alarm-settings';
import { useSession } from '@/lib/session';
import { LiveShield, LiveLoading } from '@/components/sahaj/live';
import { Icon } from '@/components/ui/icon';
import {
  Card,
  Hero,
  IconTile,
  LevelPill,
  LiveDot,
  Pop,
  Row,
  Screen,
  Section,
  Stat,
  T,
  Tap,
} from '@/components/sahaj/ui';
import { shield, updateDemo, useDemo, showToast } from '@/lib/demo';
import { router } from 'expo-router';
import { Check, ChevronRight, ShieldCheck, X } from 'lucide-react-native';
import { View } from 'react-native';

function DemoShield() {
  const demo = useDemo();
  return (
    <Screen>
      <View className="mb-5 mt-2 flex-row items-center justify-between">
        <T v="title">Shield</T>
        <IconTile icon={ShieldCheck} tone="teal" />
      </View>
      <Pop>
        <Hero>
          <View className="flex-row items-center">
            <LiveDot />
            <T v="small" className="ml-2 font-jk-semibold text-teal-ink">
              Demo alerts · ready to connect
            </T>
          </View>
          <T v="title" className="mt-3 text-teal-deep">
            Shield is watching
          </T>
          <View className="mt-6 flex-row">
            <Stat value={String(shield.week.checks)} label="Checks this week" />
            <View className="mr-5 w-px bg-teal/15" />
            <Stat value={String(shield.week.stopped)} label="Scams stopped" />
          </View>
          <View className="mt-6 flex-row items-center justify-between">
            <T v="small" className="text-teal-deep">
              Maa’s scam-sense
            </T>
            <T v="h3" className="text-teal-deep">
              {shield.scamSense.score}/{shield.scamSense.of}
            </T>
          </View>
          <View
            className="mt-2 flex-row"
            accessibilityLabel={`Scam-sense ${shield.scamSense.score} out of ${shield.scamSense.of}`}>
            {Array.from({ length: shield.scamSense.of }, (_, i) => (
              <View
                key={i}
                className={`mr-1.5 h-2 flex-1 rounded-full ${i < shield.scamSense.score ? 'bg-teal' : 'bg-teal/15'}`}
              />
            ))}
          </View>
          <T v="small" className="mt-2">
            Practising how to spot a suspicious request
          </T>
        </Hero>
      </Pop>
      <AlarmSettings />
      <Section title="Recent alerts">
        <View className="gap-3">
          {shield.alerts.map((alert, i) => (
            <Pop key={alert.id} delay={i * 70}>
              <Tap
                accessibilityLabel={`Open ${alert.type}`}
                onPress={() => router.push({ pathname: '/alert', params: { id: alert.id } })}>
                <Card>
                  <View className="flex-row items-center justify-between">
                    <LevelPill level={alert.level} />
                    <Icon as={ChevronRight} size={18} className="text-ink-muted" />
                  </View>
                  <T v="h3" className="mt-3">
                    {alert.type}
                  </T>
                  <T v="small" className="mt-1">
                    {alert.time} · {alert.channel}
                  </T>
                  {demo.feedback[alert.id] ? (
                    <T v="small" className="mt-2 text-teal-ink">
                      You marked it {demo.feedback[alert.id]}
                    </T>
                  ) : null}
                </Card>
              </Tap>
            </Pop>
          ))}
        </View>
      </Section>
      <Section title="What is protected">
        <Card className="py-1">
          {shield.protections.map((protection, i) => {
            const on = demo.protections[protection.name] ?? protection.on;
            return (
              <Row
                key={protection.name}
                icon={on ? Check : X}
                tone={on ? 'teal' : 'sand'}
                title={protection.name}
                last={i === shield.protections.length - 1}
                right={
                  on ? (
                    <T v="small" className="ml-2 text-teal-ink">
                      On
                    </T>
                  ) : (
                    <Tap
                      className="ml-2 min-h-12 justify-center"
                      onPress={() => {
                        updateDemo({
                          protections: { ...demo.protections, [protection.name]: true },
                        });
                        showToast('Demo protection enabled on Maa’s phone.');
                      }}>
                      <T v="small" className="font-jk-bold text-brand-ink">
                        Turn on
                      </T>
                    </Tap>
                  )
                }
              />
            );
          })}
        </Card>
      </Section>
    </Screen>
  );
}

export default function Shield() {
  const {ready,session}=useSession();
  if(!ready) return <LiveLoading/>;
  return session ? <LiveShield/> : <DemoShield/>;
}
