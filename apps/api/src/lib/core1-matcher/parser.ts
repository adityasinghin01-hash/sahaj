import type { ParsedFreeTimeResult } from './types';

export const UNKNOWN_FREE_TIME_LINE =
  'Maaf kijiye, mujhe samay samajh nahi aaya. Aap kab se kab tak free rahengi? Jaise subah 10 se 12 ya shaam 6 ke baad.';

const DEVANAGARI_DIGITS: Record<string, string> = {
  '०': '0',
  '१': '1',
  '२': '2',
  '३': '3',
  '४': '4',
  '५': '5',
  '६': '6',
  '७': '7',
  '८': '8',
  '९': '9',
};

const DEVANAGARI_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/खाना\s*खाने\s*के\s*बाद|खाने\s*के\s*बाद/g, ' khaana khaane ke baad '],
  [/नाश्ते\s*के\s*बाद/g, ' nashte ke baad '],
  [/चाय\s*के\s*बाद/g, ' chai ke baad '],
  [/पूजा\s*के\s*बाद/g, ' pooja ke baad '],
  [/सुबह|सवेरे/g, ' subah '],
  [/दोपहर/g, ' dopahar '],
  [/शाम/g, ' shaam '],
  [/रात/g, ' raat '],
  [/के\s*बाद/g, ' ke baad '],
  [/से/g, ' se '],
  [/तक/g, ' tak '],
  [/बजे/g, ' baje '],
  [/साढ़े|साढे/g, ' sadhe '],
  [/सवा/g, ' sava '],
  [/पौने/g, ' paune '],
  [/डेढ़|डेढ/g, ' dedh '],
  [/ढाई/g, ' dhai '],
  [/नहीं|नही/g, ' nahi '],
  [/एक/g, ' 1 '],
  [/दो/g, ' 2 '],
  [/तीन/g, ' 3 '],
  [/चार/g, ' 4 '],
  [/पाँच|पांच/g, ' 5 '],
  [/छह|छः/g, ' 6 '],
  [/सात/g, ' 7 '],
  [/आठ/g, ' 8 '],
  [/नौ/g, ' 9 '],
  [/दस/g, ' 10 '],
  [/ग्यारह/g, ' 11 '],
  [/बारह/g, ' 12 '],
];

const HINDI_NUMBER_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bbarah?\b/g, '12'],
  [/\bgyarah?\b/g, '11'],
  [/\bdas\b/g, '10'],
  [/\bnau\b/g, '9'],
  [/\baath\b|\bath\b/g, '8'],
  [/\bsaat\b|\bsat\b/g, '7'],
  [/\bchhah\b|\bchhe\b|\bche\b/g, '6'],
  [/\bpaanch\b|\bpanch\b/g, '5'],
  [/\bchaar\b|\bchar\b/g, '4'],
  [/\bteen\b/g, '3'],
  [/\bdo\b/g, '2'],
  [/\bek\b/g, '1'],
];

type DayPeriod = 'subah' | 'dopahar' | 'shaam' | 'raat' | 'am' | 'pm';

interface RawTimeToken {
  hour: number;
  minute: number;
  period?: DayPeriod;
}

export function formatMinutesToHHMM(minutes: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(minutes)));
  const hh = Math.floor(clamped / 60);
  const mm = clamped % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function periodForMinutes(minutes: number): 'subah' | 'dopahar' | 'shaam' | 'raat' {
  const m = ((minutes % 1440) + 1440) % 1440;
  if (m >= 240 && m < 720) return 'subah';
  if (m >= 720 && m < 960) return 'dopahar';
  if (m >= 960 && m < 1200) return 'shaam';
  return 'raat';
}

function formatHour12Hindi(minutes: number): string {
  const normalized = minutes === 1440 ? 0 : ((minutes % 1440) + 1440) % 1440;
  const h24 = Math.floor(normalized / 60);
  const min = normalized % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return min === 0 ? `${h12}` : `${h12}:${String(min).padStart(2, '0')}`;
}

export function formatHindiWindowLabel(startMinute: number, endMinute: number): string {
  const period = periodForMinutes(startMinute);
  const capPeriod = period.charAt(0).toUpperCase() + period.slice(1);
  return `${capPeriod} ${formatHour12Hindi(startMinute)} se ${formatHour12Hindi(endMinute)} baje tak`;
}

export function formatReadBackLine(startMinute: number, endMinute: number): string {
  const period = periodForMinutes(startMinute);
  return `Theek hai, aap ${period} ${formatHour12Hindi(startMinute)} se ${formatHour12Hindi(endMinute)} baje tak free hain.`;
}

