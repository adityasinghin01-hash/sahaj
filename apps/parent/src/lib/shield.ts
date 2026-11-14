// Guarded access to the native Shield module. Shield is Android-only: on web (and iOS) the module
// has no methods, so every call here checks the platform and never throws into a screen.
import { Platform } from 'react-native';

import SahajShield, {
  type AfterCallAnswer,
  type AfterCallReportResult,
  type CallRedirectionResult,
  type GatewayConfigError,
  type GatewayStatus,
  type LastCall,
  type LocalVerdictEvent,
  type ShieldFeature,
  type ShieldFeatures,
  type ShieldPairing,
  type ShieldStatus,
  type SignedRequestHeaders,
} from '../../modules/sahaj-shield';

export { SHIELD_FEATURES } from '../../modules/sahaj-shield';
export type {
  AfterCallAnswer,
  GatewayStatus,
  LastCall,
  LocalVerdictEvent,
  ShieldFeature,
  ShieldFeatures,
  ShieldStatus,
  SignedRequestHeaders,
};

export const shieldAvailable = Platform.OS === 'android';

function safe<T>(fn: () => T, fallback: T): T {
  if (!shieldAvailable) return fallback;
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  if (!shieldAvailable) return fallback;
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export const shield = {
  getServerAddress: () => safe(() => SahajShield.getServerAddress(), ''),
  signRequest: (body: string): SignedRequestHeaders | null => safe(() => SahajShield.signRequest(body), null),
  getUiPreferences: () => safe(() => SahajShield.getUiPreferences(), { lang: 'en', size: 'large' }),
  setUiPreferences: (lang: 'en' | 'hi', size: 'large' | 'xlarge') =>
    safe(() => SahajShield.setUiPreferences(lang, size), undefined),
  getStatus: (): ShieldStatus | null => safe(() => SahajShield.getStatus(), null),
  getFeatures: (): ShieldFeatures | null => safe(() => SahajShield.getFeatures(), null),
  setFeature: (name: ShieldFeature, on: boolean): ShieldFeatures | null =>
    safe(() => SahajShield.setFeature(name, on), null),
  requestSms: () => safeAsync(() => SahajShield.requestSmsPermission(), false),
  requestPhone: () => safeAsync(() => SahajShield.requestPhonePermissions(), false),
  requestOverlay: () => safeAsync(() => SahajShield.requestOverlayPermission(), false),
  requestCallScreening: () => safeAsync(() => SahajShield.requestCallScreeningRole(), false),
  requestCallRedirection: () =>
    safeAsync<CallRedirectionResult | 'unavailable'>(() => SahajShield.requestCallRedirectionRole(), 'unavailable'),
  openBattery: () => safe(() => SahajShield.openBatteryOptimizationSettings(), 'none'),
  openAutostart: () => safe(() => SahajShield.openAutostartSettings(), 'none'),
  setPairing: (p: ShieldPairing) => safeAsync(() => SahajShield.setPairing(p), false),
  testRedScreen: () => safe(() => SahajShield.testRedScreen(), false),
  playWarningLine: (line: number, drillHandled: boolean | null = null) =>
    safe(() => SahajShield.playWarningLine(line, drillHandled), undefined),
  stopWarningAudio: () => safe(() => SahajShield.stopWarningAudio(), undefined),
  openUsageAccess: () => safe(() => SahajShield.openUsageAccessSettings(), 'none'),
  openNotificationAccess: () => safe(() => SahajShield.openNotificationAccessSettings(), 'none'),
  getLastCall: (): LastCall => safe(() => SahajShield.getLastCall(), { ended: false }),
  /** Off Android (preview) nothing is sent. */
  reportAfterCall: (a: AfterCallAnswer): AfterCallReportResult | 'unavailable' =>
    safe<AfterCallReportResult | 'unavailable'>(() => SahajShield.reportAfterCall(a), 'unavailable'),
  getGatewayStatus: (): GatewayStatus | null => safe(() => SahajShield.getGatewayStatus(), null),
  /** Returns null on success, an error code, or 'unavailable'. The secret goes straight to native storage. */
  setGatewayConfig: (apiUrl: string, secret: string): GatewayConfigError | 'unavailable' =>
    safe<GatewayConfigError | 'unavailable'>(() => SahajShield.setGatewayConfig(apiUrl, secret), 'unavailable'),
  setGatewayMode: (on: boolean): GatewayStatus | null => safe(() => SahajShield.setGatewayMode(on), null),
  clearGateway: (): GatewayStatus | null => safe(() => SahajShield.clearGateway(), null),
  /** Subscribes to verdicts; returns an unsubscribe function (no-op off Android). */
  onVerdict(cb: (v: LocalVerdictEvent) => void): () => void {
    if (!shieldAvailable) return () => {};
    try {
      const sub = SahajShield.addListener('onVerdict', cb);
      return () => sub.remove();
    } catch {
      return () => {};
    }
  },
};
