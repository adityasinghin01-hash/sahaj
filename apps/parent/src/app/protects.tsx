// "Sahaj is on ✓" → a simple list of what Shield protects.
import { router, useFocusEffect } from 'expo-router';
import * as React from 'react';
import {
  AppWindow,
  BadgeCheck,
  House,
  Landmark,
  Link2,
  MessageSquareWarning,
  PhoneIncoming,
  PhoneOff,
  Timer,
  Video,
  type LucideIcon,
} from 'lucide-react-native';
import { View } from 'react-native';

import { BackBar, BigBtn, M, MaaScreen, Tick } from '@/components/sahaj/maa';
import { Icon } from '@/components/ui/icon';
import { protections, type ProtectionIcon } from '@/lib/demo';
import { useT } from '@/lib/prefs';
import { shield, shieldAvailable } from '@/lib/shield';

const ICONS: Record<ProtectionIcon, LucideIcon> = {
  sms: MessageSquareWarning,
  call: PhoneIncoming,
  link: Link2,
  app: AppWindow,
  video: Video,
  bank: Landmark,
  long: Timer,
  pause: PhoneOff,
  verified: BadgeCheck,
};

export default function Protects() {
  const { t, pick } = useT();
  const [status, setStatus] = React.useState(() => shield.getStatus());
  const [features, setFeatures] = React.useState(() => shield.getFeatures());
  useFocusEffect(React.useCallback(() => {
    setStatus(shield.getStatus());
    setFeatures(shield.getFeatures());
  }, []));
  const enabled = (id: string) => {
    if (!shieldAvailable) return false;
    if (!status || status.rulesEngine !== 'json') return false;
    switch (id) {
      case 'sms': case 'link': return status.sms;
      case 'call': return status.phoneState && status.contacts && status.callScreeningRole;
      case 'app': return !!features?.installed_apps || (!!features?.p3_apk && status.notificationAccess);
      case 'video': return !!features?.p2_video_call && status.notificationAccess && status.contacts;
      case 'bank_app': return !!features?.p9_bank_app && status.usageAccess && status.phoneState && status.callScreeningRole;
      case 'long_call': return !!features?.p6_long_call && status.phoneState && status.callScreeningRole;
      case 'bank_number': return status.phoneState && status.callScreeningRole && status.notifications;
      case 'pause_call': return !!features?.p8_pause_call && status.callRedirectionRole;
      default: return false;
    }
  };
  return (
    <MaaScreen>
      <BackBar />
      <M v="title">{t('sahaj_protects')}</M>
      <M v="body" className="mt-1">{t(shieldAvailable ? 'protection_status' : 'protection_preview')}</M>
      <View className="mt-5 rounded-3xl border border-sand-line bg-white px-5">
        {protections.map((p, i) => (
          <View key={p.id} className={i < protections.length - 1 ? 'flex-row items-center border-b border-sand-line py-4' : 'flex-row items-center py-4'}>
            <View className="h-14 w-14 items-center justify-center rounded-[18px] bg-teal-soft">
              <Icon as={ICONS[p.icon]} size={28} className="text-teal-ink" />
            </View>
            <View className="ml-4 flex-1">
              <M v="strong">{pick(p.title)}</M>
              <M v="small">{pick(p.sub)}</M>
            </View>
            <View className="ml-2 items-center">
              <Tick on={enabled(p.id)} size={36} />
              <M v="small" className="mt-1">{t(enabled(p.id) ? 'protection_on' : 'protection_off')}</M>
            </View>
          </View>
        ))}
      </View>
      <View className="flex-1" />
      <BigBtn className="mt-6" kind="dark" icon={House} label={t('home')} onPress={() => router.dismissTo('/')} />
    </MaaScreen>
  );
}
