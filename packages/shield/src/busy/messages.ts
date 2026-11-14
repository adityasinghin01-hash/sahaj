/**
 * Busy-line alert copy for the child (Riya). Same style as messages/alerts.ts: pure, English default,
 * Hindi in Latin script, names masked, and no 4+ digit run in any string.
 */
import { snippet } from "../messages/alerts";
import type { AlertLang } from "../messages/alerts";

export type BusyAlertButtonId = "call_parent" | "seen";
export interface BusyAlertButton {
  id: BusyAlertButtonId;
  label: string;
}

export interface BusyAlertMessage {
  title: string;
  body: string;
  buttons: [BusyAlertButton, BusyAlertButton];
}

export interface BusyAlertOptions {
  /** Defaults to "en". */
  lang?: AlertLang;
  /** How the parent is named in the family, e.g. "Maa". */
  parentName: string;
  /** Streak length in whole minutes. */
  minutes: number;
}

const NAME_MAX = 40;

function parentLabel(value: string): string {
  const clean = snippet(value, NAME_MAX);
  return clean.length > 0 ? clean : "Maa";
}

function wholeMinutes(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** "Maa’s phone has been busy for 50 min. You can call her — she will hear a call-waiting beep." */
export function buildBusyAlert(opts: BusyAlertOptions): BusyAlertMessage {
  const lang = opts.lang ?? "en";
  const p = parentLabel(opts.parentName);
  const min = wholeMinutes(opts.minutes);
  if (lang === "hi") {
    return {
      title: `${p} ka phone busy hai`,
      body: `${p} ka phone ${min} min se busy hai. Aap unhe call kar sakte hain — unhe call-waiting ki beep sunai degi.`,
      buttons: [
        { id: "call_parent", label: `${p} ko call karein` },
        { id: "seen", label: "Dekh liya" },
      ],
    };
  }
  return {
    title: `${p}’s phone is busy`,
    body: `${p}’s phone has been busy for ${min} min. You can call her — she will hear a call-waiting beep.`,
    buttons: [
      { id: "call_parent", label: `Call ${p}` },
      { id: "seen", label: "Seen" },
    ],
  };
}
