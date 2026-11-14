// After a risky call: "Did you share an OTP or PIN?" [Yes] [No].
// Yes → "Call 1930 now. Riya has been told." with a big [Call 1930] (national cyber-fraud helpline).
import { router } from 'expo-router';
import { Check, House, KeyRound, Phone, ShieldCheck, X } from 'lucide-react-native';
import * as React from 'react';
import { Linking, View } from 'react-native';

import { BigBtn, M, MaaScreen, successHaptic } from '@/components/sahaj/maa';
import { Icon } from '@/components/ui/icon';
import { useT } from '@/lib/prefs';
import { family } from '@/lib/demo';
import { useCall } from '@/lib/call';

export default function AfterCall() {
  const { t } = useT();
  const call = useCall();
  const [answer, setAnswer] = React.useState<'yes' | 'no' | null>(null);
  const home = () => router.dismissTo('/');

  if (answer === 'yes') {
    return (
      <MaaScreen bg="bg-danger-soft">
        <View className="flex-1 justify-center">
          <View className="h-24 w-24 items-center justify-center rounded-full bg-danger">
            <Icon as={Phone} size={48} className="text-white" />
          </View>
          <M v="hero" className="mt-8 text-danger-ink">{t('call_1930_now')}</M>
          <M v="h" className="mt-3 text-ink-2">{t('tell_riya')}</M>
        </View>
        <BigBtn tall kind="danger" icon={Phone} label={t('call_1930')} onPress={() => Linking.openURL('tel:1930').catch(() => {})} />
        <BigBtn className="mt-4" kind="go" icon={Phone} label={t('call_riya')} onPress={() => call(family.riya.phone)} />
        <BigBtn className="mt-4" kind="soft" icon={House} label={t('home')} onPress={home} />
      </MaaScreen>
    );
  }

  if (answer === 'no') {
    return (
      <MaaScreen bg="bg-ok-soft">
        <View className="flex-1 items-center justify-center">
          <View className="h-28 w-28 items-center justify-center rounded-full bg-ok">
            <Icon as={ShieldCheck} size={60} className="text-white" />
          </View>
          <M v="hero" className="mt-8 text-center text-ok-ink">{t('you_are_safe')}</M>
        </View>
        <BigBtn kind="dark" icon={House} label={t('home')} onPress={home} />
      </MaaScreen>
    );
  }

  return (
    <MaaScreen>
      <View className="flex-1 justify-center">
        <View className="h-24 w-24 items-center justify-center rounded-full bg-watch-soft">
          <Icon as={KeyRound} size={48} className="text-watch-ink" />
        </View>
        <M v="hero" className="mt-8">{t('did_you_share_otp')}</M>
      </View>
      <View className="flex-row gap-4">
        <View className="flex-1">
          <BigBtn tall kind="danger" icon={Check} label={t('yes')} onPress={() => setAnswer('yes')} />
        </View>
        <View className="flex-1">
          <BigBtn
            tall
            kind="ok"
            icon={X}
            label={t('no')}
            onPress={() => {
              successHaptic();
              setAnswer('no');
            }}
          />
        </View>
      </View>
    </MaaScreen>
  );
}
