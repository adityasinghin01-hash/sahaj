import { Alert, Linking, Platform } from 'react-native';

export const RED_CHANNEL = 'shield-red-v2';
export const QUIET_CHANNEL = 'shield-quiet-v2';
export const ALARM_SOUND = 'shield_alarm.wav';
export const ALARM_TEST_ID = 'shield-local-alarm-test';
type Notifications = typeof import('expo-notifications');

export async function prepareShieldChannels(notifications: Notifications) {
  if (Platform.OS !== 'android') return;
  await notifications.setNotificationChannelAsync(RED_CHANNEL, {
    name: 'Shield · Red scam alarm',
    description: 'Urgent scam warnings for Maa · tez alarm',
    importance: notifications.AndroidImportance.MAX,
    sound: ALARM_SOUND,
    vibrationPattern: [0, 800, 400, 800, 400, 800],
    enableVibrate: true,
    enableLights: true,
    lightColor: '#E53935',
    lockscreenVisibility: notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: true,
    audioAttributes: {
      usage: notifications.AndroidAudioUsage.ALARM,
      contentType: notifications.AndroidAudioContentType.SONIFICATION,
    },
  });
  await notifications.setNotificationChannelAsync(QUIET_CHANNEL, {
    name: 'Shield · Yellow updates',
    importance: notifications.AndroidImportance.DEFAULT,
    sound: 'default',
  });
}

let dndOffered = false;
const DND_ASKED_KEY = 'sahaj.shield.dnd.asked.v2';
export async function openAlarmSettings() {
  if (Platform.OS === 'android') {
    await Linking.sendIntent('android.settings.CHANNEL_NOTIFICATION_SETTINGS', [
      { key: 'android.provider.extra.APP_PACKAGE', value: 'app.sahaj.child' },
      { key: 'android.provider.extra.CHANNEL_ID', value: RED_CHANNEL },
    ]);
  } else {
    await Linking.openSettings();
  }
}

/** Permission is optional. Persist before showing so dismissal/Skip never nags. */
export async function offerDndAccessOnce() {
  if (Platform.OS !== 'android' || dndOffered) return;
  dndOffered = true;
  try {
    const store = await import('expo-secure-store');
    if (!(await store.isAvailableAsync()) || await store.getItemAsync(DND_ASKED_KEY)) return;
    await store.setItemAsync(DND_ASKED_KEY, 'yes');
    Alert.alert(
      'Maa ka red alarm · DND access (optional)',
      'Maa ko scam ka khatra ho toh Do Not Disturb mein bhi alarm sunne ke liye Sahaj ko DND access dein. Allow Sahaj in phone settings, then check “Override Do Not Disturb” in Red scam alarm settings. You can skip. Phone settings still control sound and alarm volume.',
      [
        { text: 'Skip / Abhi nahi', style: 'cancel' },
        { text: 'Open DND settings', onPress: () => {
          void Linking.sendIntent('android.settings.NOTIFICATION_POLICY_ACCESS_SETTINGS').catch(() => {
            Alert.alert('Open phone Settings', 'Find Do Not Disturb access and allow Sahaj if you want red alarms during DND.');
          });
        } },
      ],
      { cancelable: true }
    );
  } catch {
    // Optional setup must never stop delivery or expose native error text.
  }
}

/** No session, network, Expo token or EAS project id is needed. */
export async function scheduleTestAlarm() {
  if (Platform.OS === 'web') throw new Error('phone-only');
  const notifications = await import('expo-notifications');
  await prepareShieldChannels(notifications);
  let permission = await notifications.getPermissionsAsync();
  if (!permission.granted && permission.canAskAgain) {
    permission = await notifications.requestPermissionsAsync();
  }
  if (!permission.granted) return false;
  // One fixed identifier prevents repeated taps queuing multiple test alarms.
  await notifications.cancelScheduledNotificationAsync(ALARM_TEST_ID);
  await notifications.scheduleNotificationAsync({
    identifier: ALARM_TEST_ID,
    content: {
      title: '🔴 Test alarm · Maa ka Shield',
      body: 'Sirf alarm test hai. This is a local test; Maa has no new scam alert.',
      sound: Platform.OS === 'ios' ? 'default' : ALARM_SOUND,
      priority: notifications.AndroidNotificationPriority.MAX,
      data: { level: 'red', alarm_test: true, route: '/alert' },
    },
    trigger: {
      type: notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: 2,
      channelId: RED_CHANNEL,
    },
  });
  return true;
}
