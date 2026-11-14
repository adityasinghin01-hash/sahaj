import { useSession } from '@/lib/session';
import { LiveVerify, LiveLoading } from '@/components/sahaj/live';
import { Icon } from '@/components/ui/icon';
import { Btn, Card, LiveDot, Pop, Screen, T, TopBar } from '@/components/sahaj/ui';
import { checkDemoLink, verification } from '@/lib/demo';
import { Check, LockKeyhole, RotateCcw } from 'lucide-react-native';
import * as React from 'react';
import { View } from 'react-native';
function DemoVerify() {
  const [checked, setChecked] = React.useState(0);
  const [run, setRun] = React.useState(0);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    let next = 0;
    const timer = setInterval(() => {
      if (!checkDemoLink(next)) {
        setFailed(true);
        clearInterval(timer);
        return;
      }
      next += 1;
      setChecked(next);
      if (next === verification.length) clearInterval(timer);
    }, 650);
    return () => clearInterval(timer);
  }, [run]);
  const complete = checked === verification.length;
  return (
    <Screen>
      <TopBar title="Verify the record" />
      <Pop>
        <View className="mb-4 h-14 w-14 items-center justify-center rounded-2xl bg-teal-soft">
          <Icon as={LockKeyhole} size={25} className="text-teal-ink" />
        </View>
        <T v="title">Every step connects</T>
        <T v="body" className="mt-2">
          We follow the record from the first check-in to the last response.
        </T>
      </Pop>
      <Card className="mt-6">
        {verification.map((row, i) => (
          <View key={row.id} className={`${i ? 'mt-5' : ''} flex-row items-center`}>
            <View
              className={`h-8 w-8 items-center justify-center rounded-full ${i < checked ? 'bg-teal' : 'bg-sand'}`}>
              {i < checked ? (
                <Pop>
                  <Icon as={Check} size={17} className="text-white" />
                </Pop>
              ) : i === checked && !failed ? (
                <LiveDot />
              ) : (
                <T v="small">{row.step}</T>
              )}
            </View>
            <View className="ml-3 flex-1">
              <T v="small">{row.time}</T>
              <T v="bodyStrong" className="mt-1">
                {row.text}
              </T>
            </View>
          </View>
        ))}
      </Card>
      {complete ? (
        <Pop>
          <Card tone="teal" className="mt-5">
            <T v="h2" className="text-teal-deep">
              All {verification.length} steps match — nothing was changed
            </T>
            <T v="body" className="mt-2 text-teal-deep">
              Each step still points to the one before it.
            </T>
          </Card>
        </Pop>
      ) : (
        <T v="small" className="mt-4" accessibilityLiveRegion="polite">
          {failed
            ? 'A step did not match. This record needs review.'
            : `Checking step ${Math.min(checked + 1, verification.length)} of ${verification.length}…`}
        </T>
      )}
      <T v="small" className="mt-4">
        Demo walkthrough of synthetic links. Real signature verification needs the connected signed
        record.
      </T>
      <Btn
        label="Check again"
        icon={RotateCcw}
        kind="ghost"
        className="mt-5"
        onPress={() => {
          setChecked(0);
          setFailed(false);
          setRun((n) => n + 1);
        }}
      />
    </Screen>
  );
}

export default function Verify() {
  const {ready,session}=useSession();
  if(!ready) return <LiveLoading/>;
  return session ? <LiveVerify/> : <DemoVerify/>;
}
