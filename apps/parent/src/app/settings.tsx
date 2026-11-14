// Settings: language, text size, Shield switches (module setFeature list), setup, About.
import { router, useFocusEffect } from 'expo-router';
import { BellRing, ChevronRight, Info, KeyRound, Smartphone, type LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

import { BackBar, BigSwitch, Choice, M, MaaScreen } from '@/components/sahaj/maa';
import { Tap } from '@/components/sahaj/ui';
import { Icon } from '@/components/ui/icon';
import type { Bi } from '@/lib/demo';
import { usePrefs, useT } from '@/lib/prefs';
import { SHIELD_FEATURES, shield, shieldAvailable, type ShieldFeature, type ShieldFeatures } from '@/lib/shield';

const FEATURE_NAMES: Record<ShieldFeature, { title: Bi; sub: Bi }> = {
  p8_pause_call: { title: { en: 'Pause risky calls', hi: 'ख़तरनाक कॉल रोकें' }, sub: { en: 'Numbers from fraud SMS', hi: 'फ्रॉड SMS वाले नंबर' } },
  p9_bank_app: { title: { en: 'Bank app on calls', hi: 'कॉल पर बैंक ऐप' }, sub: { en: 'Unknown caller + UPI app', hi: 'अनजान कॉल + UPI ऐप' } },
  p2_video_call: { title: { en: 'Long video calls', hi: 'लंबी वीडियो कॉल' }, sub: { en: 'Strangers on WhatsApp', hi: 'WhatsApp पर अनजान' } },
  p3_apk: { title: { en: '.apk files', hi: '.apk फ़ाइलें' }, sub: { en: 'Fake wedding cards', hi: 'नकली शादी कार्ड' } },
  installed_apps: { title: { en: 'Risky apps check', hi: 'ख़तरनाक ऐप जाँच' }, sub: { en: 'Screen-sharing apps', hi: 'स्क्रीन-शेयर ऐप' } },
};

export default function SettingsScreen() {
  const { t, pick } = useT();
  const { lang, setLang, size, setSize } = usePrefs();
  const [features, setFeatures] = React.useState<ShieldFeatures | null>(null);
  useFocusEffect(React.useCallback(() => setFeatures(shield.getFeatures()), []));

  return (
    <MaaScreen>
      <BackBar title={t('settings')} />

      <Section title={t('language')}>
        <Choice value={lang} onChange={setLang} options={[{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिंदी' }]} />
      </Section>

      <Section title={t('text_size')}>
        <Choice value={size} onChange={setSize} options={[{ value: 'large', label: t('large') }, { value: 'xlarge', label: t('extra_large') }]} />
      </Section>

      <Section title={t('shield_switches')}>
        <View className="rounded-3xl border border-sand-line bg-white px-5">
          {shieldAvailable && features ? (
            SHIELD_FEATURES.map((f, i) => (
              <View key={f} className={i < SHIELD_FEATURES.length - 1 ? 'flex-row items-center border-b border-sand-line py-4' : 'flex-row items-center py-4'}>
                <View className="mr-3 flex-1">
                  <M v="strong">{pick(FEATURE_NAMES[f].title)}</M>
                  <M v="small">{pick(FEATURE_NAMES[f].sub)}</M>
                </View>
                <BigSwitch
                  on={features[f]}
                  label={pick(FEATURE_NAMES[f].title)}
                  onChange={(on) => setFeatures(shield.setFeature(f, on) ?? features)}
                />
              </View>
            ))
          ) : (
            <M v="small" className="py-5">{t('shield_android_only')}</M>
          )}
        </View>
      </Section>

      <Section title={t('setup')}>
        <LinkRow icon={Smartphone} title={t('setup_phone')} sub={t('setup_phone_sub')} onPress={() => router.push('/setup')} />
        <LinkRow icon={BellRing} title={t('try_red')} sub={t('try_screens')} onPress={() => router.push({ pathname: '/warning', params: { test: '1' } })} />
        <LinkRow icon={KeyRound} title={t('try_after_call')} sub={t('try_screens')} onPress={() => router.push('/after-call')} />
        <LinkRow icon={Info} title={t('about_sahaj')} onPress={() => router.push('/about')} />
      </Section>
    </MaaScreen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mb-7">
      <M v="label" className="mb-3">{title}</M>
      {children}
    </View>
  );
}

function LinkRow({ icon, title, sub, onPress }: { icon: LucideIcon; title: string; sub?: string; onPress: () => void }) {
  return (
    <Tap onPress={onPress} accessibilityRole="button" accessibilityLabel={title} className="mb-3 min-h-[80px] flex-row items-center rounded-3xl border border-sand-line bg-white px-4 py-3">
      <View className="h-14 w-14 items-center justify-center rounded-[18px] bg-sand">
        <Icon as={icon} size={28} className="text-ink-2" />
      </View>
      <View className="ml-4 flex-1">
        <M v="strong">{title}</M>
        {sub ? <M v="small">{sub}</M> : null}
      </View>
      <Icon as={ChevronRight} size={28} className="text-ink-faint" />
    </Tap>
  );
}
