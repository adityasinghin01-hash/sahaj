// After a risky call: "Did you share an OTP or PIN?" [Haan, OTP bataya] [Nahi] + [Bank se bola tha].
// "Haan, OTP bataya" → voice_report (context.otp_shared) and "Call 1930 now" with a big [Call 1930].
// "Bank se bola tha" → voice_report (context.claimed_bank + the caller type; server rule P7).
// After an incoming 1600-series call the screen also shows "Ye registered bank number tha" (no alarm).
// Nothing is claimed about Riya: the screen only says Sahaj noted it when the event was really queued.
import { router } from 'expo-router';
import { BadgeCheck, Check, House, KeyRound, Landmark, Phone, ShieldCheck, X } from 'lucide-react-native';
import * as React from 'react';
import { Linking, View } from 'react-native';

import { BigBtn, M, MaaScreen, successHaptic } from '@/components/sahaj/maa';
import { Icon } from '@/components/ui/icon';
import { useT } from '@/lib/prefs';
import { family } from '@/lib/demo';
import { useCall } from '@/lib/call';
import { shield, type AfterCallAnswer, type LastCall } from '@/lib/shield';

type Answer = 'yes' | 'no' | 'bank';

export default function AfterCall() {
  const { t } = useT();
  const call = useCall();
  const [answer, setAnswer] = React.useState<Answer | null>(null);
  const [noted, setNoted] = React.useState(false);
  const [lastCall] = React.useState<LastCall>(() => shield.getLastCall());
  const registeredBank = lastCall.ended && lastCall.registeredBank;
  const home = () => router.dismissTo('/');

  const choose = (a: Answer) => {
    const wire: AfterCallAnswer = a === 'yes' ? 'otp_shared' : a === 'bank' ? 'claimed_bank' : 'no';
    setNoted(shield.reportAfterCall(wire) === 'sent');
    if (a === 'no') successHaptic();
    setAnswer(a);
  };

  if (answer === 'yes') {
    return (
      <MaaScreen bg="bg-danger-soft">
        <View className="flex-1 justify-center">
          <View className="h-24 w-24 items-center justify-center rounded-full bg-danger">
            <Icon as={Phone} size={48} className="text-white" />
          </View>
          <M v="hero" className="mt-8 text-danger-ink">{t('call_1930_now')}</M>
          <M v="h" className="mt-3 text-ink-2">{t('tell_riya')}</M>
          {noted ? <M v="body" className="mt-3">{t('noted')}</M> : null}
        </View>
        <BigBtn tall kind="danger" icon={Phone} label={t('call_1930')} onPress={() => Linking.openURL('tel:1930').catch(() => {})} />
        <BigBtn className="mt-4" kind="go" icon={Phone} label={t('call_riya')} onPress={() => call(family.riya.phone)} />
        <BigBtn className="mt-4" kind="soft" icon={House} label={t('home')} onPress={home} />
      </MaaScreen>
    );
  }

  if (answer === 'bank') {
    const line = registeredBank
      ? t('registered_bank_note')
      : lastCall.ended && lastCall.callerType !== 'unknown'
        ? t('bank_not_registered')
        : t('bank_unknown');
    return (
      <MaaScreen bg={registeredBank ? 'bg-ok-soft' : 'bg-watch-soft'}>
        <View className="flex-1 justify-center">
          <View className={registeredBank ? 'h-24 w-24 items-center justify-center rounded-full bg-ok' : 'h-24 w-24 items-center justify-center rounded-full bg-watch'}>
            <Icon as={registeredBank ? BadgeCheck : Landmark} size={48} className="text-white" />
          </View>
          <M v="hero" className="mt-8">{line}</M>
          {!registeredBank ? <M v="h" className="mt-3 text-ink-2">{t('tell_riya')}</M> : null}
          {noted ? <M v="body" className="mt-3">{t('noted')}</M> : null}
        </View>
        {!registeredBank ? (
          <BigBtn tall kind="go" icon={Phone} label={t('call_riya')} onPress={() => call(family.riya.phone)} />
        ) : null}
        <BigBtn className="mt-4" kind={registeredBank ? 'dark' : 'soft'} icon={House} label={t('home')} onPress={home} />
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
        {registeredBank ? (
          <View className="mb-6 flex-row items-center rounded-3xl bg-ok-soft px-4 py-3">
            <Icon as={BadgeCheck} size={28} className="text-ok-ink" />
            <M v="strong" className="ml-3 flex-1 text-ok-ink">{t('registered_bank_note')}</M>
          </View>
        ) : null}
        <View className="h-24 w-24 items-center justify-center rounded-full bg-watch-soft">
          <Icon as={KeyRound} size={48} className="text-watch-ink" />
        </View>
        <M v="hero" className="mt-8">{t('did_you_share_otp')}</M>
      </View>
      <View className="flex-row gap-4">
        <View className="flex-1">
          <BigBtn tall kind="danger" icon={Check} label={t('otp_told')} onPress={() => choose('yes')} />
        </View>
        <View className="flex-1">
          <BigBtn tall kind="ok" icon={X} label={t('no')} onPress={() => choose('no')} />
        </View>
      </View>
      <BigBtn className="mt-4" tall kind="soft" icon={Landmark} label={t('bank_said')} onPress={() => choose('bank')} />
    </MaaScreen>
  );
}
