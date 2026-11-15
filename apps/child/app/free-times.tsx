import * as React from 'react';
import { View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import {
  CalendarClock,
  Check,
  Clock3,
  Phone,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react-native';
import { LangToggle } from '@/components/sahaj/core1-screens';
import { LiveLoading } from '@/components/sahaj/live';
import {
  Btn,
  Card,
  Chip,
  Field,
  Hero,
  IconTile,
  LiveDot,
  Notice,
  Pop,
  Screen,
  Section,
  T,
  Tap,
  TopBar,
} from '@/components/sahaj/ui';
import { CORE1_STRINGS, useCore1Lang } from '@/lib/core1';
import {
  MATCHER_STRINGS,
  PRESET_FREE_WINDOWS,
  useCore1MatcherApi,
  type FreeTimesResponse,
  type FreeWindowItem,
} from '@/lib/core1-matcher';
import { ApiError } from '@/lib/api';
import { demoCall, showToast } from '@/lib/demo';
import { useSession } from '@/lib/session';

const INITIAL_DEMO_RIYA_WINDOWS: FreeWindowItem[] = [
  {
    id: 'demo-riya-win-1',
    person_id: 'demo-riya',
    person_display_name: 'Riya',
    person_role: 'child',
    timezone: 'Asia/Kolkata',
    start_time: '18:00',
    end_time: '20:00',
    start_minute: 1080,
    end_minute: 1200,
    kind: 'recurring',
    days_of_week: null,
    expires_at: null,
    source: 'app',
    label: 'Shaam 6 se 8 baje tak',
    active_now: true,
    created_at: '2026-11-15T12:00:00.000Z',
  },
];

const DEMO_MAA_WINDOWS: FreeWindowItem[] = [
  {
    id: 'demo-maa-win-1',
    person_id: 'demo-maa',
    person_display_name: 'Meena (Maa)',
    person_role: 'parent',
    timezone: 'Asia/Kolkata',
    start_time: '18:00',
    end_time: '20:00',
    start_minute: 1080,
    end_minute: 1200,
    kind: 'recurring',
    days_of_week: null,
    expires_at: null,
    source: 'sarvam_checkin',
    label: 'Shaam 6 se 8 baje tak',
    active_now: true,
    created_at: '2026-11-15T04:00:00.000Z',
  },
];

function WindowCard({
  item,
  onDelete,
  removeLabel,
  busy,
}: {
  item: FreeWindowItem;
  onDelete?: (id: string) => void;
  removeLabel: string;
  busy?: boolean;
}) {
  return (
    <Card className="mb-3">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center flex-1">
          <IconTile icon={Clock3} tone={item.active_now ? 'teal' : 'sand'} size={40} />
          <View className="ml-3 flex-1">
            <View className="flex-row items-center flex-wrap gap-2">
              <T v="h3">
                {item.start_time} – {item.end_time}
              </T>
              {item.active_now ? <Chip label="Free now" tone="ok" /> : null}
              {item.source === 'free_now' ? <Chip label="30 min" tone="teal" /> : null}
              {item.source === 'sarvam_checkin' ? <Chip label="Check-in" tone="brand" /> : null}
            </View>
            <T v="small" className="mt-1">
              {item.label} · {item.timezone}
            </T>
          </View>
        </View>
        {onDelete ? (
          <Tap
            accessibilityLabel={`${removeLabel} ${item.start_time}`}
            disabled={busy}
            onPress={() => onDelete(item.id)}
            className="ml-2 h-10 w-10 items-center justify-center rounded-full bg-sand">
            <IconTile icon={Trash2} tone="danger" size={34} />
          </Tap>
        ) : null}
      </View>
    </Card>
  );
}

function DemoFreeTimesScreen() {
  const [lang] = useCore1Lang();
  const s = MATCHER_STRINGS[lang];
  const c1 = CORE1_STRINGS[lang];
  const [windows, setWindows] = React.useState<FreeWindowItem[]>(INITIAL_DEMO_RIYA_WINDOWS);
  const [startTime, setStartTime] = React.useState('18:00');
  const [endTime, setEndTime] = React.useState('20:00');
  const [error, setError] = React.useState<string | null>(null);

  const bothFree = windows.some((w) => w.active_now);

  const handleFreeNow = () => {
    setError(null);
    const filtered = windows.filter((w) => w.source !== 'free_now');
    setWindows([
      {
        id: `demo-freenow-${Date.now()}`,
        person_id: 'demo-riya',
        person_display_name: 'Riya',
        person_role: 'child',
        timezone: 'Asia/Kolkata',
        start_time: 'Now',
        end_time: '+30m',
        start_minute: 1080,
        end_minute: 1110,
        kind: 'ad_hoc',
        days_of_week: null,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        source: 'free_now',
        label: 'Free now (30 min)',
        active_now: true,
        created_at: new Date().toISOString(),
      },
      ...filtered,
    ]);
    showToast('Demo · Marked free now for 30 minutes.');
  };

  const handleAddWindow = (start: string, end: string, label?: string) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start.trim()) || !/^([01]\d|2[0-4]):[0-5]\d$/.test(end.trim())) {
      setError('Enter valid 24-hour times like 18:00 and 20:00.');
      return;
    }
    if (start.trim() === end.trim()) {
      setError('Start and end time must be different.');
      return;
    }
    setError(null);
    setWindows((prev) => [
      ...prev,
      {
        id: `demo-win-${Date.now()}`,
        person_id: 'demo-riya',
        person_display_name: 'Riya',
        person_role: 'child',
        timezone: 'Asia/Kolkata',
        start_time: start.trim(),
        end_time: end.trim(),
        start_minute: 0,
        end_minute: 60,
        kind: 'recurring',
        days_of_week: null,
        expires_at: null,
        source: 'app',
        label: label ?? `${start.trim()} – ${end.trim()}`,
        active_now: true,
        created_at: new Date().toISOString(),
      },
    ]);
  };

  return (
    <Screen>
      <TopBar title={s.title} right={<LangToggle compact />} />
      <View className="mb-4 flex-row items-center justify-between rounded-2xl bg-teal-soft px-4 py-2.5">
        <View className="flex-row items-center">
          <LiveDot color="bg-teal" size={7} />
          <T v="small" className="ml-2 font-jk-bold text-teal-ink">
            {c1.demoLabel}
          </T>
        </View>
        <Chip label="Demo" tone="sand" />
      </View>

      <T v="body" className="mb-4">
        {s.sub}
      </T>

      {bothFree ? (
        <Pop>
          <Hero tone="brand">
            <View className="flex-row items-center">
              <IconTile icon={Sparkles} tone="brand" size={38} />
              <View className="ml-3 flex-1">
                <T v="label" className="text-brand-ink">
                  BOTH FREE NOW
                </T>
                <T v="h2" className="mt-1">
                  {s.bothFreeBanner}
                </T>
              </View>
            </View>
            <T v="small" className="mt-2">
              {s.bothFreeHint}
            </T>
            <Btn label={s.callMaaBtn} icon={Phone} className="mt-4" onPress={demoCall} />
          </Hero>
        </Pop>
      ) : null}

      <View className="mt-4">
        <Btn label={s.freeNowBtn} icon={Clock3} kind="teal" onPress={handleFreeNow} />
      </View>

      <Section title={s.maaWindowsSection}>
        {DEMO_MAA_WINDOWS.map((w) => (
          <WindowCard key={w.id} item={w} removeLabel={s.removeBtn} />
        ))}
      </Section>

      <Section title={s.yourWindowsSection}>
        {windows.length === 0 ? (
          <Card tone="sand">
            <T v="small">{s.noYourWindows}</T>
          </Card>
        ) : (
          windows.map((w) => (
            <WindowCard
              key={w.id}
              item={w}
              removeLabel={s.removeBtn}
              onDelete={(id) => setWindows((prev) => prev.filter((x) => x.id !== id))}
            />
          ))
        )}
      </Section>

      <Section title={s.addWindowTitle}>
        <Card>
          <View className="flex-row flex-wrap gap-2">
            {PRESET_FREE_WINDOWS.map((preset) => (
              <Tap
                key={preset.label}
                onPress={() => {
                  setStartTime(preset.startTime);
                  setEndTime(preset.endTime);
                  handleAddWindow(preset.startTime, preset.endTime, preset.label);
                }}>
                <Chip label={preset.label} tone="teal" icon={Plus} />
              </Tap>
            ))}
          </View>
          <Field label={s.startLabel} value={startTime} onChangeText={setStartTime} />
          <Field label={s.endLabel} value={endTime} onChangeText={setEndTime} />
          {error ? <Notice tone="brand">{error}</Notice> : null}
          <Btn
            label={s.addBtn}
            icon={Check}
            className="mt-4"
            onPress={() => handleAddWindow(startTime, endTime)}
          />
        </Card>
      </Section>

      <Btn
        label={c1.signInPrompt}
        kind="ghost"
        className="mt-6"
        onPress={() => router.push('/sign-in')}
      />
    </Screen>
  );
}

