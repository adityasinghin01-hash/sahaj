// Shield contracts v1 (Core 3 file §5, §6.2). Changed only by a PR both coders approve.
import { z } from "zod";

export const AlertLevel = z.enum(["green", "yellow", "red"]);
export type AlertLevel = z.infer<typeof AlertLevel>;

export const ScamType = z.enum([
  "digital_arrest", "kyc_block", "electricity_cut", "parcel_customs", "lottery_prize",
  "job_task", "family_in_trouble", "wedding_invite_apk", "refund_cashback", "sextortion_threat",
  "otp_theft", "remote_access", "unknown",
]);
export type ScamType = z.infer<typeof ScamType>;

export const PatternId = z.enum(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]);
export type PatternId = z.infer<typeof PatternId>;

export const SenderType = z.enum(["business_header", "mobile_10", "international", "short_code", "saved_contact", "unknown"]);
export const CallerType = z.enum(["series_1600", "series_140", "mobile_10", "international", "saved_contact", "unknown"]);

export const ShieldChannel = z.enum(["device", "keypad_voice", "gateway_sms", "busy_watch"]);
export const ShieldEventKind = z.enum(["sms", "call_in", "call_out", "call_state", "app_open", "notification", "install", "voice_report"]);

export const ShieldAction = z.enum([
  "speak_clip", "show_red_screen", "alert_child", "bridge_child", "circle_chain",
  "pause_call", "watch_numbers_24h", "offer_1930",
]);
export type ShieldAction = z.infer<typeof ShieldAction>;

/** What leaves the phone (or a keypad tool) — always masked. Never raw numbers or OTP digits. */
export const ShieldEvent = z.object({
  idempotency_key: z.string().min(8),
  family_id: z.string(),
  parent_id: z.string(),
  device_id: z.string().optional(),
  channel: ShieldChannel,
  kind: ShieldEventKind,
  occurred_at: z.string().datetime(),
  masked_text: z.string().max(2000).optional(),
  sender_type: SenderType.optional(),
  caller_type: CallerType.optional(),
  link_domains: z.array(z.string()).default([]),
  matched_rules: z.array(z.string()).default([]),
  local_level: AlertLevel.optional(),
  /** e.g. { on_call_with_unsaved: true, call_started_at: "..." } — no numbers */
  context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});
export type ShieldEvent = z.infer<typeof ShieldEvent>;

export const VerdictReason = z.object({
  rule_id: z.string(),
  hi: z.string(),
  en: z.string(),
});

export const Verdict = z.object({
  level: AlertLevel,
  scam_type: ScamType,
  reasons: z.array(VerdictReason),
  checks_fired: z.array(z.string()),
  ai_used: z.boolean(),
  models_agreed: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  actions: z.array(ShieldAction),
});
export type Verdict = z.infer<typeof Verdict>;

/** The AI output schema for a masked message (Core 3 Step 1.4 node 4). */
export const ScamJudgement = z.object({
  is_scam: z.boolean(),
  scam_type: ScamType,
  pressure_signals: z.array(z.string()),
  asks_for: z.array(z.enum(["otp", "pin", "money", "app_install", "secrecy"])),
  confidence: z.number().min(0).max(1),
  hindi_reason: z.string(),
});
export type ScamJudgement = z.infer<typeof ScamJudgement>;

export const FamilyCheckState = z.enum(["asked", "confirmed", "denied", "no_answer"]);
