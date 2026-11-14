import * as React from 'react';
import { Linking, Platform, Share, Switch, View } from 'react-native';
import { router } from 'expo-router';
import type { AppHarness, AppVerification } from '@sahaj/shared';
import {
  Btn,
  Card,
  Field,
  Hero,
  LevelPill,
  Notice,
  Screen,
  Section,
  Stat,
  T,
  Tap,
  TopBar,
} from './ui';
import { useApi, useLive, useLiveAlerts } from '@/lib/useLive';
import { DEFAULT_SERVER_URL, saveSession, useSession } from '@/lib/session';
import { usePushStatus } from '@/lib/notifications';
import type { AppApi } from '@/lib/api';

const loadSummary = (api: AppApi, signal: AbortSignal) => api.summary(signal);
const loadTimeline = (api: AppApi, signal: AbortSignal) => api.timeline(signal);
const loadVerify = (api: AppApi, signal: AbortSignal) => api.verify(signal);
const loadHarness = (api: AppApi, signal: AbortSignal) => api.harness(signal);
export function LiveLoading() {
  return (
    <Screen>
      <TopBar title="Shield" />
      <T v="body">Loading session…</T>
    </Screen>
  );
}
function Status({
  error,
  loading,
  updated,
}: {
  error: string | null;
  loading: boolean;
  updated?: number;
}) {
  return (
    <View className="my-3">
      <T v="small" className="text-teal-ink">
        Live Shield · {updated ? `updated ${new Date(updated).toLocaleTimeString()}` : 'connecting'}
      </T>
      {loading ? <T v="body">Loading server record…</T> : null}
      {error ? (
        <Notice tone="sand">
          {error} {updated ? 'Previously fetched record shown.' : ''}
        </Notice>
      ) : null}
    </View>
  );
}
export function LiveSessionBar() {
  const pushStatus = usePushStatus();
  return (
    <View className="my-4 gap-2">
      {pushStatus ? <Notice tone="sand">{pushStatus}</Notice> : null}
      <Btn label="Pair Maa’s phone" kind="teal" onPress={() => router.push('/pair')} />
      <Btn label="Lab sign-in / sign out" kind="ghost" onPress={() => router.push('/sign-in')} />
    </View>
  );
}
export function HarnessNumbers({ data }: { data: AppHarness }) {
  return (
    <Card>
      <T v="h2">Harness · {data.available ? (data.mode ?? 'mode not recorded') : 'unavailable'}</T>
      {Object.entries(data.summary).map(([key, value]) => (
        <T v="small" key={key}>
          {key.replaceAll('_', ' ')}: {value}
        </T>
      ))}
      <T v="small" className="mt-2">
        AI evaluation: {data.ai ? JSON.stringify(data.ai) : 'not recorded'}
      </T>
    </Card>
  );
}
export function LiveHome() {
  const summary = useLive(loadSummary),
    alerts = useLiveAlerts();
  const latest = alerts.data?.find((a) => a.level !== 'green');
  return (
    <Screen>
      <T v="title" className="mt-3">
        Your family’s Shield
      </T>
      <Status
        error={summary.error ?? alerts.error}
        loading={!summary.data || !alerts.data}
        updated={alerts.updated}
      />
      {summary.data ? (
        <Hero>
          <Stat value={String(summary.data.checks_this_week)} label="Checks this week" />
          <Stat
            value={String(summary.data.frauds_stopped)}
            label="Red warnings · not marked safe"
          />
        </Hero>
      ) : null}
      <Section title="Latest alert">
        {latest ? (
          <Tap onPress={() => router.push({ pathname: '/alert', params: { id: latest.id } })}>
            <Card>
              <LevelPill level={latest.level} />
              <T v="h2" className="mt-3">
                {latest.scam_type.replaceAll('_', ' ')}
              </T>
              <T v="body">{latest.masked_snippet}</T>
              <T v="small">{new Date(latest.created_at).toLocaleString()}</T>
            </Card>
          </Tap>
        ) : alerts.data ? (
          <T v="body">No flagged alerts in the server record.</T>
        ) : null}
      </Section>
      <Btn label="Open Shield" onPress={() => router.push('/shield')} />
      <LiveSessionBar />
      <Section title="Core 2 · Demo">
        <T v="small">Safety and Circle screens still use synthetic demo data.</T>
        <Btn label="Open safety demo" kind="ghost" onPress={() => router.push('/safe')} />
        <Btn label="Open demo controls" kind="ghost" onPress={() => router.push('/demo')} />
      </Section>
    </Screen>
  );
}
export function LiveShield() {
  const summary = useLive(loadSummary),
    alerts = useLiveAlerts(),
    api = useApi();
  const [drills, setDrills] = React.useState<Record<string, boolean>>({}),
    [message, setMessage] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  return (
    <Screen>
      <T v="title" className="mt-3">
        Shield
      </T>
      <Status
        error={summary.error ?? alerts.error}
        loading={!summary.data || !alerts.data}
        updated={summary.updated}
      />
      {summary.data ? (
        <>
          <Hero>
            <View className="flex-row">
              <Stat value={String(summary.data.checks_this_week)} label="Checks this week" />
              <Stat value={String(summary.data.frauds_stopped)} label="Red warnings" />
            </View>
            <T v="small" className="mt-3">
              Red warnings exclude alerts marked safe. They do not prove a financial loss was
              prevented.
            </T>
          </Hero>
          <Section title="Maa’s scam-sense">
            {summary.data.parents.map((p) => (
              <Card key={p.id} className="mb-3">
                <T v="h2">
                  {p.name}: {p.scam_sense.score_out_of_5}/5
                </T>
                <T v="small">
                  {p.scam_sense.drills_this_month} completed practices this month ·{' '}
                  {p.scam_sense.trend}
                </T>
              </Card>
            ))}
          </Section>
          <Section title="What is protected">
            {summary.data.devices.length ? (
              summary.data.devices.map((d) => (
                <Card key={d.id} className="mb-3">
                  <T v="h2">{d.label ?? 'Paired phone'}</T>
                  {Object.entries(d.protections).map(([name, on]) => (
                    <T v="body" key={name}>
                      {on ? '✓' : '○'} {name} · {on ? 'On' : 'Off'}
                    </T>
                  ))}
                  <T v="small">
                    Last heartbeat:{' '}
                    {d.last_heartbeat_at
                      ? new Date(d.last_heartbeat_at).toLocaleString()
                      : 'not received'}
                  </T>
                </Card>
              ))
            ) : (
              <T v="body">No paired devices yet.</T>
            )}
          </Section>
          <Section title="Experience practice · opt in">
            <Notice tone="sand">
              Off by default. A family opt-in and Maa’s recorded “yes” are both needed before any
              experience drill can start.
            </Notice>
            {summary.data.parents.map((p) => (
              <Card key={p.id} className="mt-3">
                <View className="flex-row items-center justify-between">
                  <T v="bodyStrong" className="flex-1">
                    {p.name} · experience drills
                  </T>
                  <Switch
                    accessibilityLabel={`Experience drills for ${p.name}`}
                    disabled={pending}
                    value={drills[p.id] ?? false}
                    onValueChange={async (enabled) => {
                      if (!api || pending) return;
                      setPending(true);
                      setMessage(null);
                      try {
                        const res = await api.drills({ parent_id: p.id, enabled });
                        setDrills((prev) => ({ ...prev, [p.id]: res.enabled }));
                        setMessage(
                          'Family preference saved. Maa’s recorded consent is still required.'
                        );
                      } catch (e) {
                        setMessage(e instanceof Error ? e.message : 'Could not save preference.');
                      } finally {
                        setPending(false);
                      }
                    }}
                  />
                </View>
              </Card>
            ))}
            {message ? <Notice>{message}</Notice> : null}
          </Section>
        </>
      ) : null}
      <Section title="Recent alerts">
        <View className="gap-3">
          {alerts.data?.map((a) => (
            <Tap
              key={a.id}
              onPress={() => router.push({ pathname: '/alert', params: { id: a.id } })}>
              <Card>
                <LevelPill level={a.level} />
                <T v="h3" className="mt-3">
                  {a.scam_type.replaceAll('_', ' ')}
                </T>
                <T v="small">
                  {new Date(a.created_at).toLocaleString()} · {a.channel}
                </T>
                {a.child_feedback ? <T v="small">Family marked {a.child_feedback}</T> : null}
              </Card>
            </Tap>
          ))}
          {alerts.data?.length === 0 ? <T v="body">No alerts recorded.</T> : null}
        </View>
      </Section>
      <LiveSessionBar />
    </Screen>
  );
}
export function LiveAlert({ id }: { id: string }) {
  const loader = React.useCallback(
    (api: AppApi, signal: AbortSignal) => api.alert(id, signal),
    [id]
  );
  const live = useLive(loader),
    api = useApi();
  const [message, setMessage] = React.useState<string | null>(null),
    [pending, setPending] = React.useState(false);
  const alert = live.data;
  async function answer(answer: 'safe' | 'fraud') {
    if (!api || pending) return;
    setPending(true);
    try {
      const res = await api.feedback(id, { answer });
      setMessage(`Feedback saved: ${res.feedback}`);
      live.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Feedback failed.');
    } finally {
      setPending(false);
    }
  }
  return (
    <Screen>
      <TopBar title="Alert detail" />
      <Status error={live.error} loading={!alert} updated={live.updated} />
      {alert ? (
        <>
          <LevelPill level={alert.level} />
          <T v="title" className="mt-3">
            {alert.scam_type.replaceAll('_', ' ')}
          </T>
          <Card className="mt-4">
            <T v="label">Masked message</T>
            <T v="body" className="mt-2">
              {alert.masked_snippet || 'No text recorded'}
            </T>
          </Card>
          <Section title="Why Shield flagged it">
            <Card>
              {alert.reasons.map((r) => (
                <View className="mb-3" key={r.rule_id}>
                  <T v="body">{r.en}</T>
                  <T v="body">{r.hi}</T>
                </View>
              ))}
              <T v="small">Checks: {alert.checks_fired.join(', ') || 'none'}</T>
            </Card>
          </Section>
          <Section title="What Maa was told">
            <Card tone="brand">
              <T v="body">{alert.told_hi}</T>
              <T v="small" className="mt-3">
                {alert.told_en}
              </T>
              <T v="small" className="mt-3">
                The action record below shows what delivery was recorded. This record alone does not
                confirm Maa heard it.
              </T>
            </Card>
          </Section>
          <Section title="Action record">
            <Card>
              {alert.timeline.map((r) => (
                <T v="body" key={r.id}>
                  {new Date(r.created_at).toLocaleTimeString()} · {r.step} ·{' '}
                  {r.status ?? 'recorded'}
                </T>
              ))}
              {!alert.timeline.length ? <T v="body">No signed action entries yet.</T> : null}
            </Card>
          </Section>
          {alert.child_feedback ? (
            <Notice>Family marked this {alert.child_feedback}.</Notice>
          ) : (
            <View className="mt-4 gap-2">
              <Btn
                label={pending ? 'Saving…' : 'It was fraud'}
                onPress={() => {
                  void answer('fraud');
                }}
              />
              <Btn
                label="It was safe"
                kind="ghost"
                onPress={() => {
                  void answer('safe');
                }}
              />
            </View>
          )}
          {message ? <Notice>{message}</Notice> : null}
          {alert.level === 'red' ? (
            <Btn
              label="Report pack"
              className="mt-4"
              onPress={() => router.push({ pathname: '/report-pack', params: { id } })}
            />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
export function LiveTimeline() {
  const live = useLive(loadTimeline);
  return (
    <Screen>
      <TopBar title="Timeline" />
      <Status error={live.error} loading={!live.data} updated={live.updated} />
      <Btn label="Verify hash chain" onPress={() => router.push('/verify')} />
      <Section title="Signed Shield record">
        {live.data?.rows.map((r) => (
          <Card className="mb-3" key={r.id}>
            <T v="small">{new Date(r.created_at).toLocaleString()}</T>
            <T v="h3">{r.step}</T>
            <T v="small">
              {r.status ?? 'recorded'} · step {r.seq}
            </T>
          </Card>
        ))}
        {live.data?.rows.length === 0 ? <T v="body">No signed steps yet.</T> : null}
      </Section>
    </Screen>
  );
}
export function VerifyResult({ data }: { data: AppVerification }) {
  return (
    <Card tone={data.valid ? 'teal' : 'sand'}>
      <T v="h2">{data.valid ? 'Hash chain matches' : 'Hash chain needs review'}</T>
      <T v="body">{data.checked} family steps checked</T>
      <T v="small">
        {data.broken_at
          ? `Broken at ${data.broken_at}`
          : data.valid
            ? 'SHA-256 links recomputed by the server.'
            : 'A global chain link failed. Other families’ rows are private.'}
      </T>
      <T v="small" className="mt-2">
        Hash consistency is checked against the stored chain. An independently trusted checkpoint is
        not available.
      </T>
    </Card>
  );
}
export function LiveVerify() {
  const live = useLive(loadVerify);
  return (
    <Screen>
      <TopBar title="Verify record" />
      <Status error={live.error} loading={!live.data} updated={live.updated} />
      {live.data ? <VerifyResult data={live.data} /> : null}
      <Btn label="Check again" className="mt-4" onPress={live.refresh} />
    </Screen>
  );
}
async function copyOrShare(text: string) {
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return 'Copied for 1930.';
  }
  await Share.share({ title: 'Sahaj evidence for 1930', message: text });
  return 'Share sheet opened. You can copy the visible text below.';
}
export function LiveEvidence({ id }: { id: string }) {
  const loader = React.useCallback(
    (api: AppApi, signal: AbortSignal) => api.evidence(id, signal),
    [id]
  );
  const live = useLive(loader),
    [message, setMessage] = React.useState<string | null>(null);
  const pack = live.data;
  return (
    <Screen>
      <TopBar title="Report pack" />
      <Status error={live.error} loading={!pack} updated={live.updated} />
      {pack ? (
        <>
          <T v="title">Incident evidence</T>
          <Section title="English">
            <Card>
              <T v="body" selectable>
                {pack.summary_en}
              </T>
            </Card>
          </Section>
          <Section title="Hindi">
            <Card>
              <T v="body" selectable>
                {pack.summary_hi}
              </T>
            </Card>
          </Section>
          <Card>
            <T v="small" selectable>
              Checkpoint: {pack.chain_hash}
            </T>
            <T v="small">Created {pack.created_at}</T>
          </Card>
          {pack.verification ? (
            <VerifyResult data={pack.verification} />
          ) : (
            <Notice>
              Pack signature verification is not available on this server. You can separately check
              the timeline chain.
            </Notice>
          )}
          <Section title="Copy for 1930">
            <Card>
              <T v="body" selectable>
                {pack.copy_for_1930}
              </T>
            </Card>
          </Section>
          <View className="gap-2">
            <Btn
              label="Copy for 1930"
              onPress={() => {
                void copyOrShare(pack.copy_for_1930)
                  .then(setMessage)
                  .catch(() => setMessage('Copy failed. Select the visible text to copy it.'));
              }}
            />
            <Btn
              label="Open cybercrime.gov.in"
              kind="ghost"
              onPress={() => {
                void Linking.openURL('https://cybercrime.gov.in').catch(() =>
                  setMessage('Could not open the reporting website.')
                );
              }}
            />
            <Btn
              label="Share report"
              kind="teal"
              onPress={() => {
                void Share.share({ title: 'Sahaj evidence', message: pack.copy_for_1930 }).catch(
                  () => setMessage('Sharing failed. The report is still visible.')
                );
              }}
            />
          </View>
          <Notice>
            Exporting does not file a complaint. Original numbers and messages were not stored; ask
            Maa for those details.
          </Notice>
        </>
      ) : null}
      {message ? <Notice>{message}</Notice> : null}
    </Screen>
  );
}
export function LiveHarness() {
  const live = useLive(loadHarness);
  return (
    <Screen>
      <TopBar title="Lab results" />
      <Status error={live.error} loading={!live.data} updated={live.updated} />
      {live.data ? <HarnessNumbers data={live.data} /> : null}
      <LiveSessionBar />
    </Screen>
  );
}
export function PairScreen() {
  const api = useApi(),
    { ready, session } = useSession();
  const [pair, setPair] = React.useState<Awaited<ReturnType<AppApi['pair']>> | null>(null);
  const [pending, setPending] = React.useState(false),
    [error, setError] = React.useState<string | null>(null),
    [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Screen>
      <TopBar title="Pair Maa’s phone" />
      <T v="body">
        Create a one-time code, then enter it in Maa’s Shield setup. Codes expire after ten minutes.
      </T>
      {!ready ? (
        <T v="body">Loading session…</T>
      ) : !session ? (
        <Btn
          label="Sign in to create a code"
          className="mt-4"
          onPress={() => router.push('/sign-in')}
        />
      ) : (
        <>
          {pair ? (
            <Card className="mt-4">
              <T v="title" selectable>
                {pair.code}
              </T>
              <T v="small">
                {Date.parse(pair.expires_at) > now
                  ? `Expires ${new Date(pair.expires_at).toLocaleTimeString()}`
                  : 'Code expired. Create another.'}
              </T>
              <T v="small" selectable>
                Family: {pair.family_id}
              </T>
            </Card>
          ) : null}
          <Btn
            label={pending ? 'Creating…' : 'Create pairing code'}
            className="mt-4"
            onPress={async () => {
              if (!api || pending) return;
              setPending(true);
              setError(null);
              try {
                setPair(await api.pair());
              } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not create code.');
              } finally {
                setPending(false);
              }
            }}
          />
        </>
      )}
      {error ? <Notice>{error}</Notice> : null}
    </Screen>
  );
}
export function SignInScreen() {
  const { session, storage } = useSession();
  const pushStatus = usePushStatus();
  const [url, setUrl] = React.useState(session?.url ?? DEFAULT_SERVER_URL),
    [token, setToken] = React.useState(''),
    [error, setError] = React.useState<string | null>(null),
    [pending, setPending] = React.useState(false);
  return (
    <Screen>
      <TopBar title="Lab sign-in" />
      <T v="title">Connect Riya’s Shield</T>
      <T v="body" className="mt-3">
        Paste the server URL and your 12-hour access token from the lab mint script.
      </T>
      <View className="mt-5 gap-3">
        <Field
          label="API URL"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="https://your-shield-server"
        />
        <Field
          label="Access token"
          value={token}
          onChangeText={setToken}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Btn
          label={pending ? 'Checking…' : 'Connect'}
          onPress={async () => {
            if (pending) return;
            setPending(true);
            setError(null);
            try {
              // Production: replace this paste form with Supabase Auth; the server accepts the same HS256 authenticated token format.
              const { createApi } = await import('@/lib/api');
              const candidate = { url, token: token.trim() };
              // Validate locally before transmitting the bearer token, then verify membership on the server.
              const { validateLabSession } = await import('@/lib/session');
              const valid = validateLabSession(candidate);
              await createApi(valid).summary();
              await saveSession(valid);
              setToken('');
              router.replace('/shield');
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Sign-in failed.');
            } finally {
              setPending(false);
            }
          }}
        />
        <Btn
          label="Use labelled Demo / sign out"
          kind="ghost"
          onPress={() => {
            saveSession(null);
            setToken('');
            router.replace('/');
          }}
        />
      </View>
      {error ? <Notice>{error}</Notice> : null}
      {pushStatus ? <Notice tone="sand">{pushStatus}</Notice> : null}
      <Notice tone="sand">
        Use an access token, never a server secret. {storage === 'secure'
          ? 'This phone stores your session securely.'
          : storage === 'browser' ? 'Web sessions use browser storage.'
          : 'Secure storage is unavailable; this session lasts until the app closes.'}
      </Notice>
    </Screen>
  );
}
