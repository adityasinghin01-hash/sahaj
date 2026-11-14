// Riya's latest voice message (real expo-audio playback, loud & slow), plus spoken reply (max 30s).
import {
  createAudioPlayer,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import { useLocalSearchParams } from 'expo-router';
import { CheckCheck, Mic, Pause, Play, RefreshCw, Square } from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { BackBar, M, MaaScreen, TILE_SHADOW, softHaptic, successHaptic, useFont } from '@/components/sahaj/maa';
import { Face, Tap, Waveform } from '@/components/sahaj/ui';
import { Icon } from '@/components/ui/icon';
import { latestVoice } from '@/lib/demo';
import {
  bytesToBase64,
  fetchMaaVoiceList,
  isLivePaired,
  makeIdempotencyKey,
  markMaaVoicePlayed,
  sendMaaVoiceReply,
  type MaaVoiceItem,
} from '@/lib/maa-api';
import { reportMaaPlaybackFinished } from '@/lib/maa-heard';
import { useT } from '@/lib/prefs';
import { cn } from '@/lib/utils';

const MAX_REPLY_SECONDS = 30;
const HOLD_THRESHOLD_MS = 550;
const PLAYBACK_RATE_SLOW = 0.88;

const clock = (s: number) => `0:${String(Math.max(0, Math.round(s))).padStart(2, '0')}`;

function formatMessageTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function Voice() {
  const { t, pick } = useT();
  const params = useLocalSearchParams<{ autoPlay?: string; id?: string }>();
  const autoPlay = params.autoPlay === '1';
  const requestedId = typeof params.id === 'string' ? params.id : undefined;

  const livePaired = isLivePaired();
  const [loading, setLoading] = React.useState(livePaired);
  const [loadError, setLoadError] = React.useState(false);
  const [activeItem, setActiveItem] = React.useState<MaaVoiceItem | null>(null);

  const retryLoad = React.useCallback(async () => {
    if (!isLivePaired()) {
      setLoading(false);
      setLoadError(false);
      setActiveItem(null);
      return;
    }

    setLoading(true);
    setLoadError(false);
    const res = await fetchMaaVoiceList();
    setLoading(false);

    if (!res.ok) {
      if (res.kind !== 'not_paired') setLoadError(true);
      return;
    }

    const items = res.data.items;
    const match =
      (requestedId ? items.find((item) => item.id === requestedId) : undefined) ?? items[0] ?? null;
    setActiveItem(match);
  }, [requestedId]);

  React.useEffect(() => {
    if (!livePaired) return;
    let active = true;
    const tId = setTimeout(async () => {
      const res = await fetchMaaVoiceList();
      if (!active) return;
      setLoading(false);
      if (!res.ok) {
        if (res.kind !== 'not_paired') setLoadError(true);
        return;
      }
      setLoadError(false);
      const items = res.data.items;
      const match =
        (requestedId ? items.find((item) => item.id === requestedId) : undefined) ?? items[0] ?? null;
      setActiveItem(match);
    }, 0);
    return () => {
      active = false;
      clearTimeout(tId);
    };
  }, [livePaired, requestedId]);

  const senderLabel = activeItem?.from_display_name ?? 'Riya';
  const subTime = activeItem ? formatMessageTime(activeItem.created_at) : !livePaired ? pick(latestVoice.sentAt) : '';

  return (
    <MaaScreen>
      <BackBar />
      <View className="flex-row items-center">
        <Face name={senderLabel} size={64} tone={0} />
        <View className="ml-4 flex-1">
          <M v="title">{t('riyas_voice')}</M>
          {subTime ? <M v="small">{subTime}</M> : null}
        </View>
      </View>

      {loading ? (
        <View className="mt-6 flex-row items-center justify-center rounded-[32px] bg-brand-soft px-5 py-6">
          <ActivityIndicator />
          <M v="strong" className="ml-3 text-brand-ink">
            {t('riya_ka_sandesh')}
          </M>
        </View>
      ) : loadError ? (
        <View className="mt-6 rounded-[32px] bg-watch-soft px-5 py-5">
          <M v="body" className="text-watch-ink">
            {t('voice_load_failed')}
          </M>
          <Tap
            onPress={() => void retryLoad()}
            accessibilityRole="button"
            className="mt-3 flex-row items-center self-start rounded-full bg-white px-5 py-3">
            <Icon as={RefreshCw} size={20} className="text-watch-ink" />
            <M v="strong" weight="bold" className="ml-2 text-watch-ink">
              {t('retry')}
            </M>
          </Tap>
        </View>
      ) : livePaired && !activeItem ? (
        <View className="mt-6 rounded-[32px] bg-sand px-5 py-5">
          <M v="strong" className="text-center text-ink-2">
            {t('no_new_voice')}
          </M>
        </View>
      ) : (
        <Player livePaired={livePaired} item={activeItem} autoPlay={autoPlay} />
      )}

      {!livePaired ? (
        <M v="small" className="mt-4 text-center">
          {t('demo_voice')}
        </M>
      ) : (
        <M v="small" className="mt-4 text-center text-ink-2">
          {t('loud_slow_note')}
        </M>
      )}

      <View className="flex-1" />
      <Reply livePaired={livePaired} replyToId={activeItem?.id ?? null} />
    </MaaScreen>
  );
}

function Player({
  livePaired,
  item,
  autoPlay,
}: {
  livePaired: boolean;
  item: MaaVoiceItem | null;
  autoPlay: boolean;
}) {
  const { t } = useT();
  const font = useFont();
  const mediaUrl = item?.media_url ?? null;
  const useRealAudio = Boolean(mediaUrl);

  const playerRef = React.useRef<AudioPlayer | null>(null);
  const [audioState, setAudioState] = React.useState<{
    playing: boolean;
    currentTime: number;
    duration: number;
    didJustFinish: boolean;
  }>({ playing: false, currentTime: 0, duration: item?.duration_s ?? 8, didJustFinish: false });

  const [demoPlaying, setDemoPlaying] = React.useState(() => autoPlay && !livePaired && !mediaUrl);
  const [demoProgress, setDemoProgress] = React.useState(0);
  const autoPlayedRef = React.useRef(false);
  const markedPlayedRef = React.useRef<string | null>(null);

  const markPlayedOnce = React.useCallback(() => {
    if (!livePaired || !item || item.state === 'heard' || markedPlayedRef.current === item.id) return;
    markedPlayedRef.current = item.id;
    void markMaaVoicePlayed(item.id);
  }, [item, livePaired]);

  // "Maa heard it" proof: a device-signed ack, sent only when playback reaches its natural end.
  const reportedHeardRef = React.useRef<string | null>(null);
  const reportHeardOnce = React.useCallback(
    (next: AudioStatus) => {
      if (!livePaired || !item || reportedHeardRef.current === item.id) return;
      const clipDurationS = Math.max(1, Math.round(next.duration > 0 ? next.duration : (item.duration_s ?? 1)));
      const playedDurationS = Math.round(Math.max(next.currentTime, next.duration));
      reportedHeardRef.current = item.id;
      void reportMaaPlaybackFinished({
        messageKind: 'core1_voice_post',
        deliveryId: item.id,
        voicePostId: item.id,
        clipDurationS,
        playedDurationS,
        playbackFinished: true,
      }).then((res) => {
        // Let a later full replay retry if this one failed (e.g. network); the server dedupes receipts.
        if (!res.ok && reportedHeardRef.current === item.id) reportedHeardRef.current = null;
      });
    },
    [item, livePaired],
  );

  React.useEffect(() => {
    if (!mediaUrl) {
      playerRef.current?.remove();
      playerRef.current = null;
      return;
    }

    const instance = createAudioPlayer({ uri: mediaUrl }, { updateInterval: 200, downloadFirst: true });
    playerRef.current = instance;

    try {
      instance.volume = 1.0;
      instance.shouldCorrectPitch = true;
      instance.setPlaybackRate(PLAYBACK_RATE_SLOW, 'high');
    } catch {
      // Fallback if platform rejects rate before load
    }

    const sub = instance.addListener('playbackStatusUpdate', (next: AudioStatus) => {
      setAudioState({
        playing: next.playing,
        currentTime: next.currentTime,
        duration: next.duration,
        didJustFinish: next.didJustFinish,
      });
      if (next.didJustFinish) reportHeardOnce(next);

      if (autoPlay && !autoPlayedRef.current && next.isLoaded) {
        autoPlayedRef.current = true;
        void setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false })
          .catch(() => {})
          .finally(() => {
            try {
              instance.volume = 1.0;
              instance.shouldCorrectPitch = true;
              instance.setPlaybackRate(PLAYBACK_RATE_SLOW, 'high');
            } catch {
              // Non-fatal
            }
            instance.play();
            markPlayedOnce();
          });
      }
    });

    return () => {
      sub.remove();
      instance.remove();
      if (playerRef.current === instance) {
        playerRef.current = null;
      }
    };
  }, [autoPlay, markPlayedOnce, mediaUrl, reportHeardOnce]);

  React.useEffect(() => {
    if (useRealAudio || !demoPlaying) return;
    const secs = latestVoice.seconds;
    const id = setInterval(() => {
      setDemoProgress((v) => {
        const nv = v + 0.1 / secs;
        if (nv >= 1) {
          setDemoPlaying(false);
          return 0;
        }
        return nv;
      });
    }, 100);
    return () => clearInterval(id);
  }, [demoPlaying, useRealAudio]);

  const togglePlay = async () => {
    const p = playerRef.current;
    if (useRealAudio && p) {
      if (audioState.playing) {
        p.pause();
        return;
      }
      try {
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
      } catch {
        // Non-fatal
      }
      try {
        p.volume = 1.0;
        p.shouldCorrectPitch = true;
        p.setPlaybackRate(PLAYBACK_RATE_SLOW, 'high');
      } catch {
        // Non-fatal
      }
      if (
        audioState.didJustFinish ||
        (audioState.duration > 0 && audioState.currentTime >= audioState.duration - 0.15)
      ) {
        await p.seekTo(0);
      }
      p.play();
      markPlayedOnce();
      return;
    }
    setDemoPlaying((x) => !x);
  };

  const playing = useRealAudio ? audioState.playing : demoPlaying;
  const totalSecs = useRealAudio
    ? audioState.duration > 0
      ? audioState.duration
      : (item?.duration_s ?? 8)
    : latestVoice.seconds;
  const progress = useRealAudio
    ? audioState.duration > 0
      ? Math.min(1, Math.max(0, audioState.currentTime / audioState.duration))
      : 0
    : demoProgress;
  const remaining = playing ? Math.max(0, totalSecs * (1 - progress)) : totalSecs;

  return (
    <View className="mt-6 flex-row items-center rounded-[36px] bg-brand-soft p-3 pr-5">
      <Tap
        onPress={() => void togglePlay()}
        haptic="medium"
        accessibilityRole="button"
        accessibilityLabel={playing ? t('pause') : t('play')}
        className="h-[88px] w-[88px] items-center justify-center rounded-full bg-brand">
        <Icon
          as={playing ? Pause : Play}
          size={40}
          className="text-white"
          style={{ marginLeft: playing ? 0 : 4 }}
        />
      </Tap>
      <View className="ml-4 flex-1">
        <Waveform progress={progress} seed={latestVoice.seed} n={26} color="bg-brand" track="bg-brand/25" height={52} />
      </View>
      <M
        v="strong"
        weight="bold"
        className="ml-4 text-brand-ink"
        style={[font(22, 'bold'), { fontVariant: ['tabular-nums'] }]}>
        {clock(remaining)}
      </M>
    </View>
  );
}

