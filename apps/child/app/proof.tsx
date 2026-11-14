import { Icon } from '@/components/ui/icon';
import {
  Btn,
  Card,
  ClipPlayer,
  Notice,
  Pop,
  Screen,
  T,
  Tap,
  TopBar,
  Waveform,
  palette,
} from '@/components/sahaj/ui';
import {
  createProofApi,
  DEMO_PROOF_WORDS,
  type ProofChallenge,
} from '@/lib/core2-proof';
import { useSession } from '@/lib/session';
import { useVoiceRecorder } from '@/lib/voice-recorder';
import { useLocalSearchParams } from 'expo-router';
import { CheckCheck, Clock, Mic, RefreshCw, Send, ShieldAlert, Square } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';

const MAX_PROOF_CLIP_SECONDS = 30;
const DEMO_TTL_SECONDS = 60;

export default function ProofOfLifeScreen() {
  const { session } = useSession();
  const params = useLocalSearchParams<{ challenge_id?: string }>();
  const requestedId = typeof params.challenge_id === 'string' ? params.challenge_id : undefined;

  const api = React.useMemo(() => (session ? createProofApi(session) : null), [session]);
  const recorder = useVoiceRecorder(MAX_PROOF_CLIP_SECONDS);

  const [challenge, setChallenge] = React.useState<ProofChallenge | null>(null);
  const [loading, setLoading] = React.useState(Boolean(api));
  const [submitting, setSubmitting] = React.useState(false);
  const [statusMessage, setStatusMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const [nowMs, setNowMs] = React.useState(() => Date.now());

  // Demo state when not signed into a live backend
  const [demoWordIdx, setDemoWordIdx] = React.useState(0);
  const [demoExpiresAt, setDemoExpiresAt] = React.useState(() => Date.now() + DEMO_TTL_SECONDS * 1000);
  const [demoStatus, setDemoStatus] = React.useState<'pending' | 'verified' | 'escalated'>('pending');
  const [demoRecording, setDemoRecording] = React.useState(false);
  const [demoClipSeconds, setDemoClipSeconds] = React.useState(0);
  const demoRecStartRef = React.useRef<number | null>(null);

  const loadLiveChallenge = React.useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError('');
    try {
      const res = requestedId
        ? await api.getChallengeById(requestedId)
        : await api.getLatestChallenge();
      setChallenge(res.challenge);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load proof challenge.');
    } finally {
      setLoading(false);
    }
  }, [api, requestedId]);

  React.useEffect(() => {
    if (!api) {
      setLoading(false);
      return;
    }
    void loadLiveChallenge();
  }, [api, loadLiveChallenge]);

  // 1-second live countdown ticker
  React.useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Poll server if pending and timer expires so escalated state renders promptly
  React.useEffect(() => {
    if (!api || !challenge) return;
    if (challenge.status !== 'pending' && challenge.status !== 'word_mismatch') return;
    const expiresMs = Date.parse(challenge.expires_at);
    if (Number.isFinite(expiresMs) && nowMs >= expiresMs) {
      void loadLiveChallenge();
    }
  }, [api, challenge, loadLiveChallenge, nowMs]);

  // Demo timer escalation at 0 s
  React.useEffect(() => {
    if (api) return;
    if (demoStatus === 'pending' && nowMs >= demoExpiresAt) {
      setDemoStatus('escalated');
    }
  }, [api, demoExpiresAt, demoStatus, nowMs]);

  React.useEffect(() => {
    if (api || !demoRecording) return;
    const id = setInterval(() => {
      if (!demoRecStartRef.current) return;
      const elapsed = Math.min(
        MAX_PROOF_CLIP_SECONDS,
        Math.max(1, Math.round((Date.now() - demoRecStartRef.current) / 1000)),
      );
      setDemoClipSeconds(elapsed);
    }, 300);
    return () => clearInterval(id);
  }, [api, demoRecording]);

  const activeWord = api ? challenge?.word_token ?? null : DEMO_PROOF_WORDS[demoWordIdx]!;
  const activeStatus = api ? challenge?.status ?? 'none' : demoStatus;
  const expiresMs = api
    ? challenge
      ? Date.parse(challenge.expires_at)
      : 0
    : demoExpiresAt;
  const secondsLeft =
    activeStatus === 'pending' || activeStatus === 'word_mismatch'
      ? Math.max(0, Math.ceil((expiresMs - nowMs) / 1000))
      : 0;

  const handleToggleRecord = async () => {
    setError('');
    setStatusMessage('');
    if (!api) {
      if (demoRecording) {
        demoRecStartRef.current = null;
        setDemoRecording(false);
      } else {
        demoRecStartRef.current = Date.now();
        setDemoClipSeconds(1);
        setDemoRecording(true);
      }
      return;
    }

    if (recorder.recording) {
      await recorder.stopRecording();
    } else {
      await recorder.startRecording();
    }
  };

  const handleSendAnswer = async () => {
    setError('');
    setStatusMessage('');

    if (!api) {
      setDemoStatus('verified');
      setStatusMessage(`Verified "${activeWord}"! Maa hears your voice with a fresh timestamp.`);
      return;
    }

    if (!challenge) return;
    const clip = recorder.recording ? await recorder.stopRecording() : recorder.clip;
    if (!clip) {
      setError('Record a short voice clip saying the word first.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.uploadAndAnswer(challenge, clip);
      setChallenge(res.challenge);
      if (res.verified) {
        setStatusMessage('Verified! Maa can hear your clip with a fresh timestamp.');
      } else if (res.retry_allowed) {
        setError(`Could not clearly hear "${challenge.word_token}". Please say it again before time runs out.`);
      } else {
        setError('Time expired before the word could be verified.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to verify proof clip.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetDemo = () => {
    setDemoWordIdx((i) => (i + 1) % DEMO_PROOF_WORDS.length);
    setDemoExpiresAt(Date.now() + DEMO_TTL_SECONDS * 1000);
    setDemoStatus('pending');
    setDemoRecording(false);
    setDemoClipSeconds(0);
    setStatusMessage('');
    setError('');
  };

  const canAnswer =
    activeWord !== null &&
    (activeStatus === 'pending' || activeStatus === 'word_mismatch') &&
    secondsLeft > 0;

  return (
    <Screen>
      <TopBar
        title="Fresh proof of life"
        right={
          api ? (
            <Tap
              onPress={() => void loadLiveChallenge()}
              className="h-11 w-11 items-center justify-center rounded-full bg-sand">
              <Icon as={RefreshCw} size={18} className="text-ink-2" />
            </Tap>
          ) : (
            <Tap
              onPress={handleResetDemo}
              className="rounded-full bg-sand px-3 py-2">
              <T v="small" className="font-jk-semibold text-ink">
                New word
              </T>
            </Tap>
          )
        }
      />

      <Pop>
        {loading ? (
          <Card tone="sand">
            <T v="body">Checking if Maa asked for a fresh voice check…</T>
          </Card>
        ) : !activeWord ? (
          <Card tone="sand">
            <T v="h2">No active check right now</T>
            <T v="body" className="mt-2">
              When Maa asks &ldquo;Riya theek hai?&rdquo;, Sahaj picks a fresh word here for you to say aloud.
            </T>
            {api ? (
              <Btn
                label="Refresh"
                icon={RefreshCw}
                kind="soft"
                className="mt-4"
                onPress={() => void loadLiveChallenge()}
              />
            ) : null}
          </Card>
        ) : (
          <>
            <Card tone="brand">
              <View className="flex-row items-center justify-between">
                <T v="label" className="text-brand-ink">
                  Sahaj picked this word right now
                </T>
                <View className="flex-row items-center rounded-full bg-white px-3 py-1">
                  <Icon as={Clock} size={14} className="mr-1.5 text-brand-ink" />
                  <T v="small" className="font-jk-bold text-brand-ink">
                    {secondsLeft}s
                  </T>
                </View>
              </View>

              <T v="display" className="mt-4 text-center text-brand-deep">
                Bolo: {activeWord}
              </T>
              <T v="body" className="mt-3 text-center text-ink">
                Say: &ldquo;Maa, main theek hoon — {activeWord}&rdquo;
              </T>
            </Card>

            {activeStatus === 'verified' ? (
              <Card tone="ok" className="mt-5">
                <View className="flex-row items-center">
                  <Icon as={CheckCheck} size={22} className="mr-2.5 text-ok-ink" />
                  <T v="h2" className="text-ok-ink">
                    Verified with fresh stamp
                  </T>
                </View>
                <T v="body" className="mt-2 text-ink">
                  {challenge?.freshness_stamp_hi ?? 'Riya ne abhi ye kaha.'}
                </T>
              </Card>
            ) : activeStatus === 'escalated' || activeStatus === 'expired' ? (
              <Card tone="watch" className="mt-5">
                <View className="flex-row items-center">
                  <Icon as={ShieldAlert} size={22} className="mr-2.5 text-watch-ink" />
                  <T v="h2" className="text-watch-ink">
                    60 s passed — local circle notified
                  </T>
                </View>
                <T v="body" className="mt-2 text-ink">
                  {challenge?.escalation_message_hi ??
                    'Riya se abhi baat nahi hui, Priya unke paas ja rahi hai. Paise bilkul mat bhejiye.'}
                </T>
              </Card>
            ) : null}

            {canAnswer ? (
              <Card className="mt-5">
                <T v="h3">Record your voice (max 30 s)</T>
                <T v="small" className="mt-1">
                  Saaras checks that &ldquo;{activeWord}&rdquo; is in your clip before sending to Maa.
                </T>

                <View className="mt-4 items-center">
                  <Tap
                    onPress={() => void handleToggleRecord()}
                    className={`h-24 w-24 items-center justify-center rounded-full ${
                      (api ? recorder.recording : demoRecording) ? 'bg-danger' : 'bg-brand'
                    }`}>
                    <Icon
                      as={(api ? recorder.recording : demoRecording) ? Square : Mic}
                      size={32}
                      className="text-white"
                    />
                  </Tap>
                  <T v="num" className="mt-3">
                    0:{String(api ? recorder.secs : demoClipSeconds).padStart(2, '0')}
                  </T>
                </View>

                {(api ? recorder.recording : demoRecording) ? (
                  <View className="mt-3">
                    <Waveform
                      progress={0.65}
                      seed={api ? recorder.seed : 7}
                      color="bg-brand"
                      track="bg-brand/20"
                    />
                  </View>
                ) : null}

                {((api && recorder.clip) || (!api && demoClipSeconds > 0 && !demoRecording)) ? (
                  <View className="mt-4">
                    <ClipPlayer
                      seconds={api ? recorder.clip?.durationS ?? 4 : demoClipSeconds}
                      tone="brand"
                      label={`Ready to verify (${activeWord})`}
                    />
                  </View>
                ) : null}

                <Btn
                  label={submitting ? 'Verifying with Saaras…' : 'Send to Maa'}
                  icon={Send}
                  kind="teal"
                  size="lg"
                  className="mt-5"
                  disabled={
                    submitting ||
                    (api ? !recorder.clip && !recorder.recording : demoClipSeconds === 0)
                  }
                  onPress={() => void handleSendAnswer()}
                />
              </Card>
            ) : null}
          </>
        )}
      </Pop>

      {statusMessage ? <Notice tone="teal">{statusMessage}</Notice> : null}
      {error ? (
        <Card tone="danger" className="mt-4">
          <T v="small" style={{ color: palette.danger }}>
            {error}
          </T>
        </Card>
      ) : null}
      {recorder.error ? (
        <Card tone="danger" className="mt-4">
          <T v="small" style={{ color: palette.danger }}>
            {recorder.error}
          </T>
        </Card>
      ) : null}
    </Screen>
  );
}
