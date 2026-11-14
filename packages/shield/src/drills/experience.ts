/**
 * Step 3.5 experience drills (opt-in). Aasha Didi, clearly saying she is an AI, plays a GENERIC
 * scam call so Maa can practise saying no. Three locks before any call: Maa's recorded consent,
 * the child's per-parent switch, and at most one experience drill per rolling seven days, never
 * in quiet hours.
 *
 * The turn tool stops the drill the moment Maa starts giving digits, says OTP/PIN/code or agrees to
 * share or pay. Digits are never stored: every stored answer is masked first and has no digit at all.
 */
import { z } from "zod";
import { RULES } from "../rules";
import { STOP_SCRIPTS } from "../tools/lines";
import { TIMED_OUT, TOOL_TIMEOUT_MS, withTimeout } from "../tools/runtime";
import { maskPrivate } from "./privacy";
import type { DrillContext, DrillRecord } from "./types";

export const EXPERIENCE_DRILL_JOB = "shield.drill.experience";
export const EXPERIENCE_DRILL_PURPOSE = "experience_drill" as const;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Quiet hours in India time (UTC+05:30): no experience drill from 20:00 to 09:00. */
export const EXPERIENCE_QUIET_HOURS_IST = { from: 20, to: 9 } as const;
export function isQuietHours(at: Date): boolean {
  const ist = new Date(at.getTime() + 330 * 60 * 1000);
  const hour = ist.getUTCHours();
  const { from, to } = EXPERIENCE_QUIET_HOURS_IST;
  return from > to ? hour >= from || hour < to : hour >= from && hour < to;
}

export interface ExperienceScript {
  id: string;
  scam_type: "kyc_block" | "electricity_cut" | "parcel_customs" | "lottery_prize";
  /** The first sentence always says this is an AI voice (ground rule 4). */
  opening_hi: string;
  /** What the "caller" asks for, generic only: no real bank, brand, app or website. */
  ask_hi: string;
  /** Spoken if Maa does not answer the ask; the drill then waits for experience_turn. */
  nudge_hi: string;
}

/** GENERIC scripts. validateExperienceScript() keeps every real brand from rules.json out. */
export const EXPERIENCE_SCRIPTS: readonly ExperienceScript[] = [
  { id: "generic_kyc", scam_type: "kyc_block",
    opening_hi: "Namaste ji, yeh ek AI awaaz hai. Main aapke bank khaate ki KYC team ki taraf se bol rahi hoon.",
    ask_hi: "Aapka khaata aaj band ho jayega. Abhi aapke phone par ek code aaya hoga, woh code mujhe bata dijiye.",
    nudge_hi: "Jaldi kijiye ji, warna pension ruk jayegi. Code bataiye." },
  { id: "generic_power", scam_type: "electricity_cut",
    opening_hi: "Namaste ji, yeh ek AI awaaz hai. Main bijli daftar ki taraf se bol rahi hoon.",
    ask_hi: "Aapka bill update nahi hua hai, aaj raat bijli kat jayegi. Abhi chhota sa payment kar dijiye.",
    nudge_hi: "Bas paanch minute hain ji. Payment kar dijiye, warna line kat jayegi." },
  { id: "generic_parcel", scam_type: "parcel_customs",
    opening_hi: "Namaste ji, yeh ek AI awaaz hai. Main courier ki taraf se bol rahi hoon.",
    ask_hi: "Aapke naam ka parcel customs mein ruka hai. Chhudaane ke liye fees bhejni hogi, aur apna PIN bataiye.",
    nudge_hi: "Aaj hi karna hoga ji, warna case ban jayega." },
  { id: "generic_prize", scam_type: "lottery_prize",
    opening_hi: "Namaste ji, yeh ek AI awaaz hai. Badhaai ho, aapka inaam nikla hai.",
    ask_hi: "Inaam aapke khaate mein bhejne ke liye pehle processing fees bhejiye aur jo code aaya hai woh bataiye.",
    nudge_hi: "Offer sirf aaj tak hai ji. Code bataiye." },
];

function words(text: string): string {
  return ` ${text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim()} `;
}

