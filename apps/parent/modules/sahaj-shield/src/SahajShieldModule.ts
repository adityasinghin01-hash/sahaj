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
  /** ROLE_CALL_REDIRECTION. "not_declared_yet" until the Phase 2 CallRedirectionService exists. */
  requestCallRedirectionRole(): Promise<CallRedirectionResult>;
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
