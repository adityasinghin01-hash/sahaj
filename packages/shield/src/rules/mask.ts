import { RULES, compile } from "./config";
import { findLinks, isApk } from "./links";
import { findOtpCodes } from "./otp";
import { asciiDigits } from "./text";

const M = RULES.mask;
const STEPS = M.steps.map((s) => ({ ...s, re: compile(s.pattern, s.flags, "g") }));

interface Replacement {
  start: number;
  end: number;
  value: string;
}

function applyReplacements(text: string, reps: Replacement[]): string {
  let out = "";
  let pos = 0;
  for (const r of [...reps].sort((a, b) => a.start - b.start)) {
    if (r.start < pos) continue;
    out += text.slice(pos, r.start) + r.value;
    pos = r.end;
  }
  return out + text.slice(pos);
}

/**
 * Remove personal data before anything leaves the phone:
 * URLs → <URL:host>, OTP digits → ******, 1600 numbers → <1600_NUMBER>, +intl → <INTL>,
 * 10-digit mobiles → <MOBILE_10>, any other 4+ digit run → <NUM>.
 */
export function mask(input: string): string {
  let text = asciiDigits(input);

  text = applyReplacements(
    text,
    findLinks(text).map((l) => ({
      start: l.start,
      end: l.end,
      value: `${M.url_token_prefix}${l.host.replace(/[0-9]{4,}/g, "#")}${M.url_token_suffix}${isApk(l.url) ? M.apk_marker : ""}`,
    })),
  );

  const replaceStep = (step: (typeof STEPS)[number]) => {
    step.re.lastIndex = 0;
    text = text.replace(step.re, (_m: string, lead: string) => `${lead ?? ""}${step.token}`);
  };
  // phone numbers first (so they are not mistaken for OTP codes), OTP digits next, leftover digit runs last
  for (const step of STEPS.slice(0, -1)) replaceStep(step);
  text = applyReplacements(
    text,
    findOtpCodes(text).map((s) => ({ ...s, value: M.otp_token })),
  );
  const last = STEPS[STEPS.length - 1];
  if (last) replaceStep(last);
  return text;
}

