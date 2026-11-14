/**
 * Digit masking. Runs before anything leaves for an AI (and before timeline writes).
 * - Devanagari digits are normalised to ASCII first so they cannot slip through.
 * - Digits split by spaces, dashes, dots, commas, slashes or brackets are joined into one run
 *   ("98765 43210", "4 5 6 7", "1,00,000") so a spoken/typed number cannot dodge the mask.
 * - A run whose digits form a 10-digit mobile (optionally +91 / 91 / 0 prefixed) → <MOBILE_10>.
 * - Any other run of 4+ digits → <NUM>. Shorter runs (e.g. "2 baje", "100 rupaye") stay.
 */
const DEVANAGARI_ZERO = 0x0966;

function toAsciiDigits(text: string): string {
  return text.replace(/[\u0966-\u096F]/g, (d) => String(d.charCodeAt(0) - DEVANAGARI_ZERO));
}

const DIGIT_RUN = /\+?\d(?:[\s\-.,/()]{0,2}\d)*/g;

function isMobile10(digits: string): boolean {
  return (
    digits.length === 10 ||
    (digits.length === 11 && digits.startsWith("0")) ||
    (digits.length === 12 && digits.startsWith("91"))
  );
}

export function maskDigits(text: string): string {
  return toAsciiDigits(text).replace(DIGIT_RUN, (run) => {
    const digits = run.replace(/\D/g, "");
    if (isMobile10(digits)) return "<MOBILE_10>";
    if (digits.length >= 4) return "<NUM>";
    return run;
  });
}

/** True if the text still holds a run of 4+ digits (used as a last-line guard before the LLM call). */
export function hasLongDigitRun(text: string): boolean {
  return /\d{4,}/.test(toAsciiDigits(text).replace(/[\s\-.,/()]/g, ""));
}
