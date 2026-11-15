import * as React from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Btn, Card, Field, Notice, Screen, T, TopBar } from '../sahaj/ui';
import { Core2Error } from '../../lib/core2';
import { core2Text, type Core2String, type Lang } from '../../lib/core2-strings';
import { saveSession, useSession } from '../../lib/session';
import type { useCore2Mutation } from '../../lib/useCore2';
let settings: { mode: 'live' | 'demo'; lang: Lang } = { mode: 'live', lang: 'en' };
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
function update(patch: Partial<typeof settings>) {
  settings = { ...settings, ...patch };
  listeners.forEach((fn) => fn());
}
export function useCore2Text() {
  const { lang } = React.useSyncExternalStore(
    subscribe,
    () => settings,
    () => settings
  );
  return (key: Core2String) => core2Text(lang, key);
}
export function Core2Gate({
  title,
  demo,
  children,
}: {
  title: Core2String;
  demo?: React.ReactNode;
  children: React.ReactNode;
}) {
  const prefs = React.useSyncExternalStore(
    subscribe,
    () => settings,
    () => settings
  );
  const { ready, session } = useSession();
  const t = useCore2Text();
  const [family, setFamily] = React.useState(session?.familyId ?? '');
  const [familyError, setFamilyError] = React.useState(false);
  // Family choice matters only for accounts in several families; keep it out of the way unless asked for.
  const [showFamily, setShowFamily] = React.useState(false);
  React.useEffect(() => {
    setFamily(session?.familyId ?? '');
    setFamilyError(false);
  }, [session]);
  const bar = (
    <View className="gap-2 px-4 py-2">
      <T v="small">{t(prefs.mode === 'demo' ? 'demo' : 'live')}</T>
      <View className="flex-row gap-2">
        <Btn
          label={t('language')}
          kind="ghost"
          onPress={() => update({ lang: prefs.lang === 'en' ? 'hi' : 'en' })}
        />
        <Btn
          label={t(prefs.mode === 'demo' ? 'useLive' : 'useDemo')}
          kind="ghost"
          onPress={() => update({ mode: prefs.mode === 'demo' ? 'live' : 'demo' })}
        />
      </View>
    </View>
  );
  if (prefs.mode === 'demo' && demo)
    return (
      <View className="flex-1">
        {bar}
        {demo}
      </View>
    );
  return (
    <Screen>
      <TopBar title={t(title)} />
      {bar}
      {prefs.mode === 'demo' ? (
        <Notice>{t('demo')}</Notice>
      ) : !ready ? (
        <T>{t('loading')}</T>
      ) : !session ? (
        <>
          <Notice>{t('connect')}</Notice>
          <Btn label={t('signIn')} onPress={() => router.push('/sign-in')} />
        </>
      ) : (
        <>
          <View key={`${session.url}|${session.token}|${session.familyId ?? ''}`}>{children}</View>
          {!showFamily && !familyError ? (
            <Btn label={t('familySettings')} kind="ghost" className="mt-6" onPress={() => setShowFamily(true)} />
          ) : (
          <Card className="mt-6">
            <Field
              label={t('family')}
              value={family}
              onChangeText={setFamily}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Btn
              label={t('saveFamily')}
              kind="ghost"
              onPress={() => {
                void saveSession({ ...session, familyId: family }).catch(() =>
                  setFamilyError(true)
                );
              }}
            />
            {familyError ? <Notice>{t('invalid')}</Notice> : null}
          </Card>
          )}
        </>
      )}
    </Screen>
  );
}
export function Failure({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useCore2Text();
  if (!error) return null;
  const key =
    error instanceof Core2Error && error.status === 401
      ? 'sessionExpired'
      : error instanceof Core2Error && error.code === 'family_selection_required'
        ? 'familyRequired'
        : 'failed';
  return (
    <View>
      <Notice tone="sand">
        {t(key)}
        {error instanceof Core2Error ? ` (${error.status}: ${error.code})` : ''}
      </Notice>
      <Btn label={t('retry')} kind="ghost" onPress={retry} />
      {key === 'sessionExpired' ? (
        <Btn label={t('signIn')} onPress={() => router.push('/sign-in')} />
      ) : null}
    </View>
  );
}
export function ReadState({
  data,
  error,
  refresh,
}: {
  data: unknown;
  error: unknown;
  refresh: () => void;
}) {
  const t = useCore2Text();
  return (
    <>
      <Failure error={error} retry={refresh} />
      {!data && !error ? <T>{t('loading')}</T> : null}
      <Btn label={t('refresh')} kind="ghost" onPress={refresh} />
    </>
  );
}
export function MutationState({ action }: { action: ReturnType<typeof useCore2Mutation> }) {
  const t = useCore2Text();
  return (
    <>
      {action.pending ? <T accessibilityLiveRegion="polite">{t('saving')}</T> : null}
      <Failure error={action.error} retry={action.retry} />
      {action.canEdit ? <Btn label={t('edit')} kind="ghost" onPress={action.edit} /> : null}
      {action.success ? <Notice>{t('saved')}</Notice> : null}
    </>
  );
}
export function stateKey(state: string): Core2String {
  if (state === 'safe') return 'safeState';
  if (state === 'failed') return 'failedState';
  if (state === 'verified_accepted') return 'accepted';
  return state as Core2String;
}
