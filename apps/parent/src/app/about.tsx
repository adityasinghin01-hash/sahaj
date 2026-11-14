import Constants from 'expo-constants';
import { router } from 'expo-router';
import { House, ShieldCheck } from 'lucide-react-native';
import { View } from 'react-native';

import { BackBar, BigBtn, M, MaaScreen } from '@/components/sahaj/maa';
import { Icon } from '@/components/ui/icon';
import { useT } from '@/lib/prefs';
import { shield } from '@/lib/shield';

export default function About() {
  const { t } = useT();
  const rules = shield.getStatus()?.rulesVersion;
  return (
    <MaaScreen>
      <BackBar title={t('about_sahaj')} />
      <View className="h-24 w-24 items-center justify-center rounded-[28px] bg-teal-soft">
        <Icon as={ShieldCheck} size={52} className="text-teal-ink" />
      </View>
      <M v="title" className="mt-6">{t('about_line_1')}</M>
      <M v="body" className="mt-4">{t('about_line_2')}</M>
      <M v="body" className="mt-3">{t('about_line_3')}</M>
      <View className="flex-1" />
      <M v="small" className="mb-4 mt-8">
        {t('version')} {Constants.expoConfig?.version ?? '1.0.0'}
        {rules ? ` · rules ${rules}` : ''}
      </M>
      <BigBtn kind="dark" icon={House} label={t('home')} onPress={() => router.dismissTo('/')} />
    </MaaScreen>
  );
}
