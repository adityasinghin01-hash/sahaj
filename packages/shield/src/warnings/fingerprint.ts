/**
 * Shared-warning fingerprints (Core 3 Step 2.5). fingerprint = hex(SHA-256(normalised value)).
 * Only the fingerprint is stored; the raw number, domain or message never is.
 *
 * Normalisation:
 * - number   → last 10 digits (Devanagari digits read as ASCII). Fewer than 10 digits → no fingerprint.
 * - domain   → registrable domain, lowercase (punycode for IDNs, "www." and port dropped).
 * - template → masked text with digits removed, lowercase, whitespace collapsed.
 *
 * The phone may send a number fingerprint itself (raw numbers never leave the phone). It must use
 * numberFingerprint() so both sides agree.
 */
import { sha256Hex } from "../tools/check_code_word";
import { maskDigits } from "../tools/mask";

export type IndicatorKind = "number" | "domain" | "template";

export const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
/** Templates shorter than this after normalisation are too generic to share ("hi", "call me"). */
export const MIN_TEMPLATE_CHARS = 12;

function asciiDigits(text: string): string {
  return text.replace(/[\u0966-\u096F]/g, (d) => String(d.charCodeAt(0) - 0x0966));
}

export function normaliseNumber(raw: string): string | null {
  const digits = asciiDigits(raw).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * Public suffixes with more than one label that matter for Indian scam traffic, plus the free
 * hosting platforms scammers use (from the private section of the Public Suffix List). Without
 * these, "github.io" or "co.in" would be treated as one site and flag everyone on it.
 * This is a subset of the PSL, not the whole list.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  // India (.in second-level)
  "co.in", "net.in", "org.in", "gov.in", "ac.in", "edu.in", "res.in", "nic.in", "firm.in", "gen.in", "ind.in", "mil.in",
  // Common elsewhere
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "com.sg", "com.my", "co.za",
  "com.br", "com.cn", "com.pk", "com.bd", "com.np", "co.jp", "com.hk", "com.tr", "com.ng",
  // Free hosting / app platforms
  "blogspot.com", "github.io", "web.app", "firebaseapp.com", "netlify.app", "vercel.app", "herokuapp.com",
  "pages.dev", "workers.dev", "ngrok.io", "ngrok-free.app", "glitch.me", "repl.co", "wixsite.com",
  "weebly.com", "000webhostapp.com", "onrender.com", "azurewebsites.net", "appspot.com", "web.core.windows.net",
]);
const MAX_SUFFIX_LABELS = 4;

function isIp(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":");
}

export function registrableDomain(raw: string): string | null {
  const text = raw.trim();
  if (text === "" || /\s/.test(text)) return null;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/\.+$/, "");
  if (host === "") return null;
  if (isIp(host)) return host;
  const labels = host.split(".").filter((l) => l.length > 0);
  if (labels.length < 2) return null;
  let suffixLabels = 1;
  for (let n = Math.min(MAX_SUFFIX_LABELS, labels.length); n >= 2; n--) {
    if (MULTI_LABEL_SUFFIXES.has(labels.slice(-n).join("."))) {
      suffixLabels = n;
      break;
    }
  }
  if (labels.length <= suffixLabels) return null;
  return labels.slice(-(suffixLabels + 1)).join(".");
}

export function normaliseTemplate(text: string): string | null {
  const norm = maskDigits(text.normalize("NFC"))
    .replace(/\d/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return norm.length >= MIN_TEMPLATE_CHARS ? norm : null;
}

export function normalise(kind: IndicatorKind, raw: string): string | null {
  switch (kind) {
    case "number":
      return normaliseNumber(raw);
    case "domain":
      return registrableDomain(raw);
    case "template":
      return normaliseTemplate(raw);
  }
}

/**
 * hex(SHA-256(normalised value)). Null if the value does not normalise. The table key is
 * (kind, fingerprint), so equal hashes of different kinds never merge.
 */
export async function fingerprint(kind: IndicatorKind, raw: string): Promise<string | null> {
  const norm = normalise(kind, raw);
  return norm === null ? null : sha256Hex(norm);
}

/** For the phone app: the fingerprint it may send as event context `number_fingerprint`. */
export function numberFingerprint(rawNumber: string): Promise<string | null> {
  return fingerprint("number", rawNumber);
}
