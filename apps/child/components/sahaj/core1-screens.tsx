import * as React from 'react';
import { Linking, Platform, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  BellRing,
  CalendarClock,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  FileText,
  Mic,
  Pause,
  Phone,
  PhoneMissed,
  Pill,
  Play,
  Radio,
  RefreshCw,
  Siren,
  Square,
  X,
} from 'lucide-react-native';
import { Icon } from '@/components/ui/icon';
import {
  Btn,
  Card,
  Chip,
  Face,
  Field,
  Hero,
  IconTile,
  LevelPill,
  LiveDot,
  Notice,
  Pop,
  Screen,
  Section,
  T,
  Tap,
  TopBar,
  Waveform,
} from '@/components/sahaj/ui';
import {
  CORE1_STRINGS,
  useCore1Api,
  useCore1Lang,
  type CheckInsFeedResponse,
  type Core1Api,
  type IncidentFeedItem,
  type IncidentsFeedResponse,
  type RefillFeedItem,
  type RefillsFeedResponse,
  type VoiceFeedItem,
  type VoiceFeedResponse,
} from '@/lib/core1';
import { ApiError } from '@/lib/api';
import type { Level } from '@/lib/demo';
import { cn } from '@/lib/utils';
import { useVoicePlayer, useVoiceRecorder } from '@/lib/voice-recorder';
import { LiveHeardBadge } from './live-heard-badge';

