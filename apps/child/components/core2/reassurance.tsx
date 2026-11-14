import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Btn, Card, Field, Notice, T } from '../sahaj/ui';
import { LiveHeardBadge } from '../sahaj/live-heard-badge';
import {
  type Core2Api,
  type Reassurance,
  type SendReassurance,
  type SharingPreferences,
} from '../../lib/core2';
import { useCore2Mutation, useCore2Read } from '../../lib/useCore2';
import { MutationState, ReadState, stateKey, useCore2Text } from './common';
const load = (api: Core2Api, signal: AbortSignal) => api.reassurance({ limit: 50 }, signal);
const loadPreferences = (api: Core2Api, signal: AbortSignal) => api.preferences(signal);
export function LiveReassurance() {
  const t = useCore2Text(),
    live = useCore2Read(load),
    action = useCore2Mutation();
  const { watchId, sosId } = useLocalSearchParams<{ watchId?: string; sosId?: string }>();
  const [kind, setKind] = React.useState<SendReassurance['kind']>('im_safe');
  const [recipients, setRecipients] = React.useState(''),
    [voice, setVoice] = React.useState('');
  const [result, setResult] = React.useState<Reassurance | null>(null);
  const [invalid, setInvalid] = React.useState(false);
  // Keep the safe transaction separate from reassurance: a queued update alone cannot close a watch.
  const safeAction = useCore2Mutation();
  const watchLoad = React.useCallback(
    (api: Core2Api, signal: AbortSignal) =>
      watchId ? api.watch(watchId, signal) : Promise.resolve(null),
    [watchId]
  );
  const watch = useCore2Read(watchLoad);
  const watchRecord = watch.data?.watch;
  const [resolved, setResolved] = React.useState(false);
  React.useEffect(() => setResolved(false), [watchId]);
  const watchSafe = !watchId || resolved || watchRecord?.state === 'safe';
  return (
    <>
      <Notice>{t('voiceUnavailable')}</Notice>
      {watchId ? (
        <>
          <ReadState {...watch} />
          {!watchSafe && watchRecord ? (
            <Btn
              label={t('safe')}
              kind="teal"
              size="lg"
              disabled={safeAction.blocked}
              onPress={() => {
                void safeAction.run(
                  (api, key) =>
                    api.safeWatch(watchId, { expected_version: watchRecord.version }, key),
                  (value) => {
                    setResolved(value.watch.state === 'safe');
                    watch.refresh();
                  }
                );
              }}
            />
          ) : null}
          <MutationState action={safeAction} />
        </>
      ) : null}
      <Card>
        {(['im_safe', 'reached_home', 'truth_line'] as const).map((k) => (
          <Btn
            key={k}
            label={`${kind === k ? '✓ ' : ''}${t(k)}`}
            kind="ghost"
            disabled={action.blocked}
            onPress={() => setKind(k)}
          />
        ))}
        <Field
          label={t('recipients')}
          value={recipients}
          onChangeText={setRecipients}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Field
          label={t('voiceId')}
          value={voice}
          onChangeText={setVoice}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {invalid ? <Notice>{t('invalid')}</Notice> : null}
        <Btn
          label={t('send')}
          kind="teal"
          size="lg"
          disabled={action.blocked || !watchSafe}
          onPress={() => {
            const ids = recipients
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            const uuid =
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            if (
              !ids.length ||
              ids.length > 50 ||
              !ids.every((id) => uuid.test(id)) ||
              (voice.trim() && !uuid.test(voice.trim()))
            ) {
              setInvalid(true);
              return;
            }
            setInvalid(false);
            const input: SendReassurance = {
              kind,
              recipient_person_ids: ids,
              ...(voice.trim() ? { voice_post_id: voice.trim() } : {}),
              ...(watchId ? { watch_id: watchId } : {}),
              ...(sosId ? { sos_id: sosId } : {}),
            };
            void action.run(
              (api, key) => api.sendReassurance(input, key),
              (value) => {
                setResult(value.reassurance);
                live.refresh();
              }
            );
          }}
        />
      </Card>
      <MutationState action={action} />
      {result ? (
        <ReassuranceCard row={live.data?.reassurance.find((r) => r.id === result.id) ?? result} />
      ) : null}
      <ReadState {...live} />
      {live.data?.reassurance.length === 0 ? <Notice>{t('empty')}</Notice> : null}
      {live.data?.reassurance
        .filter((row) => row.id !== result?.id)
        .map((row) => (
          <ReassuranceCard row={row} key={row.id} />
        ))}
    </>
  );
}
function ReassuranceCard({ row }: { row: Reassurance }) {
  const t = useCore2Text();
  return (
    <Card className="mt-4">
      <T v="h2">{t(row.kind)}</T>
      <T>{t(stateKey(row.status))}</T>
      {row.facts_exposed?.status_label || row.status_label ? (
        <T>
          {t('serverStatus')}: {row.facts_exposed?.status_label ?? row.status_label}
        </T>
      ) : null}
      <T>{t(row.delivery_verified ? 'verified' : 'unverified')}</T>
      <LiveHeardBadge deliveryId={row.id} messageKind="core2_reassurance" />
      <T>{row.occurred_at ?? row.created_at}</T>
    </Card>
  );
}
export function LivePreferences() {
  const live = useCore2Read(loadPreferences);
  return (
    <>
      <ReadState {...live} />
      {live.data ? <PreferencesForm preferences={live.data.preferences} /> : null}
    </>
  );
}
function PreferencesForm({ preferences }: { preferences: SharingPreferences }) {
  const t = useCore2Text(),
    action = useCore2Mutation();
  const [draft, setDraft] = React.useState(preferences);
  return (
    <>
      <Card>
        {(Object.keys(preferences) as (keyof SharingPreferences)[]).map((key) => (
          <Btn
            key={key}
            label={`${draft[key] ? '✓ ' : ''}${t(key)}`}
            kind="ghost"
            disabled={action.blocked}
            onPress={() => setDraft((prev) => ({ ...prev, [key]: !prev[key] }))}
          />
        ))}
        <Btn
          label={t('savePreferences')}
          disabled={action.blocked}
          onPress={() => {
            const input = { ...draft };
            void action.run(
              (api, key) => api.savePreferences(input, key),
              (value) => setDraft(value.preferences)
            );
          }}
        />
      </Card>
      <MutationState action={action} />
    </>
  );
}
