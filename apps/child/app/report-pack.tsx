import { useSession } from '@/lib/session';
import { LiveEvidence, LiveLoading } from '@/components/sahaj/live';
import {
  Btn,
  Card,
  LevelPill,
  Notice,
  Pop,
  Screen,
  Section,
  T,
  TopBar,
} from '@/components/sahaj/ui';
import { shield, useDemo, showToast } from '@/lib/demo';
import { useLocalSearchParams } from 'expo-router';
import { Download } from 'lucide-react-native';
import { Platform, Share } from 'react-native';
function DemoReportPack() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const demo = useDemo();
  const alert = id ? shield.alerts.find((row) => row.id === id) : shield.alerts[0];
  if (!alert)
    return (
      <Screen>
        <TopBar title="Report pack" />
        <T v="title">Alert not found</T>
        <T v="body" className="mt-2">
          This alert is not in the demo record. No report will be exported.
        </T>
      </Screen>
    );
  const feedback = demo.feedback[alert.id];
  const text = [
    'SAHAJ · DEMO REPORT PACK',
    'Synthetic data. Not a filed complaint.',
    '',
    alert.type,
    `${alert.time} · ${alert.channel}`,
    '',
    'MASKED MESSAGE',
    alert.snippet,
    '',
    'WHY FLAGGED',
    ...alert.reasons,
    '',
    'WHAT MAA HEARD',
    alert.told,
    '',
    'ACTION TIMELINE',
    ...alert.actions.map((action) => `${action.t} · ${action.a}`),
    '',
    `Family feedback: ${feedback ?? 'Not yet reviewed'}`,
  ].join('\n');
  const exportPack = async () => {
    try {
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `sahaj-demo-${alert.id}.txt`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast('Demo report pack downloaded.');
      } else {
        await Share.share({ title: 'Sahaj demo report pack', message: text });
      }
    } catch {
      showToast('Could not export. Your report is still visible here.');
    }
  };
  return (
    <Screen>
      <TopBar title="Report pack" />
      <Pop>
        <LevelPill level={alert.level} />
        <T v="title" className="mt-4">
          Keep the whole story
        </T>
        <T v="body" className="mt-2">
          A masked copy of this alert, its reasons and what happened next.
        </T>
        <Card className="mt-5">
          <T v="h2">{alert.type}</T>
          <T v="small" className="mt-2">
            {alert.time} · {alert.channel}
          </T>
          <T v="bodyStrong" className="mt-4">
            {alert.snippet}
          </T>
        </Card>
      </Pop>
      <Section title="Included in the pack">
        <Card>
          <T v="body">
            Message with hidden links{'\n'}Why Shield flagged it{'\n'}The warning Maa heard{'\n'}
            Every response, in order{'\n'}Your feedback: {feedback ?? 'Not yet reviewed'}
          </T>
        </Card>
      </Section>
      <Btn label="Export pack" icon={Download} className="mt-6" onPress={exportPack} />
      <Notice tone="sand">
        Demo evidence only · exporting does not file a complaint or contact anyone.
      </Notice>
    </Screen>
  );
}

export default function ReportPack() {
  const {ready,session}=useSession();
  const {id} = useLocalSearchParams<{id?:string}>();
  if(!ready) return <LiveLoading/>;
  return session ? <LiveEvidence id={id ?? ""}/> : <DemoReportPack/>;
}
