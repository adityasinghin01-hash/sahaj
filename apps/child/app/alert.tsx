import { useSession } from '@/lib/session';
import { LiveAlert, LiveLoading } from '@/components/sahaj/live';
import { Icon } from '@/components/ui/icon';
import {
  Btn,
  Card,
  LevelPill,
  Notice,
  Pop,
  Screen,
  Section,
  T,
  TopBar,
} from '@/components/sahaj/ui';
import { demoCall, shield, updateDemo, useDemo } from '@/lib/demo';
import { router, useLocalSearchParams } from 'expo-router';
import { Check, FileText, Phone, ShieldCheck } from 'lucide-react-native';
import { View } from 'react-native';

function DemoAlertDetail() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const demo = useDemo();
  const alert = id ? shield.alerts.find((row) => row.id === id) : shield.alerts[0];
  if (!alert)
    return (
      <Screen>
        <TopBar title="Alert" />
        <T v="title">Alert not found</T>
        <T v="body" className="mt-2">
          This alert isn’t in the demo record.
        </T>
        <Btn label="Open Shield" className="mt-6" onPress={() => router.replace('/shield')} />
      </Screen>
    );
  return (
    <Screen>
      <TopBar title="Alert detail" />
      <Pop>
        <LevelPill level={alert.level} />
        <T v="title" className="mt-4">
          {alert.type}
        </T>
        <T v="small" className="mt-2">
          {alert.time} · {alert.channel}
        </T>
        <Card tone="sand" className="mt-5">
          <T v="label">Masked message</T>
          <T v="bodyStrong" className="mt-3">
            {alert.snippet}
          </T>
          <T v="small" className="mt-3">
            Links and personal details are hidden.
          </T>
        </Card>
      </Pop>
      <Section title="Why Shield flagged it">
        <Card>
          {alert.reasons.map((reason, i) => (
            <View key={reason} className={`${i ? 'mt-4' : ''} flex-row items-start`}>
              <Icon as={ShieldCheck} size={18} className="mt-0.5 text-brand-ink" />
              <T v="body" className="ml-3 flex-1 text-ink">
                {reason}
              </T>
            </View>
          ))}
        </Card>
      </Section>
      <Section title="What Maa heard">
        <Card tone="brand">
          <T v="h2" className="text-brand-deep">
            {alert.told}
          </T>
          <T v="small" className="mt-3">
            Spoken to her in Hindi
          </T>
        </Card>
      </Section>
      <Section title="What happened, in order">
        <Card>
          {alert.actions.map((action, i) => (
            <View key={action.t} className="flex-row">
              <View className="mr-3 items-center">
                <View className="h-7 w-7 items-center justify-center rounded-full bg-teal-soft">
                  <Icon as={Check} size={14} className="text-teal-ink" />
                </View>
                {i < alert.actions.length - 1 ? (
                  <View className="min-h-9 w-px flex-1 bg-sand-line" />
                ) : null}
              </View>
              <View className="flex-1 pb-5">
                <T v="small">{action.t}</T>
                <T v="bodyStrong" className="mt-1">
                  {action.a}
                </T>
              </View>
            </View>
          ))}
        </Card>
      </Section>
      {demo.feedback[alert.id] ? (
        <Notice>
          Thank you · you marked this as {demo.feedback[alert.id] === 'fraud' ? 'fraud' : 'safe'}.
          Your feedback is saved in this demo.
        </Notice>
      ) : (
        <View className="mt-5 flex-row gap-2">
          <Btn
            label="It was fraud"
            className="flex-1"
            onPress={() => updateDemo({ feedback: { ...demo.feedback, [alert.id]: 'fraud' } })}
          />
          <Btn
            label="It was safe"
            kind="ghost"
            className="flex-1"
            onPress={() => updateDemo({ feedback: { ...demo.feedback, [alert.id]: 'safe' } })}
          />
        </View>
      )}
      <View className="mt-5 gap-2">
        <Btn label="Call Maa now" icon={Phone} kind="dark" onPress={demoCall} />
        <Btn
          label="Report pack"
          icon={FileText}
          kind="ghost"
          onPress={() => router.push({ pathname: '/report-pack', params: { id: alert.id } })}
        />
      </View>
    </Screen>
  );
}

export default function AlertDetail() {
  const {ready,session}=useSession();
  const {id} = useLocalSearchParams<{id?:string}>();
  if(!ready) return <LiveLoading/>;
  return session ? <LiveAlert id={id ?? ""}/> : <DemoAlertDetail/>;
}