function normalizeUtterance(raw: string): string {
  let out = raw.replace(/[०-९]/g, (d) => DEVANAGARI_DIGITS[d] ?? d);
  for (const [pattern, replacement] of DEVANAGARI_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  out = out.toLowerCase();
  // Strip any 4+ digit numeric sequences (phone numbers / OTPs) before parsing.
  out = out.replace(/\b\d{4,}\b/g, ' ');
  out = out
    .replace(/\bmorning\b/g, 'subah')
    .replace(/\bafternoon\b/g, 'dopahar')
    .replace(/\bevening\b/g, 'shaam')
    .replace(/\bnight\b/g, 'raat')
    .replace(/\bkhana\b/g, 'khaana')
    .replace(/\bkhane\b/g, 'khaane')
    .replace(/\bbad\b/g, 'baad')
    .replace(/\bto\b/g, 'se')
    .replace(/\btill\b|\buntil\b/g, 'tak')
    .replace(/[-–—]/g, ' se ');

  for (const [pattern, digit] of HINDI_NUMBER_WORDS) {
    out = out.replace(pattern, digit);
  }
  return out.replace(/\s+/g, ' ').trim();
}

function detectPeriod(segment: string): DayPeriod | undefined {
  if (/\bsubah\b|\bsavere\b/.test(segment)) return 'subah';
  if (/\bdopahar\b/.test(segment)) return 'dopahar';
  if (/\bshaam\b|\bsham\b/.test(segment)) return 'shaam';
  if (/\braat\b/.test(segment)) return 'raat';
  if (/\bpm\b/.test(segment)) return 'pm';
  if (/\bam\b/.test(segment)) return 'am';
  return undefined;
}

function parseTimeFragment(fragment: string): RawTimeToken | null {
  const clean = fragment.trim();
  if (!clean) return null;
  const localPeriod = detectPeriod(clean);

  if (/\bdedh\b/.test(clean)) {
    return { hour: 1, minute: 30, period: localPeriod };
  }
  if (/\bdhai\b/.test(clean)) {
    return { hour: 2, minute: 30, period: localPeriod };
  }

  const modMatch = clean.match(/\b(sadhe|sava|paune)\s+(\d{1,2})\b/);
  if (modMatch) {
    const mod = modMatch[1];
    const h = Number(modMatch[2]);
    if (h >= 0 && h <= 23) {
      if (mod === 'sadhe') return { hour: h, minute: 30, period: localPeriod };
      if (mod === 'sava') return { hour: h, minute: 15, period: localPeriod };
      // paune X => (X - 1):45
      const prevH = h === 0 ? 23 : h === 1 ? 12 : h - 1;
      return { hour: prevH, minute: 45, period: localPeriod };
    }
  }

  const hhmmMatch = clean.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (hhmmMatch) {
    const h = Number(hhmmMatch[1]);
    const m = Number(hhmmMatch[2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return { hour: h, minute: m, period: localPeriod };
    }
  }

  const hMatch = clean.match(/\b(\d{1,2})\b/);
  if (hMatch) {
    const h = Number(hMatch[1]);
    if (h >= 0 && h <= 23) {
      return { hour: h, minute: 0, period: localPeriod };
    }
  }

  return null;
}

function resolveHour24(token: RawTimeToken, contextPeriod?: DayPeriod, isEnd = false): number {
  const p = token.period ?? contextPeriod;
  const h = token.hour;
  if (h >= 13) return h * 60 + token.minute;

  if (p === 'subah' || p === 'am') {
    if (h === 12) return token.minute; // 12 AM
    return h * 60 + token.minute;
  }
  if (p === 'dopahar') {
    if (h === 12) return 12 * 60 + token.minute;
    if (h >= 1 && h <= 5) return (h + 12) * 60 + token.minute;
    return h * 60 + token.minute;
  }
  if (p === 'shaam' || p === 'pm') {
    if (h === 12) return 12 * 60 + token.minute;
    if (h >= 1 && h <= 11) return (h + 12) * 60 + token.minute;
    return h * 60 + token.minute;
  }
  if (p === 'raat') {
    if (h === 12) return isEnd ? 24 * 60 : 0;
    if (h >= 6 && h <= 11) return (h + 12) * 60 + token.minute;
    return h * 60 + token.minute;
  }

  // No explicit period: apply natural Indian daily-routine heuristic.
  // 1..7 without period in Indian conversation is typically afternoon/evening (1 PM - 7 PM).
  if (h >= 1 && h <= 7) {
    return (h + 12) * 60 + token.minute;
  }
  if (h === 12) {
    return isEnd ? 12 * 60 + token.minute : 12 * 60 + token.minute;
  }
  // 8..11 without period -> morning (08:00..11:00)
  return h * 60 + token.minute;
}

function buildSuccess(
  startMinute: number,
  endMinute: number,
  confidence: ParsedFreeTimeResult & { ok: true } extends { confidence: infer C } ? C : never,
): ParsedFreeTimeResult {
  const s = Math.max(0, Math.min(1439, startMinute));
  let e = Math.max(1, Math.min(1440, endMinute));
  if (e === s) {
    e = Math.min(1440, s + 60);
  }
  return {
    ok: true,
    startMinute: s,
    endMinute: e,
    startTime: formatMinutesToHHMM(s),
    endTime: formatMinutesToHHMM(e),
    label: formatHindiWindowLabel(s, e),
    readBackLine: formatReadBackLine(s, e),
    confidence,
  };
}

/**
 * Deterministic Hindi/Hinglish/Devanagari free-time parser.
 * Zero LLM calls. Never echoes or stores 4+ digit runs.
 */
export function parseHindiFreeTime(rawInput: string): ParsedFreeTimeResult {
  if (typeof rawInput !== 'string' || !rawInput.trim()) {
    return {
      ok: false,
      reason: 'empty_input',
      readBackLine: UNKNOWN_FREE_TIME_LINE,
    };
  }

  const text = normalizeUtterance(rawInput);
  if (!text) {
    return {
      ok: false,
      reason: 'empty_input',
      readBackLine: UNKNOWN_FREE_TIME_LINE,
    };
  }

  // Negative / unsure utterances should ask again rather than guess.
  if (
    /\b(nahi|naa|no|busy|vyast|pata nahi|maloom nahi|kabhi nahi|free nahi)\b/.test(text) &&
    !/\bse\b|\bke baad\b/.test(text)
  ) {
    return {
      ok: false,
      reason: 'no_free_time',
      readBackLine: UNKNOWN_FREE_TIME_LINE,
    };
  }

  const globalPeriod = detectPeriod(text);

  // 1. Explicit range: "<start> se <end>"
  const rangeMatch = text.match(/(.+?)\bse\b(.+)/);
  if (rangeMatch) {
    const left = rangeMatch[1];
    const right = rangeMatch[2].split(/\btak\b/)[0];
    const leftPeriod = detectPeriod(left) ?? globalPeriod;
    const rightPeriod = detectPeriod(right) ?? leftPeriod;
    const startToken = parseTimeFragment(left);
    const endToken = parseTimeFragment(right);

    if (startToken && endToken) {
      const startMin = resolveHour24(startToken, leftPeriod, false);
      let endMin = resolveHour24(endToken, rightPeriod, true);
      // Handle e.g. "subah 10 se 1" where end wrapped past noon without dopahar keyword
      if (endMin <= startMin && !endToken.period && startMin < 12 * 60 && endToken.hour <= 5) {
        endMin = (endToken.hour + 12) * 60 + endToken.minute;
      }
      // Handle e.g. "raat 8 se 12" -> end 24:00
      if (endMin <= startMin && endToken.hour === 12) {
        endMin = 24 * 60;
      }
      if (endMin !== startMin) {
        return buildSuccess(startMin, endMin, 'explicit_range');
      }
    }
  }

  // 2. Routine / meal anchors before numeric "ke baad"
  if (/\b(khaana khaane ke baad|khaane ke baad|lunch ke baad|dinner ke baad)\b/.test(text)) {
    if (globalPeriod === 'raat' || /\bdinner\b/.test(text)) {
      return buildSuccess(21 * 60, 22 * 60 + 30, 'routine_anchor');
    }
    return buildSuccess(14 * 60, 16 * 60, 'routine_anchor');
  }
  if (/\b(nashte ke baad|breakfast ke baad)\b/.test(text)) {
    return buildSuccess(10 * 60, 12 * 60, 'routine_anchor');
  }
  if (/\bchai ke baad\b/.test(text)) {
    return buildSuccess(17 * 60, 19 * 60, 'routine_anchor');
  }
  if (/\bpooja ke baad\b/.test(text)) {
    return buildSuccess(9 * 60, 11 * 60, 'routine_anchor');
  }

  // 3. "<time> ke baad" / "after <time>" => sensible 2-hour window starting at <time>
  const afterMatch = text.match(/(.+?)\bke baad\b/) ?? text.match(/\bafter\s+(.+)/);
  if (afterMatch) {
    const targetChunk = afterMatch[1];
    const token = parseTimeFragment(targetChunk);
    if (token) {
      const startMin = resolveHour24(token, globalPeriod, false);
      const endMin = Math.min(24 * 60, startMin + 120);
      return buildSuccess(startMin, endMin, 'after_time');
    }
  }

  // 4. Single explicit time (e.g. "shaam 6 baje free hoon")
  const singleToken = parseTimeFragment(text);
  if (singleToken) {
    const startMin = resolveHour24(singleToken, globalPeriod, false);
    const endMin = Math.min(24 * 60, startMin + 120);
    return buildSuccess(startMin, endMin, 'single_time');
  }

  // 5. Period-only utterance ("subah free hoon", "shaam ko", etc.)
  if (globalPeriod === 'subah' || globalPeriod === 'am') {
    return buildSuccess(9 * 60, 12 * 60, 'period_default');
  }
  if (globalPeriod === 'dopahar') {
    return buildSuccess(14 * 60, 17 * 60, 'period_default');
  }
  if (globalPeriod === 'shaam' || globalPeriod === 'pm') {
    return buildSuccess(17 * 60, 20 * 60, 'period_default');
  }
  if (globalPeriod === 'raat') {
    return buildSuccess(20 * 60, 22 * 60, 'period_default');
  }

  return {
    ok: false,
    reason: 'unknown_time_window',
    readBackLine: UNKNOWN_FREE_TIME_LINE,
  };
}
