import { NativeModule, requireNativeModule } from 'expo';

import type {
  AfterCallAnswer,
  AfterCallReportResult,
  CallRedirectionResult,
  GatewayConfigError,
  GatewayStatus,
  LastCall,
  SahajShieldModuleEvents,
  ShieldFeature,
  ShieldFeatures,
  ShieldPairing,
  ShieldStatus,
  SignedRequestHeaders,
} from './SahajShield.types';

declare class SahajShieldModule extends NativeModule<SahajShieldModuleEvents> {
  getStatus(): ShieldStatus;
  /** Public origin only, from encrypted pairing storage. */
  getServerAddress(): string;
  /** Signs a Core 1 Maa HTTP request body using stored paired-device HMAC credentials. */
  signRequest(body: string): SignedRequestHeaders | null;
  getUiPreferences(): { lang: string; size: string };
  setUiPreferences(lang: 'en' | 'hi', size: 'large' | 'xlarge'): void;
  requestSmsPermission(): Promise<boolean>;
  /** READ_PHONE_STATE + READ_CONTACTS + CALL_PHONE (+ POST_NOTIFICATIONS on Android 13+). */
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
  /** Phase 2 switches (persisted on the phone). */
  getFeatures(): ShieldFeatures;
  setFeature(name: ShieldFeature, on: boolean): ShieldFeatures;
  setDemoScale(scale: number): ShieldFeatures;
  /** Feeds fake signals through the same code path. "off" when the switch is off. */
  simulateFeature(name: ShieldFeature): string;
  /** Real installed-app scan now; resolves the number of NEW flags (0 when the switch is off). */
  runInstalledAppScan(): Promise<number>;
  testRedScreen(): boolean;
  playWarningLine(line: number, drillHandled: boolean | null): void;
  stopWarningAudio(): void;
  /** Setup wizard: Settings → Usage access. Returns which screen opened. */
  openUsageAccessSettings(): string;
  /** Setup wizard: Settings → Notification access. Returns which screen opened. */
  openNotificationAccessSettings(): string;
  /** Step 3.3: last finished call (no number). */
  getLastCall(): LastCall;
  /** Step 3.3: after-call answer → voice_report event ("no" sends nothing). */
  reportAfterCall(answer: AfterCallAnswer): AfterCallReportResult;
  /** Step 3.4 gateway mode. The secret is stored encrypted natively and never returned. */
  getGatewayStatus(): GatewayStatus;
  setGatewayConfig(apiUrl: string, secret: string): GatewayConfigError;
  setGatewayMode(on: boolean): GatewayStatus;
  clearGateway(): GatewayStatus;
}

export default requireNativeModule<SahajShieldModule>('SahajShield');
