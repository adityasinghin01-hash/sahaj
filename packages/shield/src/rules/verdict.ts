import type { AlertLevel, ScamType, ShieldAction, Verdict } from "@sahaj/shared";
import { RULES, SCRIPT_TYPE_IDS, type ReasonText } from "./config";
import { checkP1, checkP5, toMs, type RuleCallEvent, type RuleEvent, type RuleSmsEvent, type Timestamp } from "./patterns";
import { isOtp } from "./otp";
import { clampScore, scoreText, type RuleHit } from "./score";
import { callerRule, callerType, senderRule, senderType, type CallerType, type SenderType } from "./sender";

export interface VerdictInput {
  /** message text, raw or already masked */
  text?: string;
  /** raw SMS sender (header / number) */
  sender?: string;
  /** pre-classified sender (use when only masked data is available) */
  sender_type?: SenderType;
  sender_saved?: boolean;
  /** number of a call that is active right now (or the call being judged) */
  caller?: string;
  caller_type?: CallerType;
  caller_saved?: boolean;
  /** when the message arrived / the situation is judged (default: now) */
  at?: Timestamp;
  /** recent context: calls and SMS (e.g. last 30 min) used by P1 */
  events?: RuleEvent[];
}

export interface RuleVerdict extends Verdict {
  /** true when the score sits inside thresholds.ask_ai_between and no hard rule decided it */
  needs_ai: boolean;
  score: number;
  sender_type?: SenderType;
  caller_type?: CallerType;
}

const LEVEL_RANK: Record<AlertLevel, number> = { green: 0, yellow: 1, red: 2 };
const maxLevel = (a: AlertLevel, b: AlertLevel): AlertLevel => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a);

/** rule_id → bilingual reason, built once from rules.json */
const REASONS: Record<string, ReasonText> = (() => {
  const r: Record<string, ReasonText> = {};
  for (const s of RULES.sender.rules) r[s.id] = s.reason;
  r[RULES.sender.mobile_claims_brand.id] = RULES.sender.mobile_claims_brand.reason;
  r[RULES.sender.saved_contact.id] = RULES.sender.saved_contact.reason;
  for (const c of RULES.caller.rules) r[c.id] = c.reason;
  r[RULES.otp.id] = RULES.otp.reason;
  const L = RULES.links;
  for (const x of [L.present, L.shortener, L.apk, L.look_alike, L.punycode]) r[x.id] = x.reason;
  for (const g of RULES.generic_signals) r[g.id] = g.reason;
  for (const t of SCRIPT_TYPE_IDS) r[`script.${t}`] = RULES.scam_scripts.types[t].reason;
  r[RULES.patterns.P1.id] = RULES.patterns.P1.reason;
  r[`${RULES.patterns.P5.id}.red`] = RULES.patterns.P5.red.reason;
  r[`${RULES.patterns.P5.id}.yellow`] = RULES.patterns.P5.yellow.reason;
  return r;
})();

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function confidenceFor(level: AlertLevel, score: number, forced: boolean, needsAi: boolean): number {
  const { red_at, yellow_at, max_score } = RULES.thresholds;
  let c: number;
  if (forced) c = 0.95;
  else if (level === "red") c = 0.7 + 0.25 * Math.min(1, (score - red_at) / Math.max(1, max_score - red_at));
  else if (level === "yellow") c = 0.5 + 0.2 * ((score - yellow_at) / Math.max(1, red_at - yellow_at));
  else c = 0.9 - 0.4 * (score / Math.max(1, yellow_at));
  if (needsAi) c = Math.min(c, 0.6);
  return round2(Math.max(0, Math.min(1, c)));
}

/**
 * Decide green / yellow / red for one SMS or call situation using only local rules.
 * Hard rules (APK link, pattern P1, P5-red) force red; P5-yellow lifts to at least yellow.
 */