/** Every brand token, brand name and official domain from rules.json `links.brands`. */
export function brandTermsFromRules(): string[] {
  const terms = new Set<string>();
  for (const brand of RULES.links.brands) {
    for (const token of brand.tokens) terms.add(token.toLowerCase());
    for (const domain of brand.official) terms.add(domain.toLowerCase());
    for (const part of brand.brand.toLowerCase().split(/[()/]/)) if (part.trim().length > 2) terms.add(part.trim());
  }
  return [...terms];
}

/** Throws if any line of the script names a real brand from the official-brand list. */
export function validateExperienceScript(script: ExperienceScript, terms = brandTermsFromRules()): ExperienceScript {
  const raw = [script.opening_hi, script.ask_hi, script.nudge_hi].join(" ");
  const text = words(raw);
  const lower = raw.toLowerCase();
  // Domains match as substrings; names and tokens as whole words ("sbi", "bank of baroda").
  const hit = terms.find(term => term.includes(".") ? lower.includes(term) : text.includes(` ${words(term).trim()} `));
  if (hit) throw new Error("Experience drill script names a real brand");
  if (!/\bAI\b/.test(script.opening_hi)) throw new Error("Experience drill script must say it is an AI");
  if (/\p{Nd}{4,}/u.test(raw)) throw new Error("Experience drill script holds a number");
  return script;
}

/** Stored and AI-bound text for an experience answer: masked, then no digit at all. */
export function maskExperienceAnswer(said: string): string {
  return maskPrivate(said).replace(/\p{Nd}+/gu, "<NUM>").replace(DIGIT_WORD_RUN, " <NUM> ").replace(/\s+/g, " ").trim().slice(0, 2000);
}

const DIGIT_WORDS = ["shunya", "zero", "ek", "do", "teen", "char", "chaar", "paanch", "panch", "chhe", "chhah", "che", "saat",
  "aath", "nau", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "शून्य", "एक", "दो", "तीन", "चार", "पांच", "पाँच", "छह", "छः", "सात", "आठ", "नौ"];
const DIGIT_WORD = `(?:${DIGIT_WORDS.join("|")})`;
const DIGIT_WORD_RUN = new RegExp(`(?<![\\p{L}\\p{M}])${DIGIT_WORD}(?:[\\s,.-]+${DIGIT_WORD}){2,}(?![\\p{L}\\p{M}])`, "giu");
const SECRET_WORDS = /(?:^|\s)(otp|o t p|pin|code|cvv|password|passcode|ओटीपी|पिन|कोड|पासवर्ड)(?=\s|$)/u;
const AGREE = /(?:^|\s)(bata (?:deti|dungi|rahi|raha|deta|doon|du)|bataati hoon|batati hoon|bhej (?:deti|dungi|rahi|diya|di|doon|du)|bhejti hoon|de (?:deti|dungi|rahi|doon|du)|deti hoon|pay kar|payment kar (?:deti|dungi|rahi|diya)|kar (?:deti|dungi) payment|haan (?:bata|bhej|de|likh)|likh (?:lo|lijiye|lijie)|note kar|abhi bhejti|bataa? rahi|बता (?:देती|दूँगी|दूंगी|रही)|भेज (?:देती|दूँगी|दूंगी|रही)|दे (?:देती|दूँगी|दूंगी))(?=\s|$)/u;
const REFUSE = /(?:^|\s)(nahi|nahin|nai|mat|no|never|kabhi nahi|phone rakh|phone kaat|kaat (?:rahi|deti|dungi)|rakh (?:rahi|deti|dungi)|fraud|thag|riya se|beta se|beti se|bete se|ghar walon se|bank (?:jaungi|jaakar)|नहीं|नही|मत|फ्रॉड|ठग)(?=\s|$)/u;

export type ExperienceTurnKind = "danger" | "refusal" | "continue";

