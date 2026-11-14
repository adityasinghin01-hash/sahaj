// Home: greeting + Shield chip, the voice orb ("Talk to Aasha"), and three big tiles.
import { router, useFocusEffect } from 'expo-router';
import { Check, ChevronRight, HeartHandshake, Play, Settings, Siren, TriangleAlert } from 'lucide-react-native';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { BigTile, HoldTile, M, MaaScreen, TILE_SHADOW } from '@/components/sahaj/maa';
import { Tap } from '@/components/sahaj/ui';
import { VoiceOrb } from '@/components/sahaj/VoiceOrb';
import { Icon } from '@/components/ui/icon';
import { aashaReply, family } from '@/lib/demo';
import { useT } from '@/lib/prefs';
import { shield, shieldAvailable } from '@/lib/shield';
import { cn } from '@/lib/utils';

const LISTEN_MS = 3200;

function greetingKey() {
  const h = new Date().getHours();
  return h < 12 ? 'good_morning' : h < 17 ? 'good_afternoon' : 'good_evening';
}

export default function Home() {
  const { t, pick } = useT();
  const [listening, setListening] = React.useState(false);
  const [reply, setReply] = React.useState<string | null>(null);
  const [shieldOn, setShieldOn] = React.useState(true);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  useFocusEffect(
    React.useCallback(() => {
      // Demo (web): always on. Phone: on once SMS checking is allowed.
      if (shieldAvailable) {
        const s = shield.getStatus();
        setShieldOn(!!s && s.sms && s.phoneState && s.contacts && s.overlay &&
          s.callScreeningRole && s.paired && s.rulesEngine === 'json');
      }
    }, [])
  );
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const talk = () => {
    if (timer.current) clearTimeout(timer.current);
    if (listening) {
      setListening(false);
      return;
    }
    setReply(null);
    setListening(true);
    timer.current = setTimeout(() => {
      setListening(false);
      setReply(pick(aashaReply));
    }, LISTEN_MS);
  };

  return (
    <MaaScreen>
      <View className="mt-2 flex-row items-center justify-between">
        {/* Hidden: hold the title 3 s → Shield test screen. Not a button for Maa. */}
        <Pressable delayLongPress={3000} onLongPress={() => router.push('/debug')} accessibilityRole="header">
          <M v="title" className="text-brand-ink">{t('app_name')}</M>
        </Pressable>
        <Tap
          onPress={() => router.push('/settings')}
          accessibilityRole="button"
          accessibilityLabel={t('settings')}
          className="h-16 w-16 items-center justify-center rounded-full border border-sand-line bg-white">
          <Icon as={Settings} size={30} className="text-ink-2" />
        </Tap>
      </View>

      <M v="hero" className="mt-5">
        {t(greetingKey())},{'\n'}
        {pick(family.maa.called)}
      </M>

      <View className="flex-row">
      <Tap
        onPress={() => router.push(!shieldAvailable || shieldOn ? '/protects' : '/setup')}
        accessibilityRole="button"
        className={cn('mt-4 min-h-16 flex-row items-center rounded-full pl-2 pr-4', shieldOn ? 'bg-ok-soft' : 'bg-watch-soft')}>
        <View className={cn('h-10 w-10 items-center justify-center rounded-full', shieldOn ? 'bg-ok' : 'bg-watch')}>
          <Icon as={shieldOn ? Check : TriangleAlert} size={24} className="text-white" strokeWidth={3} />
        </View>
        <M v="strong" weight="bold" className={cn('ml-3', shieldOn ? 'text-ok-ink' : 'text-watch-ink')}>
          {!shieldAvailable ? t('demo_mode') : shieldOn ? `${t('sahaj_is_on')} ✓` : t('needs_setup')}
        </M>
        <Icon as={ChevronRight} size={24} className={cn('ml-1', shieldOn ? 'text-ok-ink' : 'text-watch-ink')} />
      </Tap>
      </View>

      <View className="mt-4 items-center">
        <Tap onPress={talk} haptic="medium" accessibilityRole="button" accessibilityLabel={t('talk_to_aasha')} className="items-center">
          <VoiceOrb size={236} listening={listening} />
        </Tap>
        <M v="h" className={cn('-mt-2 text-center', listening ? 'text-teal-ink' : 'text-ink')}>
          {listening ? t('listening') : t('talk_to_aasha')}
        </M>
        <View className="mt-2 min-h-[62px] w-full items-center justify-center">
          {listening ? (
            <M v="small" className="text-center">{t('tap_to_stop')}</M>
          ) : reply ? (
            <View className="w-full rounded-3xl bg-teal-soft px-5 py-3">
              <M v="strong" className="text-teal-deep">
                <M v="strong" weight="bold" className="text-teal-ink">{t('aasha_says')}: </M>
                {reply}
              </M>
            </View>
          ) : null}
        </View>
      </View>

      <View className="mt-4">
        <HoldTile icon={Siren} title={t('madad')} sub={t('hold_2_seconds')} holdingSub={t('keep_holding')} onComplete={() => router.push('/madad')} />
        <BigTile icon={Play} tone="brand" title={t('riyas_voice')} sub={t('new_message')} onPress={() => router.push('/voice')} right={<NewDot />} />
        <BigTile icon={HeartHandshake} tone="teal" title={t('how_is_riya')} sub={t('tap_to_know')} onPress={() => router.push('/riya')} />
      </View>
    </MaaScreen>
  );
}

function NewDot() {
  return <View className="mr-1 h-4 w-4 rounded-full bg-brand" style={TILE_SHADOW} />;
}
