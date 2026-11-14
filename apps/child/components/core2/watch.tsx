import * as React from 'react';
import { router } from 'expo-router';
import { Btn, Card, Field, Notice, T } from '../sahaj/ui';
import { type Core2Api, type Watch } from '../../lib/core2';
import { useCore2Mutation, useCore2Read } from '../../lib/useCore2';
import { MutationState, ReadState, stateKey, useCore2Text } from './common';
const load = (api: Core2Api, signal: AbortSignal) => api.watches({ limit: 50 }, signal);
export function LiveWatch() {
  const t = useCore2Text(),
    list = useCore2Read(load),
    action = useCore2Mutation();
  const [selected, setSelected] = React.useState<Watch | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [from, setFrom] = React.useState(''),
    [to, setTo] = React.useState(''),
    [cab, setCab] = React.useState(''),
    [eta, setEta] = React.useState('30');
  const [invalid, setInvalid] = React.useState(false);
  const detailLoader = React.useCallback(
    (api: Core2Api, signal: AbortSignal) =>
      selected ? api.watch(selected.id, signal) : Promise.resolve(null),
    [selected?.id]
  );
  const detail = useCore2Read(detailLoader);
  const record =
    detail.data?.watch && (!selected || detail.data.watch.version >= selected.version)
      ? detail.data.watch
      : selected;
  const complete = (value: { watch: Watch }) => {
    setSelected(value.watch);
    setCreating(false);
    setFrom('');
    setTo('');
    setCab('');
    detail.refresh();
    list.refresh();
  };
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const remaining = record
    ? Math.max(0, Math.ceil((Date.parse(record.deadline_at) - now) / 1000))
    : 0;
  const terminal = record && ['safe', 'cancelled'].includes(record.state);
  return (
    <>
      <ReadState {...list} />
      {!record && list.data && !creating ? (
        <>
          {list.data.watches.length === 0 ? <Notice>{t('empty')}</Notice> : null}
          {list.data.watches.map((watch) => (
            <Btn
              key={watch.id}
              label={`${t(stateKey(watch.state))} · ${new Date(watch.deadline_at).toLocaleString()}`}
              kind="ghost"
              onPress={() => setSelected(watch)}
            />
          ))}
          <Btn label={t('newWatch')} size="lg" onPress={() => setCreating(true)} />
        </>
      ) : null}
      {creating ? (
        <Card>
          <Field label={t('from')} value={from} onChangeText={setFrom} maxLength={160} />
          <Field label={t('to')} value={to} onChangeText={setTo} maxLength={160} />
          <Field
            label={t('eta')}
            value={eta}
            onChangeText={setEta}
            keyboardType="number-pad"
            maxLength={3}
          />
          <Field label={t('cab')} value={cab} onChangeText={setCab} maxLength={160} />
          {invalid ? <Notice>{t('invalid')}</Notice> : null}
          <Btn
            label={t('startWatch')}
            size="lg"
            kind="teal"
            disabled={action.blocked}
            onPress={() => {
              const minutes = Number(eta);
              if (
                !from.trim() ||
                !to.trim() ||
                !Number.isInteger(minutes) ||
                minutes < 1 ||
                minutes > 240
              ) {
                setInvalid(true);
                return;
              }
              setInvalid(false);
              const input = {
                eta_minutes: minutes,
                grace_minutes: 10,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
                from_label: from.trim(),
                to_label: to.trim(),
                ...(cab.trim() ? { cab_note: cab.trim() } : {}),
              };
              void action.run((api, key) => api.startWatch(input, key), complete);
            }}
          />
          <Btn
            label={t('cancel')}
            kind="ghost"
            disabled={action.blocked}
            onPress={() => setCreating(false)}
          />
        </Card>
      ) : null}
      {record ? (
        <>
          <Card tone="teal">
            <T v="h2">{t(stateKey(record.state))}</T>
            <T v="title">
              {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}
            </T>
            <T>
              {t('deadline')}: {new Date(record.deadline_at).toLocaleString()}
            </T>
            <T>
              {t('grace')}: {new Date(record.grace_until).toLocaleString()}
            </T>
          </Card>
          <ReadState {...detail} />
          {!terminal ? (
            <>
              {['active', 'checking_in'].includes(record.state) ? (
                <Btn
                  label={t('extend')}
                  size="lg"
                  disabled={action.blocked}
                  onPress={() => {
                    void action.run(
                      (api, key) =>
                        api.extendWatch(
                          record.id,
                          { add_minutes: 15, expected_version: record.version },
                          key
                        ),
                      complete
                    );
                  }}
                />
              ) : null}
              <Btn
                label={t('safe')}
                size="lg"
                kind="teal"
                disabled={action.blocked}
                onPress={() => {
                  void action.run(
                    (api, key) =>
                      api.safeWatch(record.id, { expected_version: record.version }, key),
                    complete
                  );
                }}
              />
              {record.state !== 'escalated' ? (
                <Btn
                  label={t('cancel')}
                  size="lg"
                  kind="ghost"
                  disabled={action.blocked}
                  onPress={() => {
                    void action.run(
                      (api, key) =>
                        api.cancelWatch(record.id, { expected_version: record.version }, key),
                      complete
                    );
                  }}
                />
              ) : null}
              <Btn
                label={t('safeTitle')}
                kind="ghost"
                onPress={() => router.push({ pathname: '/safe', params: { watchId: record.id } })}
              />
            </>
          ) : (
            <Btn
              label={t('newWatch')}
              onPress={() => {
                setSelected(null);
                setCreating(true);
              }}
            />
          )}
        </>
      ) : null}
      <Notice>{t('quiet')}</Notice>
      <MutationState action={action} />
    </>
  );
}
