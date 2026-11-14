// Text normalisation + phrase matching shared by scoring and topic detection.
// The same algorithm is documented in rules.json → normalize.note so Kotlin can mirror it.

/** Devanagari digits ०-९ → ASCII 0-9. */
export function asciiDigits(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code >= 0x0966 && code <= 0x096f ? String.fromCharCode(48 + code - 0x0966) : ch;
  }
  return out;
}

function keep(code: number): boolean {
  if (code >= 0x61 && code <= 0x7a) return true; // a-z
  if (code >= 0x30 && code <= 0x39) return true; // 0-9
  // Devanagari block minus danda (U+0964) and double danda (U+0965)
  return code >= 0x0900 && code <= 0x097f && code !== 0x0964 && code !== 0x0965;
}

/** Lowercase, drop ZWJ/ZWNJ, map everything else that is not [a-z0-9]/Devanagari to one space. */
export function normalizeText(text: string): string {
  const lower = asciiDigits(text).toLowerCase();
  let out = "";
  let lastSpace = true;
  for (const ch of lower) {
    const code = ch.charCodeAt(0);
    if (code === 0x200c || code === 0x200d) continue;
    if (keep(code)) {
      out += ch;
      lastSpace = false;
    } else if (!lastSpace) {
      out += " ";
      lastSpace = true;
    }
  }
  return out.trim();
}

export interface PhraseMatch<T> {
  item: T;
  phrase: string;
  start: number;
  end: number;
}

/**
 * Whole-word phrase matching on normalised text. Within one call, a match whose span lies
 * entirely inside a longer accepted match is dropped ("longest match wins"), so "kyc" does
 * not stack on top of "kyc expire ho raha hai".
 */
export function matchPhrases<T>(normalized: string, items: readonly T[], text: (item: T) => string): PhraseMatch<T>[] {
  const hay = ` ${normalized} `;
  const found: PhraseMatch<T>[] = [];
  for (const item of items) {
    const phrase = normalizeText(text(item));
    if (!phrase) continue;
    const idx = hay.indexOf(` ${phrase} `);
    if (idx >= 0) found.push({ item, phrase, start: idx + 1, end: idx + 1 + phrase.length });
  }
  found.sort((a, b) => b.end - b.start - (a.end - a.start));
  const accepted: PhraseMatch<T>[] = [];
  for (const m of found) {
    if (!accepted.some((a) => a.start <= m.start && m.end <= a.end)) accepted.push(m);
  }
  return accepted;
}

export function hasAnyPhrase(normalized: string, phrases: readonly string[]): boolean {
  const hay = ` ${normalized} `;
  return phrases.some((p) => {
    const n = normalizeText(p);
    return n.length > 0 && hay.includes(` ${n} `);
  });
}