export function buildVerdict(input: VerdictInput): RuleVerdict {
  const hits: RuleHit[] = [];
  const reasonIds: string[] = [];
  const addReason = (id: string) => {
    if (REASONS[id] && !reasonIds.includes(id)) reasonIds.push(id);
  };

  const text = input.text?.trim() ? input.text : undefined;
  const at = input.at ?? Date.now();
  let floor: AlertLevel = "green";
  let forced = false;

  // 1. message content
  const ts = text ? scoreText(text) : null;
  if (ts) {
    hits.push(...ts.hits);
    for (const h of ts.hits) {
      if (h.weight > 0) addReason(h.rule_id);
    }
    if (ts.apk) {
      floor = maxLevel(floor, RULES.links.apk.force_level);
      forced = true;
    }
  }

  // 2. sender
  let sType: SenderType | undefined;
  if (input.sender !== undefined || input.sender_type || input.sender_saved) {
    sType = input.sender_saved ? "saved_contact" : (input.sender_type ?? senderType(input.sender));
    const rule = senderRule(sType);
    if (rule) hits.push({ rule_id: rule.id, weight: text ? rule.score : 0 });
    if (rule && text && rule.score > 0) addReason(rule.id);
    if (sType === "saved_contact" && text) {
      const sc = RULES.sender.saved_contact;
      hits.push({ rule_id: sc.id, weight: sc.score });
    }
    if (sType === "mobile_10" && ts?.topic) {
      const mb = RULES.sender.mobile_claims_brand;
      hits.push({ rule_id: mb.id, weight: mb.score });
      addReason(mb.id);
    }
  }

  // 3. caller (active call)
  let cType: CallerType | undefined;
  const currentCall: RuleCallEvent | null =
    input.caller !== undefined || input.caller_type || input.caller_saved
      ? { kind: "call", at, number: input.caller, caller_type: input.caller_type, saved_contact: input.caller_saved }
      : null;
  if (currentCall) {
    cType = input.caller_saved ? "saved_contact" : (input.caller_type ?? callerType(input.caller));
    const rule = callerRule(cType);
    if (rule) {
      hits.push({ rule_id: rule.id, weight: rule.score });
      if (rule.score > 0) addReason(rule.id);
    }
  }

  // 4. patterns, judged for the current message
  const firedPatterns: string[] = [];
  let patternType: ScamType | null = null;
  if (text) {
    const sms: RuleSmsEvent = {
      kind: "sms",
      at,
      text,
      sender: input.sender,
      sender_type: sType,
      sender_saved: input.sender_saved,
    };
    const calls = (input.events ?? []).filter((e): e is RuleCallEvent => e.kind === "call");
    if (currentCall) {
      // the call is active right now; its start is unknown, so treat it as started at epoch 0
      calls.push({ ...currentCall, at: 0 });
    }
    if (Number.isFinite(toMs(at)) && checkP1(sms, calls)) {
      const P1 = RULES.patterns.P1;
      firedPatterns.push(P1.id);
      hits.push({ rule_id: P1.id, weight: 0, scam_type: P1.scam_type });
      addReason(P1.id);
      floor = maxLevel(floor, P1.level);
      forced = true;
      patternType = P1.scam_type;
    }
    const p5 = checkP5(sms);
    if (p5) {
      const id = RULES.patterns.P5.id;
      firedPatterns.push(id);
      hits.push({ rule_id: `${id}.${p5}`, weight: 0 });
      addReason(`${id}.${p5}`);
      floor = maxLevel(floor, p5);
      if (p5 === "red") forced = true;
    }
  }

  // 5. score → level
  const score = clampScore(hits.reduce((s, h) => s + h.weight, 0));
  const { red_at, yellow_at, ask_ai_between } = RULES.thresholds;
  const scoreLevel: AlertLevel = score >= red_at ? "red" : score >= yellow_at ? "yellow" : "green";
  const level = maxLevel(scoreLevel, floor);
  const [aiLow, aiHigh] = ask_ai_between;
  const needs_ai = Boolean(text) && !forced && score >= aiLow && score < aiHigh;
  if (text && isOtp(text)) {
    hits.push({ rule_id: RULES.otp.id, weight: 0 });
    if (level !== "green") addReason(RULES.otp.id);
  }

  // 6. scam type
  let scam_type: ScamType = ts?.scam_type ?? "unknown";
  if (scam_type === "unknown" && patternType) scam_type = patternType;

  const actions: ShieldAction[] = [...RULES.actions[level]];
  const checks_fired = Array.from(
    new Set(hits.map((h) => (h.detail && h.detail !== "total" && h.rule_id.startsWith("script.") ? `${h.rule_id}:${h.detail}` : h.rule_id))),
  );

  return {
    level,
    scam_type,
    reasons: level === "green" ? [] : reasonIds.map((id) => ({ rule_id: id, ...(REASONS[id] as ReasonText) })),
    checks_fired: Array.from(new Set([...checks_fired, ...firedPatterns])),
    ai_used: false,
    models_agreed: [],
    confidence: confidenceFor(level, score, forced, needs_ai),
    actions,
    needs_ai,
    score,
    sender_type: sType,
    caller_type: cType,
  };
}
