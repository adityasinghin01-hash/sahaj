import type { AlertLevel, PatternId } from "@sahaj/shared";
import { RULES } from "./config";
import { isShortener, lookAlikeDetail, findLinks } from "./links";
import { isOtp } from "./otp";
import { hasTopicWords } from "./score";
import { callerType, senderType, type CallerType, type SenderType } from "./sender";

export type Timestamp = number | string;

export interface RuleSmsEvent {
  kind: "sms";
  /** epoch ms or ISO string */
  at: Timestamp;
  /** raw sender (header or number). Optional when sender_type is given (masked server-side data). */
  sender?: string;
  sender_type?: SenderType;
  sender_saved?: boolean;
  text: string;
}

export interface RuleCallEvent {
  kind: "call";
  /** call start: epoch ms or ISO string */
  at: Timestamp;
  /** call end; omitted while the call is still active */
  ended_at?: Timestamp;
  number?: string;
  caller_type?: CallerType;
  saved_contact?: boolean;
  direction?: "in" | "out";
  video?: boolean;
  source?: string;
  whatsapp_call_unsaved?: boolean;
  duration_ms?: number;
  long_vs_normal?: boolean;
  claimed_bank?: boolean;
  cancelled?: boolean;
}

export interface RuleVoiceReportEvent {
  kind: "voice_report";
  at: Timestamp;
  number?: string;
  caller_type?: CallerType;
  saved_contact?: boolean;
  claimed_bank?: boolean;
  text?: string;
}

export interface RuleAppOpenEvent {
  kind: "app_open";
  at: Timestamp;
  package?: string;
  on_call_with_unsaved?: boolean;
  saved_contact?: boolean;
  caller_type?: CallerType;
}

export interface RuleNotificationEvent {
  kind: "notification";
  at: Timestamp;
  source?: string;
  whatsapp_call_unsaved?: boolean;
  call_seconds?: number;
  attachment_apk?: boolean;
  cancelled?: boolean;
  ended_at?: Timestamp;
  saved_contact?: boolean;
  caller_type?: CallerType;
  text?: string;
}

export interface RuleInstallEvent {
  kind: "install";
  at: Timestamp;
  package?: string;
  installer?: string;
  installed_hours_ago?: number;
  is_system?: boolean;
}

export type RuleEvent =
  | RuleSmsEvent
  | RuleCallEvent
  | RuleAppOpenEvent
  | RuleNotificationEvent
  | RuleInstallEvent
  | RuleVoiceReportEvent;

export interface PatternHit {
  id: PatternId;
  rule_id: string;
  level: AlertLevel;
  /** index of the triggering event in the input array */
  event_index: number;
}

const PATTERN_ORDER: readonly PatternId[] = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"];

export function toMs(t: Timestamp): number {
  return typeof t === "number" ? t : Date.parse(t);
}

function smsSenderType(e: RuleSmsEvent): SenderType {
  return e.sender_saved ? "saved_contact" : (e.sender_type ?? senderType(e.sender));
}

function callCallerType(e: RuleCallEvent): CallerType {
  return e.saved_contact ? "saved_contact" : (e.caller_type ?? callerType(e.number));
}

function isAllowedUnknownCaller(
  allowed: readonly CallerType[],
  savedContact?: boolean,
  explicitType?: CallerType,
  number?: string,
): boolean {
  if (savedContact) return false;
  const ct = explicitType ?? callerType(number);
  return allowed.includes(ct);
}

/** P1: OTP SMS during a call with an unknown number (or within window_after_call_ms after it ended). */
export function checkP1(sms: RuleSmsEvent, calls: RuleCallEvent[]): boolean {
  const P1 = RULES.patterns.P1;
  if (!isOtp(sms.text)) return false;
  const at = toMs(sms.at);
  if (!Number.isFinite(at)) return false;
  return calls.some((c) => {
    if (!P1.caller_types.includes(callCallerType(c))) return false;
    const start = toMs(c.at);
    const end = c.ended_at === undefined ? Number.POSITIVE_INFINITY : toMs(c.ended_at);
    return Number.isFinite(start) && at >= start && at <= end + P1.window_after_call_ms;
  });
}

/** P5: link + bank/electricity/courier words + risky sender → red; one of the two → yellow. */
export function checkP5(sms: RuleSmsEvent): AlertLevel | null {
  const P5 = RULES.patterns.P5;
  const links = findLinks(sms.text);
  if (links.length === 0) return null;
  const st = smsSenderType(sms);
  const topic = hasTopicWords(sms.text);
  const risky = P5.risky_sender_types.includes(st);
  if (topic && risky) return "red";
  if (!topic && !risky) return null;
  const trusted = st === "business_header" || st === "saved_contact";
  if (trusted) {
    const badLink = links.some((l) => isShortener(l.host) || lookAlikeDetail(l.host).look_alike);
    return badLink ? "yellow" : null;
  }
  return "yellow";
}

