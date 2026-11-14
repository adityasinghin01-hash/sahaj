/**
 * The one place that writes Shield alerts for the child (Riya) and the family circle.
 * Pure functions: no I/O, no clock, no randomness. English is the default; Hindi is Hinglish
 * in Latin script, matching the spoken lines.
 *
 * Privacy rules applied to every string that goes out:
 * - Text from the verdict and from names is passed through maskDigits, then the mask tokens are
 *   replaced with "•••", so an alert never holds a raw number, an OTP or any 4+ digit run.
 * - Free text taken from the verdict (the reason) is cut to SNIPPET_MAX characters.
 */
import type { ScamType, ShieldAction, ShieldChannel, Verdict } from "@sahaj/shared";
import type { z } from "zod";
import { maskDigits } from "../tools/mask";

export type AlertLang = "en" | "hi";
export type ShieldChannelValue = z.infer<typeof ShieldChannel>;

export type AlertButtonId = "call_parent" | "safe" | "fraud";
export interface AlertButton {
  id: AlertButtonId;
  label: string;
}

export interface ShieldAlertMessage {
  title: string;
  /** At most 3 short lines joined with "\n": what happened, why, what Sahaj did. */
  body: string;
  buttons: [AlertButton, AlertButton, AlertButton];
}

export interface ShieldAlertOptions {
  /** Defaults to "en". */
  lang?: AlertLang;
  /** How the parent is named in the family, e.g. "Maa". */
  parentName: string;
  /** Where the event came from (phone app, keypad helpline, SMS gateway, busy watch). */
  channel: ShieldChannelValue;
}

export interface CircleAlertOptions extends ShieldAlertOptions {
  /** The person who did not respond first, e.g. "Riya". */
  childName: string;
}

export const SNIPPET_MAX = 80;
export const MAX_BODY_LINES = 3;
const NAME_MAX = 40;

/* ------------------------------------------------------------------ text safety */

/** Masks digits and replaces the mask tokens with a neutral placeholder. */
export function safeText(text: string): string {
  return maskDigits(text)
    .replace(/<MOBILE_10>|<NUM>/g, "•••")
    .replace(/\s+/g, " ")
    .trim();
}

/** A masked, single-line snippet of at most `max` characters. */
export function snippet(text: string, max = SNIPPET_MAX): string {
  const clean = safeText(text);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}

function name(value: string, fallback: string): string {
  const clean = snippet(value, NAME_MAX);
  return clean.length > 0 ? clean : fallback;
}

/* ------------------------------------------------------------------ copy */

const SCAM_LABEL: Record<ScamType, Record<AlertLang, string>> = {
  digital_arrest: { en: "a fake police 'digital arrest'", hi: "nakli police 'digital arrest'" },
  kyc_block: { en: "a fake bank KYC block", hi: "nakli bank KYC block" },
  electricity_cut: { en: "a fake electricity cut notice", hi: "nakli bijli kaatne ki dhamki" },
  parcel_customs: { en: "a fake parcel or customs case", hi: "nakli parcel/customs case" },
  lottery_prize: { en: "a fake lottery or prize", hi: "nakli lottery ya inaam" },
  job_task: { en: "a fake job or task offer", hi: "nakli job/task offer" },
  family_in_trouble: { en: "someone pretending to be family", hi: "koi ghar wala banke baat kar raha hai" },
  wedding_invite_apk: { en: "a fake invite file (APK)", hi: "nakli invite file (APK)" },
  refund_cashback: { en: "a fake refund or cashback", hi: "nakli refund ya cashback" },
  sextortion_threat: { en: "a blackmail threat", hi: "blackmail ki dhamki" },
  otp_theft: { en: "someone asking for an OTP", hi: "koi OTP maang raha hai" },
  remote_access: { en: "a screen-sharing app request", hi: "screen-share app ki maang" },
  unknown: { en: "a suspicious call or message", hi: "shak wali call ya message" },
};

function happened(channel: ShieldChannelValue, parent: string, lang: AlertLang): string {
  if (lang === "hi") {
    switch (channel) {
      case "keypad_voice":
        return `${parent} ne Sahaj helpline par shak wali call/message bataya.`;
      case "gateway_sms":
        return `${parent} ne Sahaj ko ek shak wala SMS bheja.`;
      case "busy_watch":
        return `${parent} anjaan number se lambi call par hain.`;
      case "device":
        return `${parent} ke phone par shak wali call/message aaya.`;
    }
  }
  switch (channel) {
    case "keypad_voice":
      return `${parent} reported a suspicious call or message on the Sahaj helpline.`;
    case "gateway_sms":
      return `${parent} forwarded a suspicious SMS to Sahaj.`;
    case "busy_watch":
      return `${parent} is on a long call with an unknown number.`;
    case "device":
      return `Sahaj spotted a suspicious call or message on ${parent}'s phone.`;
  }
}

