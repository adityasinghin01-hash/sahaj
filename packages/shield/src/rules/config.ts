// Loads and validates rules/rules.json once. Pure: no I/O beyond the static JSON import.
import { z } from "zod";
import { AlertLevel, CallerType, PatternId, ScamType, SenderType, ShieldAction } from "@sahaj/shared";
import rawRules from "../../rules/rules.json";

const Reason = z.object({ hi: z.string().min(1), en: z.string().min(1) });
const Flags = z.string().regex(/^i?$/, "only the 'i' flag is portable");

const TypedRegexRule = z.object({
  id: z.string(),
  pattern: z.string(),
  flags: Flags,
  score: z.number(),
  reason: Reason,
});

const Phrase = z.object({ text: z.string().min(1), lang: z.enum(["hi", "hinglish", "en"]), w: z.number().positive() });

const ScriptType = z.object({ reason: Reason, phrases: z.array(Phrase).min(1) });

const Signal = z.object({
  id: z.string(),
  score: z.number(),
  phrases: z.array(z.string().min(1)).min(1),
  scam_type: ScamType.optional(),
  reason: Reason,
});

const ScoredRule = z.object({ id: z.string(), score: z.number(), reason: Reason });

const PhaseTwo = z.object({ phase: z.literal(2), id: z.string(), description: z.string() });

export const RulesFileSchema = z.object({
  version: z.string(),
  updated: z.string(),
  sources: z.array(z.object({ id: z.string(), title: z.string(), url: z.string() })).min(3),
  regex_dialect: z.string(),
  normalize: z.object({ note: z.string(), number_strip_pattern: z.string() }),
  sender: z.object({
    rules: z.array(TypedRegexRule.extend({ type: SenderType })),
    mobile_claims_brand: ScoredRule,
    saved_contact: ScoredRule,
  }),
  caller: z.object({ rules: z.array(TypedRegexRule.extend({ type: CallerType })) }),
  otp: z.object({
    id: z.string(),
    keyword_pattern: z.string(),
    keyword_flags: Flags,
    number_pattern: z.string(),
    number_flags: Flags,
    number_group: z.number().int().positive(),
    currency_before_pattern: z.string(),
    currency_before_flags: Flags,
    window_chars: z.number().int().positive(),
    reason: Reason,
  }),
  mask: z.object({
    note: z.string(),
    url_token_prefix: z.string(),
    url_token_suffix: z.string(),
    apk_marker: z.string(),
    otp_token: z.string(),
    steps: z.array(z.object({ id: z.string(), token: z.string(), pattern: z.string(), flags: Flags })),
  }),
  links: z.object({
    url_pattern: z.string(),
    url_flags: Flags,
    url_group: z.number().int().positive(),
    trailing_punct_pattern: z.string(),
    multi_part_suffixes: z.array(z.string()),
    present: ScoredRule,
    shortener: ScoredRule.extend({ domains: z.array(z.string()).min(6) }),
    apk: ScoredRule.extend({ force_level: AlertLevel, pattern: z.string(), flags: Flags }),
    look_alike: ScoredRule,
    punycode: ScoredRule,
    trusted_suffixes: z.array(z.string()),
    brands: z.array(z.object({ brand: z.string(), tokens: z.array(z.string()).min(1), official: z.array(z.string()).min(1) })),
  }),
  topic_words: z.object({
    note: z.string(),
    bank: z.array(z.string()),
    electricity: z.array(z.string()),
    courier: z.array(z.string()),
  }),
  generic_signals: z.array(Signal),
  scam_scripts: z.object({
    min_type_score: z.number(),
    types: z.object({
      digital_arrest: ScriptType,
      kyc_block: ScriptType,
      electricity_cut: ScriptType,
      parcel_customs: ScriptType,
      lottery_prize: ScriptType,
      job_task: ScriptType,
      family_in_trouble: ScriptType,
      wedding_invite_apk: ScriptType,
      refund_cashback: ScriptType,
      sextortion_threat: ScriptType,
    }),
  }),
  patterns: z.object({
    P1: z.object({
      phase: z.literal(1),
      id: z.string(),
      level: AlertLevel,
      scam_type: ScamType,
      description: z.string(),
      caller_types: z.array(CallerType),
      window_after_call_ms: z.number().int().nonnegative(),
      reason: Reason,
    }),
    P5: z.object({
      phase: z.literal(1),
      id: z.string(),
      description: z.string(),
      risky_sender_types: z.array(SenderType),
      red: z.object({ level: z.literal("red"), reason: Reason }),
      yellow: z.object({ level: z.literal("yellow"), reason: Reason }),
    }),
    P2: PhaseTwo.extend({
      level: AlertLevel,
      scam_type: ScamType,
      caller_types: z.array(CallerType),
      min_duration_ms: z.number().int().positive(),
      min_duration_seconds: z.number().int().positive(),
      require_video_or_whatsapp: z.boolean(),
      reason: Reason,
    }),
    P3: PhaseTwo.extend({
      level: AlertLevel,
      scam_type: ScamType,
      play_store_installers: z.array(z.string().min(1)).min(1),
      recent_install_hours: z.number().int().positive(),
      reason: Reason,
    }),
    P4: PhaseTwo.extend({
      level: AlertLevel,
      scam_type: ScamType,
      packages: z.array(z.string().min(1)).min(1),
      reason: Reason,
    }),
    P6: PhaseTwo.extend({
      level: AlertLevel,
      scam_type: ScamType,
      caller_types: z.array(CallerType),
      min_duration_ms: z.number().int().positive(),
      multiplier_vs_normal: z.number().positive(),
      reason: Reason,
    }),
    P7: PhaseTwo.extend({
      level: AlertLevel,
      scam_type: ScamType,
      trusted_caller_types: z.array(CallerType).min(1),
      reason: Reason,
    }),
    P8: PhaseTwo.extend({
      level: AlertLevel,
      local_only: z.boolean(),
      keep_hours: z.number().int().positive(),
      max_numbers: z.number().int().positive(),
      reason: Reason,
    }),
    P9: PhaseTwo.extend({
      level: AlertLevel,
      scam_type: ScamType,
      caller_types: z.array(CallerType),
      poll_ms: z.number().int().positive(),
      packages: z.array(z.string().min(1)).min(1),
      reason: Reason,
    }),
  }),
  thresholds: z.object({
    red_at: z.number(),
    yellow_at: z.number(),
    ask_ai_between: z.tuple([z.number(), z.number()]),
    max_score: z.number(),
  }),
  actions: z.object({ red: z.array(ShieldAction), yellow: z.array(ShieldAction), green: z.array(ShieldAction) }),
});
export type RulesFile = z.infer<typeof RulesFileSchema>;

/** Validated rules (throws at import time if rules.json is malformed). */
export const RULES: RulesFile = RulesFileSchema.parse(rawRules);

/** Raw JSON (for tests that walk every regex). */
export const RAW_RULES: unknown = rawRules;

export type ScriptTypeId = keyof RulesFile["scam_scripts"]["types"];
export const SCRIPT_TYPE_IDS = Object.keys(RULES.scam_scripts.types) as ScriptTypeId[];

export type ReasonText = z.infer<typeof Reason>;
export type PhaseOnePattern = Extract<PatternId, "P1" | "P5">;

/** Compile a rules.json regex string. `extra` adds JS-only runtime flags such as "g". */
export function compile(pattern: string, flags = "", extra = ""): RegExp {
  const all = Array.from(new Set((flags + extra).split(""))).join("");
  return new RegExp(pattern, all);
}

