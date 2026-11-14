import { mask } from "../rules/mask";
import { maskDigits } from "../tools/mask";

/** Mask URLs, separated numbers and Unicode decimal digits before AI or storage. */
export function maskPrivate(text: string): string {
  const normalized = text.replace(/[\u0966-\u096f]/g, d => String(d.charCodeAt(0) - 0x0966))
    .replace(/\p{Nd}/gu, d => /[0-9]/.test(d) ? d : "0");
  const separatedMasked = normalized.replace(/\+?\d(?:[\s\p{Cf}\p{Pd}.,/()]*\d){3,}/gu, run => {
    const digits = run.replace(/\D/g, "");
    return digits.length === 10 || (digits.length === 11 && digits.startsWith("0"))
      || (digits.length === 12 && digits.startsWith("91")) ? "<MOBILE_10>" : "<NUM>";
  });
  return maskDigits(mask(maskDigits(separatedMasked))).replace(/\p{Nd}{4,}/gu, "<NUM>");
}
