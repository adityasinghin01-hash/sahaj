// One-tap Core 1 entry points for Riya's home (demo and live). Plain English + Hindi, follows the Core 1 lang toggle.
import { router } from 'expo-router';
import { BellRing, CalendarClock, Clock3, Mic, Pill, type LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';
import { Card, IconTile, T, Tap } from './ui';
import { useCore1Lang } from '@/lib/core1';

export type Core1LinkKey = 'maaDay' | 'voice' | 'refills' | 'urgent' | 'freeTimes';

const LINKS: Record<
  Core1LinkKey,
  {
    href: '/maa-day' | '/voice' | '/refills' | '/incident' | '/free-times';
    icon: LucideIcon;
    tone: 'brand' | 'teal' | 'watch' | 'danger' | 'ok';
    en: [string, string];
    hi: [string, string];
  }
> = {
  maaDay: {
    href: '/maa-day',
    icon: CalendarClock,
    tone: 'brand',
    en: ["Maa's day", 'Check-ins and missed calls'],
    hi: ['माँ का दिन', 'चेक-इन और छूटी कॉल'],
  },
  voice: {
    href: '/voice',
    icon: Mic,
    tone: 'teal',
    en: ['Voice to Maa', 'Send your own voice'],
    hi: ['माँ को आवाज़', 'अपनी आवाज़ भेजें'],
  },
  refills: {
    href: '/refills',
    icon: Pill,
    tone: 'watch',
    en: ['Refill approvals', 'Medicines waiting for your yes'],
    hi: ['दवा रिफिल मंज़ूरी', 'आपकी हाँ का इंतज़ार'],
  },
  urgent: {
    href: '/incident',
    icon: BellRing,
    tone: 'danger',
    en: ['Urgent help', 'Live status of who is coming'],
    hi: ['ज़रूरी मदद', 'कौन आ रहा है, अभी की ख़बर'],
  },
  freeTimes: {
    href: '/free-times',
    icon: Clock3,
    tone: 'ok',
    en: ['Free times', 'When you and Maa can talk'],
    hi: ['फ्री समय', 'आप और माँ कब बात कर सकते हैं'],
  },
};

export function Core1Links({ only }: { only: readonly Core1LinkKey[] }) {
  const [lang] = useCore1Lang();
  return (
    <View className="mt-3 flex-row flex-wrap justify-between">
      {only.map((key) => {
        const link = LINKS[key];
        const [title, sub] = link[lang];
        return (
          <View key={key} className="mb-3 w-[48.5%]">
            <Tap accessibilityLabel={title} onPress={() => router.push(link.href)}>
              <Card className="p-4">
                <IconTile icon={link.icon} tone={link.tone} size={38} />
                <T v="h3" className="mt-3">
                  {title}
                </T>
                <T v="small" className="mt-0.5">
                  {sub}
                </T>
              </Card>
            </Tap>
          </View>
        );
      })}
    </View>
  );
}
