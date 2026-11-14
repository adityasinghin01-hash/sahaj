// Hidden SMS gateway screen (Core 3 Step 3.4). Reached by 7 taps on the version line in Settings.
// Only for a SPARE Android phone that is the "1 Sahaj SMS" number for keypad parents: with the switch
// ON, every SMS this phone receives is forwarded to {api}/api/sms/gateway. It is never Maa's phone.
// The operator types the API URL + gateway secret here; they go straight to native encrypted storage
// (Android Keystore) and are never kept in JS state after saving, never in .env/app.json/the bundle.
import { useFocusEffect } from 'expo-router';
import { MessageSquareText, Save, Trash2 } from 'lucide-react-native';
import * as React from 'react';
import { TextInput, View } from 'react-native';

import { BackBar, BigBtn, BigSwitch, M, MaaScreen, useFont } from '@/components/sahaj/maa';
import { useT } from '@/lib/prefs';
import { shield, shieldAvailable, type GatewayStatus } from '@/lib/shield';
import type { StringKey } from '@/lib/strings';

const ERRORS: Record<string, StringKey> = {
  bad_url: 'gateway_err_bad_url',
  https_required: 'gateway_err_https',
  secret_too_short: 'gateway_err_secret',
  secret_bad_chars: 'gateway_err_secret_chars',
  unavailable: 'gateway_err_unavailable',
};

const STATUS: Record<GatewayStatus['recent'][number]['status'], StringKey> = {
  queued: 'gateway_status_queued',
  sent: 'gateway_status_sent',
  retrying: 'gateway_status_retrying',
  dropped: 'gateway_status_dropped',
};

function when(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function Gateway() {
  const { t } = useT();
  const font = useFont();
  const [status, setStatus] = React.useState<GatewayStatus | null>(() => shield.getGatewayStatus());
  const [url, setUrl] = React.useState('');
  const [secret, setSecret] = React.useState('');
  const [message, setMessage] = React.useState<{ ok: boolean; key: StringKey } | null>(null);
  const refresh = React.useCallback(() => setStatus(shield.getGatewayStatus()), []);
  useFocusEffect(refresh);
  React.useEffect(() => {
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const save = () => {
    const err = shield.setGatewayConfig(url.trim(), secret);
    setSecret(''); // never keep the secret in JS memory longer than needed
    if (err) {
      setMessage({ ok: false, key: ERRORS[err] ?? 'gateway_err_bad_url' });
    } else {
      setUrl('');
      setMessage({ ok: true, key: 'gateway_saved' });
    }
    refresh();
  };

  const toggle = (on: boolean) => {
    const s = shield.setGatewayMode(on);
    if (!s && on) setMessage({ ok: false, key: 'gateway_needs_config' });
    refresh();
  };

  const inputStyle = [font(20, 'medium'), { minHeight: 60 }];

  return (
    <MaaScreen>
      <BackBar title={t('gateway_title')} />
      <M v="body">{t('gateway_why')}</M>

      {!shieldAvailable ? (
        <M v="small" className="mt-6">{t('gateway_err_unavailable')}</M>
      ) : (
        <>
          <View className="mt-6 flex-row items-center rounded-3xl border border-sand-line bg-white px-5 py-4">
            <View className="mr-3 flex-1">
              <M v="strong">{t('gateway_mode')}</M>
              <M v="small">{status?.configured ? (status.apiHost ?? '') : t('gateway_needs_config')}</M>
              {status?.gatewayId ? <M v="small">{status.gatewayId}</M> : null}
            </View>
            <BigSwitch on={!!status?.enabled} label={t('gateway_mode')} onChange={toggle} />
          </View>

          {status && !status.smsPermission ? (
            <BigBtn className="mt-4" kind="soft" icon={MessageSquareText} label={t('gateway_sms')} onPress={() => shield.requestSms().then(refresh)} />
          ) : null}

          <M v="label" className="mb-2 mt-7">{t('gateway_url')}</M>
          <TextInput
            value={url}
            onChangeText={setUrl}
            placeholder="https://"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel={t('gateway_url')}
            className="rounded-2xl border border-sand-line bg-white px-4 text-ink"
            style={inputStyle}
          />
          <M v="label" className="mb-2 mt-4">{t('gateway_secret')}</M>
          <TextInput
            value={secret}
            onChangeText={setSecret}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            textContentType="password"
            importantForAutofill="no"
            accessibilityLabel={t('gateway_secret')}
            className="rounded-2xl border border-sand-line bg-white px-4 text-ink"
            style={inputStyle}
          />
          {message ? (
            <M v="small" className={message.ok ? 'mt-3 text-ok-ink' : 'mt-3 text-danger-ink'}>{t(message.key)}</M>
          ) : null}
          <BigBtn className="mt-4" icon={Save} label={t('gateway_save')} onPress={save} disabled={!url.trim() || !secret} />

          <M v="label" className="mb-2 mt-8">{t('gateway_recent')}</M>
          <View className="rounded-3xl border border-sand-line bg-white px-5">
            {status && status.recent.length > 0 ? (
              status.recent.map((r, i) => (
                <View key={`${r.at}-${i}`} className={i < status.recent.length - 1 ? 'flex-row justify-between border-b border-sand-line py-3' : 'flex-row justify-between py-3'}>
                  <M v="small">{when(r.at)}</M>
                  <M v="strong">{t(STATUS[r.status] ?? 'gateway_status_queued')}</M>
                </View>
              ))
            ) : (
              <M v="small" className="py-4">{t('gateway_none')}</M>
            )}
          </View>
          {status && status.queued > 0 ? <M v="small" className="mt-2">{t('gateway_waiting', { n: status.queued })}</M> : null}

          {status?.configured ? (
            <BigBtn className="mt-8" kind="soft" icon={Trash2} label={t('gateway_clear')} onPress={() => { shield.clearGateway(); refresh(); }} />
          ) : null}
        </>
      )}
    </MaaScreen>
  );
}
