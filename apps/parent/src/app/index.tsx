// Home: greeting + Shield chip, the voice orb ("Talk to Aasha"), Riya's new voice CTA, and three big tiles.
import { router, useFocusEffect } from 'expo-router';
import { Check, ChevronRight, HeartHandshake, Phone, Play, Settings, Siren, TriangleAlert, X } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Modal, Pressable, View } from 'react-native';

import { BigBtn, BigTile, HoldTile, M, MaaScreen, TILE_SHADOW } from '@/components/sahaj/maa';
import { Tap } from '@/components/sahaj/ui';
import { VoiceOrb } from '@/components/sahaj/VoiceOrb';
import { Icon } from '@/components/ui/icon';
import { useCall } from '@/lib/call';
import { aashaReply, family } from '@/lib/demo';
import {
  fetchMaaVoiceList,
  isLivePaired,
  makeIdempotencyKey,
  triggerMaaUrgent,
  type MaaVoiceItem,
} from '@/lib/maa-api';
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
  const call = useCall();
  const [listening, setListening] = React.useState(false);
  const [reply, setReply] = React.useState<string | null>(null);
  const [shieldOn, setShieldOn] = React.useState(true);
  const [newVoice, setNewVoice] = React.useState<MaaVoiceItem | null>(null);
  const [voiceReachError, setVoiceReachError] = React.useState(false);
  const [confirmSos, setConfirmSos] = React.useState(false);
  const [sosBusy, setSosBusy] = React.useState(false);
  const [sosError, setSosError] = React.useState(false);
  const sosIdempKeyRef = React.useRef<string>(makeIdempotencyKey('sos'));
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const livePaired = isLivePaired();

  const loadVoiceBadge = React.useCallback(async () => {
    if (!isLivePaired()) {
      setVoiceReachError(false);
      setNewVoice(null);
      return;
    }
    const res = await fetchMaaVoiceList();
    if (!res.ok) {
      if (res.kind !== 'not_paired') setVoiceReachError(true);
      return;
    }
    setVoiceReachError(false);
    const unheard = res.data.items.find((item) => item.state !== 'heard' && !item.played_at) ?? null;
    setNewVoice(unheard);
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      // Demo (web): always on. Phone: on once SMS checking is allowed.
      if (shieldAvailable) {
        const s = shield.getStatus();
        setShieldOn(
          !!s &&
            s.sms &&
            s.phoneState &&
            s.contacts &&
            s.overlay &&
            s.callScreeningRole &&
            s.paired &&
            s.rulesEngine === 'json',
        );
      }
      void loadVoiceBadge();
    }, [loadVoiceBadge]),
  );

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

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

  const openVoiceNow = (autoPlay: boolean) => {
    const query = new URLSearchParams();
    if (autoPlay) query.set('autoPlay', '1');
    if (newVoice?.id) query.set('id', newVoice.id);
    const qs = query.toString();
    router.push((qs ? `/voice?${qs}` : '/voice') as '/voice');
  };

  const openSosConfirm = () => {
    sosIdempKeyRef.current = makeIdempotencyKey('sos');
    setSosError(false);
    setConfirmSos(true);
  };

  const confirmAndSendSos = async () => {
    if (sosBusy) return;
    if (!isLivePaired()) {
      setConfirmSos(false);
      router.push('/madad?demo=1' as '/madad');
      return;
    }

    setSosBusy(true);
    setSosError(false);
    const res = await triggerMaaUrgent(sosIdempKeyRef.current);
    setSosBusy(false);

    if (!res.ok) {
      setSosError(true);
      return;
    }

    setConfirmSos(false);
    router.push(`/madad?id=${encodeURIComponent(res.data.id)}` as '/madad');
  };

  const showNewVoiceCta = !livePaired || Boolean(newVoice);

  return (
    <MaaScreen>
      <View className="mt-2 flex-row items-center justify-between">
        {/* Hidden: hold the title 3 s → Shield test screen. Not a button for Maa. */}
        <Pressable delayLongPress={3000} onLongPress={() => router.push('/debug')} accessibilityRole="header">
          <M v="title" className="text-brand-ink">
            {t('app_name')}
          </M>
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
          className={cn(
            'mt-4 min-h-16 flex-row items-center rounded-full pl-2 pr-4',
            shieldOn ? 'bg-ok-soft' : 'bg-watch-soft',
          )}>
          <View
            className={cn(
              'h-10 w-10 items-center justify-center rounded-full',
              shieldOn ? 'bg-ok' : 'bg-watch',
            )}>
            <Icon as={shieldOn ? Check : TriangleAlert} size={24} className="text-white" strokeWidth={3} />
          </View>
          <M v="strong" weight="bold" className={cn('ml-3', shieldOn ? 'text-ok-ink' : 'text-watch-ink')}>
            {!shieldAvailable ? t('demo_mode') : shieldOn ? `${t('sahaj_is_on')} ✓` : t('needs_setup')}
          </M>
          <Icon as={ChevronRight} size={24} className={cn('ml-1', shieldOn ? 'text-ok-ink' : 'text-watch-ink')} />
        </Tap>
      </View>

      <View className="mt-4 items-center">
        <Tap
          onPress={talk}
          haptic="medium"
          accessibilityRole="button"
          accessibilityLabel={t('talk_to_aasha')}
          className="items-center">
          <VoiceOrb size={236} listening={listening} />
        </Tap>
        <M v="h" className={cn('-mt-2 text-center', listening ? 'text-teal-ink' : 'text-ink')}>
          {listening ? t('listening') : t('talk_to_aasha')}
        </M>

        {showNewVoiceCta ? (
          <Tap
            onPress={() => openVoiceNow(true)}
            haptic="medium"
            accessibilityRole="button"
            accessibilityLabel={t('riya_ka_sandesh')}
            className="mt-4 min-h-[72px] w-full flex-row items-center justify-center rounded-[28px] bg-brand px-6 py-4"
            style={TILE_SHADOW}>
            <Icon as={Play} size={28} className="text-white" />
            <M v="h" weight="bold" className="ml-3 text-white">
              ▶ {t('riya_ka_sandesh')}
            </M>
          </Tap>
        ) : null}

        {voiceReachError ? (
          <View className="mt-3 w-full rounded-3xl bg-watch-soft px-5 py-3">
            <M v="body" className="text-watch-ink">
              {t('server_unreachable')}
            </M>
            <Tap
              onPress={() => void loadVoiceBadge()}
              accessibilityRole="button"
              className="mt-2 self-start rounded-full bg-white px-4 py-2">
              <M v="strong" weight="bold" className="text-watch-ink">
                {t('retry')}
              </M>
            </Tap>
          </View>
        ) : null}

        <View className="mt-2 min-h-[48px] w-full items-center justify-center">
          {listening ? (
            <M v="small" className="text-center">
              {t('tap_to_stop')}
            </M>
          ) : reply ? (
            <View className="w-full rounded-3xl bg-teal-soft px-5 py-3">
              <M v="strong" className="text-teal-deep">
                <M v="strong" weight="bold" className="text-teal-ink">
                  {t('aasha_says')}:{' '}
                </M>
                {reply}
              </M>
            </View>
          ) : null}
        </View>
      </View>

      <View className="mt-2">
        <HoldTile
          icon={Siren}
          title={t('madad')}
          sub={t('hold_2_seconds')}
          holdingSub={t('keep_holding')}
          onComplete={openSosConfirm}
        />
        <BigTile
          icon={Play}
          tone="brand"
          title={t('riyas_voice')}
          sub={showNewVoiceCta ? t('new_voice_tap_to_play') : t('no_new_voice')}
          onPress={() => openVoiceNow(false)}
          right={showNewVoiceCta ? <NewDot /> : undefined}
        />
        <BigTile
          icon={HeartHandshake}
          tone="teal"
          title={t('how_is_riya')}
          sub={t('tap_to_know')}
          onPress={() => router.push('/riya')}
        />
      </View>

      <Modal
        visible={confirmSos}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!sosBusy) setConfirmSos(false);
        }}>
        <View className="flex-1 justify-end bg-black/50 p-5">
          <View className="rounded-[32px] bg-white p-6" style={TILE_SHADOW}>
            <M v="hero" className="text-urgent">
              {t('madad_bulaun')}
            </M>
            <M v="body" className="mt-3 text-ink-2">
              {t('madad_confirm_sub')}
            </M>

            {sosBusy ? (
              <View className="mt-5 flex-row items-center rounded-2xl bg-urgent-soft px-4 py-3">
                <ActivityIndicator />
                <M v="strong" weight="bold" className="ml-3 text-urgent">
                  {t('madad_sending')}
                </M>
              </View>
            ) : null}

            {sosError ? (
              <View className="mt-5 rounded-2xl bg-watch-soft px-4 py-3">
                <M v="body" className="text-watch-ink">
                  {t('madad_send_failed')}
                </M>
              </View>
            ) : null}

            <BigBtn
              className="mt-6"
              kind="danger"
              icon={Siren}
              label={sosError ? t('retry') : t('madad_confirm_yes')}
              onPress={() => void confirmAndSendSos()}
            />

            {sosError ? (
              <BigBtn
                className="mt-3"
                kind="ok"
                icon={Phone}
                label={t('call_riya')}
                onPress={() => call(family.riya.phone)}
              />
            ) : null}

            <BigBtn
              className="mt-3"
              kind="soft"
              icon={X}
              label={t('madad_confirm_no')}
              onPress={() => {
                if (!sosBusy) setConfirmSos(false);
              }}
            />
          </View>
        </View>
      </Modal>
    </MaaScreen>
  );
}

function NewDot() {
  return <View className="mr-1 h-4 w-4 rounded-full bg-brand" style={TILE_SHADOW} />;
}