/** Pure decision on what Maa just said (raw, never stored). */
export function classifyExperienceTurn(said: string): ExperienceTurnKind {
  const ascii = said.replace(/\p{Nd}/gu, "0");
  if ((ascii.match(/\d/g) ?? []).length >= 3) return "danger";
  DIGIT_WORD_RUN.lastIndex = 0;
  if (DIGIT_WORD_RUN.test(said)) { DIGIT_WORD_RUN.lastIndex = 0; return "danger"; }
  const text = words(said);
  // Agreeing to share or pay always stops the drill, even with a "nahi" elsewhere in the turn.
  if (AGREE.test(text)) return "danger";
  const refused = REFUSE.test(text);
  if (SECRET_WORDS.test(text) && !refused) return "danger";
  if (refused) return "refusal";
  return "continue";
}

export const EXPERIENCE_TEACH_LINE = "Bas ek baat yaad rakhiye: asli call mein bhi OTP, PIN ya code kabhi kisi ko mat bataiye, aur paise mat bhejiye. Phone kaatkar Riya ko bataiye.";
/** Line 9 + teach: spoken the moment the drill is stopped for a risky answer. */
export const EXPERIENCE_STOP_LINE = `${STOP_SCRIPTS[9]} ${EXPERIENCE_TEACH_LINE}`;
/** Spoken at the end of a refusal (line 9). */
export const EXPERIENCE_REFUSAL_LINE = STOP_SCRIPTS[9];
/** Queued for the next daily check-in after a refusal or hang-up. */
export const EXPERIENCE_PRAISE_LINE = "Pichhli baar abhyaas call mein aapne kuch nahi bataya aur phone sambhaal liya. Bahut badhiya ji, aise hi saavdhaan rahiye!";

export const ExperienceTurnInput = z.object({
  drill_id: z.string().min(1).max(100),
  said: z.string().max(2000).default(""),
  hung_up: z.boolean().default(false),
});
export interface ExperienceTurnOutput { stop: boolean; line: string | null; score?: 0 | 2 }

export interface ExperienceStore {
  /** Same parent-scoped lock as helper drills. All callback operations use its connection. */
  withParentLock<T>(ctx: DrillContext, work: (store: ExperienceStore) => Promise<T>): Promise<T>;
  getParent(ctx: DrillContext): Promise<boolean>;
  /** Returns null when the parent is not in the family. */
  recordConsent(input: DrillContext & { clipRef: string; givenAt: Date }): Promise<{ id: string } | null>;
  revokeConsent(input: DrillContext & { at: Date }): Promise<number>;
  hasConsent(ctx: DrillContext): Promise<boolean>;
  /** byUserId must be a child member of the family; false = nothing written. */
  setEnabled(input: DrillContext & { enabled: boolean; byUserId: string; at: Date }): Promise<boolean>;
  isEnabled(ctx: DrillContext): Promise<boolean>;
  lastExperienceAt(ctx: DrillContext): Promise<string | null>;
  insertExperience(input: DrillContext & { drillId: string; askedAt: Date }): Promise<void>;
  getExperience(input: DrillContext & { drillId: string }): Promise<DrillRecord | null>;
  /** First result only (score is null). Returns whether this call wrote it. */
  saveExperienceResult(input: DrillContext & { drillId: string; answerMasked: string; score: 0 | 2 }): Promise<boolean>;
  queueCheckinLine(input: DrillContext & { line: string; at: Date }): Promise<void>;
  /** Oldest undelivered praise line, marked delivered. */
  takeCheckinLine(input: DrillContext & { at: Date }): Promise<string | null>;
}

export interface ExperienceDeps {
  db: ExperienceStore;
  clock: { now(): Date };
  scheduler: { after(delayMs: number, name: string, payload: Record<string, unknown>): Promise<void> };
}

export type StartExperienceResult =
  | { ok: true; drill_id: string; script_id: string }
  | { ok: false; reason: "not_found" | "no_consent" | "disabled" | "too_soon" | "quiet_hours" };

export function pickExperienceScript(previousCount: number): ExperienceScript {
  const script = EXPERIENCE_SCRIPTS[Math.abs(previousCount) % EXPERIENCE_SCRIPTS.length]!;
  return validateExperienceScript(script);
}
export function experienceScriptFor(drillId: string): ExperienceScript | null {
  const id = /^exp\.([a-z_]+)\./.exec(drillId)?.[1];
  const script = EXPERIENCE_SCRIPTS.find(item => item.id === id);
  return script ? validateExperienceScript(script) : null;
}

