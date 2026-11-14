import { publicUrl } from "../brain/sandbox.js";
import { feedMatches, loadOpenPhishFeed } from "./openphish.js";
import { domainAgeDays, isNewDomain, lookupRegistration, rdapDomainFor } from "./rdap.js";
import type { LinkIntelDeps } from "./types.js";

export type { LinkIntelDeps } from "./types.js";
export {
  OPENPHISH_FEED_URL, OPENPHISH_CACHE_KEY, OPENPHISH_TTL_SECONDS, OPENPHISH_MAX_ENTRIES,
  normaliseFeedUrl, parseFeed, loadOpenPhishFeed, feedMatches, openPhishEnabled,
} from "./openphish.js";
export type { PhishFeed } from "./openphish.js";
export {
  RDAP_BASE, RDAP_TTL_SECONDS, NEW_DOMAIN_DAYS, rdapCacheKey, isValidRdapDomain, rdapDomainFor,
  registrationDate, lookupRegistration, domainAgeDays, isNewDomain, rdapEnabled,
} from "./rdap.js";

export interface LinkIntel {
  /** A link on this host is on the OpenPhish feed (by exact URL or host-wide hostname). */
  phishFeed: boolean;
  /** Registrable domain was registered fewer than 30 days ago (RDAP). */
  newDomain: boolean;
  /** Whole days since registration; null when unknown or not looked up. */
  domainAgeDays: number | null;
}

/**
 * Key-free link signals per hostname (keyed like the Safe Browsing results: lowercase URL hostname).
 * Fail-open: a disabled or unavailable source simply contributes nothing.
 */
export async function checkLinkIntel(links: { url: string }[], deps: LinkIntelDeps): Promise<Map<string, LinkIntel>> {
  const byHost = new Map<string, string[]>();
  for (const link of links) {
    try {
      const url = publicUrl(link.url);
      const host = url.hostname.toLowerCase();
      byHost.set(host, [...(byHost.get(host) ?? []), url.href]);
    } catch { /* Blocked/invalid links are already reported by the reputation check. */ }
  }
  const out = new Map<string, LinkIntel>();
  if (byHost.size === 0) return out;
  const nowMs = (deps.now ?? Date.now)();
  const domains = new Map<string, string | null>();
  for (const host of byHost.keys()) domains.set(host, rdapDomainFor(host));
  const unique = [...new Set([...domains.values()].filter((d): d is string => d !== null))];
  const [feed, registrations] = await Promise.all([
    loadOpenPhishFeed(deps),
    Promise.all(unique.map(async domain => [domain, await lookupRegistration(domain, deps)] as const)),
  ]);
  const registered = new Map(registrations);
  for (const [host, urls] of byHost) {
    const domain = domains.get(host);
    const age = domain ? domainAgeDays(registered.get(domain) ?? null, nowMs) : null;
    out.set(host, {
      phishFeed: !!feed && urls.some(url => feedMatches(feed, url)),
      newDomain: isNewDomain(age),
      domainAgeDays: age,
    });
  }
  return out;
}
