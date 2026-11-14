import { router } from 'expo-router';
import { Btn, Card } from '../sahaj/ui';
import { useCore2Text } from './common';
export function Core2Links() {
  const t = useCore2Text();
  return (
    <Card className="mt-4">
      <Btn label={t('sos')} kind="danger" size="lg" onPress={() => router.push('/sos')} />
      <Btn label={t('watch')} kind="teal" onPress={() => router.push('/watch')} />
      <Btn label={t('safeTitle')} kind="ghost" onPress={() => router.push('/safe')} />
      <Btn label={t('contacts')} kind="ghost" onPress={() => router.push('/circle')} />
      <Btn label={t('preferences')} kind="ghost" onPress={() => router.push('/permissions')} />
      <Btn label={t('proofLink')} kind="ghost" onPress={() => router.push('/proof')} />
    </Card>
  );
}
