// Maa's Fresh Proof-of-Life + Any-Phone Live Voice view (large type, calm Hindi/English, loud & slow audio).
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import {
  CheckCheck,
  Clock,
  Pause,
  PhoneCall,
  Play,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';

import {
  BackBar,
  BigBtn,
  M,
  MaaScreen,
  TILE_SHADOW,
  softHaptic,
  successHaptic,
} from '@/components/sahaj/maa';
import { Face, Tap, Waveform } from '@/components/sahaj/ui';
import { Icon } from '@/components/ui/icon';
import { isLivePaired } from '@/lib/maa-api';
import {
  fetchMaaProofDashboard,
  formatFreshnessDisplay,
  requestMaaProofChallenge,
  type MaaAnyPhoneAlert,
  type MaaProofChallenge,
} from '@/lib/maa-proof';
import { usePrefs } from '@/lib/prefs';

const POLL_MS = 2500;
const PLAYBACK_RATE_SLOW = 0.88;

function ProofAudioCard({
  mediaUrl,
  stampLine,
  title,
  subline,
  tone = 'ok',
}: {
  mediaUrl: string | null;
  stampLine: string;
  title: string;
  subline?: string | null;
  tone?: 'ok' | 'brand';
}) {
  const { lang } = usePrefs();
  const playerRef = React.useRef<AudioPlayer | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [demoPlaying, setDemoPlaying] = React.useState(false);

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
      // Fallback before load
    }

    const sub = instance.addListener('playbackStatusUpdate', (next: AudioStatus) => {
      setPlaying(next.playing);
      if (next.duration > 0) {
        setProgress(Math.min(1, Math.max(0, next.currentTime / next.duration)));
      }
    });

    return () => {
      sub.remove();
      instance.remove();
      if (playerRef.current === instance) {
        playerRef.current = null;
      }
    };
  }, [mediaUrl]);

  React.useEffect(() => {
    if (mediaUrl || !demoPlaying) return;
    const id = setInterval(() => {
      setProgress((prev) => {
        const next = prev + 0.05;
        if (next >= 1) {
          setDemoPlaying(false);
          return 0;
        }
        return next;
      });
    }, 200);
    return () => clearInterval(id);
  }, [demoPlaying, mediaUrl]);

  const togglePlay = async () => {
    softHaptic();
    const p = playerRef.current;
    if (mediaUrl && p) {
      if (playing) {
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
      if (progress >= 0.98) {
        await p.seekTo(0);
      }
      p.play();
      return;
    }
    setDemoPlaying((x) => !x);
  };

  const activePlaying = mediaUrl ? playing : demoPlaying;
  const bg = tone === 'ok' ? 'bg-ok-soft' : 'bg-brand-soft';
  const ink = tone === 'ok' ? 'text-ok-ink' : 'text-brand-ink';

  return (
    <View className={`mt-5 rounded-[32px] border border-sand-line p-5 ${bg}`} style={TILE_SHADOW}>
      <View className="flex-row items-center">
        <Face name="Riya" size={56} tone={0} />
        <View className="ml-4 flex-1">
          <M v="h" className={ink}>
            {title}
          </M>
          <M v="strong" className="mt-1 text-ink">
            {stampLine}
          </M>
          {subline ? (
            <M v="small" className="mt-1 text-ink-2">
              {subline}
            </M>
          ) : null}
        </View>
      </View>

      <View className="mt-5 flex-row items-center rounded-full bg-white px-4 py-3">
        <Tap
          onPress={() => void togglePlay()}
          accessibilityRole="button"
          accessibilityLabel={activePlaying ? 'Pause' : 'Play'}
          className="h-14 w-14 items-center justify-center rounded-full bg-ink">
          <Icon as={activePlaying ? Pause : Play} size={26} className="text-white" />
        </Tap>
        <View className="ml-4 flex-1">
          <Waveform
            progress={progress}
            seed={11}
            n={26}
            color={tone === 'ok' ? 'bg-ok' : 'bg-brand'}
            track="bg-sand-2"
            height={30}
          />
        </View>
        <M v="small" className="ml-3 text-ink-2">
          {lang === 'hi' ? 'साफ़ व धीमी आवाज़' : 'Clear & slow'}
        </M>
      </View>
    </View>
  );
}

