// Sahaj design primitives, copied from Riya's app (apps/child/components/sahaj/ui.tsx). Maa-sized
// versions built on top of these live in ./maa.tsx.
import { Icon } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import type { Level } from '@/lib/demo';
import * as Haptics from 'expo-haptics';
import { ChevronLeft, Pause, Play, type LucideIcon } from 'lucide-react-native';
import { router } from 'expo-router';
import * as React from 'react';
import { Platform, Pressable, ScrollView, Text, View, type PressableProps, type TextProps } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

/* ---------- type ---------- */
type TVariant = 'display' | 'title' | 'h2' | 'h3' | 'body' | 'bodyStrong' | 'small' | 'label' | 'num';
const tClass: Record<TVariant, string> = {
  display: 'font-jk-extrabold text-[32px] leading-[38px] tracking-[-0.8px] text-ink',
  title: 'font-jk-extrabold text-[26px] leading-[32px] tracking-[-0.6px] text-ink',
  h2: 'font-jk-bold text-[19px] leading-[25px] tracking-[-0.3px] text-ink',
  h3: 'font-jk-semibold text-[16px] leading-[22px] tracking-[-0.1px] text-ink',
  body: 'font-jk text-[15px] leading-[22px] text-ink-2',
  bodyStrong: 'font-jk-semibold text-[15px] leading-[22px] text-ink',
  small: 'font-jk-medium text-[13px] leading-[18px] text-ink-muted',
  label: 'font-jk-bold text-[11px] leading-[14px] tracking-[1.2px] uppercase text-ink-muted',
  num: 'font-jk-extrabold text-[28px] leading-[32px] tracking-[-0.8px] text-ink',
};
export function T({ v = 'body', className, ...p }: TextProps & { v?: TVariant; className?: string }) {
  return <Text className={cn(tClass[v], className)} {...p} />;
}

/* ---------- haptic press ---------- */
const LAYOUT = /^(flex-1|grow|shrink-0|m[trblxy]?-|-m[trblxy]?-|w-|min-w-|max-w-|self-|basis-|mt-|mb-|ml-|mr-|mx-|my-)/;
function splitLayout(cls?: string) {
  const outer: string[] = [];
  const inner: string[] = [];
  (cls ?? '').split(/\s+/).filter(Boolean).forEach((c) => {
    if (!LAYOUT.test(c)) inner.push(c);
    else {
      outer.push(c);
      // Fixed widths size the pressable too (round icon buttons), not only the wrapper.
      if (/^(w-|min-w-|max-w-)/.test(c)) inner.push(c);
    }
  });
  return { outer: outer.join(' '), inner: inner.join(' ') };
}

/** Pressable with a spring press + haptic. Layout classes (flex-1, margins, widths) go on an outer
 *  wrapper so flex sizing works; visual classes go on the pressable itself. */
export function Tap({ onPress, className, haptic = 'light', ...p }: PressableProps & { className?: string; haptic?: 'light' | 'medium' | 'heavy' | 'none' }) {
  const scale = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const { outer, inner } = splitLayout(className);
  return (
    // Layout classes go on a plain View: NativeWind className on Animated.View is not applied on web.
    <View className={outer}>
    <Animated.View style={style}>
      <Pressable
        className={inner}
        onPressIn={() => scale.set(withSpring(0.97, { damping: 18, stiffness: 420 }))}
        onPressOut={() => scale.set(withSpring(1, { damping: 14, stiffness: 300 }))}
        onPress={(e) => {
          if (haptic !== 'none' && Platform.OS !== 'web') {
            Haptics.impactAsync(
              haptic === 'heavy' ? Haptics.ImpactFeedbackStyle.Heavy : haptic === 'medium' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light
            );
          }
          onPress?.(e);
        }}
        {...p}
      />
    </Animated.View>
    </View>
  );
}

