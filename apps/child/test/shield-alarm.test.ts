import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  platform: { OS: 'android' },
  alert: vi.fn(),
  sendIntent: vi.fn(async () => {}),
  stored: new Map<string, string>(),
  permission: vi.fn(),
  requestPermission: vi.fn(),
  channel: vi.fn(async () => null),
  cancel: vi.fn(async () => {}),
  schedule: vi.fn(async (_request: { identifier: string }) => 'local'),
  token: vi.fn(() => { throw new Error('Local alarm must never request a token'); }),
}));
vi.mock('react-native', () => ({
  Platform: fake.platform,
  Alert: { alert: fake.alert },
  Linking: { sendIntent: fake.sendIntent, openSettings: vi.fn() },
}));
vi.mock('expo-secure-store', () => ({
  isAvailableAsync: async () => true,
  getItemAsync: async (key: string) => fake.stored.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { fake.stored.set(key, value); },
}));
vi.mock('expo-notifications', () => ({
  setNotificationChannelAsync: fake.channel,
  getPermissionsAsync: fake.permission,
  requestPermissionsAsync: fake.requestPermission,
  cancelScheduledNotificationAsync: fake.cancel,
  scheduleNotificationAsync: fake.schedule,
  getExpoPushTokenAsync: fake.token,
  AndroidImportance: { MAX: 7, DEFAULT: 5 },
  AndroidAudioUsage: { ALARM: 4 },
  AndroidAudioContentType: { SONIFICATION: 4 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
  AndroidNotificationPriority: { MAX: 2 },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fake.platform.OS = 'android';
  fake.stored.clear();
  fake.permission.mockResolvedValue({ granted: true, canAskAgain: true });
  fake.requestPermission.mockResolvedValue({ granted: false, canAskAgain: false });
});

describe('local Shield alarm (native services faked, no network)', () => {
  it('schedules a red test on the alarm channel without a push token or sign-in', async () => {
    const { scheduleTestAlarm } = await import('../lib/shield-alarm');
    expect(await scheduleTestAlarm()).toBe(true);
    expect(fake.token).not.toHaveBeenCalled();
    expect(fake.schedule).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ sound: 'shield_alarm.wav', data: { level: 'red', alarm_test: true, route: '/alert' } }),
      trigger: { type: 'timeInterval', seconds: 2, channelId: 'shield-red-v2' },
    }));
    expect(fake.channel).toHaveBeenCalledWith('shield-red-v2', expect.objectContaining({
      importance: 7, sound: 'shield_alarm.wav', bypassDnd: true,
      audioAttributes: { usage: 4, contentType: 4 },
      vibrationPattern: [0, 800, 400, 800, 400, 800], lockscreenVisibility: 1,
    }));
  });
  it('creates channels before requesting permission and does not schedule after denial', async () => {
    fake.permission.mockResolvedValue({ granted: false, canAskAgain: true });
    const { scheduleTestAlarm } = await import('../lib/shield-alarm');
    expect(await scheduleTestAlarm()).toBe(false);
    expect(fake.channel.mock.invocationCallOrder[0]).toBeLessThan(fake.requestPermission.mock.invocationCallOrder[0]!);
    expect(fake.schedule).not.toHaveBeenCalled();
  });
  it('does not re-prompt a denied permission that cannot be asked again', async () => {
    fake.permission.mockResolvedValue({ granted: false, canAskAgain: false });
    const { scheduleTestAlarm } = await import('../lib/shield-alarm');
    expect(await scheduleTestAlarm()).toBe(false);
    expect(fake.requestPermission).not.toHaveBeenCalled();
    expect(fake.schedule).not.toHaveBeenCalled();
  });
  it('replaces the pending test instead of stacking scheduled alarms', async () => {
    const { scheduleTestAlarm, ALARM_TEST_ID } = await import('../lib/shield-alarm');
    await scheduleTestAlarm();
    await scheduleTestAlarm();
    expect(fake.cancel).toHaveBeenNthCalledWith(1, ALARM_TEST_ID);
    expect(fake.cancel).toHaveBeenNthCalledWith(2, ALARM_TEST_ID);
    expect(fake.schedule.mock.calls.every(([request]) => request.identifier === ALARM_TEST_ID)).toBe(true);
  });
  it('offers optional DND setup once, persists Skip across app runs, and never opens settings itself', async () => {
    let alarm = await import('../lib/shield-alarm');
    await alarm.offerDndAccessOnce();
    await alarm.offerDndAccessOnce();
    expect(fake.alert).toHaveBeenCalledTimes(1);
    expect(fake.alert.mock.calls[0]![2]).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Skip / Abhi nahi', style: 'cancel' }),
    ]));
    expect(fake.sendIntent).not.toHaveBeenCalled();
    vi.resetModules();
    alarm = await import('../lib/shield-alarm');
    await alarm.offerDndAccessOnce();
    expect(fake.alert).toHaveBeenCalledTimes(1);
  });
  it('uses the default iOS test sound without Android channels', async () => {
    fake.platform.OS = 'ios';
    const { scheduleTestAlarm } = await import('../lib/shield-alarm');
    expect(await scheduleTestAlarm()).toBe(true);
    expect(fake.channel).not.toHaveBeenCalled();
    expect(fake.schedule).toHaveBeenCalledWith(expect.objectContaining({ content: expect.objectContaining({ sound: 'default' }) }));
  });
  it('rejects web testing without requesting native permissions', async () => {
    fake.platform.OS = 'web';
    const { scheduleTestAlarm } = await import('../lib/shield-alarm');
    await expect(scheduleTestAlarm()).rejects.toThrow('phone-only');
    expect(fake.permission).not.toHaveBeenCalled();
    expect(fake.schedule).not.toHaveBeenCalled();
  });
});
