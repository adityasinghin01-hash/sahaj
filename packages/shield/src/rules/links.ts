import { RULES, compile } from "./config";

export interface FoundLink {
  /** URL exactly as written (trailing punctuation removed) */
  url: string;
  /** lowercase host without scheme, port, userinfo or leading "www." */
  host: string;
  registrableDomain: string;
  /** offsets in the input string */
  start: number;
  end: number;
}

export interface LookAlikeResult {
  look_alike: boolean;
  brand: string | null;
  punycode: boolean;
  official: boolean;
}

const L = RULES.links;
const URL_GROUP = L.url_group;
const TRAILING = compile(L.trailing_punct_pattern, "");
const APK = compile(L.apk.pattern, L.apk.flags);
const MULTI = new Set(L.multi_part_suffixes.map((s) => s.toLowerCase()));
const SHORTENERS = new Set(L.shortener.domains.map((s) => s.toLowerCase()));
const IPV4 = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;

/** Host from a URL or bare domain. */
export function hostOf(urlOrDomain: string): string {
  let h = urlOrDomain.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  h = h.split(/[/?#\\]/)[0] ?? "";
  const at = h.lastIndexOf("@");
  if (at >= 0) h = h.slice(at + 1);
  h = h.replace(/:[0-9]*$/, "").replace(/\.+$/, "");
  if (h.startsWith("www.")) h = h.slice(4);
  return h;
}

/** eTLD+1 using the small multi-part suffix list in rules.json (co.in, gov.in, bank.in, …). */
export function registrableDomain(urlOrDomain: string): string {
  const host = hostOf(urlOrDomain);
  if (IPV4.test(host)) return host;
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** Every URL / bare domain in the text, in order. Also finds the host inside a masked "<URL:host>" token. */
export function findLinks(text: string): FoundLink[] {
  const re = compile(L.url_pattern, L.url_flags, "g");
  const out: FoundLink[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const lead = m[1] ?? "";
    const raw = m[URL_GROUP] ?? "";
    const start = m.index + lead.length;
    re.lastIndex = start + raw.length;
    if (!raw) {
      re.lastIndex = m.index + 1;
      continue;
    }
    const url = raw.replace(TRAILING, "");
    const host = hostOf(url);
    if (!host || !host.includes(".")) continue;
    out.push({ url, host, registrableDomain: registrableDomain(host), start, end: start + url.length });
  }
  return out;
}

export function isShortener(urlOrDomain: string): boolean {
  const host = hostOf(urlOrDomain);
  return SHORTENERS.has(host) || SHORTENERS.has(registrableDomain(host));
}

/** ".apk" anywhere in the text (or the Devanagari "एपीके"). */
export function isApk(text: string): boolean {
  return APK.test(text);
}

function suffixMatch(host: string, suffix: string): boolean {
  const s = suffix.toLowerCase();
  return host === s || host.endsWith(`.${s}`);
}

/** Brand look-alike check: brand token in the domain but not an official/trusted domain; punycode always flagged. */
export function lookAlikeDetail(urlOrDomain: string): LookAlikeResult {
  const host = hostOf(urlOrDomain);
  const punycode = host.split(".").some((label) => label.startsWith("xn--"));
  const official =
    L.trusted_suffixes.some((s) => suffixMatch(host, s)) ||
    L.brands.some((b) => b.official.some((s) => suffixMatch(host, s)));
  if (official && !punycode) return { look_alike: false, brand: null, punycode, official: true };
  const brand = L.brands.find((b) => b.tokens.some((t) => host.includes(t.toLowerCase())));
  return { look_alike: Boolean(brand) || punycode, brand: brand?.brand ?? null, punycode, official };
}

export function lookAlike(urlOrDomain: string): boolean {
  return lookAlikeDetail(urlOrDomain).look_alike;
}

