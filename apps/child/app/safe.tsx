import { Core2Gate } from '@/components/core2/common';
import { LiveReassurance } from '@/components/core2/reassurance';
import { Icon } from '@/components/ui/icon';
import {
  Btn,
  Card,
  ClipPlayer,
  Face,
  Field,
  Notice,
  Pop,
  Screen,
  T,
  Tap,
  TopBar,
  palette,
  Waveform,
} from '@/components/sahaj/ui';
import { useCore1Api } from '@/lib/core1';
import { circle, family, safeClip, markSafe, useDemo, watch } from '@/lib/demo';
import { useVoiceRecorder } from '@/lib/voice-recorder';
import { CheckCheck, Mic, Send } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

function DemoSafe() {
  const demo = useDemo();
  const api = useCore1Api();
  const recorder = useVoiceRecorder(safeClip.maxSeconds);

  const [stage, setStage] = React.useState<'idle' | 'recording' | 'sending' | 'heard'>(
    !api && demo.safeSent ? 'heard' : 'idle'
  );
  const [seconds, setSeconds] = React.useState(0);
  const [error, setError] = React.useState('');
  const [recipientIdInput, setRecipientIdInput] = React.useState('');
  const [liveVoicePostId, setLiveVoicePostId] = React.useState<string | null>(null);
  const started = React.useRef<number | null>(null);
  const pulse = useSharedValue(1);
  const ring = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
    opacity: 2 - pulse.value,
  }));
  const friend = circle.find((person) => person.id === watch.friendId)!;

  React.useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .voiceFeed()
      .then((feed) => {
        if (cancelled) return;
        for (const item of feed.items) {
          if (item.from_person_id !== feed.caller_person_id) {
            setRecipientIdInput((prev) => prev || item.from_person_id);
            break;
          }
          if (item.to_person_id !== feed.caller_person_id) {
            setRecipientIdInput((prev) => prev || item.to_person_id);
            break;
          }
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  React.useEffect(() => {
    started.current = null;
    setStage(!api && demo.safeSent ? 'heard' : 'idle');
    setSeconds(0);
    setError('');
    setLiveVoicePostId(null);
    pulse.value = 1;
  }, [api, demo.revision]);

  const sendLiveVoiceSafe = React.useCallback(
    async (recorded: NonNullable<typeof recorder.clip>) => {
      if (!api) return;
      try {
        let recipientPersonId = recipientIdInput.trim();
        let callerPersonId: string | undefined;
        const feedBefore = await api.voiceFeed();
        callerPersonId = feedBefore.caller_person_id;
        if (!recipientPersonId) {
          for (const item of feedBefore.items) {
            if (item.from_person_id !== callerPersonId) {
              recipientPersonId = item.from_person_id;
              break;
            }
            if (item.to_person_id !== callerPersonId) {
              recipientPersonId = item.to_person_id;
              break;
            }
          }
        }
        if (!recipientPersonId) {
          throw new Error('Recipient person ID (Maa) is required.');
        }

        const uploaded = await api.uploadVoiceMessage({
          recipientPersonId,
          fileUri: recorded.fileUri,
          blob: recorded.blob,
          contentType: recorded.contentType,
          filename: recorded.filename,
          durationS: recorded.durationS,
          consentGranted: true,
        });

        await api.sendVoiceMessage({
          recipientPersonId,
          mediaObjectPath: uploaded.media_object_path,
          consentId: uploaded.consent_id,
        });

        const feedAfter = await api.voiceFeed();
        const createdPost =
          feedAfter.items.find(
            (item) =>
              item.direction === 'outbound' &&
              item.to_person_id === recipientPersonId &&
              !feedBefore.items.some((prev) => prev.id === item.id)
          ) ??
          feedAfter.items.find(
            (item) => item.direction === 'outbound' && item.to_person_id === recipientPersonId
          );

        if (!createdPost) {
          throw new Error('Voice post queued, but voice_post_id could not be resolved yet.');
        }

        await api.sendCore2Reassurance({
          kind: 'im_safe',
          voicePostId: createdPost.id,
          recipientPersonIds: [recipientPersonId],
        });

        setLiveVoicePostId(createdPost.id);
        setStage('heard');
      } catch (err) {
        setStage('idle');
        setError(err instanceof Error ? err.message : 'Unable to send Main safe hoon voice check.');
      }
    },
    [api, recipientIdInput]
  );

  const finish = React.useCallback(async () => {
    if (started.current === null) return;
    const length = Math.min(safeClip.maxSeconds, Math.floor((Date.now() - started.current) / 1000));
    started.current = null;
    pulse.value = withSpring(1);
    setSeconds(length);

    if (api) {
      const clip = await recorder.stopRecording();
      if (!clip || length < 1) {
        setStage('idle');
        setError('Hold to record at least 1–5 seconds of your voice.');
        return;
      }
      setStage('sending');
      await sendLiveVoiceSafe(clip);
      return;
    }

    if (length < safeClip.minSeconds) {
      setStage('idle');
      setError('Hold for 3–5 seconds, or use your saved clip.');
      return;
    }
    setStage('sending');
  }, [api, pulse, recorder, sendLiveVoiceSafe]);

  React.useEffect(() => {
    if (stage !== 'recording') return;
    const timer = setInterval(() => {
      if (started.current === null) return;
      const length = Math.floor((Date.now() - started.current) / 1000);
      setSeconds(length);
      if (length >= safeClip.maxSeconds) {
        void finish();
      }
    }, 100);
    return () => clearInterval(timer);
  }, [stage, finish]);

  React.useEffect(() => {
    if (api || stage !== 'sending') return;
    const timer = setTimeout(() => {
      setStage('heard');
      markSafe();
    }, 2200);
    return () => clearTimeout(timer);
  }, [api, stage]);
  return (
    <Screen>
      <TopBar title="I’m safe" />
      <Pop>
        <T v="title">Main safe hoon.</T>
        <T v="body" className="mt-2">
          Let Maa hear it in your voice.
        </T>
      </Pop>
      {stage === 'heard' ? (
        <Pop>
          <Card tone="teal" className="mt-6">
            <View className="h-14 w-14 items-center justify-center rounded-full bg-teal">
              <Icon as={CheckCheck} size={28} className="text-white" />
            </View>
            <T v="title" className="mt-5 text-teal-deep">
              Maa heard your voice ✓✓
            </T>
            <T v="body" className="mt-3 text-teal-deep">
              Your circle was told you’re safe.
            </T>
            <View className="mt-5 flex-row items-center">
              <Face name={friend.name} />
              <View className="ml-3 flex-1">
                <T v="h3">{friend.name} knows too</T>
                <T v="small">Your safety contact · any open watch is closed</T>
              </View>
            </View>
          </Card>
          {api ? (
            <Notice tone="teal">
              Sent live reassurance with voice post {liveVoicePostId ?? ''} — Maa’s real clip is queued for delivery.
            </Notice>
          ) : (
            <Notice tone="sand">Demo delivery · no audio or notification was sent.</Notice>
          )}
          <Btn
            label="Send another"
            kind="ghost"
            className="mt-5"
            onPress={() => {
              setStage('idle');
              setSeconds(0);
            }}
          />
        </Pop>
      ) : stage === 'sending' ? (
        <Pop>
          <Card tone="teal" className="mt-8 items-center">
            <Icon as={Send} size={30} className="text-teal-ink" />
            <T v="h2" className="mt-4">
              On its way to Maa
            </T>
            <T v="small" className="mt-2">
              {api ? 'Uploading recorded voice' : 'Demo clip'} · {seconds} seconds
            </T>
            <T v="body" className="mt-3 text-center">
              Sahaj is playing your voice on a call.
            </T>
          </Card>
        </Pop>
      ) : (
        <>
          <Pop delay={80}>
            <Card className="mt-6 items-center">
              <T v="label">Your voice, her reassurance</T>
              <View className="mt-6 h-12 w-full flex-row items-center">
                {stage === 'recording' ? (
                  <Waveform seed={seconds + 5} progress={1} n={32} height={40} />
                ) : (
                  <View className="h-px flex-1 bg-sand-line" />
                )}
              </View>
              <T v="num" className="mt-4">
                0:{String(seconds).padStart(2, '0')}
              </T>
              <T v="small" className="mt-1">
                {stage === 'recording'
                  ? 'Recording · release to send'
                  : 'Hold to record · 3–5 seconds'}
              </T>
              <View className="mt-4 h-40 w-40 items-center justify-center">
                <Animated.View
                  style={[
                    ring,
                    {
                      position: 'absolute',
                      width: 112,
                      height: 112,
                      borderRadius: 56,
                      backgroundColor: palette.brandSoft,
                    },
                  ]}
                />
                <Tap
                  accessibilityLabel="Hold to record a safety message"
                  onPressIn={() => {
                    setError('');
                    setSeconds(0);
                    started.current = Date.now();
                    setStage('recording');
                    pulse.value = withRepeat(withTiming(1.35, { duration: 900 }), -1, true);
                    if (api) {
                      void recorder.startRecording();
                    }
                  }}
                  onPressOut={() => {
                    void finish();
                  }}
                  haptic="medium"
                  className="h-28 w-28 items-center justify-center rounded-full bg-brand">
                  <Icon as={Mic} size={38} className="text-white" />
                </Tap>
              </View>
              <T v="small" className="text-center">
                Stops and sends automatically at 5 seconds
              </T>
            </Card>
          </Pop>
          {api && !recipientIdInput ? (
            <Card className="mt-4">
              <Field
                label="Maa recipient ID (UUID)"
                value={recipientIdInput}
                onChangeText={setRecipientIdInput}
                placeholder="c2000000-0000-4000-8000-000000000002"
                autoCapitalize="none"
              />
            </Card>
          ) : null}
          {error || recorder.error ? <Notice tone="sand">{error || recorder.error}</Notice> : null}
          {!api ? (
            <>
              <Card tone="brand" className="mt-4">
                <T v="label">Or use your saved clip</T>
                <T v="h2" className="mt-3 text-brand-deep">
                  {safeClip.quote}
                </T>
                <T v="small" className="mt-2">
                  {safeClip.translation}
                </T>
                <View className="mt-4">
                  <ClipPlayer seconds={safeClip.seconds} seed={19} />
                </View>
                <Btn
                  label="Use saved"
                  className="mt-4"
                  onPress={() => {
                    setSeconds(safeClip.seconds);
                    setStage('sending');
                    setError('');
                  }}
                />
              </Card>
              <T v="small" className="mt-4 text-center">
                Demo recorder · previews the flow without microphone access.
              </T>
            </>
          ) : null}
        </>
      )}
      <T v="small" className="mt-6 text-center">
        A familiar voice on {family.parent.called}’s {family.parent.phone}.
      </T>
    </Screen>
  );
}

export default function Safe() {
  return <Core2Gate title="safeTitle" demo={<DemoSafe />}><LiveReassurance /></Core2Gate>;
}
