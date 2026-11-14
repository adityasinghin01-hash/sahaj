import { useSession } from '@/lib/session';
import { LiveHarness, LiveLoading } from '@/components/sahaj/live';
import { Icon } from '@/components/ui/icon';
import { Card, Pop, Screen, T, Tap, TopBar } from '@/components/sahaj/ui';
import { demoCall, demoScenes, resetDemo, showToast, shield } from '@/lib/demo';
import { router } from 'expo-router';
import {
  ChevronRight,
  FlaskConical,
  MessageSquareWarning,
  Phone,
  PhoneMissed,
  RotateCcw,
  Timer,
  type LucideIcon,
} from 'lucide-react-native';
import { View } from 'react-native';
const icons: Record<string, LucideIcon> = {
  call: Phone,
  missed: PhoneMissed,
  scam: MessageSquareWarning,
  late: Timer,
  reset: RotateCcw,
};
function DemoDemo() {
  return (
    <Screen>
      <TopBar title="Demo controls" />
      <Pop>
        <View className="mb-4 h-14 w-14 items-center justify-center rounded-2xl bg-brand-soft">
          <Icon as={FlaskConical} size={25} className="text-brand-ink" />
        </View>
        <T v="title">A family day,{'\n'}ready to play.</T>
        <T v="body" className="mt-3">
          Synthetic scenes. No real calls, messages or emergency alerts are sent.
        </T>
      </Pop>
      <View className="mt-6 gap-3">
        {demoScenes.map((scene, i) => (
          <Pop key={scene.id} delay={i * 50}>
            <Tap
              onPress={() => {
                if (scene.id === 'reset') resetDemo();
                if (scene.id === 'call') demoCall();
                if (scene.id === 'missed') router.push('/incident');
                if (scene.id === 'scam')
                  router.push({ pathname: '/alert', params: { id: shield.alerts[0].id } });
                if (scene.id === 'late')
                  router.push({ pathname: '/watch', params: { scene: 'late' } });
                showToast(scene.toast);
              }}>
              <Card className="min-h-24 flex-row items-center">
                <Icon as={icons[scene.id]} size={24} className="text-brand-ink" />
                <View className="ml-4 flex-1">
                  <T v="h2">{scene.label}</T>
                  <T v="small" className="mt-1">
                    {scene.detail}
                  </T>
                </View>
                <Icon as={ChevronRight} size={18} className="ml-2 text-ink-muted" />
              </Card>
            </Tap>
          </Pop>
        ))}
      </View>
      <T v="small" className="mt-6">
        Open this panel again by tapping Riya’s face five times on Home. Reset restores selections
        and pending scenes.
      </T>
    </Screen>
  );
}

export default function Demo() {
  const {ready,session}=useSession();
  if(!ready) return <LiveLoading/>;
  return session ? <LiveHarness/> : <DemoDemo/>;
}
