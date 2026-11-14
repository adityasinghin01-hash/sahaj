/**
 * Summary lines for shared warnings. Written by the LLM from masked text only, then checked; a line
 * that could carry personal data (a link, an e-mail, a handle, any 4+ digit run) is replaced by the
 * fixed line for the scam type.
 */
import { z } from "zod";
import type { ScamType } from "@sahaj/shared";
import { hasLongDigitRun, maskDigits } from "../tools/mask";
import { LLM_BUDGET_MS, TIMED_OUT, toScamType, withTimeout } from "../tools/runtime";
import type { ShieldDeps } from "../tools/types";

export interface SummaryLines {
  summary_hi: string;
  summary_en: string;
}

export const SUMMARY_MAX = 200;
const LLM_INPUT_MAX = 1000;

const l = (en: string, hi: string): SummaryLines => ({ summary_en: en, summary_hi: hi });

/** One fixed line per scam type, used when the LLM is unavailable or its line fails the checks. */
export const FALLBACK_SUMMARY: Record<ScamType, SummaryLines> = {
  digital_arrest: l(
    "Fake police or CBI callers are threatening 'digital arrest'. Real police never arrest anyone on a video call.",
    "Nakli police ya CBI wale 'digital arrest' ki dhamki de rahe hain. Asli police video call par arrest nahi karti.",
  ),
  kyc_block: l(
    "Fake 'KYC blocked' messages are going around. Banks never ask for an OTP or a link click to unblock an account.",
    "Nakli 'KYC block' wale message aa rahe hain. Bank kabhi OTP ya link click karke account chalu nahi karta.",
  ),
  electricity_cut: l(
    "Fake 'electricity will be cut tonight' messages are going around. Pay bills only in the official app or office.",
    "Nakli 'aaj raat bijli kat jayegi' wale message aa rahe hain. Bill sirf official app ya daftar mein bharein.",
  ),
  parcel_customs: l(
    "Fake parcel or customs calls are going around. No courier asks you to pay a fine over the phone.",
    "Nakli parcel ya customs wali call aa rahi hai. Koi courier phone par jurmana nahi maangta.",
  ),
  lottery_prize: l(
    "Fake lottery and prize messages are going around. If you must pay to get a prize, it is a scam.",
    "Nakli lottery aur inaam wale message aa rahe hain. Inaam ke liye paise maange to woh fraud hai.",
  ),
  job_task: l(
    "Fake part-time job and task offers are going around. Real jobs never ask you to pay first.",
    "Nakli part-time job aur task wale offer aa rahe hain. Asli naukri pehle paise nahi maangti.",
  ),
  family_in_trouble: l(
    "Callers are pretending to be family in trouble and asking for money. Call the person back on their own number first.",
    "Log ghar wale banke musibat batakar paise maang rahe hain. Pehle unke apne number par wapas call karein.",
  ),
  wedding_invite_apk: l(
    "Fake wedding invites are being sent as app files (APK). Never install an app sent on WhatsApp.",
    "Nakli shaadi ke card app file (APK) banke aa rahe hain. WhatsApp par aayi app kabhi install na karein.",
  ),
  refund_cashback: l(
    "Fake refund and cashback messages are going around. You never need to enter a PIN to receive money.",
    "Nakli refund aur cashback wale message aa rahe hain. Paise lene ke liye kabhi PIN nahi daalna padta.",
  ),
  sextortion_threat: l(
    "Blackmail calls and messages are going around. Do not pay; tell your family and report it.",
    "Blackmail wali call aur message aa rahe hain. Paise na dein; ghar walon ko batayein aur report karein.",
  ),
  otp_theft: l(
    "Callers are asking people to read out an OTP. Never share an OTP with anyone, even if they say they are from the bank.",
    "Log phone karke OTP maang rahe hain. OTP kisi ko na batayein, chahe woh bank ka naam lein.",
  ),
  remote_access: l(
    "Callers are asking people to install screen-sharing apps. Never install an app because a caller told you to.",
    "Log screen-share app install karwa rahe hain. Kisi caller ke kehne par koi app install na karein.",
  ),
  unknown: l(
    "Scam calls and messages are going around. If anyone rushes you about money, stop and call your family first.",
    "Fraud call aur message aa rahe hain. Koi paise ke liye jaldi machaye to ruk jaiye aur pehle ghar walon ko call karein.",
  ),
};

export function fallbackSummary(scamType: string): SummaryLines {
  return FALLBACK_SUMMARY[toScamType(scamType)];
}

const URLISH = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i;
const HANDLE = /@/;

/**
 * Accepts a line only if it carries nothing identifying: no link or domain, no e-mail or @handle,
 * no masked token, no 4+ digit run. Collapses whitespace and caps the length. Null = reject.
 */
export function cleanSummary(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const line = text.normalize("NFC").replace(/\s+/g, " ").trim();
  if (line.length < 8) return null;
  if (URLISH.test(line) || HANDLE.test(line) || hasLongDigitRun(line) || /<[A-Z_0-9]+>/.test(line)) return null;
  if (maskDigits(line) !== line) return null;
  if (line.length <= SUMMARY_MAX) return line;
  const cut = line.slice(0, SUMMARY_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > SUMMARY_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const SummarySchema = z.object({ summary_hi: z.string(), summary_en: z.string() });

const SYSTEM = [
  "You write a one-sentence scam warning for elderly people in India, based on a scam message that was reported.",
  "The input is masked: numbers are replaced by tokens. Describe the kind of scam and what to do, in general terms.",
  "Never include names, phone numbers, amounts, account details, links, domains, or any text copied from the message.",
  "summary_en: plain English. summary_hi: Hinglish in Latin script. Each under 160 characters.",
].join(" ");

/**
 * LLM summary of one masked text, checked by cleanSummary. Falls back per line to the fixed line
 * for the scam type. The text is masked again here and never sent if a 4+ digit run survives.
 */
export async function summarise(
  deps: Pick<ShieldDeps, "llm">,
  maskedText: string | null,
  scamType: string,
): Promise<{ lines: SummaryLines; source: "llm" | "fallback" }> {
  const fallback = fallbackSummary(scamType);
  if (!maskedText) return { lines: fallback, source: "fallback" };
  const input = maskDigits(maskedText).replace(/\s+/g, " ").trim().slice(0, LLM_INPUT_MAX);
  if (input === "" || hasLongDigitRun(input)) return { lines: fallback, source: "fallback" };

  try {
    const work = deps.llm.understand({ task: "shield.warning_summary", system: SYSTEM, input, schema: SummarySchema, effort: "low" });
    work.catch(() => undefined); // a late rejection after the timeout must not go unhandled
    const res = await withTimeout(work, LLM_BUDGET_MS);
    if (res === TIMED_OUT || !res.ok) return { lines: fallback, source: "fallback" };
    const hi = cleanSummary(res.data.summary_hi);
    const en = cleanSummary(res.data.summary_en);
    if (!hi || !en) return { lines: fallback, source: "fallback" };
    return { lines: { summary_hi: hi, summary_en: en }, source: "llm" };
  } catch {
    return { lines: fallback, source: "fallback" };
  }
}
