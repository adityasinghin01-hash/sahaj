import type { z } from "zod";
import type { CallerType as CallerTypeSchema, SenderType as SenderTypeSchema } from "@sahaj/shared";
import { RULES, compile } from "./config";
import { asciiDigits } from "./text";

export type SenderType = z.infer<typeof SenderTypeSchema>;
export type CallerType = z.infer<typeof CallerTypeSchema>;

const STRIP = compile(RULES.normalize.number_strip_pattern, "", "g");
const SENDER_RULES = RULES.sender.rules.map((r) => ({ ...r, re: compile(r.pattern, r.flags) }));
const CALLER_RULES = RULES.caller.rules.map((r) => ({ ...r, re: compile(r.pattern, r.flags) }));

export interface ContactOpts {
  /** true when the number/sender is saved in the parent's contacts */
  saved?: boolean;
}

function classify<T extends string>(raw: string, rules: { type: T; re: RegExp }[], fallback: T): T {
  const trimmed = asciiDigits(raw).trim();
  if (!trimmed) return fallback;
  for (const r of rules) {
    // headers keep their dashes; numbers are tested with spaces/dashes/brackets removed
    if (r.re.test(trimmed) || r.re.test(trimmed.replace(STRIP, ""))) return r.type;
  }
  return fallback;
}

/** SMS sender → business_header | mobile_10 | international | short_code | saved_contact | unknown. */
export function senderType(sender: string | null | undefined, opts: ContactOpts = {}): SenderType {
  if (opts.saved) return "saved_contact";
  return classify<SenderType>(sender ?? "", SENDER_RULES, "unknown");
}

/** Caller number → series_1600 | series_140 | mobile_10 | international | saved_contact | unknown. */
export function callerType(number: string | null | undefined, opts: ContactOpts = {}): CallerType {
  if (opts.saved) return "saved_contact";
  return classify<CallerType>(number ?? "", CALLER_RULES, "unknown");
}

export function senderRule(type: SenderType) {
  return RULES.sender.rules.find((r) => r.type === type);
}

export function callerRule(type: CallerType) {
  return RULES.caller.rules.find((r) => r.type === type);
}

