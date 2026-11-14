import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
} from 'expo-audio';
import * as React from 'react';
import { Platform } from 'react-native';

export const MAX_VOICE_CLIP_SECONDS = 60;

export interface RecordedVoiceClip {
  fileUri?: string;
  blob?: Blob;
  contentType: string;
  filename: string;
  durationS: number;
}

function pickWebAudioMime(): { mimeType: string; ext: 'ogg' | 'm4a' } {
  if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
    if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') || MediaRecorder.isTypeSupported('audio/ogg')) {
      return { mimeType: 'audio/ogg', ext: 'ogg' };
    }
    if (MediaRecorder.isTypeSupported('audio/mp4')) {
      return { mimeType: 'audio/mp4', ext: 'm4a' };
    }
  }
  return { mimeType: 'audio/mp4', ext: 'm4a' };
}

export function useVoiceRecorder(maxSeconds = MAX_VOICE_CLIP_SECONDS) {
  const nativeRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = React.useState(false);
  const [secs, setSecs] = React.useState(0);
  const [seed, setSeed] = React.useState(5);
  const [clip, setClip] = React.useState<RecordedVoiceClip | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const startedAtRef = React.useRef<number | null>(null);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const mediaStreamRef = React.useRef<MediaStream | null>(null);
  const webChunksRef = React.useRef<Blob[]>([]);
  const webMimeRef = React.useRef<{ mimeType: string; ext: 'ogg' | 'm4a' }>({
    mimeType: 'audio/mp4',
    ext: 'm4a',
  });
  const stoppingRef = React.useRef(false);

  const stopRecording = React.useCallback(async (): Promise<RecordedVoiceClip | null> => {
    if (stoppingRef.current) return null;
    stoppingRef.current = true;
    const elapsedMs = startedAtRef.current ? Date.now() - startedAtRef.current : secs * 1000;
    const durationS = Math.min(maxSeconds, Math.max(1, Math.round(elapsedMs / 1000)));
    startedAtRef.current = null;
    setRecording(false);

    try {
      if (Platform.OS === 'web' && mediaRecorderRef.current) {
        const rec = mediaRecorderRef.current;
        mediaRecorderRef.current = null;
        const { mimeType, ext } = webMimeRef.current;
        const finished = await new Promise<RecordedVoiceClip | null>((resolve) => {
          rec.onstop = () => {
            mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
            mediaStreamRef.current = null;
            const blob = new Blob(webChunksRef.current, { type: mimeType });
            webChunksRef.current = [];
            if (blob.size === 0) {
              resolve(null);
              return;
            }
            resolve({
              blob,
              contentType: mimeType,
              filename: `voice-${Date.now()}.${ext}`,
              durationS,
            });
          };
          if (rec.state !== 'inactive') {
            rec.stop();
          } else {
            resolve(null);
          }
        });
        setClip(finished);
        if (!finished) setError('Empty recording; please record again.');
        return finished;
      }

      await nativeRecorder.stop();
      const uri = nativeRecorder.uri;
      if (!uri) {
        setError('Could not save recorded audio file.');
        return null;
      }
      const lower = uri.toLowerCase();
      const contentType = lower.endsWith('.ogg') ? 'audio/ogg' : 'audio/mp4';
      const ext = lower.endsWith('.ogg') ? 'ogg' : 'm4a';
      const nextClip: RecordedVoiceClip = {
        fileUri: uri,
        contentType,
        filename: `voice-${Date.now()}.${ext}`,
        durationS,
      };
      setClip(nextClip);
      return nextClip;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to finish recording.');
      return null;
    } finally {
      stoppingRef.current = false;
    }
  }, [maxSeconds, nativeRecorder, secs]);

  React.useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => {
      setSecs((prev) => {
        const next = prev + 1;
        setSeed((x) => x + 1);
        if (next >= maxSeconds) {
          void stopRecording();
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [recording, maxSeconds, stopRecording]);

  React.useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const startRecording = React.useCallback(async () => {
    setError(null);
    setClip(null);
    setSecs(0);

    try {
      if (
        Platform.OS === 'web' &&
        typeof navigator !== 'undefined' &&
        navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== 'undefined'
      ) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const picked = pickWebAudioMime();
        webMimeRef.current = picked;
        webChunksRef.current = [];
        const rec = MediaRecorder.isTypeSupported(picked.mimeType)
          ? new MediaRecorder(stream, { mimeType: picked.mimeType })
          : new MediaRecorder(stream);
        rec.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) {
            webChunksRef.current.push(ev.data);
          }
        };
        mediaStreamRef.current = stream;
        mediaRecorderRef.current = rec;
        rec.start(250);
        startedAtRef.current = Date.now();
        setRecording(true);
        return;
      }

      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setError('Microphone permission is required to record voice messages.');
        return;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      await nativeRecorder.prepareToRecordAsync();
      nativeRecorder.record();
      startedAtRef.current = Date.now();
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to access microphone.');
      setRecording(false);
    }
  }, [nativeRecorder]);

  return {
    recording,
    secs,
    seed,
    clip,
    error,
    startRecording,
    stopRecording,
    clearClip: () => setClip(null),
  };
}

export function useVoicePlayer() {
  const nativePlayer = useAudioPlayer(null);
  const nativeStatus = useAudioPlayerStatus(nativePlayer);
  const webAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = React.useState<string | null>(null);
  const [playError, setPlayError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (Platform.OS !== 'web' && playingId && nativeStatus.didJustFinish) {
      setPlayingId(null);
    }
  }, [playingId, nativeStatus.didJustFinish]);

  React.useEffect(() => {
    return () => {
      webAudioRef.current?.pause();
    };
  }, []);

  const stop = React.useCallback(() => {
    if (Platform.OS === 'web') {
      webAudioRef.current?.pause();
      webAudioRef.current = null;
    } else {
      nativePlayer.pause();
    }
    setPlayingId(null);
  }, [nativePlayer]);

  const playUrl = React.useCallback(
    async (id: string, signedUrl: string) => {
      setPlayError(null);
      if (playingId === id) {
        stop();
        return false;
      }
      stop();

      if (Platform.OS === 'web' && typeof Audio !== 'undefined') {
        const audio = new Audio(signedUrl);
        audio.onended = () => {
          setPlayingId(null);
          webAudioRef.current = null;
        };
        audio.onerror = () => {
          setPlayingId(null);
          webAudioRef.current = null;
          setPlayError('Audio playback failed for the signed recording URL.');
        };
        await audio.play();
        webAudioRef.current = audio;
        setPlayingId(id);
        return true;
      }

      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      });
      nativePlayer.replace({ uri: signedUrl });
      nativePlayer.play();
      setPlayingId(id);
      return true;
    },
    [nativePlayer, playingId, stop]
  );

  return {
    playingId,
    playError,
    playUrl,
    stop,
  };
}
