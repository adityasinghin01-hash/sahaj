import { NativeModule, requireNativeModule } from 'expo';

import type {
  CallRedirectionResult,
  SahajShieldModuleEvents,
  ShieldPairing,
  ShieldStatus,
} from './SahajShield.types';

declare class SahajShieldModule extends NativeModule<SahajShieldModuleEvents> {
  getStatus(): ShieldStatus;
  requestSmsPermission(): Promise<boolean>;
  /** READ_PHONE_STATE + READ_CONTACTS (+ POST_NOTIFICATIONS on Android 13+). */
  requestPhonePermissions(): Promise<boolean>;
  requestCallScreeningRole(): Promise<boolean>;
  /** ROLE_CALL_REDIRECTION: opens the system role dialog (T4). */
  requestCallRedirectionRole(): Promise<CallRedirectionResult>;
  /** T5: PACKAGE_USAGE_STATS granted in Settings → Usage access. */
  isUsageAccessGranted(): boolean;
  /** T5: package name that came to the foreground in the last 10 s, or null. Throws if usage access is off. */
  foregroundAppNow(): string | null;
  /** T6: Sahaj Maa enabled in Settings → Notification access. */
  isNotificationAccessGranted(): boolean;
  /** T4/T6 service log lines, newest first. Memory only; never numbers or message text. */
  getDebugEvents(): string[];
  requestOverlayPermission(): Promise<boolean>;
  /** Debug screen only: Log.i("SahajShieldTest", message). */
  debugLog(message: string): void;
  /** Returns which screen opened: "request_exemption" | "optimization_list" | "app_details" | "none". */
  openBatteryOptimizationSettings(): string;
  /** Opens the OEM autostart screen when known (Xiaomi/Oppo/Realme/Vivo/OnePlus), else app details. */
  openAutostartSettings(): string;
  setPairing(pairing: ShieldPairing): Promise<boolean>;
  testRedScreen(): boolean;
}

export default requireNativeModule<SahajShieldModule>('SahajShield');
