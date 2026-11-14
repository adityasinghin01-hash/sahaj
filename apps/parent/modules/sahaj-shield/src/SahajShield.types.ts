export type ShieldLevel = 'green' | 'yellow' | 'red';

/** Same shape the native rules engine returns. maskedText is already masked on the phone. */
export type LocalVerdictEvent = {
  level: ShieldLevel;
  reasons: string[];
  matchedRules: string[];
  maskedText: string;
  senderType: string;
  linkDomains: string[];
};

export type ShieldStatus = {
  sms: boolean;
  phoneState: boolean;
  contacts: boolean;
  notifications: boolean;
  callScreeningRole: boolean;
  overlay: boolean;
  batteryOptimizationIgnored: boolean;
  autostartScreenAvailable: boolean;
  manufacturer: string;
  sdkInt: number;
  paired: boolean;
  queuedEvents: number;
  rulesVersion: string;
};

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
