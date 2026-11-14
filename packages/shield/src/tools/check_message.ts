import { z } from "zod";
import type { AlertLevel, ScamType } from "@sahaj/shared";
import { maskDigits } from "./mask";
import { LINES, SAFE_FALLBACK_LINE, STOP_SCRIPTS, type StopScriptId } from "./lines";
import { alertChild, defineTool, makeVerdict, safeSign, toScamType } from "./runtime";

export const CheckMessageInput = z.object({
  from_kind: z.enum(["unknown_number", "bank_name", "saved", "not_sure"]),
  /** Keywords Maa mentions: bijli, bank, inaam, otp, parcel, police… */
  mentions: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  number_said: z.string().max(100).optional(),
});

export interface CheckMessageOutput {
  level: AlertLevel;
  scam_type: ScamType;
  /** Recorded clip id when the line is one of the stop scripts, else null. */
  line_id: StopScriptId | null;
  line_hi: string;
}

/** Whole-word / phrase match, so "whatsapp" does not count as "app". */
function has(mentions: string[], ...words: string[]): boolean {
  return mentions.some((m) => words.some((w) => ` ${m.replace(/[^\p{L}\p{N}]+/gu, " ")} `.includes(` ${w} `)));
}

function redScript(mentions: string[]): StopScriptId {
  if (has(mentions, "police", "cbi", "arrest", "video call")) return 4;
  if (has(mentions, "otp", "pin")) return 2;
  if (has(mentions, "apk", "file", "app", "link")) return 5;
  return 1;
}

export const checkMessage = defineTool({
  name: "check_message",
  description: "Score a message Maa describes (sender kind + keywords); alerts the child on yellow/red.",
  input: CheckMessageInput,
  fallback: (): CheckMessageOutput => ({
    level: "yellow",
    scam_type: "unknown",
    line_id: 1,
    line_hi: SAFE_FALLBACK_LINE,
  }),
  async handler(deps, ctx, input): Promise<CheckMessageOutput> {
    const mentions = input.mentions.map((m) => maskDigits(m).toLowerCase());
    const maskedNumber = input.number_said ? maskDigits(input.number_said) : undefined;
    const maskedText = [
      `from:${input.from_kind}`,
      maskedNumber ? `number:${maskedNumber}` : "",
      ...mentions,
    ]
      .filter(Boolean)
      .join(" ");

    const score = deps.rules.scoreText(maskedText);
    const level = score.level;
    const scamType = toScamType(score.scam_type);

    let lineId: StopScriptId | null = null;
    let line: string;
    if (level === "red") {
      lineId = redScript(mentions);
      line = STOP_SCRIPTS[lineId];
    } else if (level === "yellow") {
      line = LINES.messageYellow;
    } else {
      line = LINES.messageGreen;
    }

    await safeSign(deps, {
      familyId: ctx.familyId,
      type: "shield.voice.check_message",
      line: `Maa asked about a message (${input.from_kind}). Level ${level}.`,
      data: {
        level,
        scam_type: scamType,
        from_kind: input.from_kind,
        mentions,
        number_kind: maskedNumber === undefined ? null : maskedNumber.includes("<MOBILE_10>") ? "mobile_10" : "other",
        rule_hits: score.hits,
        masked_text: maskedText,
      },
    });

    if (level !== "green") {
      await alertChild(
        deps,
        ctx,
        makeVerdict({
          level,
          scam_type: scamType,
          rule_id: "voice.check_message",
          hi: "Maa ko ek shak wala message aaya hai.",
          en: "Maa described a suspicious message on the keypad helpline.",
          checks_fired: score.hits,
          actions: ["speak_clip", "alert_child"],
        }),
      );
    }

    return { level, scam_type: scamType, line_id: lineId, line_hi: line };
  },
});