/** Checks every lock under the parent lock, records the drill, then queues the call job. */
export async function startExperienceDrill(deps: ExperienceDeps, ctx: DrillContext): Promise<StartExperienceResult> {
  const now = deps.clock.now();
  const result = await deps.db.withParentLock(ctx, async db => {
    if (!await db.getParent(ctx)) return { ok: false as const, reason: "not_found" as const };
    if (!await db.hasConsent(ctx)) return { ok: false as const, reason: "no_consent" as const };
    if (!await db.isEnabled(ctx)) return { ok: false as const, reason: "disabled" as const };
    const last = await db.lastExperienceAt(ctx);
    if (last && now.getTime() - Date.parse(last) < WEEK_MS) return { ok: false as const, reason: "too_soon" as const };
    if (isQuietHours(now)) return { ok: false as const, reason: "quiet_hours" as const };
    const script = pickExperienceScript(Math.floor(now.getTime() / WEEK_MS));
    const drillId = `exp.${script.id}.${crypto.randomUUID()}`;
    await db.insertExperience({ ...ctx, drillId, askedAt: now });
    return { ok: true as const, drill_id: drillId, script_id: script.id };
  });
  if (result.ok) {
    await deps.scheduler.after(0, EXPERIENCE_DRILL_JOB, { family_id: ctx.familyId, parent_id: ctx.parentId, drill_id: result.drill_id });
  }
  return result;
}

export const ExperienceJobPayload = z.object({
  family_id: z.string().min(1).max(100), parent_id: z.string().min(1).max(100), drill_id: z.string().min(1).max(100),
}).strict();

export const experienceTurn = {
  name: "experience_turn" as const,
  description: "During an opt-in experience drill: decide from what Maa just said whether to stop the drill now.",
  input: ExperienceTurnInput,
  async run(deps: ExperienceDeps, ctx: DrillContext, raw: z.input<typeof ExperienceTurnInput>): Promise<ExperienceTurnOutput> {
    const stopNow: ExperienceTurnOutput = { stop: true, line: EXPERIENCE_STOP_LINE };
    const parsed = ExperienceTurnInput.safeParse(raw);
    if (!parsed.success) return stopNow;
    // Decide on the raw words in memory, then keep only the masked, digit-free form.
    const kind = parsed.data.hung_up ? "refusal" as const : classifyExperienceTurn(parsed.data.said);
    const masked = parsed.data.hung_up ? "<hung_up>" : maskExperienceAnswer(parsed.data.said) || "<silence>";
    const reply: ExperienceTurnOutput = kind === "danger" ? { stop: true, line: EXPERIENCE_STOP_LINE, score: 0 }
      : kind === "refusal" ? { stop: true, line: parsed.data.hung_up ? null : EXPERIENCE_REFUSAL_LINE, score: 2 }
        : { stop: false, line: null };
    const work = deps.db.withParentLock(ctx, async db => {
      if (!await db.getParent(ctx)) return stopNow;
      const drill = await db.getExperience({ ...ctx, drillId: parsed.data.drill_id });
      if (!drill || drill.type !== "experience") return stopNow;
      if (drill.score !== null) return { stop: true, line: null, score: drill.score === 0 ? 0 as const : 2 as const };
      if (reply.score === undefined) return reply;
      const wrote = await db.saveExperienceResult({ ...ctx, drillId: parsed.data.drill_id, answerMasked: masked, score: reply.score });
      if (wrote && reply.score === 2) await db.queueCheckinLine({ ...ctx, line: EXPERIENCE_PRAISE_LINE, at: deps.clock.now() });
      return reply;
    });
    work.catch(() => undefined);
    try {
      const result = await withTimeout(work, TOOL_TIMEOUT_MS);
      if (result !== TIMED_OUT) return result;
    } catch { /* Storage failure: still answer, and still stop on danger. */ }
    // Safe direction: a slow store never lets the drill keep asking for a code.
    return kind === "continue" ? { stop: false, line: null } : reply;
  },
};
