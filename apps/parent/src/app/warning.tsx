// In-app red warning. Same look as the native overlay (AlertController.kt): danger red #C62828,
// one big line, the reason in one line, [OK] (white, red text) and [Call Riya] (green).
// Plays the bundled warning clip and vibrates. Opened by a RED onVerdict while the app is open.
import { useAudioPlayer } from 'expo-audio';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Check, OctagonAlert, Phone } from 'lucide-react-native';
import * as React from 'react';
import { Platform, Vibration, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { BigBtn, M, MaaScreen } from '@/components/sahaj/maa';
import { Icon } from '@/components/ui/icon';
import { family, type Bi } from '@/lib/demo';
import { useT } from '@/lib/prefs';
import { useCall } from '@/lib/call';

// Placeholder clip: the same Hindi line the native overlay plays (res/raw/shield_warning_hi.wav).
const CLIP = require('../../assets/audio/shield_warning_hi.wav');

/** One plain reason per scam type, so English mode never shows a Hindi rule reason. */
const REASONS: Partial<Record<string, Bi>> = {
  otp_theft: { en: 'Someone is asking for your OTP.', hi: 'कोई आपका OTP माँग रहा है।' },
  kyc_block: { en: 'Banks never block accounts by SMS.', hi: 'बैंक SMS से खाता बंद नहीं करते।' },
  digital_arrest: { en: 'Police never arrest on a video call.', hi: 'पुलिस वीडियो कॉल पर गिरफ़्तार नहीं करती।' },
  electricity_cut: { en: 'The electricity office never sends such SMS.', hi: 'बिजली दफ़्तर ऐसे SMS नहीं भेजता।' },
  parcel_customs: { en: 'No parcel is stuck. Do not pay.', hi: 'कोई पार्सल नहीं अटका। पैसे न दें।' },
  lottery_prize: { en: 'There is no prize. Do not pay.', hi: 'कोई इनाम नहीं है। पैसे न दें।' },
  job_task: { en: 'Easy-money jobs are a trick.', hi: 'आसान कमाई वाला काम धोखा है।' },
  family_in_trouble: { en: 'Call Riya first. Do not send money.', hi: 'पहले रिया को कॉल करें। पैसे न भेजें।' },
  wedding_invite_apk: { en: 'Do not open this file.', hi: 'यह फ़ाइल मत खोलिए।' },
  refund_cashback: { en: 'Refunds never need your PIN.', hi: 'रिफ़ंड के लिए PIN नहीं लगता।' },
  sextortion_threat: { en: 'Do not pay. Call Riya.', hi: 'पैसे न दें। रिया को कॉल करें।' },
  remote_access: { en: 'Do not install screen-sharing apps.', hi: 'स्क्रीन-शेयर ऐप मत डालिए।' },
};
const DEVANAGARI = /[\u0900-\u097F]/;

export default function Warning() {
  const { t, pick, lang } = useT();
  const call = useCall();
  const params = useLocalSearchParams<{ scamType?: string; reason?: string; test?: string }>();
  const player = useAudioPlayer(CLIP);
  const pulse = useSharedValue(0);

  React.useEffect(() => {
    // Real alerts already use the native controller, which waits for a call to end.
    // React owns audio only for the explicit Settings/setup preview.
    if (params.test !== '1') return;
    try {
      player.play();
    } catch {
      // audio unavailable: the screen and vibration still work
    }
    if (Platform.OS !== 'web') Vibration.vibrate([0, 700, 300, 700, 300, 700]);
    pulse.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.sin) }), -1, true);
    return () => {
      if (Platform.OS !== 'web') Vibration.cancel();
    };
  }, [player, pulse, params.test]);

  const icon = useAnimatedStyle(() => ({ transform: [{ scale: 1 + pulse.value * 0.08 }] }));

  const fromType = params.scamType ? REASONS[params.scamType] : undefined;
  const raw = params.reason?.trim();
  const reason = params.test
    ? t('this_is_a_test')
    : fromType
      ? pick(fromType)
      : raw && (lang === 'hi' || !DEVANAGARI.test(raw))
        ? raw
        : t('warning_reason_default');

  const close = () => {
    try {
      player.pause();
    } catch {
      // already released
    }
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  return (
    <MaaScreen bg="bg-[#C62828]">
      <StatusBar style="light" />
      <View className="flex-1 justify-center">
        <Animated.View style={icon} className="h-28 w-28 items-center justify-center rounded-full bg-white/15">
          <Icon as={OctagonAlert} size={72} className="text-white" strokeWidth={2.2} />
        </Animated.View>
        <M v="hero" className="mt-8 text-white">
          {t('stop_fraud')}
        </M>
        <M v="h" weight="semibold" className="mt-5 text-white/95" numberOfLines={2}>
          {reason}
        </M>
      </View>
      <BigBtn tall kind="white" icon={Check} label={t('ok')} onPress={close} />
      <BigBtn
        tall
        className="mt-4"
        kind="go"
        icon={Phone}
        label={t('call_riya')}
        onPress={() => call(family.riya.phone)}
      />
    </MaaScreen>
  );
}
