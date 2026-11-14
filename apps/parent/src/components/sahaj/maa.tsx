// Maa-sized primitives on top of the shared Sahaj kit (./ui.tsx) and the same tokens.
// Rules: body ≥ 22 px, buttons ≥ 64 px tall, every button = icon + 1–2 words, haptic on every tap.
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { Check, ChevronLeft, type LucideIcon } from 'lucide-react-native';
import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View, type TextProps } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Tap } from '@/components/sahaj/ui';
import { Icon } from '@/components/ui/icon';
import { usePrefs, useT } from '@/lib/prefs';
import { cn } from '@/lib/utils';

/* ---------- type ---------- */
type MVariant = 'hero' | 'title' | 'h' | 'body' | 'strong' | 'small' | 'label';
type Weight = 'regular' | 'medium' | 'semibold' | 'bold' | 'extrabold';
const SIZES: Record<MVariant, { size: number; line: number; weight: Weight; track?: number; color: string }> = {
  hero: { size: 38, line: 46, weight: 'extrabold', track: -0.9, color: 'text-ink' },
  title: { size: 30, line: 37, weight: 'extrabold', track: -0.6, color: 'text-ink' },
  h: { size: 25, line: 32, weight: 'bold', track: -0.3, color: 'text-ink' },
  body: { size: 22, line: 31, weight: 'regular', color: 'text-ink-2' },
  strong: { size: 22, line: 30, weight: 'semibold', color: 'text-ink' },
  small: { size: 20, line: 27, weight: 'medium', color: 'text-ink-muted' },
  label: { size: 18, line: 24, weight: 'bold', track: 0.6, color: 'text-ink-muted' },
};
const JK: Record<Weight, string> = {
  regular: 'PlusJakartaSans_400Regular',
  medium: 'PlusJakartaSans_500Medium',
  semibold: 'PlusJakartaSans_600SemiBold',
  bold: 'PlusJakartaSans_700Bold',
  extrabold: 'PlusJakartaSans_800ExtraBold',
};
const HI: Record<Weight, string> = {
  regular: 'NotoSansDevanagari_400Regular',
  medium: 'NotoSansDevanagari_400Regular',
  semibold: 'NotoSansDevanagari_600SemiBold',
  bold: 'NotoSansDevanagari_600SemiBold',
  extrabold: 'NotoSansDevanagari_600SemiBold',
};

export function useFont() {
  const { lang, scale } = usePrefs();
  return React.useCallback(
    (size: number, weight: Weight = 'regular', line?: number) => ({
      fontFamily: (lang === 'hi' ? HI : JK)[weight],
      fontSize: Math.round(size * scale),
      // Devanagari needs a taller line for matras.
      lineHeight: Math.round((line ?? size * 1.35) * scale * (lang === 'hi' ? 1.12 : 1)),
    }),
    [lang, scale]
  );
}

/** Maa text. Size scales with Settings → Text size; font switches to Noto Devanagari in Hindi. */
export function M({ v = 'body', className, style, weight, ...p }: TextProps & { v?: MVariant; className?: string; weight?: Weight }) {
  const font = useFont();
  const s = SIZES[v];
  return (
    <Text
      className={cn(s.color, className)}
      style={[font(s.size, weight ?? s.weight, s.line), s.track ? { letterSpacing: s.track } : null, style]}
      {...p}
    />
  );
}

/* ---------- layout ---------- */
export function MaaScreen({ children, scroll = true, className, bg = 'bg-cream' }: { children: React.ReactNode; scroll?: boolean; className?: string; bg?: string }) {
  const body = <View className={cn('flex-1 px-6 pb-10 pt-2', className)}>{children}</View>;
  return (
    <SafeAreaView edges={['top', 'bottom']} className={cn('flex-1', bg)}>
      {scroll ? (
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} showsVerticalScrollIndicator={false}>
          {body}
        </ScrollView>
      ) : (
        body
      )}
    </SafeAreaView>
  );
}

/** Big back button for pushed screens (64 px, icon + word). */
export function BackBar({ title, right }: { title?: string; right?: React.ReactNode }) {
  const { t } = useT();
  return (
    <View className="mb-5 mt-1 flex-row items-center justify-between">
      <Tap
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        accessibilityRole="button"
        accessibilityLabel={t('back')}
        className="h-16 flex-row items-center rounded-full border border-sand-line bg-white pl-3 pr-5">
        <Icon as={ChevronLeft} size={30} className="text-ink" />
        <M v="strong" className="ml-1">{t('back')}</M>
      </Tap>
      {title ? <M v="h" className="ml-4 flex-1 text-right">{title}</M> : <View className="flex-1" />}
      {right}
    </View>
  );
}

/* ---------- buttons ---------- */
type BigKind = 'primary' | 'dark' | 'soft' | 'teal' | 'danger' | 'ok' | 'white' | 'go';
const BIG_KINDS: Record<BigKind, [string, string]> = {
  primary: ['bg-brand', 'text-white'],
  dark: ['bg-ink', 'text-white'],
  soft: ['bg-white border border-sand-line', 'text-ink'],
  teal: ['bg-teal', 'text-white'],
  danger: ['bg-danger', 'text-white'],
  ok: ['bg-ok', 'text-white'],
  // Red-screen buttons, same colours as the native overlay (AlertController.kt).
  white: ['bg-white', 'text-[#C62828]'],
  go: ['bg-[#1B5E20]', 'text-white'],
};

