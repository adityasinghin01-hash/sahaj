import { Alert, Linking } from 'react-native';
import { useT } from '@/lib/prefs';

export function useCall() {
  const { t } = useT();
  return (number: string) => {
    if (!/^\+?[\d\s-]{3,20}$/.test(number)) {
      Alert.alert(t('call_not_ready'), t('call_setup_needed'));
      return;
    }
    Linking.openURL(`tel:${number.replace(/[\s-]/g, '')}`).catch(() => {
      Alert.alert(t('call_not_ready'), t('call_setup_needed'));
    });
  };
}