function LiveFreeTimesScreen() {
  const [lang] = useCore1Lang();
  const s = MATCHER_STRINGS[lang];
  const api = useCore1MatcherApi();

  const [data, setData] = React.useState<FreeTimesResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [startTime, setStartTime] = React.useState('18:00');
  const [endTime, setEndTime] = React.useState('20:00');

  const load = React.useCallback(
    async (signal?: AbortSignal) => {
      if (!api) return;
      setLoading(true);
      setError(null);
      try {
        const res = await api.getFreeTimes(signal);
        setData(res);
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') return;
        setError(err instanceof ApiError ? err.message : 'Could not load free-time windows.');
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useFocusEffect(
    React.useCallback(() => {
      const ctrl = new AbortController();
      void load(ctrl.signal);
      return () => ctrl.abort();
    }, [load]),
  );

  const onFreeNow = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.freeNow(30, data?.timezone);
      setNotice(s.freeNowActive);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mark free now.');
    } finally {
      setBusy(false);
    }
  };

  const onAddWindow = async (start: string, end: string, label?: string) => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.addFreeWindow({
        startTime: start.trim(),
        endTime: end.trim(),
        timezone: data?.timezone,
        label,
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save window.');
    } finally {
      setBusy(false);
    }
  };

  const onDeleteWindow = async (id: string) => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.deleteFreeWindow(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove window.');
    } finally {
      setBusy(false);
    }
  };

  const maaWindows = (data?.family_windows ?? []).filter((w) => w.person_role === 'parent');
  const ownWindows = data?.windows ?? [];

  return (
    <Screen>
      <TopBar
        title={s.title}
        right={
          <View className="flex-row items-center gap-2">
            <LangToggle />
            <Tap
              accessibilityLabel="Refresh"
              onPress={() => void load()}
              className="h-10 w-10 items-center justify-center rounded-full bg-sand">
              <IconTile icon={RefreshCw} tone="sand" size={34} />
            </Tap>
          </View>
        }
      />

      <T v="body" className="mb-4">
        {s.sub}
      </T>

      {error ? <Notice tone="brand">{error}</Notice> : null}
      {notice ? <Notice tone="teal">{notice}</Notice> : null}

      {data?.both_free_now && !data.maa_quiet_now ? (
        <Pop>
          <Hero tone="brand">
            <View className="flex-row items-center">
              <IconTile icon={CalendarClock} tone="brand" size={38} />
              <View className="ml-3 flex-1">
                <T v="label" className="text-brand-ink">
                  BOTH FREE NOW
                </T>
                <T v="h2" className="mt-1">
                  {data.nudge_message || s.bothFreeBanner}
                </T>
              </View>
            </View>
            <T v="small" className="mt-2">
              {s.bothFreeHint}
            </T>
          </Hero>
        </Pop>
      ) : null}

      {data?.maa_quiet_now ? <Notice tone="sand">{s.quietHoursNote}</Notice> : null}
      {data?.talked_today ? <Notice tone="teal">{s.talkedTodayNote}</Notice> : null}
      {data?.nudged_today ? <Notice tone="sand">{s.nudgedTodayNote}</Notice> : null}

      <View className="mt-4">
        <Btn
          label={s.freeNowBtn}
          icon={Clock3}
          kind="teal"
          disabled={busy}
          onPress={() => void onFreeNow()}
        />
      </View>

      <Section title={s.maaWindowsSection}>
        {loading && !data ? (
          <Card tone="sand">
            <T v="small">Loading…</T>
          </Card>
        ) : maaWindows.length === 0 ? (
          <Card tone="sand">
            <T v="small">{s.noMaaWindows}</T>
          </Card>
        ) : (
          maaWindows.map((w) => <WindowCard key={w.id} item={w} removeLabel={s.removeBtn} />)
        )}
      </Section>

      <Section title={s.yourWindowsSection}>
        {ownWindows.length === 0 ? (
          <Card tone="sand">
            <T v="small">{s.noYourWindows}</T>
          </Card>
        ) : (
          ownWindows.map((w) => (
            <WindowCard
              key={w.id}
              item={w}
              busy={busy}
              removeLabel={s.removeBtn}
              onDelete={(id) => void onDeleteWindow(id)}
            />
          ))
        )}
      </Section>

      <Section title={s.addWindowTitle}>
        <Card>
          <View className="flex-row flex-wrap gap-2">
            {PRESET_FREE_WINDOWS.map((preset) => (
              <Tap
                key={preset.label}
                disabled={busy}
                onPress={() => {
                  setStartTime(preset.startTime);
                  setEndTime(preset.endTime);
                  void onAddWindow(preset.startTime, preset.endTime, preset.label);
                }}>
                <Chip label={preset.label} tone="teal" icon={Plus} />
              </Tap>
            ))}
          </View>
          <Field label={s.startLabel} value={startTime} onChangeText={setStartTime} />
          <Field label={s.endLabel} value={endTime} onChangeText={setEndTime} />
          <Btn
            label={s.addBtn}
            icon={Check}
            disabled={busy}
            className="mt-4"
            onPress={() => void onAddWindow(startTime, endTime)}
          />
        </Card>
      </Section>
    </Screen>
  );
}

export default function FreeTimesRoute() {
  const { ready, session } = useSession();
  if (!ready) return <LiveLoading />;
  return session ? <LiveFreeTimesScreen /> : <DemoFreeTimesScreen />;
}