function formatInr(amountMinor: number): string {
  const rupees = amountMinor / 100;
  return Number.isInteger(rupees) ? `₹${rupees}` : `₹${rupees.toFixed(2)}`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatElapsed(fromIso: string, nowMs: number): string {
  const start = Date.parse(fromIso);
  if (!Number.isFinite(start)) return '00:00';
  const totalSec = Math.max(0, Math.floor((nowMs - start) / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function incidentLevel(item: IncidentFeedItem): Level {
  if (item.state === 'done' || item.state === 'closed') return 'green';
  if (item.severity === 'critical' || item.severity === 'urgent' || item.state === 'escalated') {
    return 'red';
  }
  return 'yellow';
}

function useLiveClock(active: boolean): number {
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}

function useCore1Query<T>(
  load: (api: Core1Api, signal: AbortSignal) => Promise<T>
): {
  data: T | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
} {
  const api = useCore1Api();
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState<boolean>(Boolean(api));
  const [error, setError] = React.useState<string | null>(null);
  const [rev, setRev] = React.useReducer((n: number) => n + 1, 0);

  useFocusEffect(
    React.useCallback(() => {
      if (!api) {
        setLoading(false);
        setData(null);
        setError(null);
        return;
      }
      let cancelled = false;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      setLoading(true);
      setError(null);
      load(api, controller.signal)
        .then((res) => {
          if (!cancelled) {
            setData(res);
            setError(null);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          const msg =
            err instanceof ApiError && err.status === 401
              ? 'Session expired. Sign in again.'
              : err instanceof Error
                ? err.message
                : 'Could not reach server.';
          setError(msg);
        })
        .finally(() => {
          clearTimeout(timeout);
          if (!cancelled) setLoading(false);
        });

      return () => {
        cancelled = true;
        clearTimeout(timeout);
        controller.abort();
      };
    }, [api, load, rev])
  );

  return { data, loading, error, retry: setRev };
}

export function LangToggle() {
  const [lang, setLang] = useCore1Lang();
  return (
    <Tap
      accessibilityLabel="Switch language between English and Hindi"
      onPress={() => setLang(lang === 'en' ? 'hi' : 'en')}
      className="rounded-full border border-sand-line bg-white px-3 py-1.5">
      <T v="small" className="font-jk-bold text-ink">
        {lang === 'en' ? 'EN · हिंदी' : 'हिंदी · EN'}
      </T>
    </Tap>
  );
}

function ErrorRetryCard({
  error,
  onRetry,
  retryLabel,
}: {
  error: string;
  onRetry: () => void;
  retryLabel: string;
}) {
  return (
    <Card tone="danger" className="mt-3">
      <T v="bodyStrong" className="text-danger-ink">
        {error}
      </T>
      <Btn label={retryLabel} icon={RefreshCw} kind="dark" className="mt-3" onPress={onRetry} />
    </Card>
  );
}

export function MissedCallNudgeCard({
  nudges,
  onOpenDay,
}: {
  nudges: CheckInsFeedResponse['missed_call_nudges'];
  onOpenDay?: () => void;
}) {
  const [lang] = useCore1Lang();
  const s = CORE1_STRINGS[lang];
  if (nudges.length === 0) return null;
  const latest = nudges[0];
  return (
    <Pop>
      <Card tone="brand" className="mt-4">
        <View className="flex-row items-start">
          <IconTile icon={PhoneMissed} tone="brand" size={42} />
          <View className="ml-3 flex-1">
            <T v="label" className="text-brand-ink">
              {s.missedCallSub}
            </T>
            <T v="h3" className="mt-1">
              {s.missedCallTitle}
            </T>
            <T v="small" className="mt-1 text-ink-2">
              {latest.person_display_name} · {formatDateTime(latest.scheduled_at)} ({latest.status})
            </T>
          </View>
        </View>
        <View className="mt-4 flex-row gap-2">
          <Btn
            label={s.callMaa}
            icon={Phone}
            className="flex-1"
            onPress={() => (onOpenDay ? onOpenDay() : router.push('/maa-day'))}
          />
          {onOpenDay ? null : (
            <Btn
              label={s.openMaasDay}
              kind="ghost"
              className="flex-1"
              onPress={() => router.push('/maa-day')}
            />
          )}
        </View>
      </Card>
    </Pop>
  );
}

const loadCheckins = (api: Core1Api, signal: AbortSignal) => api.checkInsFeed(signal);
const loadIncidents = (api: Core1Api, signal: AbortSignal) => api.incidentsFeed(signal);
const loadVoice = (api: Core1Api, signal: AbortSignal) => api.voiceFeed(signal);
const loadRefills = (api: Core1Api, signal: AbortSignal) => api.refillsFeed(signal);

export function LiveCore1HomeSection() {
  const [lang] = useCore1Lang();
  const s = CORE1_STRINGS[lang];
  const checkins = useCore1Query<CheckInsFeedResponse>(loadCheckins);
  const incidents = useCore1Query<IncidentsFeedResponse>(loadIncidents);
  const voice = useCore1Query<VoiceFeedResponse>(loadVoice);
  const refills = useCore1Query<RefillsFeedResponse>(loadRefills);

  const openIncident = incidents.data?.items.find(
    (i) => i.state !== 'done' && i.state !== 'closed'
  );
  const nowMs = useLiveClock(Boolean(openIncident));
  const latestCheckin = checkins.data?.items[0] ?? null;
  const pendingRefills =
    refills.data?.items.filter((r) => r.state === 'pending').length ?? 0;
  const inboundVoice =
    voice.data?.items.filter((v) => v.direction === 'inbound').length ?? 0;

  return (
    <Section title={s.maasDayTitle}>
      <View className="mb-3 flex-row items-center justify-between">
        <T v="small">{s.maasDaySub}</T>
        <LangToggle />
      </View>

      {openIncident ? (
        <Tap onPress={() => router.push('/incident')} className="mb-3">
          <View className="flex-row items-center rounded-2xl bg-danger px-4 py-3.5">
            <View className="h-9 w-9 items-center justify-center rounded-full bg-white/20">
              <Icon as={Siren} size={18} className="text-white" />
            </View>
            <View className="ml-3 flex-1">
              <T v="bodyStrong" className="text-white">
                {openIncident.subject_display_name} · {openIncident.state}
              </T>
              <T v="small" className="text-white/85">
                {openIncident.responder
                  ? `${openIncident.responder.display_name} (${openIncident.responder.state})`
                  : 'Waiting for responder'}{' '}
                · {formatElapsed(openIncident.created_at, nowMs)}
              </T>
            </View>
            <Icon as={ChevronRight} size={20} className="text-white" />
          </View>
        </Tap>
      ) : null}

      {checkins.error ? (
        <ErrorRetryCard error={checkins.error} onRetry={checkins.retry} retryLabel={s.retry} />
      ) : null}

      {checkins.data?.missed_call_nudges?.length ? (
        <MissedCallNudgeCard nudges={checkins.data.missed_call_nudges} />
      ) : null}

      <Tap onPress={() => router.push('/maa-day')} className="mt-3">
        <Hero tone="brand">
          <View className="flex-row items-center justify-between">
            <T v="label" className="text-brand-ink">
              {s.todayCheckin}
            </T>
            {latestCheckin ? (
              <LevelPill
                level={
                  latestCheckin.state === 'completed'
                    ? 'green'
                    : latestCheckin.state === 'failed'
                      ? 'red'
                      : 'yellow'
                }
                label={latestCheckin.state}
              />
            ) : null}
          </View>
          {checkins.loading && !checkins.data ? (
            <T v="body" className="mt-2">
              {s.loading}
            </T>
          ) : (
            <>
              <T v="h2" className="mt-2">
                {latestCheckin ? latestCheckin.short_summary : s.noCheckins}
              </T>
              <T v="small" className="mt-1 text-ink-2">
                {s.nextCheckin}:{' '}
                {checkins.data?.next_checkin
                  ? formatDateTime(checkins.data.next_checkin.scheduled_for)
                  : s.noNextCheckin}
              </T>
            </>
          )}
        </Hero>
      </Tap>

      <View className="mt-3 flex-row gap-3">
        <Tap onPress={() => router.push('/voice')} className="flex-1">
          <Card className="p-4">
            <IconTile icon={Mic} tone="teal" size={38} />
            <T v="h3" className="mt-3">
              {s.voiceTitle}
            </T>
            <T v="small" className="mt-0.5">
              {voice.loading && !voice.data
                ? s.loading
                : `${inboundVoice} replies`}
            </T>
          </Card>
        </Tap>
        <Tap onPress={() => router.push('/refills')} className="flex-1">
          <Card className="p-4">
            <IconTile icon={Pill} tone="watch" size={38} />
            <T v="h3" className="mt-3">
              {s.refillsTitle}
            </T>
            <T v="small" className="mt-0.5">
              {refills.loading && !refills.data
                ? s.loading
                : `${pendingRefills} pending`}
            </T>
          </Card>
        </Tap>
      </View>

      <View className="mt-3 flex-row gap-3">
        <Btn
          label={s.urgentTitle}
          icon={BellRing}
          kind="ghost"
          className="flex-1"
          onPress={() => router.push('/incident')}
        />
        <Btn
          label={s.openMaasDay}
          icon={CalendarClock}
          kind="soft"
          className="flex-1"
          onPress={() => router.push('/maa-day')}
        />
      </View>
    </Section>
  );
}

export function LiveMaasDayScreen() {
  const [lang] = useCore1Lang();
  const s = CORE1_STRINGS[lang];
  const api = useCore1Api();
  const checkins = useCore1Query<CheckInsFeedResponse>(loadCheckins);
  const [reportPending, setReportPending] = React.useState(false);
  const [reportResult, setReportResult] = React.useState<string | null>(null);
  const [reportError, setReportError] = React.useState<string | null>(null);

  const requestReport = async () => {
    if (!api || reportPending) return;
    setReportPending(true);
    setReportError(null);
    setReportResult(null);
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
      const res = await api.requestFamilyReport({
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
      });
      setReportResult(`${s.familyReportSent} (${res.status} · ${res.eventId})`);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : 'Failed to request report.');
    } finally {
      setReportPending(false);
    }
  };

  return (
    <Screen>
      <TopBar title={s.maasDayTitle} right={<LangToggle />} />
      {checkins.loading && !checkins.data ? (
        <Card>
          <T v="body">{s.loading}</T>
        </Card>
      ) : null}
      {checkins.error ? (
        <ErrorRetryCard error={checkins.error} onRetry={checkins.retry} retryLabel={s.retry} />
      ) : null}

      {checkins.data ? (
        <>
          <MissedCallNudgeCard
            nudges={checkins.data.missed_call_nudges}
            onOpenDay={checkins.retry}
          />

          <Hero tone="brand">
            <T v="label" className="text-brand-ink">
              {s.nextCheckin}
            </T>
            <T v="h2" className="mt-2">
              {checkins.data.next_checkin
                ? `${checkins.data.next_checkin.person_display_name} · ${formatDateTime(checkins.data.next_checkin.scheduled_for)}`
                : s.noNextCheckin}
            </T>
            {checkins.data.next_checkin ? (
              <T v="small" className="mt-1">
                {checkins.data.next_checkin.timezone}
              </T>
            ) : null}
          </Hero>

          <Section title={s.recentCheckins}>
            {checkins.data.items.length === 0 ? (
              <Card tone="sand">
                <T v="body">{s.noCheckins}</T>
              </Card>
            ) : (
              checkins.data.items.map((item) => (
                <Card key={item.id} className="mb-3">
                  <View className="flex-row items-center justify-between">
                    <T v="h3">{item.person_display_name}</T>
                    <LevelPill
                      level={
                        item.state === 'completed'
                          ? 'green'
                          : item.state === 'failed'
                            ? 'red'
                            : 'yellow'
                      }
                      label={item.state}
                    />
                  </View>
                  <T v="body" className="mt-2">
                    {item.short_summary}
                  </T>
                  <T v="small" className="mt-2">
                    {formatDateTime(item.scheduled_for)}
                    {item.ai_disclosed ? ' · AI disclosed' : ''}
                  </T>
                </Card>
              ))
            )}
          </Section>

          <Section title="Family report">
            <Btn
              label={reportPending ? 'Requesting…' : s.familyReportBtn}
              icon={FileText}
              onPress={reportPending ? undefined : requestReport}
              className={reportPending ? 'opacity-60' : undefined}
            />
            {reportResult ? <Notice tone="teal">{reportResult}</Notice> : null}
            {reportError ? (
              <Notice tone="brand">{reportError}</Notice>
            ) : null}
          </Section>
        </>
      ) : null}
    </Screen>
  );
}

export function LiveVoiceScreen() {
  const [lang] = useCore1Lang();
  const s = CORE1_STRINGS[lang];
  const api = useCore1Api();
  const voice = useCore1Query<VoiceFeedResponse>(loadVoice);
  const recorder = useVoiceRecorder();
  const player = useVoicePlayer();

  const [consentId, setConsentId] = React.useState('');
  const [consentGranted, setConsentGranted] = React.useState(true);
  const [recipientOverride, setRecipientOverride] = React.useState('');
  const [replyToId, setReplyToId] = React.useState<string | undefined>(undefined);
  const [sending, setSending] = React.useState(false);
  const [sendSuccess, setSendSuccess] = React.useState<string | null>(null);
  const [sendError, setSendError] = React.useState<string | null>(null);

  const [playLoadingId, setPlayLoadingId] = React.useState<string | null>(null);
  const [playMessage, setPlayMessage] = React.useState<string | null>(null);

  const inferredRecipientId = React.useMemo(() => {
    if (recipientOverride.trim()) return recipientOverride.trim();
    const callerId = voice.data?.caller_person_id;
    const items = voice.data?.items ?? [];
    for (const item of items) {
      if (item.from_person_id !== callerId) return item.from_person_id;
      if (item.to_person_id !== callerId) return item.to_person_id;
    }
    return '';
  }, [recipientOverride, voice.data]);

  const startRecording = async () => {
    setSendError(null);
    setSendSuccess(null);
    await recorder.startRecording();
  };

  const stopRecording = async () => {
    await recorder.stopRecording();
  };

  const handleSend = async () => {
    if (!api || sending) return;
    setSendError(null);
    setSendSuccess(null);

    if (!voice.data?.family_id) {
      setSendError('Family session not loaded yet. Retry loading voice messages first.');
      return;
    }
    if (!inferredRecipientId) {
      setSendError('Recipient person ID is required.');
      return;
    }
    if (!recorder.clip) {
      setSendError('Record a voice clip (up to 60 seconds) before sending.');
      return;
    }

    setSending(true);
    try {
      const uploaded = await api.uploadVoiceMessage({
        recipientPersonId: inferredRecipientId,
        fileUri: recorder.clip.fileUri,
        blob: recorder.clip.blob,
        contentType: recorder.clip.contentType,
        filename: recorder.clip.filename,
        durationS: recorder.clip.durationS,
        consentId: consentId.trim() || undefined,
        consentGranted,
      });

      const res = await api.sendVoiceMessage({
        recipientPersonId: inferredRecipientId,
        mediaObjectPath: uploaded.media_object_path,
        consentId: uploaded.consent_id,
        replyToId,
      });
      setSendSuccess(`${s.voiceSent} (${res.status} · ${res.eventId})`);
      recorder.clearClip();
      setReplyToId(undefined);
      voice.retry();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send voice message.');
    } finally {
      setSending(false);
    }
  };

  const handlePlayToggle = async (item: VoiceFeedItem) => {
    if (!api) return;
    setPlayMessage(null);

    if (player.playingId === item.id) {
      player.stop();
      return;
    }

    setPlayLoadingId(item.id);
    try {
      const media = await api.voiceMediaUrl(item.id);
      const started = await player.playUrl(item.id, media.url);
      if (started && item.direction === 'inbound' && item.state !== 'heard') {
        await api.markVoicePlayed(item.id).catch(() => undefined);
        voice.retry();
      }
    } catch (err) {
      setPlayMessage(err instanceof Error ? err.message : 'Unable to fetch signed media URL.');
    } finally {
      setPlayLoadingId(null);
    }
  };

  const recorderNote = recorder.error;
  const playingId = player.playingId;
  const activePlayMessage = playMessage ?? player.playError;

  return (
    <Screen>
      <TopBar title={s.voiceTitle} right={<LangToggle />} />
      <T v="title">{s.voiceTitle}</T>
      <T v="body" className="mt-2">
        {s.voiceSub}
      </T>

      <Card className="mt-5 items-center">
        <View className="h-12 w-full flex-row items-center px-2">
          {recorder.recording ? (
            <Waveform seed={recorder.seed} n={34} progress={1} height={40} />
          ) : (
            <View className="h-px flex-1 bg-sand-line" />
          )}
        </View>
        <T v="num" className="mt-3" style={{ fontVariant: ['tabular-nums'] }}>
          0:{String(recorder.secs).padStart(2, '0')}
        </T>
        <View className="mt-4 flex-row gap-3">
          {recorder.recording ? (
            <Btn label="Stop recording" icon={Square} kind="danger" onPress={() => void stopRecording()} />
          ) : (
            <Btn label={recorder.clip ? 'Re-record voice' : 'Record voice'} icon={Mic} onPress={() => void startRecording()} />
          )}
        </View>
        {recorder.clip ? (
          <T v="small" className="mt-2 text-teal-ink">
            Ready to upload ({recorder.clip.durationS}s · {recorder.clip.filename})
          </T>
        ) : null}
        {recorderNote ? <Notice tone="sand">{recorderNote}</Notice> : null}

        <View className="mt-2 w-full">
          {!inferredRecipientId || recipientOverride ? (
            <Field
              label="Recipient person ID (UUID)"
              value={recipientOverride}
              onChangeText={setRecipientOverride}
              placeholder="c2000000-0000-4000-8000-000000000002"
              autoCapitalize="none"
            />
          ) : (
            <T v="small" className="mt-3">
              Recipient ID: {inferredRecipientId}
            </T>
          )}
          <Field
            label="Voice consent ID (optional if active consent exists)"
            value={consentId}
            onChangeText={setConsentId}
            placeholder="Auto-checked or granted on send"
            autoCapitalize="none"
          />
          <Tap
            onPress={() => setConsentGranted((v) => !v)}
            className="mt-2 flex-row items-center gap-2 py-1"
            accessibilityLabel="Consent to share my recorded voice">
            <Chip
              label={consentGranted ? 'Recording share consent: Yes' : 'Recording share consent: No'}
              tone={consentGranted ? 'teal' : 'sand'}
            />
          </Tap>
          {replyToId ? (
            <T v="small" className="mt-2 text-teal-ink">
              Replying to message {replyToId}
            </T>
          ) : null}
          <Btn
            label={sending ? 'Uploading & sending…' : s.sendVoiceBtn}
            icon={Mic}
            kind={recorder.clip ? 'primary' : 'dark'}
            className={cn('mt-4', sending && 'opacity-60')}
            onPress={sending ? undefined : () => void handleSend()}
          />
          {sendSuccess ? <Notice tone="teal">{sendSuccess}</Notice> : null}
          {sendError ? <Notice tone="brand">{sendError}</Notice> : null}
        </View>
      </Card>

      <Section title={s.voiceListTitle}>
        {voice.loading && !voice.data ? (
          <Card>
            <T v="body">{s.loading}</T>
          </Card>
        ) : null}
        {voice.error ? (
          <ErrorRetryCard error={voice.error} onRetry={voice.retry} retryLabel={s.retry} />
        ) : null}
        {activePlayMessage ? <Notice tone="sand">{activePlayMessage}</Notice> : null}

        {voice.data && voice.data.items.length === 0 ? (
          <Card tone="sand">
            <T v="body">{s.noVoiceMessages}</T>
          </Card>
        ) : null}

        {voice.data?.items.map((item) => {
          const isPlaying = playingId === item.id;
          const isLoading = playLoadingId === item.id;
          return (
            <Card key={item.id} className="mb-3">
              <View className="flex-row items-center justify-between">
                <View className="flex-1">
                  <T v="h3">
                    {item.from_display_name} → {item.to_display_name}
                  </T>
                  <T v="small" className="mt-1">
                    {formatDateTime(item.created_at)}
                    {item.duration_s !== null ? ` · ${item.duration_s}s` : ''}
                  </T>
                </View>
                <Chip
                  label={item.state}
                  tone={item.state === 'heard' ? 'ok' : item.direction === 'inbound' ? 'teal' : 'brand'}
                />
              </View>
              {item.played_at ? (
                <T v="small" className="mt-2 text-ok-ink">
                  Heard at {formatDateTime(item.played_at)}
                </T>
              ) : null}
              {item.direction === 'outbound' ? (
                <View className="mt-2">
                  <LiveHeardBadge deliveryId={item.id} messageKind="core1_voice_post" />
                </View>
              ) : null}
              <View className="mt-3 flex-row gap-2">
                <Btn
                  label={isLoading ? 'Loading…' : isPlaying ? s.stopVoice : s.playVoice}
                  icon={isPlaying ? Pause : Play}
                  kind="teal"
                  className="flex-1"
                  onPress={isLoading ? undefined : () => handlePlayToggle(item)}
                />
                {item.direction === 'inbound' ? (
                  <Btn
                    label="Reply"
                    kind="ghost"
                    className="flex-1"
                    onPress={() => {
                      setRecipientOverride(item.from_person_id);
                      setReplyToId(item.id);
                    }}
                  />
                ) : null}
              </View>
            </Card>
          );
        })}
      </Section>
    </Screen>
  );
}

export function LiveUrgentScreen() {
  const [lang] = useCore1Lang();
  const s = CORE1_STRINGS[lang];
  const incidents = useCore1Query<IncidentsFeedResponse>(loadIncidents);
  const nowMs = useLiveClock(Boolean(incidents.data?.items.length));

  const active =
    incidents.data?.items.find((i) => i.state !== 'done' && i.state !== 'closed') ??
    incidents.data?.items[0] ??
    null;

  return (
    <Screen>
      <TopBar title={s.urgentTitle} right={<LangToggle />} />
      {incidents.loading && !incidents.data ? (
        <Card>
          <T v="body">{s.loading}</T>
        </Card>
      ) : null}
      {incidents.error ? (
        <ErrorRetryCard
          error={incidents.error}
          onRetry={incidents.retry}
          retryLabel={s.retry}
        />
      ) : null}

      {incidents.data && !active ? (
        <Card tone="sand">
          <T v="body">{s.noIncidents}</T>
        </Card>
      ) : null}

      {active ? (
        <>
          <Pop>
            <Card tone={incidentLevel(active) === 'red' ? 'danger' : 'white'}>
              <LevelPill level={incidentLevel(active)} label={`${active.severity} · ${active.state}`} />
              <T v="title" className="mt-3">
                {active.subject_display_name}
              </T>
              <T v="small" className="mt-1 text-ink-2">
                Started {formatDateTime(active.created_at)}
              </T>
            </Card>
          </Pop>

          <Card className="mt-4 flex-row items-center">
            <View className="flex-1">
              <T v="num" style={{ fontVariant: ['tabular-nums'] }}>
                {formatElapsed(active.created_at, nowMs)}
              </T>
              <T v="small" className="mt-1">
                {s.liveClock}
              </T>
            </View>
            <View className="h-12 w-px bg-sand-line" />
            <View className="ml-5 flex-1">
              <T v="h3">
                {active.responder ? active.responder.display_name : 'Waiting for responder'}
              </T>
              <T v="small" className="mt-1">
                {s.whoIsGoing}
                {active.responder ? ` · ${active.responder.state}` : ''}
              </T>
            </View>
          </Card>

          {active.promised_at ? (
            <Card tone="teal" className="mt-4 flex-row items-center">
              <LiveDot color="bg-teal" />
              <T v="body" className="ml-3 flex-1 text-teal-deep">
                Promised arrival: {formatDateTime(active.promised_at)}
              </T>
            </Card>
          ) : null}

          <Section title={s.responseChain}>
            <Card className="py-1">
              {active.assignments.length === 0 ? (
                <View className="py-4">
                  <T v="body">No responder assignments dispatched yet.</T>
                </View>
              ) : (
                active.assignments.map((a, idx) => {
                  const last = idx === active.assignments.length - 1;
                  const ring =
                    a.state === 'accepted' || a.state === 'completed'
                      ? 'bg-ok'
                      : a.state === 'offered'
                        ? 'bg-teal'
                        : 'bg-sand-2';
                  const icon =
                    a.state === 'accepted' || a.state === 'completed'
                      ? Check
                      : a.state === 'offered'
                        ? Radio
                        : Clock3;
                  return (
                    <View key={a.assignment_id} className="flex-row">
                      <View className="mr-4 items-center pt-4">
                        <View className={cn('h-8 w-8 items-center justify-center rounded-full', ring)}>
                          <Icon
                            as={icon}
                            size={15}
                            className={a.state === 'expired' || a.state === 'declined' ? 'text-ink-muted' : 'text-white'}
                          />
                        </View>
                        {!last ? <View className="mt-1 w-0.5 flex-1 bg-sand-line" /> : null}
                      </View>
                      <View className={cn('flex-1 py-4', !last && 'border-b border-sand-line')}>
                        <View className="flex-row items-center justify-between">
                          <View className="flex-row items-center">
                            <Face name={a.display_name} size={28} />
                            <T v="h3" className="ml-2.5">
                              {a.display_name}
                            </T>
                          </View>
                          <Chip label={a.state} tone={a.state === 'accepted' ? 'ok' : 'sand'} />
                        </View>
                        <T v="small" className="mt-1.5">
                          Offered {formatDateTime(a.offered_at)}
                          {a.accepted_at ? ` · Accepted ${formatDateTime(a.accepted_at)}` : ''}
                        </T>
                      </View>
                    </View>
                  );
                })
              )}
            </Card>
          </Section>

          {active.state === 'done' || active.state === 'closed' ? (
            <Btn
              label={s.afterReport}
              icon={FileText}
              kind="ghost"
              className="mt-4"
              onPress={() =>
                router.push({ pathname: '/after-report', params: { incidentId: active.id } })
              }
            />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

export function LiveRefillsScreen() {
  const [lang] = useCore1Lang();
  const s = CORE1_STRINGS[lang];
  const api = useCore1Api();
  const refills = useCore1Query<RefillsFeedResponse>(loadRefills);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [decisions, setDecisions] = React.useState<
    Record<string, { decision: 'approve' | 'decline'; eventId: string }>
  >({});
  const [actionError, setActionError] = React.useState<string | null>(null);

  const act = async (item: RefillFeedItem, decision: 'approve' | 'decline') => {
    if (!api || busyId) return;
    if (!item.medicine_id || !item.vendor_id) {
      setActionError('Refill proposal is missing medicineId or vendorId.');
      return;
    }
    setBusyId(item.id);
    setActionError(null);
    try {
      const res = await api.respondToRefill({
        medicineId: item.medicine_id,
        personId: item.person_id,
        vendorId: item.vendor_id,
        decision,
      });
      setDecisions((prev) => ({
        ...prev,
        [item.id]: { decision, eventId: res.eventId },
      }));
      refills.retry();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to submit refill decision.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Screen>
      <TopBar title={s.refillsTitle} right={<LangToggle />} />
      <T v="body" className="mb-4">
        {s.refillsSub}
      </T>

      {refills.loading && !refills.data ? (
        <Card>
          <T v="body">{s.loading}</T>
        </Card>
      ) : null}
      {refills.error ? (
        <ErrorRetryCard error={refills.error} onRetry={refills.retry} retryLabel={s.retry} />
      ) : null}
      {actionError ? <Notice tone="brand">{actionError}</Notice> : null}

      {refills.data && refills.data.items.length === 0 ? (
        <Card tone="sand">
          <T v="body">{s.noRefills}</T>
        </Card>
      ) : null}

      {refills.data?.items.map((item) => {
        const localDecision = decisions[item.id];
        const isBusy = busyId === item.id;
        return (
          <Card key={item.id} className="mb-3">
            <View className="flex-row items-start justify-between">
              <View className="mr-3 flex-1">
                <T v="h3">{item.medicine}</T>
                <T v="small" className="mt-1">
                  {item.vendor} · for {item.person_display_name}
                </T>
              </View>
              <T v="h2">{formatInr(item.amount_minor)}</T>
            </View>
            <View className="mt-3 flex-row flex-wrap items-center gap-2">
              <Chip
                label={item.state}
                tone={
                  item.state === 'approved' || item.state === 'executed'
                    ? 'ok'
                    : item.state === 'pending'
                      ? 'brand'
                      : 'sand'
                }
              />
              {item.two_person_required ? <Chip label="2-person required" tone="teal" /> : null}
            </View>
            {item.who_approved.length > 0 ? (
              <T v="small" className="mt-2 text-ok-ink">
                {s.approvedBy}: {item.who_approved.join(', ')}
              </T>
            ) : null}
            <T v="small" className="mt-1">
              Proposed {formatDateTime(item.created_at)}
            </T>

            {localDecision ? (
              <View className="mt-3 flex-row items-center rounded-full bg-ok-soft px-4 py-2.5">
                <Icon as={CheckCheck} size={15} className="text-ok-ink" />
                <T v="small" className="ml-2 font-jk-bold text-ok-ink">
                  {localDecision.decision === 'approve' ? 'Approval queued' : 'Decline queued'} ·{' '}
                  {localDecision.eventId}
                </T>
              </View>
            ) : item.state === 'pending' ? (
              <View className="mt-4 flex-row gap-2">
                <Btn
                  label={isBusy ? 'Sending…' : s.approve}
                  icon={Check}
                  kind="teal"
                  className={cn('flex-1', isBusy && 'opacity-60')}
                  onPress={isBusy ? undefined : () => act(item, 'approve')}
                />
                <Btn
                  label={isBusy ? 'Sending…' : s.decline}
                  icon={X}
                  kind="ghost"
                  className={cn('flex-1', isBusy && 'opacity-60')}
                  onPress={isBusy ? undefined : () => act(item, 'decline')}
                />
              </View>
            ) : null}
          </Card>
        );
      })}
    </Screen>
  );
}
