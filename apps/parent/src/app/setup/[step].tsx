// Setup wizard page. Each step: one-line why, a big [Allow] that calls the module's request
// function, and a ✓ when getStatus() says it is granted. Status refreshes when we come back from
// a system settings screen.
import { router, useLocalSearchParams } from 'expo-router';
import {
  AppWindow,
  ArrowRight,
  BatteryFull,
  Bell,
  BellRing,
  Check,
  Contact,
  Delete,
  EllipsisVertical,
  Gauge,
  Layers,
  MessageSquareText,
  PhoneIncoming,
  RotateCw,
  Settings2,
  ShieldAlert,
  Smartphone,
  ToggleRight,
  type LucideIcon,
} from 'lucide-react-native';
import * as React from 'react';
import { ActivityIndicator, AppState, Linking, View } from 'react-native';

import { BackBar, BigBtn, M, MaaScreen, Tick, successHaptic, useFont } from '@/components/sahaj/maa';
import { Tap } from '@/components/sahaj/ui';
import { Icon } from '@/components/ui/icon';
import { pairWithCode, type PairResult } from '@/lib/pairing';
import { useT } from '@/lib/prefs';
import { RESTRICTED_SETTINGS_SDK, STEPS, sessionDone, type StepId } from '@/lib/setup';
import { shield, shieldAvailable, type ShieldFeatures, type ShieldStatus } from '@/lib/shield';
import { cn } from '@/lib/utils';

const ICONS: Record<StepId, LucideIcon> = {
  pair: Smartphone,
  sms: MessageSquareText,
  phone: Contact,
  overlay: Layers,
  screening: PhoneIncoming,
  restricted: ShieldAlert,
  usage: Gauge,
  notifications: Bell,
  apps: AppWindow,
  battery: BatteryFull,
  test: BellRing,
};

function useStatus() {
  const [status, setStatus] = React.useState<ShieldStatus | null>(() => shield.getStatus());
  const [features, setFeatures] = React.useState<ShieldFeatures | null>(() => shield.getFeatures());
  const refresh = React.useCallback(() => {
    setStatus(shield.getStatus());
    setFeatures(shield.getFeatures());
  }, []);
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh());
    return () => sub.remove();
  }, [refresh]);
  return { status, features, refresh };
}

