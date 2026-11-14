// Setup wizard steps (Riya does this once on Maa's phone). One page per step.
import type { StringKey } from '@/lib/strings';
import type { ShieldFeatures, ShieldStatus } from '@/lib/shield';

export type StepId =
  | 'pair'
  | 'sms'
  | 'phone'
  | 'overlay'
  | 'screening'
  | 'restricted'
  | 'usage'
  | 'notifications'
  | 'apps'
  | 'battery'
  | 'test';

export type Step = {
  id: StepId;
  title: StringKey;
  why: StringKey;
  /** Granted according to getStatus(); null = the module cannot tell (guide / test steps). */
  granted: (s: ShieldStatus, f: ShieldFeatures | null) => boolean | null;
};

export const STEPS: Step[] = [
  { id: 'pair', title: 'pair_title', why: 'pair_why', granted: (s) => s.paired },
  { id: 'sms', title: 'sms_title', why: 'sms_why', granted: (s) => s.sms },
  { id: 'phone', title: 'phone_title', why: 'phone_why', granted: (s) => s.phoneState && s.contacts },
  { id: 'overlay', title: 'overlay_title', why: 'overlay_why', granted: (s) => s.overlay },
  { id: 'screening', title: 'screening_title', why: 'screening_why', granted: (s) => s.callScreeningRole },
  { id: 'restricted', title: 'restricted_title', why: 'restricted_why', granted: () => null },
  // Usage access + Notification access are "restricted settings" on Android 15 sideloads, so they follow it.
  { id: 'usage', title: 'usage_title', why: 'usage_why', granted: (s) => s.usageAccess },
  { id: 'notifications', title: 'notif_title', why: 'notif_why', granted: (s) => s.notificationAccess },
  { id: 'apps', title: 'apps_title', why: 'apps_why', granted: (_s, f) => (f ? f.installed_apps : null) },
  { id: 'battery', title: 'battery_title', why: 'battery_why', granted: (s) => s.batteryOptimizationIgnored },
  { id: 'test', title: 'test_title', why: 'test_why', granted: () => null },
];

/** Android 15 = API 35: "Allow restricted settings" applies to sideloaded apps. */
export const RESTRICTED_SETTINGS_SDK = 35;

/** Steps done in this session that getStatus() cannot see (demo pairing, guide opened, test shown). */
export const sessionDone = new Set<StepId>();
