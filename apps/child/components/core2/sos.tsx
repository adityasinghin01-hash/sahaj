import * as React from 'react';
import { DeviceBatteryBanner } from './device-banner';
import { Btn, Card, Notice, T } from '../sahaj/ui';
import { type Core2Api, type Sos } from '../../lib/core2';
import { useCore2Mutation, useCore2Read } from '../../lib/useCore2';
import { MutationState, ReadState, stateKey, useCore2Text } from './common';
const load = (api: Core2Api, signal: AbortSignal) => api.sosList({ limit: 50 }, signal);
export function LiveSos() {
  const t = useCore2Text(),
    list = useCore2Read(load),
    action = useCore2Mutation();
  const [selected, setSelected] = React.useState<Sos | null>(null);
  const [confirm, setConfirm] = React.useState(false);
  const detailLoader = React.useCallback(
    (api: Core2Api, signal: AbortSignal) =>
      selected ? api.sos(selected.id, signal) : Promise.resolve(null),
    [selected?.id]
  );
  const detail = useCore2Read(detailLoader);
  const record =
    detail.data?.sos && (!selected || detail.data.sos.version >= selected.version)
      ? detail.data.sos
      : selected;
  const complete = (value: { sos: Sos }) => {
    setSelected(value.sos);
    setConfirm(false);
    detail.refresh();
    list.refresh();
  };
  const terminal = record && ['cancelled', 'safe'].includes(record.status);
  return (
    <>
      <DeviceBatteryBanner />
      <T v="title">{t('sosIntro')}</T>
      <ReadState {...list} />
      {!record && list.data ? (
        <>
          {list.data.sos.length === 0 ? <Notice>{t('empty')}</Notice> : null}
          {list.data.sos.map((sos) => (
            <Btn
              key={sos.id}
              label={`${t(stateKey(sos.status))} · ${sos.created_at ?? sos.id}`}
              kind="ghost"
              onPress={() => setSelected(sos)}
            />
          ))}
        </>
      ) : null}
      {!record && !confirm ? (
        <Btn
          label={t('requestSos')}
          kind="danger"
          size="lg"
          disabled={action.blocked}
          onPress={() => setConfirm(true)}
        />
      ) : null}
      {confirm ? (
        <Card tone="danger">
          <T>{t('confirm')}</T>
          <Btn
            label={t('confirmSos')}
            kind="danger"
            size="lg"
            disabled={action.blocked}
            onPress={() => {
              void action.run((api, key) => api.startSos({ countdown_seconds: 10 }, key), complete);
            }}
          />
          <Btn
            label={t('cancel')}
            kind="ghost"
            disabled={action.blocked}
            onPress={() => setConfirm(false)}
          />
        </Card>
      ) : null}
      {record ? (
        <>
          <Card tone={terminal ? 'teal' : 'danger'}>
            <T v="h2">
              {terminal
                ? t(stateKey(record.status))
                : record.responder_accepted
                  ? t('accepted')
                  : t('waiting')}
            </T>
            <T>{t(stateKey(record.status))}</T>
            <T>{t(stateKey(record.delivery_status))}</T>
            {record.countdown_until ? (
              <T>{new Date(record.countdown_until).toLocaleTimeString()}</T>
            ) : null}
          </Card>
          <ReadState {...detail} />
          {!terminal ? (
            <>
              <Btn
                label={t('cancelSos')}
                kind="ghost"
                size="lg"
                disabled={action.blocked}
                onPress={() => {
                  void action.run(
                    (api, key) =>
                      api.cancelSos(
                        record.id,
                        { reason: 'false_alarm', expected_version: record.version },
                        key
                      ),
                    complete
                  );
                }}
              />
              <Btn
                label={t('safe')}
                kind="teal"
                size="lg"
                disabled={action.blocked}
                onPress={() => {
                  void action.run(
                    (api, key) =>
                      api.cancelSos(
                        record.id,
                        { reason: 'im_safe', expected_version: record.version },
                        key
                      ),
                    complete
                  );
                }}
              />
            </>
          ) : (
            <Btn
              label={t('requestSos')}
              kind="danger"
              size="lg"
              onPress={() => {
                setSelected(null);
                setConfirm(true);
              }}
            />
          )}
        </>
      ) : null}
      <MutationState action={action} />
    </>
  );
}
