import * as React from 'react';
import { Platform } from 'react-native';
import { Btn, Card, Section, T } from './ui';
import { openAlarmSettings, scheduleTestAlarm } from '@/lib/shield-alarm';

export function AlarmSettings() {
  const pending = React.useRef(false);
  const [message, setMessage] = React.useState('');
  return (
    <Section title="Red alert alarm">
      <Card>
        <T v="body">Maa ka red alert · tez alarm. Yellow alerts stay at normal volume.</T>
        <T v="small" className="mt-2">
          Test before relying on alerts. Keep phone alarm volume audible and allow Shield notifications.
        </T>
        <Btn label="Test alarm" kind="danger" className="mt-4" onPress={() => {
          if (pending.current) return;
          pending.current = true;
          setMessage('Preparing local alarm…');
          void scheduleTestAlarm().then((scheduled) => {
            setMessage(scheduled
              ? 'Local test scheduled. It will sound shortly; you can lock the phone now.'
              : 'Notifications are off. Enable them in phone Settings, then test again.');
          }).catch(() => {
            setMessage(Platform.OS === 'web'
              ? 'Test alarm is available in the installed phone app.'
              : 'Could not schedule the test. Check notification settings and install the latest app build.');
          }).finally(() => { pending.current = false; });
        }} />
        {Platform.OS !== 'web' ? (
          <Btn label="Alarm notification settings" kind="ghost" className="mt-2" onPress={() => {
            void openAlarmSettings().catch(() => setMessage('Open phone Settings → Sahaj → Notifications → Red scam alarm.'));
          }} />
        ) : null}
        {message ? <T v="small" className="mt-3" accessibilityLiveRegion="polite">{message}</T> : null}
      </Card>
    </Section>
  );
}
