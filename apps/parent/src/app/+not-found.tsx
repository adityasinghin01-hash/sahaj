import { router } from 'expo-router';
import { House } from 'lucide-react-native';
import { View } from 'react-native';

import { BigBtn, M, MaaScreen } from '@/components/sahaj/maa';
import { useT } from '@/lib/prefs';

export default function NotFound() {
  const { t } = useT();
  return (
    <MaaScreen>
      <View className="flex-1 justify-center">
        <M v="title">{t('app_name')}</M>
      </View>
      <BigBtn kind="dark" icon={House} label={t('home')} onPress={() => router.replace('/')} />
    </MaaScreen>
  );
}
