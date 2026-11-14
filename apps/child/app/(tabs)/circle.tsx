import { Core2Gate } from '@/components/core2/common';
import { LiveContacts } from '@/components/core2/contacts';
import { Icon } from '@/components/ui/icon';
import {
  Card,
  Chip,
  Face,
  Notice,
  Pop,
  Row,
  Screen,
  Section,
  T,
  Tap,
  Btn,
} from '@/components/sahaj/ui';
import { circle, circleSettings, updateDemo, useDemo, watch } from '@/lib/demo';
import { router } from 'expo-router';
import { ChevronRight, KeyRound, Plus, Settings2, UsersRound } from 'lucide-react-native';
import { View } from 'react-native';

function DemoCircle() {
  const demo = useDemo();
  const ordered = [...circle].sort(
    (a, b) => Number(b.id === demo.onDuty) - Number(a.id === demo.onDuty)
  );
  return (
    <Screen>
      <T v="title" className="mb-2 mt-2">
        Your circle
      </T>
      <T v="body">Familiar people. The right help, in order.</T>
      <Pop>
        <Card tone="brand" className="mt-5">
          <T v="label" className="text-brand-ink">
            On duty this week
          </T>
          <T v="h2" className="mt-2">
            Who should Sahaj ask first?
          </T>
          <View className="mt-4 flex-row flex-wrap gap-2">
            {circle
              .filter((person) => circleSettings.candidates.includes(person.name))
              .map((person) => (
                <Tap
                  key={person.id}
                  accessibilityLabel={`Put ${person.name} on duty`}
                  accessibilityState={{ selected: person.id === demo.onDuty }}
                  onPress={() => updateDemo({ onDuty: person.id })}
                  className={`min-h-12 justify-center rounded-full px-4 ${person.id === demo.onDuty ? 'bg-brand' : 'bg-white/80'}`}>
                  <T
                    v="small"
                    className={
                      person.id === demo.onDuty ? 'font-jk-bold text-white' : 'text-ink-2'
                    }>
                    {person.name}
                  </T>
                </Tap>
              ))}
          </View>
          <T v="small" className="mt-2">
            Your choice updates the call order below.
          </T>
        </Card>
      </Pop>
      <Section title="The order Sahaj asks">
        <Card>
          {ordered.map((person, i) => (
            <View
              key={person.id}
              className={`${i ? 'mt-5 border-t border-sand-line pt-5' : ''} flex-row items-start`}>
              <Face name={person.name} size={42} tone={circle.indexOf(person) % 2} />
              <View className="ml-3 flex-1">
                <View className="flex-row items-center justify-between">
                  <T v="h3" className="flex-1">
                    {person.name}
                  </T>
                  <T v="small">Ask {i + 1}</T>
                </View>
                <T v="small" className="mt-1">
                  {person.role} · {person.city}
                </T>
                <T v="body" className="mt-2">
                  {person.sees}
                </T>
                {person.id === demo.onDuty ? (
                  <View className="mt-2">
                    <Chip label="On duty · Maa’s urgent calls" tone="brand" />
                  </View>
                ) : null}
              </View>
            </View>
          ))}
        </Card>
      </Section>
      <T v="small" className="mt-3">
        Maa’s urgent calls follow the available family and neighbour. Your safety alerts go to{' '}
        {circle.find((p) => p.id === watch.friendId)?.name}; orders go to the chemist.
      </T>
      <Btn
        label="Add someone"
        icon={Plus}
        kind="ghost"
        className="mt-5"
        onPress={() => router.push('/invite')}
      />
      {demo.pendingInvite ? (
        <Notice tone="brand">{demo.pendingInvite} is waiting for Maa’s voice approval.</Notice>
      ) : (
        <T v="small" className="mt-3 text-center">
          {circleSettings.approval}
        </T>
      )}
      <Section title="Settings">
        <Card className="py-1">
          <Row
            icon={Settings2}
            title="Permissions"
            sub="Limits Maa can change too"
            right={<Icon as={ChevronRight} size={18} className="text-ink-muted" />}
            onPress={() => router.push('/permissions')}
          />
          <Row
            icon={KeyRound}
            title="Family code word"
            sub="A familiar word to check a caller"
            last
            right={<Icon as={ChevronRight} size={18} className="text-ink-muted" />}
            onPress={() => router.push('/code-word')}
          />
        </Card>
      </Section>
      <View className="mt-5 flex-row items-center">
        <Icon as={UsersRound} size={16} className="text-ink-muted" />
        <T v="small" className="ml-2 flex-1">
          Everyone sees only what they need to help.
        </T>
      </View>
    </Screen>
  );
}

export default function Circle() {
  return <Core2Gate title="contacts" demo={<DemoCircle />}><LiveContacts /></Core2Gate>;
}
