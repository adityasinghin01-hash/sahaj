// Debug-only phone test screen for Shield tests T1–T6. Plain RN, no design work.
// Every action logs to the on-screen log and to logcat (tag "SahajShieldTest").
import { useCallback, useEffect, useState } from 'react';
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import SahajShield, { type LocalVerdictEvent, type ShieldStatus } from '../../modules/sahaj-shield';

const STATUS_ROWS: { key: keyof ShieldStatus; label: string }[] = [
  { key: 'sms', label: 'SMS (RECEIVE_SMS + READ_SMS)' },
  { key: 'phoneState', label: 'Phone state' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'notifications', label: 'Post notifications' },
  { key: 'callScreeningRole', label: 'Call screening role' },
  { key: 'callRedirectionRole', label: 'Call redirection role' },
  { key: 'overlay', label: 'Overlay (draw over apps)' },
  { key: 'usageAccess', label: 'Usage access (T5)' },
  { key: 'notificationAccess', label: 'Notification access (T6)' },
  { key: 'batteryOptimizationIgnored', label: 'Battery optimisation exempt' },
  { key: 'paired', label: 'Paired' },
];

function now(): string {
  return new Date().toTimeString().slice(0, 8);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function Btn({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable style={({ pressed }) => [styles.btn, pressed && styles.btnPressed]} onPress={onPress}>
      <Text style={styles.btnText}>{title}</Text>
    </Pressable>
  );
}

export default function ShieldTestScreen() {
  const [status, setStatus] = useState<ShieldStatus | null>(() => {
    if (Platform.OS !== 'android') return null;
    try {
      return SahajShield.getStatus();
    } catch {
      return null;
    }
  });
  const [log, setLog] = useState<string[]>([]);
  const [lastVerdict, setLastVerdict] = useState<string>('none yet');
  const [baseUrl, setBaseUrl] = useState('https://');
  const [deviceId, setDeviceId] = useState('');
  const [secret, setSecret] = useState('');
  const [childNumber, setChildNumber] = useState('');

  const write = useCallback((line: string) => {
    const entry = `${now()} ${line}`;
    try {
      SahajShield.debugLog(entry);
    } catch {
      // module missing (e.g. web); on-screen log still works
    }
    setLog((l) => [entry, ...l].slice(0, 200));
  }, []);

  const refresh = useCallback(() => {
    try {
      const s = SahajShield.getStatus();
      setStatus(s);
      write(`status: ${JSON.stringify(s)}`);
    } catch (e) {
      write(`status ERROR: ${errText(e)}`);
    }
  }, [write]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = SahajShield.addListener('onVerdict', (v: LocalVerdictEvent) => {
      const line = `${v.level.toUpperCase()} · ${v.scamType} · rules=${v.matchedRules.join(',') || '-'} · ${v.reasons[0] ?? ''} · "${v.maskedText.slice(0, 80)}"`;
      setLastVerdict(`${now()} ${line}`);
      write(`onVerdict: ${line}`);
    });
    return () => sub.remove();
  }, [write]);

  const showServiceLog = (prefix: string) => {
    try {
      const lines = SahajShield.getDebugEvents().filter((l) => l.includes(prefix));
      write(`${prefix} service log: ${lines.length === 0 ? 'nothing yet' : `\n${lines.slice(0, 10).join('\n')}`}`);
    } catch (e) {
      write(`${prefix} service log ERROR: ${errText(e)}`);
    }
  };

  const checkForeground = (label: string) => {
    try {
      const pkg = SahajShield.foregroundAppNow();
      write(`${label}: ${pkg ?? 'no app came to the foreground in the last 10 s'}`);
    } catch (e) {
      write(`${label} ERROR: ${errText(e)}`);
    }
  };

  const run = (name: string, fn: () => unknown) => async () => {
    write(`${name}: started`);
    try {
      const r = await fn();
      write(`${name}: ${JSON.stringify(r)}`);
    } catch (e) {
      write(`${name} ERROR: ${errText(e)}`);
    }
    refresh();
  };

  if (Platform.OS !== 'android') {
    return (
      <View style={styles.center}>
        <Text>Shield test screen is Android-only.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.h1}>Shield phone test (debug)</Text>

      <Text style={styles.h2}>Status</Text>
      {STATUS_ROWS.map(({ key, label }) => (
        <View key={key} style={styles.row}>
          <Text style={styles.cell}>{label}</Text>
          <Text style={[styles.mark, status?.[key] ? styles.ok : styles.bad]}>
            {status == null ? '?' : status[key] ? '✓' : '✗'}
          </Text>
        </View>
      ))}
      {status && (
        <Text style={styles.small}>
          {status.manufacturer} · SDK {status.sdkInt} · queued {status.queuedEvents} · rules v
          {status.rulesVersion} ({status.rulesEngine === 'json' ? 'real engine' : 'NO ENGINE, all green'}) · autostart screen {status.autostartScreenAvailable ? 'yes' : 'no'}
        </Text>
      )}
      <Btn title="Refresh status" onPress={refresh} />

      <Text style={styles.h2}>Last SMS verdict</Text>
      <Text style={styles.verdict}>{lastVerdict}</Text>

      <Text style={styles.h2}>T1 · SMS</Text>
      <Btn title="T1 Request SMS permission" onPress={run('T1 requestSmsPermission', () => SahajShield.requestSmsPermission())} />
      <Text style={styles.hint}>
        If Android blocks it: Settings → Apps → Sahaj Maa → ⋮ → Allow restricted settings, then retry
      </Text>
      <Btn
        title="Phone state + contacts + notifications"
        onPress={run('requestPhonePermissions', () => SahajShield.requestPhonePermissions())}
      />

      <Text style={styles.h2}>T2 · Call screening</Text>
      <Btn title="T2 Request call screening role" onPress={run('T2 requestCallScreeningRole', () => SahajShield.requestCallScreeningRole())} />

      <Text style={styles.h2}>T3 · Red screen</Text>
      <Btn title="T3 Overlay permission" onPress={run('T3 requestOverlayPermission', () => SahajShield.requestOverlayPermission())} />
      <Btn title="Show red screen now" onPress={run('T3 testRedScreen', () => SahajShield.testRedScreen())} />
      <Btn
        title="Show red screen in 10 s"
        onPress={() => {
          write('T3 testRedScreen in 10 s: scheduled (start a call now)');
          setTimeout(() => void run('T3 testRedScreen (delayed)', () => SahajShield.testRedScreen())(), 10_000);
        }}
      />

      <Text style={styles.h2}>T4 · Call redirection</Text>
      <Btn
        title="T4 Request call redirection role"
        onPress={run('T4 requestCallRedirectionRole', () => SahajShield.requestCallRedirectionRole())}
      />
      <Text style={styles.hint}>
        Then dial any number: the call must go through unchanged. Tap below to see the log line.
      </Text>
      <Btn title="T4 Show redirection log" onPress={() => showServiceLog('T4')} />

      <Text style={styles.h2}>T5 · Usage access</Text>
      <Btn
        title="T5 Open Usage access settings"
        onPress={run('T5 open usage access', async () => {
          await Linking.sendIntent('android.settings.USAGE_ACCESS_SETTINGS');
          return 'opened: turn on Sahaj Maa, then come back';
        })}
      />
      <Btn title="T5 Is usage access granted?" onPress={run('T5 isUsageAccessGranted', () => SahajShield.isUsageAccessGranted())} />
      <Btn title="T5 Check foreground app now" onPress={() => checkForeground('T5 foregroundAppNow')} />
      <Btn
        title="T5 Check foreground app in 5 s"
        onPress={() => {
          write('T5 foregroundAppNow in 5 s: scheduled (switch to WhatsApp now)');
          setTimeout(() => checkForeground('T5 foregroundAppNow (delayed)'), 5_000);
        }}
      />

      <Text style={styles.h2}>T6 · Notification access</Text>
      <Btn
        title="T6 Open Notification access settings"
        onPress={run('T6 open notification access', async () => {
          await Linking.sendIntent('android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS');
          return 'opened: turn on Sahaj Maa, then come back';
        })}
      />
      <Btn
        title="T6 Is notification access granted?"
        onPress={run('T6 isNotificationAccessGranted', () => SahajShield.isNotificationAccessGranted())}
      />
      <Text style={styles.hint}>
        Then get a WhatsApp message, a WhatsApp call and an .apk document. Tap below to see what was logged.
      </Text>
      <Btn title="T6 Show notification log" onPress={() => showServiceLog('T6')} />

      <Text style={styles.h2}>Staying alive</Text>
      <Btn title="Battery optimisation exemption" onPress={run('openBatteryOptimizationSettings', () => SahajShield.openBatteryOptimizationSettings())} />
      <Btn title="OEM autostart settings" onPress={run('openAutostartSettings', () => SahajShield.openAutostartSettings())} />

      <Text style={styles.h2}>Fake pairing</Text>
      <TextInput style={styles.input} value={baseUrl} onChangeText={setBaseUrl} placeholder="Base URL (https://…)" autoCapitalize="none" autoCorrect={false} />
      <TextInput style={styles.input} value={deviceId} onChangeText={setDeviceId} placeholder="Device id" autoCapitalize="none" autoCorrect={false} />
      <TextInput style={styles.input} value={secret} onChangeText={setSecret} placeholder="Device secret (16+ chars)" autoCapitalize="none" autoCorrect={false} secureTextEntry />
      <TextInput style={styles.input} value={childNumber} onChangeText={setChildNumber} placeholder="Child phone number (for red screen button)" keyboardType="phone-pad" />
      <Btn
        title="setPairing"
        onPress={run('setPairing', () =>
          SahajShield.setPairing({ baseUrl, deviceId, deviceSecret: secret, childNumber }),
        )}
      />

      <Text style={styles.h2}>Log (newest first)</Text>
      <Btn title="Clear log" onPress={() => setLog([])} />
      {log.map((l, i) => (
        <Text key={`${i}-${l}`} style={styles.logLine} selectable>
          {l}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, paddingTop: 48, paddingBottom: 64 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 22, fontWeight: 'bold', marginBottom: 8 },
  h2: { fontSize: 18, fontWeight: 'bold', marginTop: 20, marginBottom: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderColor: '#eee' },
  cell: { fontSize: 16 },
  mark: { fontSize: 18, fontWeight: 'bold' },
  ok: { color: '#1a7f37' },
  bad: { color: '#cf222e' },
  small: { fontSize: 13, color: '#555', marginTop: 6 },
  hint: { fontSize: 14, color: '#555', marginBottom: 6 },
  verdict: { fontSize: 16, padding: 8, backgroundColor: '#f6f8fa' },
  btn: { backgroundColor: '#0969da', borderRadius: 8, paddingVertical: 16, paddingHorizontal: 12, marginVertical: 5 },
  btnPressed: { opacity: 0.7 },
  btnText: { color: '#fff', fontSize: 18, textAlign: 'center' },
  input: { borderWidth: 1, borderColor: '#999', borderRadius: 6, padding: 10, fontSize: 16, marginVertical: 4 },
  logLine: { fontSize: 12, fontFamily: 'monospace', paddingVertical: 2 },
});
