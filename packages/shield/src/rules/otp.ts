import { RULES, compile } from "./config";
import { asciiDigits } from "./text";

const O = RULES.otp;
const CURRENCY = compile(O.currency_before_pattern, O.currency_before_flags);
const OTP_TOKEN = RULES.mask.otp_token;

export interface Span {
  start: number;
  end: number;
}

function keywordSpans(text: string): Span[] {
  const re = compile(O.keyword_pattern, O.keyword_flags, "g");
  const spans: Span[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

function near(a: Span, b: Span, window: number): boolean {
  const gap = Math.max(0, b.start - a.end, a.start - b.end);
  return gap <= window;
}

/**
 * Spans of 4–8 digit codes that sit within `window_chars` of an OTP keyword
 * (amounts preceded by Rs/INR/₹ are ignored). Offsets refer to the input string;
 * Devanagari digits are treated as ASCII (same length, so offsets are stable).
 */
export function findOtpCodes(input: string): Span[] {
  const text = asciiDigits(input);
  const keywords = keywordSpans(text);
  if (keywords.length === 0) return [];
  const re = compile(O.number_pattern, O.number_flags, "g");
  const out: Span[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const lead = m[1] ?? "";
    const code = m[O.number_group] ?? "";
    const start = m.index + lead.length;
    const end = start + code.length;
    re.lastIndex = Math.max(end, m.index + 1);
    if (!code) continue;
    if (CURRENCY.test(text.slice(Math.max(0, start - 8), start))) continue;
    const span = { start, end };
    if (keywords.some((k) => near(span, k, O.window_chars))) out.push(span);
  }
  return out;
}

/** True when the text carries an OTP (also true for already-masked text: keyword + "******"). */
export function isOtp(text: string): boolean {
  if (findOtpCodes(text).length > 0) return true;
  const idx = text.indexOf(OTP_TOKEN);
  if (idx < 0) return false;
  const tokenSpan = { start: idx, end: idx + OTP_TOKEN.length };
  return keywordSpans(text).some((k) => near(tokenSpan, k, O.window_chars));
}

