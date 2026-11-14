import { mask } from "../rules/mask";
import { maskDigits } from "../tools/mask";

/** Tokens a previous masking pass already wrote. Kept as-is so "<URL:x.in>" is not masked twice. */
const MASK_TOKEN = /<URL:[^<>\s\p{Nd}]{1,253}>|<MOBILE_10>|<NUM>|<OTP>|<APK>/gu;

/** Mask URLs, separated numbers and Unicode decimal digits before AI or storage. */
export function maskPrivate(text: string): string {
  const kept: string[] = [];
  // Placeholders are letters only (no digits, no URL characters) and restored after masking.
  const placeholder = (i: number) => `\uE000${[...i.toString(26)].map(c => String.fromCharCode(97 + parseInt(c, 26))).join("")}\uE001`;
  const protectedText = text.replace(MASK_TOKEN, token => { kept.push(token); return placeholder(kept.length - 1); });
  const normalized = protectedText.replace(/[\u0966-\u096f]/g, d => String(d.charCodeAt(0) - 0x0966))
    .replace(/\p{Nd}/gu, d => /[0-9]/.test(d) ? d : "0");
  const separatedMasked = normalized.replace(/\+?\d(?:[\s\p{Cf}\p{Pd}.,/()]*\d){3,}/gu, run => {
    const digits = run.replace(/\D/g, "");
    return digits.length === 10 || (digits.length === 11 && digits.startsWith("0"))
      || (digits.length === 12 && digits.startsWith("91")) ? "<MOBILE_10>" : "<NUM>";
  });
  const masked = maskDigits(mask(maskDigits(separatedMasked))).replace(/\p{Nd}{4,}/gu, "<NUM>");
  return masked.replace(/\uE000([a-z]+)\uE001/g, (_, code: string) =>
    kept[parseInt([...code].map(c => (c.charCodeAt(0) - 97).toString(26)).join(""), 26)] ?? "");
}
