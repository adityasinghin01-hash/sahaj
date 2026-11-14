/**
 * Digit masking. Runs before anything leaves for an AI (and before timeline writes).
 * - Devanagari digits are normalised to ASCII first so they cannot slip through.
 * - Digits split by spaces, dashes, dots, commas, slashes or brackets are joined into one run
 *   ("98765 43210", "4 5 6 7", "1,00,000") so a spoken/typed number cannot dodge the mask.
 * - A run whose digits form a 10-digit mobile (optionally +91 / 91 / 0 prefixed) → <MOBILE_10>.
 * - Any other run of 4+ digits → <NUM>. Shorter runs (e.g. "2 baje", "100 rupaye") stay.
 */
const DIGIT_ZEROS = [
  0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6,
  0x0c66, 0x0ce6, 0x0d66, 0x0e50, 0x0ed0, 0x1040, 0xff10,
] as const;

function toAsciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (d) => {
    const cp = d.codePointAt(0)!;
    if (cp >= 0x30 && cp <= 0x39) return d;
    for (const zero of DIGIT_ZEROS) {
      if (cp >= zero && cp <= zero + 9) return String(cp - zero);
    }
    return d;
  });
}

const DIGIT_RUN = /\+?\p{Nd}(?:[\s\-.,/()]{0,2}\p{Nd})*/gu;

function isMobile10(digits: string): boolean {
  return (
    digits.length === 10 ||
    (digits.length === 11 && digits.startsWith("0")) ||
    (digits.length === 12 && digits.startsWith("91"))
  );
}

export function maskDigits(text: string): string {
  return toAsciiDigits(text).replace(DIGIT_RUN, (run) => {
    const digits = run.replace(/[^\p{Nd}]/gu, "");
    if (/^\d+$/.test(digits) && isMobile10(digits)) return "<MOBILE_10>";
    if ([...digits].length >= 4) return "<NUM>";
    return run;
  });
}

/** True if the text still holds a run of 4+ digits (used as a last-line guard before the LLM call). */
export function hasLongDigitRun(text: string): boolean {
  return /\p{Nd}{4,}/u.test(toAsciiDigits(text).replace(/[\s\-.,/()]/g, ""));
}
