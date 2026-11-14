/* global __dirname */
// Config plugin for the local sahaj-shield module (Expo SDK 58).
// 1. Writes the Shield permissions, receivers and services into the generated AndroidManifest.xml,
//    plus <queries> for the P4 (remote-control) and P9 (bank/UPI) packages read from rules.json.
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
  // P8: "Phir bhi call karo" re-places the paused call directly (TelecomManager.placeCall).
  // Without it the dialer opens with the number filled in.
  'android.permission.CALL_PHONE',
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

// Step 3.2 (P4): remote-control apps. FALLBACK only: the live list is rules.json patterns.P4.packages
// (see rulesQueryPackages). Same list as AppLists.REMOTE_CONTROL in core/Phase2.kt (a JVM test checks
// they match). <queries> makes them visible to getInstalledPackages on Android 11+.
const REMOTE_CONTROL_PACKAGES = [
  'com.anydesk.anydeskandroid', // AnyDesk
  'com.teamviewer.quicksupport.market', // TeamViewer QuickSupport
  'com.teamviewer.host.market', // TeamViewer Host
  'com.teamviewer.teamviewer.market.mobile', // TeamViewer Remote Control
  'com.carriez.flutter_hbb', // RustDesk
  'com.sand.airdroid', // AirDroid
  'com.sand.airdroidbiz', // AirDroid Business
  'com.sand.airmirror', // AirMirror
];

// P9: banking / UPI apps. FALLBACK only: the live list is rules.json patterns.P9.packages.
// Same list as AppLists.BANKING_UPI in core/Phase2.kt (a JVM test checks they match).
const BANKING_UPI_PACKAGES = [
  'com.google.android.apps.nbu.paisa.user',
  'com.phonepe.app',
  'net.one97.paytm',
  'in.org.npci.upiapp',
  'com.sbi.lotusintouch',
  'com.sbi.SBIFreedomPlus',
  'com.sbi.upi',
  'com.snapwork.hdfc',
  'com.csam.icici.bank.imobile',
  'com.axis.mobile',
  'com.msf.kbank.mobile',
  'com.bankofbaroda.mconnect',
  'com.Version1',
  'com.canarabank.mobility',
  'com.mobikwik_new',
  'com.freecharge.android',
  'com.dreamplug.androidapp',
];

const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

/**
 * Package names for <queries>: rules.json patterns.P4.packages + patterns.P9.packages (the same lists
 * the phone reads at run time through ShieldConfig). A list that is missing or invalid falls back to
 * the constants above, so <queries> always covers what the native code will look for.
 */
function rulesQueryPackages(rulesFile) {
  let patterns = null;
  try {
    if (rulesFile && fs.existsSync(rulesFile)) patterns = JSON.parse(fs.readFileSync(rulesFile, 'utf8')).patterns || null;
  } catch {
    patterns = null;
  }
  const pick = (id, fallback) => {
    const list = patterns && patterns[id] && patterns[id].packages;
    const ok = Array.isArray(list) && list.length > 0 && list.every((p) => typeof p === 'string' && PACKAGE_RE.test(p));
    return ok ? list : fallback;
  };
  return { p4: pick('P4', REMOTE_CONTROL_PACKAGES), p9: pick('P9', BANKING_UPI_PACKAGES) };
}

// Step 3.2 (P3): apps installed outside the Play Store. Instead of QUERY_ALL_PACKAGES (Play-restricted)
// we ask to see every app with a launcher icon, which covers a sideloaded .apk that she can open.
const LAUNCHER_QUERY = {
  action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
  category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
};

function upsertByName(list, item) {
  const name = item.$['android:name'];
  const i = list.findIndex((x) => x.$ && x.$['android:name'] === name);
  if (i >= 0) list[i] = item;
  else list.push(item);
}

function applyManifest(androidManifest, opts = {}) {
  const lists = opts.queryPackages || { p4: REMOTE_CONTROL_PACKAGES, p9: BANKING_UPI_PACKAGES };
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
  for (const p of lists.p4) upsertByName(q.package, { $: { 'android:name': p } });
  // P9: the bank/UPI apps must be visible for the usage-stats foreground check on Android 11+.
  for (const p of lists.p9) upsertByName(q.package, { $: { 'android:name': p } });
  q.intent = q.intent || [];
  if (!q.intent.some((i) => JSON.stringify(i) === JSON.stringify(LAUNCHER_QUERY))) q.intent.push(LAUNCHER_QUERY);

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

  // P8 pause-notification actions (only used without the overlay permission). Not exported.
  upsertByName(app.receiver, {
    $: { 'android:name': `${PKG}.ShieldActionReceiver`, 'android:exported': 'false' },
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

  // T4 logging + P8 (behind the p8_pause_call switch): pauses calls to numbers from flagged SMS.
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

  // T6 logging + P2/P3 (behind switches). WhatsApp / WhatsApp Business only; signals only, never the text.
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
    const rulesFile = path.resolve(c.modRequest.projectRoot, rulesPath);
    c.modResults = applyManifest(c.modResults, { queryPackages: rulesQueryPackages(rulesFile) });
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
module.exports.REMOTE_CONTROL_PACKAGES = REMOTE_CONTROL_PACKAGES;
module.exports.BANKING_UPI_PACKAGES = BANKING_UPI_PACKAGES;
module.exports.rulesQueryPackages = rulesQueryPackages;