type PendingUpload = {
  audioBase64: string;
  contentType: string;
  durationS: number;
  idempotencyKey: string;
};

function Reply({ livePaired, replyToId }: { livePaired: boolean; replyToId: string | null }) {
  const { t } = useT();
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 200);

  const [phase, setPhase] = React.useState<'idle' | 'rec' | 'sending' | 'sent' | 'error'>('idle');
  const [errorKey, setErrorKey] = React.useState<
    'mic_needed' | 'reply_too_short' | 'voice_send_failed' | null
  >(null);
  const [pendingUpload, setPendingUpload] = React.useState<PendingUpload | null>(null);
  const [elapsedSecs, setElapsedSecs] = React.useState(0);
  const [tick, setTick] = React.useState(1);

  const pressInAtRef = React.useRef(0);
  const tapHoldActiveRef = React.useRef(false);
  const stopInProgressRef = React.useRef(false);
  const maxTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulse = useSharedValue(0);

  const clearMaxTimer = React.useCallback(() => {
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    if (phase === 'rec') {
      pulse.value = withRepeat(withTiming(1, { duration: 1100, easing: Easing.out(Easing.quad) }), -1, false);
    } else {
      cancelAnimation(pulse);
      pulse.value = 0;
    }
  }, [phase, pulse]);

  React.useEffect(
    () => () => {
      clearMaxTimer();
    },
    [clearMaxTimer],
  );

  React.useEffect(() => {
    if (phase !== 'rec') return;
    const id = setInterval(() => {
      const secs = Math.min(MAX_REPLY_SECONDS, (Date.now() - pressInAtRef.current) / 1000);
      setElapsedSecs(secs);
      setTick((x) => x + 1);
    }, 180);
    return () => clearInterval(id);
  }, [phase]);

  const ring = useAnimatedStyle(() => ({
    opacity: 0.45 * (1 - pulse.value),
    transform: [{ scale: 1 + pulse.value * 0.5 }],
  }));

  const uploadPrepared = React.useCallback(
    async (payload: PendingUpload) => {
      if (!livePaired) {
        successHaptic();
        setPhase('sent');
        setPendingUpload(null);
        return;
      }

      setPhase('sending');
      setErrorKey(null);
      const res = await sendMaaVoiceReply({
        replyTo: replyToId,
        audioBase64: payload.audioBase64,
        contentType: payload.contentType,
        durationS: payload.durationS,
        idempotencyKey: payload.idempotencyKey,
      });

      if (!res.ok) {
        setPhase('error');
        setErrorKey('voice_send_failed');
        setPendingUpload(payload);
        return;
      }

      successHaptic();
      setPhase('sent');
      setPendingUpload(null);
    },
    [livePaired, replyToId],
  );

  const finishRecording = React.useCallback(async () => {
    if (stopInProgressRef.current || phase !== 'rec') return;
    stopInProgressRef.current = true;
    clearMaxTimer();

    const spokenMs = Date.now() - pressInAtRef.current;
    const durationS = Math.min(MAX_REPLY_SECONDS, Math.max(1, Math.round(spokenMs / 1000)));

    try {
      await recorder.stop();
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
    } catch {
      // Stop safely even if already stopped
    }

    stopInProgressRef.current = false;

    if (spokenMs < 950) {
      setPhase('error');
      setErrorKey('reply_too_short');
      return;
    }

    if (!livePaired) {
      successHaptic();
      setPhase('sent');
      return;
    }

    const uri = recorder.uri;
    if (!uri) {
      setPhase('error');
      setErrorKey('voice_send_failed');
      return;
    }

    try {
      const fileRes = await fetch(uri);
      const buffer = await fileRes.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (bytes.byteLength === 0) {
        setPhase('error');
        setErrorKey('voice_send_failed');
        return;
      }

      const payload: PendingUpload = {
        audioBase64: bytesToBase64(bytes),
        contentType: 'audio/mp4',
        durationS,
        idempotencyKey: makeIdempotencyKey('voice-reply'),
      };
      await uploadPrepared(payload);
    } catch {
      setPhase('error');
      setErrorKey('voice_send_failed');
    }
  }, [clearMaxTimer, livePaired, phase, recorder, uploadPrepared]);

  const startRecording = React.useCallback(async () => {
    if (phase === 'rec' || phase === 'sending') return;

    setErrorKey(null);
    setPendingUpload(null);

    if (livePaired) {
      try {
        const perm = await requestRecordingPermissionsAsync();
        if (!perm.granted) {
          setPhase('error');
          setErrorKey('mic_needed');
          return;
        }
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });
        await recorder.prepareToRecordAsync();
        recorder.record();
      } catch {
        setPhase('error');
        setErrorKey('mic_needed');
        return;
      }
    }

    softHaptic();
    pressInAtRef.current = Date.now();
    tapHoldActiveRef.current = false;
    setElapsedSecs(0);
    setPhase('rec');

    clearMaxTimer();
    maxTimerRef.current = setTimeout(() => {
      void finishRecording();
    }, MAX_REPLY_SECONDS * 1000);
  }, [clearMaxTimer, finishRecording, livePaired, phase, recorder]);

  const handlePressIn = () => {
    if (phase === 'rec') {
      void finishRecording();
      return;
    }
    tapHoldActiveRef.current = true;
    void startRecording();
  };

  const handlePressOut = () => {
    if (phase !== 'rec' || !tapHoldActiveRef.current) return;
    tapHoldActiveRef.current = false;
    const heldMs = Date.now() - pressInAtRef.current;
    if (heldMs >= HOLD_THRESHOLD_MS) {
      void finishRecording();
    }
  };

  const rec = phase === 'rec' || recorderState.isRecording;

  return (
    <View className="items-center">
      <View className="mb-4 min-h-[64px] w-full items-center justify-center">
        {rec ? (
          <View className="w-full flex-row items-center rounded-full bg-teal-soft px-5 py-2">
            <Waveform seed={tick} n={26} color="bg-teal" track="bg-teal" height={36} />
            <M v="strong" weight="bold" className="ml-4 text-teal-ink">
              {clock(elapsedSecs)} / 0:30
            </M>
          </View>
        ) : phase === 'sending' ? (
          <View className="flex-row items-center rounded-full bg-teal-soft px-5 py-3">
            <ActivityIndicator />
            <M v="strong" weight="bold" className="ml-3 text-teal-ink">
              {t('sending_reply')}
            </M>
          </View>
        ) : phase === 'sent' ? (
          <View className="flex-row items-center rounded-full bg-ok-soft px-5 py-3">
            <Icon as={CheckCheck} size={28} className="text-ok-ink" />
            <M v="strong" weight="bold" className="ml-2 text-ok-ink">
              {t('bhej_diya')}
            </M>
          </View>
        ) : phase === 'error' && errorKey ? (
          <View className="w-full rounded-3xl bg-watch-soft px-5 py-3">
            <M v="body" className="text-watch-ink">
              {t(errorKey)}
            </M>
            {pendingUpload ? (
              <Tap
                onPress={() => void uploadPrepared(pendingUpload)}
                accessibilityRole="button"
                className="mt-2 flex-row items-center self-start rounded-full bg-white px-4 py-2">
                <Icon as={RefreshCw} size={18} className="text-watch-ink" />
                <M v="strong" weight="bold" className="ml-2 text-watch-ink">
                  {t('retry')}
                </M>
              </Tap>
            ) : null}
          </View>
        ) : null}
      </View>

      <View className="h-[150px] w-[150px] items-center justify-center">
        <Animated.View style={ring} className="absolute h-[140px] w-[140px] rounded-full bg-teal" />
        <Pressable
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          disabled={phase === 'sending'}
          accessibilityRole="button"
          accessibilityLabel={t('jawab_do')}
          className={cn(
            'h-[140px] w-[140px] items-center justify-center rounded-full',
            rec ? 'bg-teal-ink' : 'bg-teal',
          )}
          style={TILE_SHADOW}>
          <Icon as={rec ? Square : Mic} size={rec ? 48 : 60} className="text-white" />
        </Pressable>
      </View>
      <M v="h" weight="bold" className="mt-3 text-center">
        {rec ? t('tap_again_to_send') : t('jawab_do')}
      </M>
      {!rec ? (
        <M v="small" className="mt-1 text-center text-ink-2">
          {t('tap_or_hold_reply')}
        </M>
      ) : null}
    </View>
  );
}