export default function MaaProofScreen() {
  const { lang } = usePrefs();
  const livePaired = isLivePaired();

  const [loading, setLoading] = React.useState(livePaired);
  const [requesting, setRequesting] = React.useState(false);
  const [proof, setProof] = React.useState<MaaProofChallenge | null>(null);
  const [anyPhone, setAnyPhone] = React.useState<MaaAnyPhoneAlert | null>(null);
  const [errorLine, setErrorLine] = React.useState<string | null>(null);
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  // Demo state for offline / web preview
  const [demoModeState, setDemoModeState] = React.useState<'idle' | 'waiting' | 'verified' | 'escalated'>('verified');
  const [demoVerifiedAt, setDemoVerifiedAt] = React.useState(() => new Date(Date.now() - 40_000).toISOString());

  const loadLive = React.useCallback(async () => {
    if (!isLivePaired()) {
      setLoading(false);
      return;
    }
    const res = await fetchMaaProofDashboard();
    setLoading(false);
    if (!res.ok) {
      if (res.kind !== 'not_paired') {
        setErrorLine(
          lang === 'hi' ? 'अभी सर्वर से जुड़ नहीं पा रहे।' : 'Could not reach server right now.',
        );
      }
      return;
    }
    setErrorLine(null);
    setProof(res.data.proof);
    setAnyPhone(res.data.any_phone);
  }, [lang]);

  React.useEffect(() => {
    if (!livePaired) return;
    const initial = setTimeout(() => void loadLive(), 0);
    const id = setInterval(() => void loadLive(), POLL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [livePaired, loadLive]);

  React.useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const handleAskRiya = async () => {
    softHaptic();
    if (!livePaired) {
      setDemoModeState('waiting');
      setTimeout(() => {
        successHaptic();
        setDemoVerifiedAt(new Date().toISOString());
        setDemoModeState('verified');
      }, 1800);
      return;
    }

    setRequesting(true);
    setErrorLine(null);
    const res = await requestMaaProofChallenge();
    setRequesting(false);
    if (!res.ok) {
      setErrorLine(
        lang === 'hi' ? 'पूछने में दिक्कत हुई, फिर से दबाएँ।' : 'Could not send check; please tap again.',
      );
      return;
    }
    successHaptic();
    setProof(res.data.challenge);
  };

  const title = lang === 'hi' ? 'रिया ठीक है?' : 'Is Riya okay?';
  const activeProof = livePaired ? proof : null;
  const isWaiting = livePaired
    ? activeProof?.status === 'pending' || activeProof?.status === 'word_mismatch'
    : demoModeState === 'waiting';
  const isVerified = livePaired ? activeProof?.status === 'verified' : demoModeState === 'verified';
  const isEscalated = livePaired
    ? activeProof?.status === 'escalated' || activeProof?.status === 'expired'
    : demoModeState === 'escalated';

  const secondsLeft =
    livePaired && activeProof && isWaiting
      ? Math.max(0, Math.ceil((Date.parse(activeProof.expires_at) - nowMs) / 1000))
      : 45;

  const freshnessStamp = livePaired
    ? formatFreshnessDisplay(
        activeProof?.verified_at ?? null,
        activeProof?.freshness_stamp_hi ?? null,
        activeProof?.freshness_stamp_en ?? null,
        lang,
        nowMs,
      )
    : formatFreshnessDisplay(demoVerifiedAt, null, null, lang, nowMs);

  return (
    <MaaScreen>
      <BackBar title={title} />

      <View className="rounded-[32px] border border-sand-line bg-white p-5" style={TILE_SHADOW}>
        <M v="h">
          {lang === 'hi'
            ? 'रिया की अभी की आवाज़ सुनें'
            : 'Hear Riya’s live voice right now'}
        </M>
        <M v="body" className="mt-2">
          {lang === 'hi'
            ? 'सहज एक नया शब्द देता है। रिया उसे बोलती है, तभी आपको सुनाई देता है।'
            : 'Sahaj picks a fresh word this second so you know her voice is live.'}
        </M>

        <View className="mt-5">
          <BigBtn
            label={
              requesting
                ? lang === 'hi'
                  ? 'भेज रहे हैं…'
                  : 'Asking…'
                : lang === 'hi'
                  ? 'रिया ठीक है?'
                  : 'Ask Riya'
            }
            icon={Sparkles}
            kind="primary"
            tall
            disabled={requesting}
            onPress={() => void handleAskRiya()}
          />
        </View>
      </View>

      {loading ? (
        <View className="mt-5 flex-row items-center justify-center rounded-[28px] bg-sand p-5">
          <ActivityIndicator />
          <M v="strong" className="ml-3">
            {lang === 'hi' ? 'देख रहे हैं…' : 'Checking…'}
          </M>
        </View>
      ) : null}

      {isWaiting ? (
        <View className="mt-5 rounded-[32px] bg-brand-soft p-5" style={TILE_SHADOW}>
          <View className="flex-row items-center justify-between">
            <View className="flex-row items-center">
              <Icon as={Clock} size={26} className="mr-3 text-brand-ink" />
              <M v="h" className="text-brand-ink">
                {lang === 'hi' ? 'रिया का इंतज़ार…' : 'Waiting for Riya…'}
              </M>
            </View>
            <M v="h" className="text-brand-ink">
              {secondsLeft}s
            </M>
          </View>
          <M v="body" className="mt-2 text-ink">
            {lang === 'hi'
              ? `रिया को नया शब्द "${activeProof?.word_token ?? 'gulab'}" भेजा गया है।`
              : `Asked Riya to say "${activeProof?.word_token ?? 'gulab'}" now.`}
          </M>
        </View>
      ) : null}

      {isVerified ? (
        <ProofAudioCard
          mediaUrl={activeProof?.media_url ?? null}
          title={lang === 'hi' ? 'रिया की ताज़ा आवाज़' : 'Riya’s fresh voice'}
          stampLine={freshnessStamp}
          subline={
            lang === 'hi'
              ? `सत्यापित शब्द: ${activeProof?.word_token ?? 'gulab'}`
              : `Verified word: ${activeProof?.word_token ?? 'gulab'}`
          }
          tone="ok"
        />
      ) : null}

      {isEscalated ? (
        <View className="mt-5 rounded-[32px] bg-watch-soft p-5" style={TILE_SHADOW}>
          <View className="flex-row items-center">
            <Icon as={ShieldAlert} size={28} className="mr-3 text-watch-ink" />
            <M v="h" className="flex-1 text-watch-ink">
              {lang === 'hi' ? 'मदद भेजी जा रही है' : 'Local help notified'}
            </M>
          </View>
          <M v="strong" className="mt-3 text-ink">
            {(lang === 'hi'
              ? activeProof?.escalation_message_hi
              : activeProof?.escalation_message_en) ??
              'Riya se abhi baat nahi hui, Priya unke paas ja rahi hai. Paise bilkul mat bhejiye.'}
          </M>
        </View>
      ) : null}

      {anyPhone ? (
        <ProofAudioCard
          mediaUrl={anyPhone.media_url}
          title={lang === 'hi' ? 'दूसरे फ़ोन से कॉल' : 'Call from another phone'}
          stampLine={lang === 'hi' ? anyPhone.status_message_hi : anyPhone.status_message_en}
          subline={
            lang === 'hi'
              ? 'कोड वर्ड से पहचान पक्की हुई · रिया की लाइव आवाज़'
              : 'Verified with family code word · Riya’s live voice'
          }
          tone="brand"
        />
      ) : !livePaired ? (
        <View className="mt-5 rounded-[28px] border border-sand-line bg-white p-5" style={TILE_SHADOW}>
          <View className="flex-row items-center">
            <Icon as={PhoneCall} size={24} className="mr-3 text-teal-ink" />
            <M v="strong" className="flex-1">
              {lang === 'hi' ? 'डेमो मोड · सिंथेटिक डेटा' : 'Demo mode · synthetic data'}
            </M>
            <Tap
              onPress={() => setDemoModeState((s) => (s === 'escalated' ? 'verified' : 'escalated'))}
              className="rounded-full bg-sand px-4 py-2">
              <M v="small" className="text-ink">
                {demoModeState === 'escalated' ? 'Show OK' : 'Test 60s'}
              </M>
            </Tap>
          </View>
        </View>
      ) : null}

      {errorLine ? (
        <View className="mt-5 rounded-[28px] bg-watch-soft p-5">
          <M v="body" className="text-watch-ink">
            {errorLine}
          </M>
          <Tap
            onPress={() => void loadLive()}
            className="mt-3 flex-row items-center self-start rounded-full bg-white px-5 py-3">
            <Icon as={RefreshCw} size={20} className="text-watch-ink" />
            <M v="strong" className="ml-2 text-watch-ink">
              {lang === 'hi' ? 'फिर कोशिश करें' : 'Retry'}
            </M>
          </Tap>
        </View>
      ) : null}

      {isVerified ? (
        <View className="mt-5 flex-row items-center justify-center">
          <Icon as={CheckCheck} size={20} className="mr-2 text-ok-ink" />
          <M v="small" className="text-ok-ink">
            {lang === 'hi'
              ? 'यह आवाज़ अभी रिकॉर्ड हुई है, पुरानी रिकॉर्डिंग नहीं है।'
              : 'Live fresh clip — never replayed from an old message.'}
          </M>
        </View>
      ) : null}
    </MaaScreen>
  );
}