export function BigBtn({ label, icon, onPress, kind = 'primary', className, tall, disabled }: { label: string; icon: LucideIcon; onPress?: () => void; kind?: BigKind; className?: string; tall?: boolean; disabled?: boolean }) {
  const font = useFont();
  const [bg, fg] = BIG_KINDS[kind];
  return (
    <Tap
      onPress={disabled ? undefined : onPress}
      haptic={kind === 'danger' || kind === 'white' ? 'medium' : 'light'}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      className={cn('flex-row items-center justify-center rounded-full px-4', tall ? 'h-[88px]' : 'h-[72px]', bg, disabled && 'opacity-40', className)}>
      <Icon as={icon} size={tall ? 34 : 30} className={cn('mr-3', fg)} />
      <Text className={fg} style={[font(tall ? 26 : 24, 'bold', tall ? 32 : 30), { flexShrink: 1 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>
        {label}
      </Text>
    </Tap>
  );
}

/** Big home tile: icon tile + title + one short line. */
export function BigTile({ icon, title, sub, tone = 'brand', onPress, right }: { icon: LucideIcon; title: string; sub?: string; tone?: 'brand' | 'teal' | 'danger' | 'ok'; onPress?: () => void; right?: React.ReactNode }) {
  const tones = {
    brand: ['bg-brand-soft', 'text-brand-ink'],
    teal: ['bg-teal-soft', 'text-teal-ink'],
    danger: ['bg-danger-soft', 'text-danger-ink'],
    ok: ['bg-ok-soft', 'text-ok-ink'],
  } as const;
  return (
    <Tap onPress={onPress} accessibilityRole="button" accessibilityLabel={title} className="mb-4 min-h-[96px] flex-row items-center rounded-3xl border border-sand-line bg-white px-4 py-4" style={TILE_SHADOW}>
      <View className={cn('h-16 w-16 items-center justify-center rounded-[20px]', tones[tone][0])}>
        <Icon as={icon} size={32} className={tones[tone][1]} />
      </View>
      <View className="ml-4 flex-1">
        <M v="h">{title}</M>
        {sub ? <M v="small" className="mt-0.5">{sub}</M> : null}
      </View>
      {right}
    </Tap>
  );
}

export const TILE_SHADOW = { shadowColor: '#5A2A1E', shadowOpacity: 0.07, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 2 } as const;

function haptic(kind: 'light' | 'heavy' | 'success') {
  if (Platform.OS === 'web') return;
  if (kind === 'success') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  else Haptics.impactAsync(kind === 'heavy' ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}
export const softHaptic = () => haptic('light');
export const successHaptic = () => haptic('success');

/**
 * Hold-to-confirm. Fills left→right over `ms`; letting go early empties it again.
 * Used for Madad (2 s). Completion runs on the JS timer so it never depends on the UI thread.
 */
export function HoldTile({ icon, title, sub, holdingSub, ms = 2000, onComplete }: { icon: LucideIcon; title: string; sub: string; holdingSub: string; ms?: number; onComplete: () => void }) {
  const p = useSharedValue(0);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holding, setHolding] = React.useState(false);
  const fill = useAnimatedStyle(() => ({ width: `${p.value * 100}%` }));
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const start = () => {
    haptic('light');
    setHolding(true);
    p.value = withTiming(1, { duration: ms });
    timer.current = setTimeout(() => {
      timer.current = null;
      setHolding(false);
      haptic('heavy');
      p.value = 0;
      onComplete();
    }, ms);
  };
  const cancel = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
    p.value = withTiming(0, { duration: 220 });
  };
  return (
    <Pressable
      onPressIn={start}
      onPressOut={cancel}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${sub}`}
      className="mb-4 min-h-[96px] flex-row items-center overflow-hidden rounded-3xl bg-danger px-4 py-4"
      style={TILE_SHADOW}>
      <Animated.View style={fill} className="absolute bottom-0 left-0 top-0 bg-danger-ink" />
      <View className="h-16 w-16 items-center justify-center rounded-[20px] bg-white/20">
        <Icon as={icon} size={32} className="text-white" />
      </View>
      <View className="ml-4 flex-1">
        <M v="h" className="text-white">{title}</M>
        <M v="small" className="mt-0.5 text-white/90">{holding ? holdingSub : sub}</M>
      </View>
    </Pressable>
  );
}

/* ---------- small things ---------- */
export function Tick({ on, size = 40 }: { on: boolean; size?: number }) {
  return (
    <View style={{ width: size, height: size, borderRadius: size }} className={cn('items-center justify-center', on ? 'bg-ok' : 'border-2 border-sand-2 bg-white')}>
      {on ? <Icon as={Check} size={Math.round(size * 0.6)} className="text-white" strokeWidth={3} /> : null}
    </View>
  );
}

/** Two big choices side by side (language, text size). */
export function Choice<V extends string>({ value, options, onChange }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  const font = useFont();
  return (
    <View className="flex-row rounded-full bg-sand p-1.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Tap
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            className={cn('h-16 flex-1 items-center justify-center rounded-full', on ? 'bg-ink' : 'bg-transparent')}>
            <Text className={on ? 'text-white' : 'text-ink-2'} style={font(22, 'bold', 28)} numberOfLines={1} adjustsFontSizeToFit>
              {o.label}
            </Text>
          </Tap>
        );
      })}
    </View>
  );
}

/** Big on/off switch (72×44). */
export function BigSwitch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  const x = useSharedValue(on ? 1 : 0);
  React.useEffect(() => {
    x.value = withTiming(on ? 1 : 0, { duration: 180 });
  }, [on, x]);
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * 28 }] }));
  return (
    <Tap
      onPress={() => onChange(!on)}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      className="h-16 w-[88px] items-center justify-center">
      <View className={cn('h-11 w-[72px] justify-center rounded-full px-1', on ? 'bg-ok' : 'bg-sand-2')}>
        <Animated.View style={knob} className="h-9 w-9 rounded-full bg-white" />
      </View>
    </Tap>
  );
}
