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
