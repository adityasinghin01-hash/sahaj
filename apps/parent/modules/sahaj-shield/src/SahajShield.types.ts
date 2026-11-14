export type ShieldLevel = 'green' | 'yellow' | 'red';

/** Same shape the native rules engine returns. maskedText is already masked on the phone. */
export type LocalVerdictEvent = {
  level: ShieldLevel;
  reasons: string[];
  matchedRules: string[];
  maskedText: string;
  senderType: string;
  linkDomains: string[];
  /** ScamType from rules.json, e.g. "kyc_block", "otp_theft"; "unknown" if none. */
  scamType: string;
};

export type ShieldStatus = {
  sms: boolean;
  phoneState: boolean;
  contacts: boolean;
  notifications: boolean;
  callScreeningRole: boolean;
  callRedirectionRole: boolean;
  overlay: boolean;
  batteryOptimizationIgnored: boolean;
  autostartScreenAvailable: boolean;
  manufacturer: string;
  sdkInt: number;
  paired: boolean;
  queuedEvents: number;
  rulesVersion: string;
  /** "json" = real JsonRulesEngine running; "none" = rules.json could not be parsed, everything GREEN. */
  rulesEngine: 'json' | 'none';
  /** T5: Settings → Usage access. */
  usageAccess: boolean;
  /** T6: Settings → Notification access. */
  notificationAccess: boolean;
  /** P8: CALL_PHONE granted, so "Phir bhi call karo" re-places the call directly (else the dialer opens). */
  callPhone: boolean;
  /** P8: how many number hashes from flagged SMS are kept (24 h, on the phone only). */
  p8NumbersKept: number;
  /** P9: polling the foreground app right now (unsaved call active and switch on). */
  p9Polling: boolean;
  /** P2: WhatsApp call notifications with a running timer. */
  p2CallsTracked: number;
  /** P6: timing an unsaved-number call right now. */
  p6Timing: boolean;
  /** "rules.json" when every Phase 2/3 threshold/list came from rules.json, else "fallback:<n fields>". */
  configSource: string;
  /** Step 3.4: this phone is the "1 Sahaj SMS" gateway (every SMS is forwarded, no rules). */
  gatewayMode: boolean;
};

/** Last finished call, without the number. */
export type LastCall =
  | { ended: false }
  | {
      ended: true;
      unsaved: boolean;
      /** CallerType: series_1600 | series_140 | mobile_10 | international | saved_contact | unknown. */
      callerType: string;
      incoming: boolean | null;
      /** Incoming 1600-series call: "Ye registered bank number tha". */
      registeredBank: boolean;
      durationSeconds: number;
      endedAt: number;
    };

export type AfterCallAnswer = 'otp_shared' | 'claimed_bank' | 'no';
export type AfterCallReportResult = 'sent' | 'nothing_sent' | 'not_paired';

/** Step 3.4 gateway status. Never contains the secret or the full URL. */
export type GatewayStatus = {
  enabled: boolean;
  configured: boolean;
  apiHost: string | null;
  gatewayId: string | null;
  queued: number;
  smsPermission: boolean;
  /** Last 5 forwards, newest first: time + status only (no number, no text). */
  recent: { at: number; status: 'queued' | 'sent' | 'retrying' | 'dropped' }[];
};

/** null = saved. */
export type GatewayConfigError = 'bad_url' | 'https_required' | 'secret_too_short' | 'secret_bad_chars' | null;

/** Phase 2 features. All OFF by default; each one turns on after its phone test passes. */
export type ShieldFeature =
  | 'p8_pause_call'
  | 'p9_bank_app'
  | 'p2_video_call'
  | 'p3_apk'
  | 'installed_apps'
  | 'p6_long_call';

export const SHIELD_FEATURES: readonly ShieldFeature[] = [
  'p8_pause_call',
  'p9_bank_app',
  'p2_video_call',
  'p3_apk',
  'installed_apps',
  'p6_long_call',
];

export type ShieldFeatures = Record<ShieldFeature, boolean> & {
  /** Divides the P2 10-minute threshold (20 → 30 s). 1 = real time. */
  demoScale: number;
};

export type CallRedirectionResult =
  | 'held'
  | 'denied'
  | 'not_declared_yet'
  | 'role_unavailable'
  | 'unsupported_sdk';

export type ShieldPairing = {
  baseUrl: string;
  deviceId: string;
  deviceSecret: string;
  childNumber: string;
  /** Shown on the red screen button: "<childName> ko call karo". Default "Riya". */
  childName?: string;
  /** Required by ShieldEvent (packages/shared/src/shield.ts). */
  familyId?: string;
  parentId?: string;
};

export type SahajShieldModuleEvents = {
  onVerdict: (verdict: LocalVerdictEvent) => void;
};
