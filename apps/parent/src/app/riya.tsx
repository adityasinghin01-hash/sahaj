// "Riya kaisi hai?" → one calm status line from demo data. Never a map or a location.
import { router } from 'expo-router';
import { House, Phone } from 'lucide-react-native';
import { View } from 'react-native';

import { BackBar, BigBtn, M, MaaScreen } from '@/components/sahaj/maa';
import { Face, LiveDot } from '@/components/sahaj/ui';
import { family, riyaStatus } from '@/lib/demo';
import { useT } from '@/lib/prefs';
import { useCall } from '@/lib/call';

export default function Riya() {
  const { t, pick } = useT();
  const call = useCall();
  return (
    <MaaScreen>
      <BackBar />
      <View className="flex-1 items-center justify-center">
        <Face name="Riya" size={132} tone={0} />
        <View className="mt-8 w-full rounded-[32px] bg-ok-soft px-6 py-7">
          <View className="flex-row items-center">
            <LiveDot color="bg-ok" size={14} />
            <M v="small" weight="bold" className="ml-3 text-ok-ink">{pick(riyaStatus.updated)}</M>
          </View>
          <M v="title" className="mt-3 text-ink">{pick(riyaStatus.line)}</M>
          <M v="small" className="mt-4">{t('demo_status')}</M>
        </View>
      </View>
      <BigBtn kind="go" icon={Phone} label={t('call_riya')} onPress={() => call(family.riya.phone)} />
      <BigBtn className="mt-4" kind="soft" icon={House} label={t('home')} onPress={() => router.dismissTo('/')} />
    </MaaScreen>
  );
}