function callDurationMs(call: RuleCallEvent, evalAtMs?: number): number | null {
  if (typeof call.duration_ms === "number" && Number.isFinite(call.duration_ms) && call.duration_ms >= 0) {
    return call.duration_ms;
  }
  const start = toMs(call.at);
  if (!Number.isFinite(start)) return null;
  if (call.ended_at !== undefined) {
    const end = toMs(call.ended_at);
    return Number.isFinite(end) && end >= start ? end - start : null;
  }
  if (evalAtMs !== undefined && Number.isFinite(evalAtMs) && evalAtMs >= start) {
    return evalAtMs - start;
  }
  return null;
}

/** P2: long (>= 10 min) video or WhatsApp call with an unknown number. */
export function checkP2Call(call: RuleCallEvent, evalAt?: Timestamp): boolean {
  const P2 = RULES.patterns.P2;
  if (call.cancelled) return false;
  if (!isAllowedUnknownCaller(P2.caller_types, call.saved_contact, call.caller_type, call.number)) return false;
  const isVideoOrWhatsApp = call.video === true || call.whatsapp_call_unsaved === true || call.source === "whatsapp";
  if (P2.require_video_or_whatsapp && !isVideoOrWhatsApp) return false;
  const evalAtMs = evalAt !== undefined ? toMs(evalAt) : undefined;
  const duration = callDurationMs(call, evalAtMs);
  return duration !== null && duration >= P2.min_duration_ms;
}

/** P2 notification form (WhatsApp ongoing unsaved call duration >= 10 min). */
export function checkP2Notification(notif: RuleNotificationEvent): boolean {
  const P2 = RULES.patterns.P2;
  if (notif.cancelled || notif.ended_at !== undefined) return false;
  if (notif.saved_contact) return false;
  if (notif.caller_type && !P2.caller_types.includes(notif.caller_type)) return false;
  if (notif.whatsapp_call_unsaved !== true) return false;
  if (typeof notif.call_seconds !== "number" || !Number.isFinite(notif.call_seconds) || notif.call_seconds < 0) {
    return false;
  }
  return notif.call_seconds * 1000 >= P2.min_duration_ms;
}

/** P9: banking or UPI app opened while a call with an unknown number is active. */
export function checkP9(appOpen: RuleAppOpenEvent, calls: RuleCallEvent[]): boolean {
  const P9 = RULES.patterns.P9;
  if (!appOpen.package || !P9.packages.includes(appOpen.package)) return false;
  if (appOpen.saved_contact) return false;
  if (appOpen.caller_type && !P9.caller_types.includes(appOpen.caller_type)) return false;
  const at = toMs(appOpen.at);
  if (!Number.isFinite(at)) return false;
  if (calls.length > 0) {
    return calls.some((c) => {
      if (!P9.caller_types.includes(callCallerType(c))) return false;
      const start = toMs(c.at);
      const end = c.ended_at === undefined ? Number.POSITIVE_INFINITY : toMs(c.ended_at);
      return Number.isFinite(start) && at >= start && at <= end;
    });
  }
  return appOpen.on_call_with_unsaved === true;
}

/** P3 (notification): .apk attachment signal. */
export function checkP3Notification(notif: RuleNotificationEvent): boolean {
  return notif.cancelled !== true && notif.attachment_apk === true;
}

/** P3 (install): non-system app recently (<= 24h) installed outside Play Store. */
export function checkP3Install(install: RuleInstallEvent): boolean {
  const P3 = RULES.patterns.P3;
  if (install.is_system) return false;
  if (typeof install.installer !== "string" || !install.installer.trim()) return false;
  if (P3.play_store_installers.includes(install.installer)) return false;
  if (
    typeof install.installed_hours_ago !== "number" ||
    !Number.isFinite(install.installed_hours_ago) ||
    install.installed_hours_ago < 0
  ) {
    return false;
  }
  return install.installed_hours_ago <= P3.recent_install_hours;
}

/** P4 (install): known remote-control / screen-sharing package installed. */
export function checkP4Install(install: RuleInstallEvent): boolean {
  if (typeof install.package !== "string" || !install.package.trim()) return false;
  return RULES.patterns.P4.packages.includes(install.package);
}

/** P6: unusually long voice call with an unsaved caller (video/WhatsApp calls stay P2). */
export function checkP6(call: RuleCallEvent, evalAt?: Timestamp): boolean {
  const P6 = RULES.patterns.P6;
  if (call.cancelled || call.video === true) return false;
  if (checkP2Call(call, evalAt)) return false;
  if (!isAllowedUnknownCaller(P6.caller_types, call.saved_contact, call.caller_type, call.number)) return false;
  if (call.long_vs_normal === true) return true;
  const evalAtMs = evalAt !== undefined ? toMs(evalAt) : undefined;
  const duration = callDurationMs(call, evalAtMs);
  return duration !== null && duration >= P6.min_duration_ms;
}

