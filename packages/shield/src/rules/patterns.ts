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
}

export type RuleEvent = RuleSmsEvent | RuleCallEvent;

export interface PatternHit {
  id: PatternId;
  rule_id: string;
  level: AlertLevel;
  /** index of the SMS event in the input array that triggered it */
  event_index: number;
}

export function toMs(t: Timestamp): number {
  return typeof t === "number" ? t : Date.parse(t);
}

function smsSenderType(e: RuleSmsEvent): SenderType {
  return e.sender_saved ? "saved_contact" : (e.sender_type ?? senderType(e.sender));
}

function callCallerType(e: RuleCallEvent): CallerType {
  return e.saved_contact ? "saved_contact" : (e.caller_type ?? callerType(e.number));
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

/** Detailed phase-1 pattern hits for every SMS in the event list. */
export function evaluatePatterns(events: RuleEvent[]): PatternHit[] {
  const calls = events.filter((e): e is RuleCallEvent => e.kind === "call");
  const hits: PatternHit[] = [];
  events.forEach((e, i) => {
    if (e.kind !== "sms") return;
    if (checkP1(e, calls)) hits.push({ id: "P1", rule_id: RULES.patterns.P1.id, level: RULES.patterns.P1.level, event_index: i });
    const p5 = checkP5(e);
    if (p5) hits.push({ id: "P5", rule_id: RULES.patterns.P5.id, level: p5, event_index: i });
  });
  return hits;
}

/** Fired pattern ids (P1, P5 in phase 1), de-duplicated, in id order. */
export function findPatterns(events: RuleEvent[]): PatternId[] {
  const ids = new Set(evaluatePatterns(events).map((h) => h.id));
  return (["P1", "P5"] as const).filter((id) => ids.has(id));
}

