/* global __dirname */
// Config plugin for the local sahaj-shield module (Expo SDK 58).
// 1. Writes the Shield permissions, receivers and services into the generated AndroidManifest.xml.
// 2. Copies packages/shield/rules/rules.json into the module's Android assets as shield/rules.json
//    (placeholder { "version": "0" } if the rules file does not exist yet).
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod, AndroidConfig } = require('expo/config-plugins');

const PKG = 'app.sahaj.shield';

const PERMISSIONS = [
  'android.permission.RECEIVE_SMS',
  'android.permission.READ_SMS',
  'android.permission.READ_PHONE_STATE',
  'android.permission.READ_CONTACTS',
  // READ_CALL_LOG is NOT added: TelephonyCallback.CallStateListener / PhoneStateListener need only
  // READ_PHONE_STATE for call state; saved/unsaved comes from the CallScreeningService.
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.INTERNET',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.VIBRATE',
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
];

// OEM autostart screens opened by KeepAlive.kt; <queries> makes them resolvable on Android 11+.
const AUTOSTART_PACKAGES = [
  'com.miui.securitycenter',
  'com.coloros.safecenter',
  'com.oppo.safe',
  'com.vivo.permissionmanager',
  'com.iqoo.secure',
  'com.oneplus.security',
];

function upsertByName(list, item) {
  const name = item.$['android:name'];
  const i = list.findIndex((x) => x.$ && x.$['android:name'] === name);
  if (i >= 0) list[i] = item;
  else list.push(item);
}

function applyManifest(androidManifest) {
  const manifest = androidManifest.manifest;
  manifest.$['xmlns:tools'] = manifest.$['xmlns:tools'] || 'http://schemas.android.com/tools';
  manifest['uses-permission'] = manifest['uses-permission'] || [];
  for (const p of PERMISSIONS) upsertByName(manifest['uses-permission'], { $: { 'android:name': p } });
  // T5: granted by the user in Settings → Usage access. It is a "protected" permission, so lint needs the ignore.
  upsertByName(manifest['uses-permission'], {
    $: { 'android:name': 'android.permission.PACKAGE_USAGE_STATS', 'tools:ignore': 'ProtectedPermissions' },
  });

  manifest.queries = manifest.queries || [{}];
  const q = manifest.queries[0];
  q.package = q.package || [];
  for (const p of AUTOSTART_PACKAGES) upsertByName(q.package, { $: { 'android:name': p } });

  const app = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  app.receiver = app.receiver || [];
  app.service = app.service || [];

  upsertByName(app.receiver, {
    $: {
      'android:name': `${PKG}.SmsReceiver`,
      'android:exported': 'true',
      'android:permission': 'android.permission.BROADCAST_SMS',
    },
    'intent-filter': [
      {
        $: { 'android:priority': '999' },
        action: [{ $: { 'android:name': 'android.provider.Telephony.SMS_RECEIVED' } }],
      },
    ],
  });

  upsertByName(app.receiver, {
    $: { 'android:name': `${PKG}.BootReceiver`, 'android:exported': 'false' },
    'intent-filter': [
      {
        action: [
          { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
          { $: { 'android:name': 'android.intent.action.MY_PACKAGE_REPLACED' } },
        ],
      },
    ],
  });

  upsertByName(app.service, {
    $: {
      'android:name': `${PKG}.ShieldCallScreeningService`,
      'android:exported': 'true',
      'android:permission': 'android.permission.BIND_SCREENING_SERVICE',
    },
    'intent-filter': [
      { action: [{ $: { 'android:name': 'android.telecom.CallScreeningService' } }] },
    ],
  });

  // T4: logging only. Always places the call unmodified (Phase 2 adds real behaviour).
  upsertByName(app.service, {
    $: {
      'android:name': `${PKG}.ShieldCallRedirectionService`,
      'android:exported': 'true',
      'android:permission': 'android.permission.BIND_CALL_REDIRECTION_SERVICE',
    },
    'intent-filter': [
      { action: [{ $: { 'android:name': 'android.telecom.CallRedirectionService' } }] },
    ],
  });

  // T6: logging only. Looks at WhatsApp / WhatsApp Business notifications, logs yes/no facts, never the text.
  upsertByName(app.service, {
    $: {
      'android:name': `${PKG}.ShieldNotificationListener`,
      'android:exported': 'true',
      'android:label': 'Sahaj Maa',
      'android:permission': 'android.permission.BIND_NOTIFICATION_LISTENER_SERVICE',
    },
    'intent-filter': [
      { action: [{ $: { 'android:name': 'android.service.notification.NotificationListenerService' } }] },
    ],
  });

  upsertByName(app.service, {
    $: {
      'android:name': `${PKG}.ShieldForegroundService`,
      'android:exported': 'false',
      'android:foregroundServiceType': 'specialUse',
    },
    property: [
      {
        $: {
          'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
          'android:value':
            'Scam protection for elderly users: watches incoming SMS and call state so a warning can be shown during a fraud call.',
        },
      },
    ],
  });
  return androidManifest;
}

function copyRules(projectRoot, rulesPath) {
  const src = path.resolve(projectRoot, rulesPath);
  const destDir = path.join(__dirname, 'android', 'src', 'main', 'assets', 'shield');
  const dest = path.join(destDir, 'rules.json');
  fs.mkdirSync(destDir, { recursive: true });
  if (fs.existsSync(src)) {
    const text = fs.readFileSync(src, 'utf8');
    JSON.parse(text); // fail prebuild on a broken rules file instead of shipping it
    fs.writeFileSync(dest, text);
  } else {
    fs.writeFileSync(dest, '{ "version": "0" }\n');
  }
  return dest;
}

const withSahajShield = (config, props = {}) => {
  const rulesPath = props.rulesPath || '../../packages/shield/rules/rules.json';
  config = withAndroidManifest(config, (c) => {
    c.modResults = applyManifest(c.modResults);
    return c;
  });
  config = withDangerousMod(config, [
    'android',
    async (c) => {
      copyRules(c.modRequest.projectRoot, rulesPath);
      return c;
    },
  ]);
  return config;
};

module.exports = withSahajShield;
module.exports.applyManifest = applyManifest;
module.exports.copyRules = copyRules;
module.exports.PERMISSIONS = PERMISSIONS;