/* ---------- layout ---------- */
export function Screen({ children, scroll = true, className }: { children: React.ReactNode; scroll?: boolean; className?: string }) {
  const body = <View className={cn('px-5 pb-32 pt-2', className)}>{children}</View>;
  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-cream">
      {scroll ? <ScrollView showsVerticalScrollIndicator={false}>{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

export function Card({ children, className, tone = 'white' }: { children: React.ReactNode; className?: string; tone?: 'white' | 'sand' | 'brand' | 'teal' | 'danger' | 'ok' | 'watch' }) {
  const tones = {
    white: 'bg-white border-sand-line',
    sand: 'bg-sand border-transparent',
    brand: 'bg-brand-soft border-transparent',
    teal: 'bg-teal-soft border-transparent',
    danger: 'bg-danger-soft border-transparent',
    ok: 'bg-ok-soft border-transparent',
    watch: 'bg-watch-soft border-transparent',
  } as const;
  return (
    <View
      className={cn('rounded-2xl border p-5', tones[tone], className)}
      style={tone === 'white' ? { shadowColor: '#5A2A1E', shadowOpacity: 0.06, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 2 } : undefined}>
      {children}
    </View>
  );
}

export function Section({ title, action, onAction, children, className }: { title: string; action?: string; onAction?: () => void; children: React.ReactNode; className?: string }) {
  return (
    <View className={cn('mt-7', className)}>
      <View className="mb-3 flex-row items-center justify-between">
        <T v="label">{title}</T>
        {action ? (
          <Pressable onPress={onAction} hitSlop={10}>
            <T v="small" className="font-jk-semibold text-brand-ink">{action}</T>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/* ---------- level colour (only place alert colours are chosen) ---------- */
export const levelStyle: Record<Level, { dot: string; text: string; soft: string; word: string }> = {
  green: { dot: 'bg-ok', text: 'text-ok-ink', soft: 'bg-ok-soft', word: 'All well' },
  yellow: { dot: 'bg-watch', text: 'text-watch-ink', soft: 'bg-watch-soft', word: 'Keep an eye' },
  red: { dot: 'bg-danger', text: 'text-danger-ink', soft: 'bg-danger-soft', word: 'Act now' },
};

export function LevelPill({ level, label }: { level: Level; label?: string }) {
  const s = levelStyle[level];
  return (
    <View className={cn('flex-row items-center self-start rounded-full px-3 py-1.5', s.soft)}>
      {level === 'red' ? <LiveDot color="bg-danger" /> : <View className={cn('h-2 w-2 rounded-full', s.dot)} />}
      <T v="small" className={cn('ml-2 font-jk-bold', s.text)}>{label ?? s.word}</T>
    </View>
  );
}

export function LiveDot({ color = 'bg-teal', size = 8 }: { color?: string; size?: number }) {
  const p = useSharedValue(0);
  React.useEffect(() => {
    p.value = withRepeat(withTiming(1, { duration: 1600, easing: Easing.out(Easing.quad) }), -1, false);
  }, [p]);
  const ring = useAnimatedStyle(() => ({ opacity: 0.45 * (1 - p.value), transform: [{ scale: 1 + p.value * 1.8 }] }));
  return (
    <View style={{ width: size, height: size }} className="items-center justify-center">
      <Animated.View style={[ring, { width: size, height: size, borderRadius: size }]} className={cn('absolute', color)} />
      <View style={{ width: size, height: size, borderRadius: size }} className={color} />
    </View>
  );
}

export function IconTile({ icon, tone = 'sand', size = 44 }: { icon: LucideIcon; tone?: 'sand' | 'brand' | 'teal' | 'ok' | 'watch' | 'danger' | 'ink'; size?: number }) {
  const tones = {
    sand: ['bg-sand', 'text-ink-2'],
    brand: ['bg-brand-soft', 'text-brand-ink'],
    teal: ['bg-teal-soft', 'text-teal-ink'],
    ok: ['bg-ok-soft', 'text-ok-ink'],
    watch: ['bg-watch-soft', 'text-watch-ink'],
    danger: ['bg-danger-soft', 'text-danger-ink'],
    ink: ['bg-ink', 'text-white'],
  } as const;
  return (
    <View style={{ width: size, height: size }} className={cn('items-center justify-center rounded-[14px]', tones[tone][0])}>
      <Icon as={icon} size={Math.round(size * 0.45)} className={tones[tone][1]} />
    </View>
  );
}

export function Row({ icon, tone, title, sub, right, onPress, last }: { icon: LucideIcon; tone?: React.ComponentProps<typeof IconTile>['tone']; title: string; sub?: string; right?: React.ReactNode; onPress?: () => void; last?: boolean }) {
  const inner = (
    <View className={cn('flex-row items-center py-3.5', !last && 'border-b border-sand-line')}>
      <IconTile icon={icon} tone={tone} size={40} />
      <View className="ml-3.5 flex-1">
        <T v="h3">{title}</T>
        {sub ? <T v="small" className="mt-0.5">{sub}</T> : null}
      </View>
      {right}
    </View>
  );
  return onPress ? <Tap onPress={onPress}>{inner}</Tap> : inner;
}

/* ---------- buttons ---------- */
export function Btn({ label, icon, onPress, kind = 'primary', className, size = 'md' }: { label: string; icon?: LucideIcon; onPress?: () => void; kind?: 'primary' | 'dark' | 'soft' | 'ghost' | 'teal' | 'danger'; className?: string; size?: 'md' | 'lg' }) {
  const kinds = {
    primary: ['bg-brand', 'text-white'],
    dark: ['bg-ink', 'text-white'],
    soft: ['bg-sand', 'text-ink'],
    ghost: ['bg-transparent border border-sand-line', 'text-ink'],
    teal: ['bg-teal', 'text-white'],
    danger: ['bg-danger', 'text-white'],
  } as const;
  return (
    <Tap onPress={onPress} haptic={kind === 'danger' ? 'medium' : 'light'} className={cn('flex-row items-center justify-center rounded-full px-5', size === 'lg' ? 'h-14' : 'h-12', kinds[kind][0], className)}>
      {icon ? <Icon as={icon} size={18} className={cn('mr-2', kinds[kind][1])} /> : null}
      <Text className={cn('font-jk-bold text-[15px] tracking-[-0.1px]', kinds[kind][1])}>{label}</Text>
    </Tap>
  );
}

/* ---------- avatar ---------- */
const avatarTones = ['bg-brand-soft text-brand-ink', 'bg-teal-soft text-teal-ink', 'bg-watch-soft text-watch-ink', 'bg-sand-2 text-ink-2'];
export function Face({ name, size = 44, tone }: { name: string; size?: number; tone?: number }) {
  const i = tone ?? (name.charCodeAt(0) + name.length) % avatarTones.length;
  const [bg, fg] = avatarTones[i].split(' ');
  return (
    <View style={{ width: size, height: size, borderRadius: size }} className={cn('items-center justify-center', bg)}>
      <Text style={{ fontSize: size * 0.4 }} className={cn('font-jk-bold', fg)}>{name.charAt(0)}</Text>
    </View>
  );
}

/* ---------- waveform + clip player (real audio wired later) ---------- */
function bars(seed: number, n: number) {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 9301 + 49297) % 233280;
    const r = x / 233280;
    const env = Math.sin((Math.PI * (i + 1)) / (n + 1));
    out.push(0.22 + 0.78 * env * (0.45 + 0.55 * r));
  }
  return out;
}
export function Waveform({ progress = 0, seed = 7, n = 34, color = 'bg-brand', track = 'bg-brand/25', height = 34 }: { progress?: number; seed?: number; n?: number; color?: string; track?: string; height?: number }) {
  const b = React.useMemo(() => bars(seed, n), [seed, n]);
  return (
    <View style={{ height }} className="flex-1 flex-row items-center justify-between">
      {b.map((h, i) => (
        <View key={i} style={{ height: Math.max(4, h * height), width: 3, borderRadius: 3 }} className={i / n <= progress ? color : track} />
      ))}
    </View>
  );
}

export function ClipPlayer({ seconds, seed, tone = 'brand', label }: { seconds: number; seed?: number; tone?: 'brand' | 'teal' | 'danger'; label?: string }) {
  const [playing, setPlaying] = React.useState(false);
  const [p, setP] = React.useState(0);
  React.useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setP((v) => {
        const nv = v + 0.1 / seconds;
        if (nv >= 1) {
          setPlaying(false);
          return 0;
        }
        return nv;
      });
    }, 100);
    return () => clearInterval(id);
  }, [playing, seconds]);
  const c = { brand: ['bg-brand', 'bg-brand/25'], teal: ['bg-teal', 'bg-teal/25'], danger: ['bg-danger', 'bg-danger/25'] }[tone];
  const shown = playing ? Math.ceil(seconds * (1 - p)) : seconds;
  return (
    <View className="flex-row items-center rounded-full bg-white/80 py-2 pl-2 pr-4">
      <Tap onPress={() => setPlaying((x) => !x)} className={cn('h-10 w-10 items-center justify-center rounded-full', c[0])}>
        <Icon as={playing ? Pause : Play} size={18} className="text-white" style={{ marginLeft: playing ? 0 : 2 }} />
      </Tap>
      <View className="ml-3 flex-1">
        <Waveform progress={p} seed={seed} color={c[0]} track={c[1]} height={28} n={30} />
      </View>
      <T v="small" className="ml-3 font-jk-semibold text-ink-2" style={{ fontVariant: ['tabular-nums'] }}>
        {label ?? `0:${String(shown).padStart(2, '0')}`}
      </T>
    </View>
  );
}

/* ---------- small things ---------- */
export function Chip({ label, icon, tone = 'sand' }: { label: string; icon?: LucideIcon; tone?: 'sand' | 'teal' | 'brand' | 'ok' }) {
  const t = { sand: 'bg-sand text-ink-2', teal: 'bg-teal-soft text-teal-ink', brand: 'bg-brand-soft text-brand-ink', ok: 'bg-ok-soft text-ok-ink' }[tone].split(' ');
  return (
    <View className={cn('flex-row items-center self-start rounded-full px-3 py-1.5', t[0])}>
      {icon ? <Icon as={icon} size={13} className={cn('mr-1.5', t[1])} /> : null}
      <Text className={cn('font-jk-semibold text-[12px]', t[1])}>{label}</Text>
    </View>
  );
}

export function Stat({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <View className="flex-1">
      <T v="num">{value}</T>
      <T v="small" className="mt-1 font-jk-semibold text-ink-2">{label}</T>
      {hint ? <T v="small" className="mt-0.5">{hint}</T> : null}
    </View>
  );
}

export function Pop({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const v = useSharedValue(0);
  React.useEffect(() => {
    v.value = withSequence(withTiming(0, { duration: delay }), withSpring(1, { damping: 16, stiffness: 160 }));
  }, [v, delay]);
  const s = useAnimatedStyle(() => ({ opacity: v.value, transform: [{ translateY: (1 - v.value) * 14 }] }));
  return <Animated.View style={s}>{children}</Animated.View>;
}

/* ---------- top bar for pushed screens ---------- */
export function TopBar({ title, right }: { title?: string; right?: React.ReactNode }) {
  return (
    <View className="mb-4 mt-1 flex-row items-center justify-between">
      <Tap onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} className="h-11 w-11 items-center justify-center rounded-full bg-white border border-sand-line">
        <Icon as={ChevronLeft} size={22} className="text-ink" />
      </Tap>
      {title ? <T v="h3" className="flex-1 text-center">{title}</T> : <View className="flex-1" />}
      <View className="h-11 w-11 items-center justify-center">{right}</View>
    </View>
  );
}
