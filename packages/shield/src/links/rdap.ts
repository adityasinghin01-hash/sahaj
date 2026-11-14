// rdap.org refuses Node's default User-Agent ("node") with 403; a named client is accepted.
export const LINK_INTEL_USER_AGENT = "sahaj-shield/0.1 (+https://github.com/adityasinghin01-hash/sahaj)";
import { hostOf, isShortener, lookAlikeDetail, registrableDomain } from "../rules/links.js";
import { withDeadline } from "../brain/deadline.js";
import type { LinkResult } from "../brain/types.js";
import type { LinkIntelDeps } from "./types.js";

export const RDAP_BASE = "https://rdap.org/domain/";
export const RDAP_TIMEOUT_MS = 3000;
export const RDAP_TTL_SECONDS = 24 * 60 * 60;
export const NEW_DOMAIN_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const IPV4 = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;

export const rdapCacheKey = (domain: string) => `rdap:domain:v1:${domain}`;

/** Strict domain check before a domain is put into the RDAP URL. */
export function isValidRdapDomain(domain: string): boolean {
  return domain.length <= 253 && /^[a-z0-9.-]+$/.test(domain) && domain.includes(".") &&
    !domain.startsWith(".") && !domain.endsWith(".") && !domain.includes("..") && !IPV4.test(domain);
}

/**
 * The registrable domain to look up for a link, or null when it must not be looked up:
 * invalid, an IP address, a shortener, or an official brand / trusted domain from rules.json.
 */
export function rdapDomainFor(urlOrHost: string): string | null {
  const host = hostOf(urlOrHost);
  const domain = registrableDomain(host);
  if (!isValidRdapDomain(domain)) return null;
  if (isShortener(host) || lookAlikeDetail(host).official || lookAlikeDetail(domain).official) return null;
  return domain;
}

/** `eventDate` of the `registration` event, or null. */
export function registrationDate(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const events = (data as { events?: unknown }).events;
  if (!Array.isArray(events)) return null;
  for (const item of events) {
    if (typeof item !== "object" || item === null) continue;
    const { eventAction, eventDate } = item as { eventAction?: unknown; eventDate?: unknown };
    if (eventAction === "registration" && typeof eventDate === "string" && Number.isFinite(Date.parse(eventDate))) {
      return new Date(Date.parse(eventDate)).toISOString();
    }
  }
  return null;
}

export function rdapEnabled(deps: LinkIntelDeps): boolean {
  return (deps.env ?? process.env).RDAP_LOOKUP !== "0" && typeof deps.linkIntelFetch === "function";
}

/** Registration time (ISO) or null for unknown. Unknown (404, unsupported TLD, timeout, no event) is cached too. */
export async function lookupRegistration(domain: string, deps: LinkIntelDeps): Promise<string | null> {
  if (!rdapEnabled(deps) || !isValidRdapDomain(domain)) return null;
  const key = rdapCacheKey(domain);
  let cached: LinkResult | null | undefined;
  try { cached = await deps.cache.get(key); } catch { /* Cache outage: look up instead. */ }
  if (cached?.domain === domain && cached.registeredAt !== undefined) return cached.registeredAt;
  let registeredAt: string | null = null;
  try {
    registeredAt = await withDeadline(RDAP_TIMEOUT_MS, async signal => {
      // Only the validated registrable domain is sent; never a path, query or anything else from the message.
      const response = await deps.linkIntelFetch!(`${RDAP_BASE}${domain}`, {
        method: "GET", redirect: "follow", signal, headers: { Accept: "application/rdap+json", "User-Agent": LINK_INTEL_USER_AGENT },
      });
      if (!response.ok) return null;
      return registrationDate(await response.json());
    });
  } catch { registeredAt = null; }
  try {
    await deps.cache.set(key, { domain, threat: false, status: "checked", registeredAt }, RDAP_TTL_SECONDS);
  } catch { /* The answer is still usable. */ }
  return registeredAt;
}

/** Whole days since registration, or null when unknown or in the future. */
export function domainAgeDays(registeredAt: string | null, nowMs: number): number | null {
  if (!registeredAt) return null;
  const at = Date.parse(registeredAt);
  if (!Number.isFinite(at) || at > nowMs) return null;
  return Math.floor((nowMs - at) / DAY_MS);
}

export const isNewDomain = (ageDays: number | null) => ageDays !== null && ageDays < NEW_DOMAIN_DAYS;