function why(verdict: Verdict, lang: AlertLang): string {
  const reason = verdict.reasons[0]?.[lang];
  const text = reason && safeText(reason).length > 0 ? reason : SCAM_LABEL[verdict.scam_type][lang];
  return lang === "hi" ? `Kyun: ${snippet(text)}` : `Why: ${snippet(text)}`;
}

/** What Sahaj did, by action, in the order shown. alert_child is implied by the alert itself. */
const DID: Partial<Record<ShieldAction, Record<AlertLang, (parent: string) => string>>> = {
  pause_call: { en: () => "paused the call", hi: () => "call rok di" },
  show_red_screen: { en: (p) => `showed ${p} a stop screen`, hi: (p) => `${p} ko stop screen dikhayi` },
  speak_clip: { en: (p) => `warned ${p}`, hi: (p) => `${p} ko saavdhaan kiya` },
  offer_1930: { en: (p) => `told ${p} to report on the cyber helpline`, hi: (p) => `${p} ko cyber helpline batayi` },
  bridge_child: { en: () => "is connecting you to the call", hi: () => "aapko call se jod raha hai" },
  circle_chain: { en: () => "will ring the family circle", hi: () => "family circle ko call karega" },
  watch_numbers_24h: { en: () => "is watching these numbers for 24 h", hi: () => "in numbers par 24 ghante nazar rakhega" },
};
const DID_ORDER: ShieldAction[] = [
  "pause_call",
  "show_red_screen",
  "speak_clip",
  "offer_1930",
  "bridge_child",
  "circle_chain",
  "watch_numbers_24h",
];
const MAX_DID = 2;

function did(verdict: Verdict, parent: string, lang: AlertLang, callNow: string | null): string {
  const parts = DID_ORDER.filter((a) => verdict.actions.includes(a))
    .slice(0, MAX_DID)
    .map((a) => DID[a]![lang](parent));
  const joiner = lang === "hi" ? " aur " : " and ";
  const lead =
    parts.length > 0
      ? lang === "hi"
        ? `Sahaj ne ${parts.join(joiner)}.`
        : `Sahaj ${parts.join(joiner)}.`
      : lang === "hi"
        ? "Sahaj ne aapko bataya."
        : "Sahaj let you know.";
  return callNow ? `${lead} ${callNow}` : lead;
}

function title(verdict: Verdict, parent: string, lang: AlertLang): string {
  if (verdict.level === "green") {
    return lang === "hi" ? `${parent} ke phone par sab theek laga` : `Looks safe on ${parent}'s phone`;
  }
  return lang === "hi" ? `${parent} ke phone par fraud ho sakta hai` : `Possible scam on ${parent}'s phone`;
}

function buttons(parent: string, lang: AlertLang): ShieldAlertMessage["buttons"] {
  return lang === "hi"
    ? [
        { id: "call_parent", label: `${parent} ko call karein` },
        { id: "safe", label: "Sab theek hai" },
        { id: "fraud", label: "Fraud hai" },
      ]
    : [
        { id: "call_parent", label: `Call ${parent}` },
        { id: "safe", label: "It's safe" },
        { id: "fraud", label: "It's fraud" },
      ];
}

function callNowLine(parent: string, lang: AlertLang): string {
  return lang === "hi" ? `${parent} ko abhi call karein.` : `Call ${parent} now.`;
}

/* ------------------------------------------------------------------ public */

/** The alert Riya (the first responder) receives for a Shield verdict. */
export function buildShieldAlert(verdict: Verdict, opts: ShieldAlertOptions): ShieldAlertMessage {
  const lang = opts.lang ?? "en";
  const parent = name(opts.parentName, "Maa");
  const callNow = verdict.level === "red" ? callNowLine(parent, lang) : null;
  const lines = [happened(opts.channel, parent, lang), why(verdict, lang), did(verdict, parent, lang, callNow)];
  return { title: title(verdict, parent, lang), body: lines.join("\n"), buttons: buttons(parent, lang) };
}

/** The alert for the next person in the circle chain when the child has not responded. */
export function buildCircleAlert(verdict: Verdict, opts: CircleAlertOptions): ShieldAlertMessage {
  const lang = opts.lang ?? "en";
  const parent = name(opts.parentName, "Maa");
  const child = name(opts.childName, lang === "hi" ? "Ghar walon" : "The first contact");
  const titleText =
    lang === "hi"
      ? `${child} ne jawab nahi diya. ${parent} ko madad chahiye ho sakti hai`
      : `${child} hasn't responded. ${parent} may need help`;
  const first =
    lang === "hi"
      ? `${child} ne ${parent} ke fraud alert ka jawab nahi diya.`
      : `${child} hasn't responded to a scam alert about ${parent}.`;
  const lines = [first, why(verdict, lang), did(verdict, parent, lang, callNowLine(parent, lang))];
  return { title: titleText, body: lines.join("\n"), buttons: buttons(parent, lang) };
}