function isTrustedBankCaller(savedContact?: boolean, explicitType?: CallerType, number?: string): boolean {
  if (explicitType === "series_1600") return true;
  const ct = savedContact ? "saved_contact" : (explicitType ?? callerType(number));
  return RULES.patterns.P7.trusted_caller_types.includes(ct);
}

/** P7: call or voice_report claiming to be a bank from a non-1600 caller. */
export function checkP7(event: RuleCallEvent | RuleVoiceReportEvent): boolean {
  if (event.claimed_bank !== true) return false;
  if (event.kind === "call" && event.cancelled) return false;
  return !isTrustedBankCaller(event.saved_contact, event.caller_type, event.number);
}

/** S4: informational green note when caller is a registered 1600-series bank number. */
export function checkS4(event: { caller_type?: CallerType; number?: string; saved_contact?: boolean }): boolean {
  if (event.caller_type === "series_1600") return true;
  if (event.saved_contact) return false;
  return (event.caller_type ?? callerType(event.number)) === "series_1600";
}

/** Detailed pattern hits for Phase 2 signal/sequence evaluation (excluding SMS P1/P5). */
export function evaluatePhase2Patterns(events: RuleEvent[], evalAt?: Timestamp): PatternHit[] {
  const calls = events.filter((e): e is RuleCallEvent => e.kind === "call");
  const hits: PatternHit[] = [];
  events.forEach((e, i) => {
    if (e.kind === "call") {
      if (checkP2Call(e, evalAt)) {
        hits.push({ id: "P2", rule_id: RULES.patterns.P2.id, level: RULES.patterns.P2.level, event_index: i });
      }
      if (checkP6(e, evalAt)) {
        hits.push({ id: "P6", rule_id: RULES.patterns.P6.id, level: RULES.patterns.P6.level, event_index: i });
      }
      if (checkP7(e)) {
        hits.push({ id: "P7", rule_id: RULES.patterns.P7.id, level: RULES.patterns.P7.level, event_index: i });
      }
    } else if (e.kind === "voice_report") {
      if (checkP7(e)) {
        hits.push({ id: "P7", rule_id: RULES.patterns.P7.id, level: RULES.patterns.P7.level, event_index: i });
      }
    } else if (e.kind === "app_open" && checkP9(e, calls)) {
      hits.push({ id: "P9", rule_id: RULES.patterns.P9.id, level: RULES.patterns.P9.level, event_index: i });
    } else if (e.kind === "notification") {
      if (checkP2Notification(e)) {
        hits.push({ id: "P2", rule_id: RULES.patterns.P2.id, level: RULES.patterns.P2.level, event_index: i });
      }
      if (checkP3Notification(e)) {
        hits.push({ id: "P3", rule_id: RULES.patterns.P3.id, level: RULES.patterns.P3.level, event_index: i });
      }
    } else if (e.kind === "install") {
      if (checkP3Install(e)) {
        hits.push({ id: "P3", rule_id: RULES.patterns.P3.id, level: RULES.patterns.P3.level, event_index: i });
      }
      if (checkP4Install(e)) {
        hits.push({ id: "P4", rule_id: RULES.patterns.P4.id, level: RULES.patterns.P4.level, event_index: i });
      }
    }
  });
  return hits;
}

/** Detailed pattern hits for every event in the event list (Phase 1 + Phase 2). */
export function evaluatePatterns(events: RuleEvent[], evalAt?: Timestamp): PatternHit[] {
  const calls = events.filter((e): e is RuleCallEvent => e.kind === "call");
  const hits: PatternHit[] = [];
  events.forEach((e, i) => {
    if (e.kind !== "sms") return;
    if (checkP1(e, calls)) hits.push({ id: "P1", rule_id: RULES.patterns.P1.id, level: RULES.patterns.P1.level, event_index: i });
    const p5 = checkP5(e);
    if (p5) hits.push({ id: "P5", rule_id: RULES.patterns.P5.id, level: p5, event_index: i });
  });
  hits.push(...evaluatePhase2Patterns(events, evalAt));
  return hits.sort((a, b) => a.event_index - b.event_index);
}

/** Fired pattern ids, de-duplicated, in deterministic id order. */
export function findPatterns(events: RuleEvent[], evalAt?: Timestamp): PatternId[] {
  const ids = new Set(evaluatePatterns(events, evalAt).map((h) => h.id));
  return PATTERN_ORDER.filter((id) => ids.has(id));
}

