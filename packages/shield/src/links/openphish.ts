import { hostOf, isShortener, lookAlikeDetail } from "../rules/links.js";
import { withDeadline } from "../brain/deadline.js";
import type { LinkIntelDeps } from "./types.js";

/** Public OpenPhish community feed: one phishing URL per line, refreshed every 12 h, no key. */
export const OPENPHISH_FEED_URL = "https://openphish.com/feed.txt";
export const OPENPHISH_CACHE_KEY = "openphish:feed:v1";
export const OPENPHISH_TTL_SECONDS = 12 * 60 * 60;
export const OPENPHISH_TIMEOUT_MS = 5000;
export const OPENPHISH_MAX_ENTRIES = 20_000;
/** After a failed download, do not retry from this process for ten minutes (fail-open meanwhile). */
const RETRY_AFTER_MS = 10 * 60 * 1000;
const MAX_BODY_CHARS = 8 * 1024 * 1024;
const MAX_LINE_CHARS = 2048;

/**
 * Hosts shared by many unrelated users. A feed entry on one of these marks only that exact URL,
 * never the whole host (one bad Google Form must not flag every Google Form).
 */
const SHARED_HOSTS = new Set([
  "docs.google.com", "sites.google.com", "drive.google.com", "forms.gle", "storage.googleapis.com",
  "github.com", "raw.githubusercontent.com", "gist.github.com", "dropbox.com", "dl.dropboxusercontent.com",
  "onedrive.live.com", "1drv.ms", "sharepoint.com", "forms.office.com", "wa.me", "t.me", "telegram.me",
  "linktr.ee", "notion.site", "canva.com", "facebook.com", "instagram.com", "whatsapp.com",
]);

export interface PhishFeed { urls: Set<string>; hosts: Set<string> }

/** host + path (no trailing slash) + query; scheme, www., port and fragment dropped. Null when not http(s). */
export function normaliseFeedUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = hostOf(url.hostname);
  if (!host || !host.includes(".")) return null;
  const path = url.pathname.replace(/\/+$/, "");
  return `${host}${path}${url.search}`;
}

/** Whether a feed hostname may mark every URL on that host. */
function hostWide(host: string): boolean {
  return !SHARED_HOSTS.has(host) && !isShortener(host) && !lookAlikeDetail(host).official;
}

/** Parses feed text into normalised URLs and host-wide hostnames, capped at 20 000 URLs. */
export function parseFeed(text: string): { urls: string[]; hosts: string[] } {
  const urls = new Set<string>();
  const hosts = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (urls.size >= OPENPHISH_MAX_ENTRIES) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.length > MAX_LINE_CHARS) continue;
    const normal = normaliseFeedUrl(trimmed);
    if (!normal) continue;
    urls.add(normal);
    const host = hostOf(trimmed);
    if (hostWide(host)) hosts.add(host);
  }
  return { urls: [...urls], hosts: [...hosts] };
}

export function openPhishEnabled(deps: LinkIntelDeps): boolean {
  return (deps.env ?? process.env).OPENPHISH_FEED !== "0" && typeof deps.linkIntelFetch === "function";
}

/** Per cache port: parsed set kept in memory so a 20 000-line feed is not re-read for every message. */
const memo = new WeakMap<object, { feed: PhishFeed | null; until: number; loading?: Promise<PhishFeed | null> }>();

async function download(deps: LinkIntelDeps): Promise<{ urls: string[]; hosts: string[] }> {
  const fetcher = deps.linkIntelFetch!;
  return withDeadline(OPENPHISH_TIMEOUT_MS, async signal => {
    // Fixed URL, no query, no body: nothing from any message is ever sent to OpenPhish.
    const response = await fetcher(OPENPHISH_FEED_URL, { method: "GET", redirect: "follow", signal, headers: { Accept: "text/plain" } });
    if (!response.ok) throw new Error("OpenPhish feed unavailable");
    const text = await response.text();
    if (text.length > MAX_BODY_CHARS) throw new Error("OpenPhish feed too large");
    const parsed = parseFeed(text);
    if (parsed.urls.length === 0) throw new Error("OpenPhish feed empty");
    return parsed;
  });
}

/** The feed set, or null when disabled or unavailable (fail-open: null never blocks or marks a link unverified). */
export async function loadOpenPhishFeed(deps: LinkIntelDeps): Promise<PhishFeed | null> {
  if (!openPhishEnabled(deps)) return null;
  const now = (deps.now ?? Date.now)();
  const slot = memo.get(deps.cache);
  if (slot && now < slot.until) return slot.feed;
  if (slot?.loading) return slot.loading;
  const loading = (async (): Promise<PhishFeed | null> => {
    try {
      let cached;
      try { cached = await deps.cache.get(OPENPHISH_CACHE_KEY); } catch { /* Cache outage: download instead. */ }
      let lists = cached?.domain === OPENPHISH_CACHE_KEY && cached.feed ? cached.feed : undefined;
      if (!lists) {
        lists = await download(deps);
        try {
          await deps.cache.set(OPENPHISH_CACHE_KEY,
            { domain: OPENPHISH_CACHE_KEY, threat: false, status: "checked", feed: lists }, OPENPHISH_TTL_SECONDS);
        } catch { /* Keep the in-memory copy. */ }
      }
      const feed: PhishFeed = { urls: new Set(lists.urls), hosts: new Set(lists.hosts) };
      // The shared cache owns the 12 h refresh; memory re-checks it every ten minutes.
      memo.set(deps.cache, { feed, until: now + RETRY_AFTER_MS });
      return feed;
    } catch {
      memo.set(deps.cache, { feed: null, until: now + RETRY_AFTER_MS });
      return null;
    }
  })();
  memo.set(deps.cache, { feed: slot?.feed ?? null, until: 0, loading });
  return loading;
}

/** True when the link's normalised URL is listed, or its hostname is a host-wide feed hostname. */
export function feedMatches(feed: PhishFeed, url: string): boolean {
  const normal = normaliseFeedUrl(url);
  if (!normal) return false;
  if (feed.urls.has(normal)) return true;
  const host = hostOf(url);
  return feed.hosts.has(host) && hostWide(host);
}