export default function SetupStep() {
  const { t } = useT();
  const { step: stepParam } = useLocalSearchParams<{ step: string }>();
  const index = Math.max(0, STEPS.findIndex((s) => s.id === stepParam));
  const step = STEPS[index];
  const { status, features, refresh } = useStatus();
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  const [busy, setBusy] = React.useState(false);

  const notNeeded = step.id === 'restricted' && status != null && status.sdkInt < RESTRICTED_SETTINGS_SDK;
  const statusSays = status ? step.granted(status, features) : null;
  const done = notNeeded || statusSays === true || sessionDone.has(step.id);
  const last = index === STEPS.length - 1;

  const markDone = () => {
    sessionDone.add(step.id);
    successHaptic();
    force();
  };

  const allow = async () => {
    setBusy(true);
    try {
      switch (step.id) {
        case 'sms':
          await shield.requestSms();
          break;
        case 'phone':
          await shield.requestPhone();
          break;
        case 'overlay':
          await shield.requestOverlay();
          break;
        case 'screening':
          await shield.requestCallScreening();
          break;
        case 'restricted':
          await Linking.openSettings();
          sessionDone.add('restricted');
          break;
        case 'usage':
          shield.openUsageAccess();
          break;
        case 'notifications':
          shield.openNotificationAccess();
          break;
        case 'apps':
          // Turns on the installed-app check; the module runs the first scan at once, then every 6 h.
          shield.setFeature('installed_apps', true);
          break;
        case 'battery':
          shield.openBattery();
          break;
        case 'test':
          if (shieldAvailable && status?.overlay) shield.testRedScreen();
          else router.push({ pathname: '/warning', params: { test: '1' } });
          markDone();
          break;
        default:
          break;
      }
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const next = () => {
    if (last) router.dismissTo('/');
    else router.push({ pathname: '/setup/[step]', params: { step: STEPS[index + 1].id } });
  };

  const allowLabel =
    step.id === 'test'
      ? t('test_now')
      : step.id === 'restricted' || step.id === 'usage' || step.id === 'notifications'
        ? t('open_settings')
        : step.id === 'apps'
          ? t('turn_on')
          : t('allow');
  const allowIcon =
    step.id === 'test'
      ? BellRing
      : step.id === 'restricted' || step.id === 'usage' || step.id === 'notifications'
        ? Settings2
        : ShieldAlert;

  return (
    <MaaScreen>
      <BackBar title={t('step_of', { n: index + 1, total: STEPS.length })} />
      <View className="mb-6 flex-row gap-1.5">
        {STEPS.map((s, i) => (
          <View key={s.id} className={cn('h-2 flex-1 rounded-full', i <= index ? 'bg-brand' : 'bg-sand-2')} />
        ))}
      </View>

      <View className="flex-row items-center justify-between">
        <View className="h-20 w-20 items-center justify-center rounded-[24px] bg-brand-soft">
          <Icon as={ICONS[step.id]} size={40} className="text-brand-ink" />
        </View>
        <Tick on={done} size={52} />
      </View>
      <M v="title" className="mt-5">{t(step.title)}</M>
      <M v="body" className="mt-1">{t(step.why)}</M>

      <View className="mt-6 flex-1">
        {step.id === 'pair' ? (
          <PairPad paired={done} onPaired={markDone} />
        ) : step.id === 'restricted' && !notNeeded ? (
          <RestrictedGuide />
        ) : !shieldAvailable && step.id !== 'test' ? (
          <M v="small">{t('android_only')}</M>
        ) : null}
        {notNeeded ? <M v="strong" className="text-ok-ink">{t('not_needed')} ✓</M> : null}
        {step.id === 'test' && done ? <M v="strong" className="text-ok-ink">{t('test_done')} ✓</M> : null}
      </View>

      {step.id !== 'pair' && !done ? (
        busy ? (
          <View className="h-[72px] items-center justify-center">
            <ActivityIndicator size="large" color="#C5523A" />
          </View>
        ) : (
          <BigBtn icon={allowIcon} label={allowLabel} onPress={allow} disabled={!shieldAvailable && step.id !== 'test'} />
        )
      ) : null}
      {step.id === 'battery' && shieldAvailable && status?.autostartScreenAvailable ? (
        <BigBtn className="mt-4" kind="soft" icon={RotateCw} label={t('autostart')} onPress={() => shield.openAutostart()} />
      ) : null}
      <BigBtn
        className="mt-4"
        kind={done ? 'dark' : 'soft'}
        icon={last ? Check : ArrowRight}
        label={last ? t('done') : done ? t('next') : t('skip')}
        onPress={next}
      />
    </MaaScreen>
  );
}

/* ---------- pairing: on-screen number pad, no keyboard ---------- */
function PairPad({ paired, onPaired }: { paired: boolean; onPaired: () => void }) {
  const { t } = useT();
  const font = useFont();
  const [code, setCode] = React.useState('');
  const [result, setResult] = React.useState<PairResult | null>(null);
  const [busy, setBusy] = React.useState(false);

  const press = async (d: string) => {
    if (busy || paired) return;
    const nextCode = (code + d).slice(0, 6);
    setCode(nextCode);
    setResult(null);
    if (nextCode.length === 6) {
      setBusy(true);
      const r = await pairWithCode(nextCode);
      setBusy(false);
      setResult(r);
      if (r === 'failed') setCode('');
      else onPaired();
    }
  };

  if (paired) {
    return <M v="strong" className="text-ok-ink">{result === 'demo' ? t('pair_demo') : t('pair_ok')} ✓</M>;
  }
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
  return (
    <View>
      <View className="flex-row justify-between">
        {Array.from({ length: 6 }).map((_, i) => (
          <View key={i} className={cn('h-[68px] w-[48px] items-center justify-center rounded-2xl border-2 bg-white', i === code.length ? 'border-brand' : 'border-sand-line')}>
            <M v="title">{code[i] ?? ''}</M>
          </View>
        ))}
      </View>
      <View className="mt-2 h-8 justify-center">
        {busy ? <ActivityIndicator color="#C5523A" /> : result === 'failed' ? <M v="small" className="text-danger-ink">{t('pair_failed')}</M> : null}
      </View>
      <View className="mt-1 flex-row flex-wrap justify-between">
        {keys.map((k, i) =>
          k === '' ? (
            <View key={i} className="mb-3 h-[68px] w-[31%]" />
          ) : (
            <View key={i} className="mb-3 w-[31%]">
              <Tap
                onPress={() => (k === 'del' ? setCode((c) => c.slice(0, -1)) : press(k))}
                accessibilityRole="button"
                accessibilityLabel={k === 'del' ? 'Delete' : k}
                className="h-[68px] items-center justify-center rounded-2xl bg-sand">
                {k === 'del' ? <Icon as={Delete} size={30} className="text-ink-2" /> : <M v="title" style={font(30, 'bold')}>{k}</M>}
              </Tap>
            </View>
          )
        )}
      </View>
    </View>
  );
}

/* ---------- Android 15+ restricted settings: 3 illustrated steps ---------- */
function RestrictedGuide() {
  const { t } = useT();
  const items: { key: 'restricted_1' | 'restricted_2' | 'restricted_3'; art: React.ReactNode }[] = [
    { key: 'restricted_1', art: <MiniPhone><MiniRow label="App info" icon={Smartphone} highlight /></MiniPhone> },
    { key: 'restricted_2', art: <MiniPhone corner /> },
    { key: 'restricted_3', art: <MiniPhone><MiniRow label="Allow restricted settings" icon={ToggleRight} highlight /></MiniPhone> },
  ];
  return (
    <View className="gap-3">
      {items.map((it, i) => (
        <View key={it.key} className="flex-row items-center rounded-3xl border border-sand-line bg-white p-3">
          {it.art}
          <View className="ml-4 flex-1">
            <M v="label" className="text-brand-ink">{i + 1}</M>
            <M v="strong">{t(it.key)}</M>
          </View>
        </View>
      ))}
    </View>
  );
}

function MiniPhone({ children, corner }: { children?: React.ReactNode; corner?: boolean }) {
  return (
    <View className="h-[92px] w-[72px] overflow-hidden rounded-[14px] border-2 border-ink-2 bg-cream px-1.5 pt-2">
      <View className="flex-row items-center justify-between">
        <View className="h-1.5 w-7 rounded-full bg-sand-2" />
        <View className={cn('rounded-md p-0.5', corner && 'bg-brand')}>
          <Icon as={EllipsisVertical} size={14} className={corner ? 'text-white' : 'text-ink-faint'} />
        </View>
      </View>
      <View className="mt-2 h-1.5 w-10 rounded-full bg-sand-2" />
      <View className="mt-1.5 h-1.5 w-8 rounded-full bg-sand-2" />
      <View className="mt-2">{children}</View>
    </View>
  );
}

function MiniRow({ label, icon, highlight }: { label: string; icon: LucideIcon; highlight?: boolean }) {
  return (
    <View accessibilityLabel={label} className={cn('flex-row items-center rounded-md px-1 py-1', highlight ? 'bg-brand' : 'bg-sand')}>
      <Icon as={icon} size={12} className={highlight ? 'text-white' : 'text-ink-2'} />
      <View className={cn('ml-1 h-1.5 flex-1 rounded-full', highlight ? 'bg-white/80' : 'bg-sand-2')} />
    </View>
  );
}
