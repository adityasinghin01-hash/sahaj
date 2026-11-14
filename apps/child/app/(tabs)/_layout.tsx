import { Icon } from '@/components/ui/icon';
import { Tap, palette } from '@/components/sahaj/ui';
import { cn } from '@/lib/utils';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { Tabs } from 'expo-router';
import { Clock3, House, ShieldCheck, UsersRound, type LucideIcon } from 'lucide-react-native';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ICONS: Record<string, { icon: LucideIcon; label: string }> = {
  index: { icon: House, label: 'Home' },
  shield: { icon: ShieldCheck, label: 'Shield' },
  circle: { icon: UsersRound, label: 'Circle' },
  timeline: { icon: Clock3, label: 'Timeline' },
};

function TabBar({ state, emitter, navigateToTab }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={{ paddingBottom: Math.max(insets.bottom, 14) }}
      className="absolute bottom-0 left-0 right-0 items-center">
      <View
        className="flex-row items-center rounded-full bg-ink px-2 py-2"
        style={{
          shadowColor: palette.ink,
          shadowOpacity: 0.22,
          shadowRadius: 22,
          shadowOffset: { width: 0, height: 10 },
          elevation: 10,
        }}>
        {state.routes.map((route, i) => {
          const focused = state.index === i;
          const meta = ICONS[route.name];
          if (!meta) return null;
          return (
            <Tap
              key={route.key}
              accessibilityLabel={meta.label}
              accessibilityRole="tab"
              accessibilityState={{ selected: focused }}
              onPress={() => {
                const e = emitter.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                });
                if (!focused && !e.defaultPrevented) navigateToTab(route.key);
              }}
              className={cn(
                'mx-0.5 h-12 flex-row items-center justify-center rounded-full',
                focused ? 'bg-cream px-4' : 'w-14'
              )}>
              <Icon as={meta.icon} size={20} className={focused ? 'text-ink' : 'text-white/70'} />
              {focused ? (
                <Text className="ml-2 font-jk-bold text-[14px] text-ink">{meta.label}</Text>
              ) : null}
            </Tap>
          );
        })}
      </View>
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(p) => <TabBar {...p} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: palette.cream } }}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="shield" />
      <Tabs.Screen name="circle" />
      <Tabs.Screen name="timeline" />
    </Tabs>
  );
}
