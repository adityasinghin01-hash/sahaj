import { Icon } from '@/components/ui/icon';
import { Switch } from '@/components/ui/switch';
import { Card, Chip, Section, Screen, T, TopBar } from '@/components/sahaj/ui';
import { askEveryTime, permissions } from '@/lib/demo';
import { Hand, ShieldCheck } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

export default function Permissions() {
  const [on, setOn] = React.useState<Record<string, boolean>>(() => Object.fromEntries(permissions.map((p) => [p.id, p.on])));
  return (
    <Screen>
      <TopBar title="Permissions" />
      <T v="title">What Sahaj may do on its own</T>
      <T v="body" className="mt-2">Each one has a limit. Anything outside it asks you first. Turn one off any time — Maa can too, by voice.</T>

      <Section title="Standing permissions">
        {permissions.map((p) => (
          <Card key={p.id} className="mb-3">
            <View className="flex-row items-start">
              <View className="flex-1">
                <View className="flex-row items-center">
                  <Chip label={p.id} />
                  <T v="h3" className="ml-2">{p.title}</T>
                </View>
                <T v="small" className="mt-2">{p.who} · {p.limit}</T>
                <T v="small">Ends {p.expires} · {p.used}</T>
              </View>
              <Switch checked={!!on[p.id]} onCheckedChange={(v) => setOn((s) => ({ ...s, [p.id]: v }))} />
            </View>
          </Card>
        ))}
      </Section>

      <Section title="Always asks you first">
        <Card tone="sand">
          {askEveryTime.map((a, i) => (
            <View key={a} className={i ? 'mt-3 flex-row items-center' : 'flex-row items-center'}>
              <Icon as={Hand} size={16} className="text-watch-ink" />
              <T v="body" className="ml-3 text-ink">{a}</T>
            </View>
          ))}
        </Card>
      </Section>

      <Card tone="teal" className="mt-6 flex-row items-center">
        <Icon as={ShieldCheck} size={18} className="text-teal-ink" />
        <T v="small" className="ml-3 flex-1 text-teal-deep">Every action is written to a signed record, with the permission that allowed it (for example, “allowed by #12”).</T>
      </Card>
    </Screen>
  );
}
