import { mask, maskDigits } from "@sahaj/shield";

/** Speech fields only. Routing ids are passed separately and never treated as speech. */
export const maskedSarvamText = (text: string, limit = 300): string => maskDigits(mask(text)).slice(0, limit);

/** Optional label for the static provider-side family transfer. Never a phone destination. */
export function sarvamBridgeLabel(env: Readonly<Record<string, string | undefined>>): string {
  const label = env.SARVAM_BRIDGE_TO?.trim() ?? "";
  return /^[a-z][a-z_.:-]{0,79}$/i.test(label) ? label : "";
}

export function drillOpening(text: string): string {
  const safe = maskedSarvamText(text);
  return /\bAI\s+(?:awaaz|voice)\b|(?:एआई|ए\.आई)\s*(?:आवाज़|आवाज|वॉइस)/i.test(safe)
    ? safe
    : `Namaste ji, yeh Sahaj ki AI awaaz hai. Ye abhyaas call hai. ${safe}`;
}
