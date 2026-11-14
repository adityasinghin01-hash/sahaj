import type { LinkResult, ShieldBrainDeps } from "./types.js";
import { createSandbox, publicUrl } from "./sandbox.js";
import { withDeadline } from "./deadline.js";

const SHORTENERS = new Set(["bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "buff.ly", "cutt.ly", "rb.gy", "shorturl.at", "rebrand.ly", "lnkd.in", "s.id", "tiny.cc"]);
const DAY_SECONDS = 24 * 60 * 60;

async function safeBrowsing(urls: string[], deps: ShieldBrainDeps, signal: AbortSignal): Promise<boolean> {
  if (urls.length > 500) {
    const batches: string[][] = [];
    for (let start = 0; start < urls.length; start += 500) batches.push(urls.slice(start, start + 500));
    const results = await Promise.allSettled(batches.map(batch => safeBrowsing(batch, deps, signal)));
    if (results.some(result => result.status === "fulfilled" && result.value)) return true;
    if (results.some(result => result.status === "rejected")) throw new Error("Incomplete Safe Browsing batches");
    return false;
  }
  const key = (deps.env ?? process.env).SAFE_BROWSING_KEY;
  if (!key) throw new Error("Safe Browsing not configured");
  const response = await (deps.safeBrowsingFetch ?? fetch)(
    `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${encodeURIComponent(key)}`,
    {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "sahaj-shield", clientVersion: "0.1.0" },
        threatInfo: {
          threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE", "POTENTIALLY_HARMFUL_APPLICATION"],
          platformTypes: ["ANY_PLATFORM"], threatEntryTypes: ["URL"],
          threatEntries: urls.map(url => ({ url })),
        },
      }),
    },
  );
  if (!response.ok) throw new Error("Safe Browsing unavailable");
  const data: unknown = await response.json();
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("Invalid Safe Browsing result");
  const matches = (data as { matches?: unknown }).matches;
  if (matches !== undefined && !Array.isArray(matches)) throw new Error("Invalid Safe Browsing matches");
  return Array.isArray(matches) && matches.length > 0;
}

/** A domain-wide request includes every event URL on that domain, not just the first path. */
export async function checkLinks(links: { url: string; domain: string }[], deps: ShieldBrainDeps): Promise<LinkResult[]> {
  const grouped = new Map<string, Set<string>>();
  const invalid: LinkResult[] = [];
  for (const link of links) {
    try {
      const url = publicUrl(link.url);
      const domain = url.hostname.toLowerCase(); // Never trust the caller-supplied domain/cache key.
      const urls = grouped.get(domain) ?? new Set<string>(); urls.add(url.href); grouped.set(domain, urls);
    } catch { invalid.push({ domain: "invalid", threat: false, status: "blocked" }); }
  }
  const domains = [...grouped.entries()];
  const completed = new Map<string, LinkResult>();
  // The whole node, including cache/DNS/network, shares a two-second budget.
  try {
    await withDeadline(2000, async signal => {
      await Promise.all(domains.map(async ([domain, values]) => {
        const cacheKey = `shield.domain.v1:${domain}`;
        try {
          let cached: LinkResult | null | undefined;
          try { cached = await deps.cache.get(cacheKey); } catch { /* Cache outage must not disable the check. */ }
          signal.throwIfAborted();
          // Domain keys carry URL coverage: neither a clean path nor one bad short link describes every path.
          if (cached?.domain === domain && cached.status === "checked" &&
              [...values].every(url => cached.checkedUrls?.includes(url))) {
            completed.set(domain, cached); return;
          }
          const urls = [...values];
          let threat = false;
          let unavailable = false;
          // Check the short URL even if expansion fails; the link itself may be listed.
          try { threat = await safeBrowsing(urls, deps, signal); } catch { unavailable = true; }
          if (SHORTENERS.has(domain) && !threat) {
            const sandbox = deps.sandbox ?? createSandbox();
            try {
              const expanded = await Promise.all(urls.map(url => sandbox.unshorten(url, signal)));
              signal.throwIfAborted();
              const destinations = expanded.map(url => publicUrl(url).href);
              const targets = new Map<string, string[]>();
              for (const url of destinations) {
                const host = new URL(url).hostname.toLowerCase();
                targets.set(host, [...new Set([...(targets.get(host) ?? []), url])]);
              }
              const results = await Promise.all([...targets].map(async ([host, urls]) => {
                const key = `shield.domain.v1:${host}`;
                try {
                  let cached: LinkResult | null | undefined;
                  try { cached = await deps.cache.get(key); } catch { /* Check without cache. */ }
                  signal.throwIfAborted();
                  if (cached?.domain === host && cached.status === "checked" && urls.every(url => cached.checkedUrls?.includes(url))) return cached;
                  const threat = await safeBrowsing(urls, deps, signal);
                  signal.throwIfAborted();
                  const checked: LinkResult = { domain: host, status: "checked", threat, checkedUrls: urls };
                  // Preserve a discovered threat even if a later cache operation stalls.
                  if (threat) completed.set(domain, { domain, status: "checked", threat: true, checkedUrls: [...values] });
                  try { await deps.cache.set(key, checked, DAY_SECONDS); } catch { /* Keep the result. */ }
                  return checked;
                } catch { return { domain: host, status: "unavailable" as const, threat: false }; }
              }));
              threat = results.some(result => result.threat);
              unavailable ||= results.some(result => result.status !== "checked");
            } catch { unavailable = true; }
          }
          signal.throwIfAborted();
          const result: LinkResult = { domain, threat, status: threat || !unavailable ? "checked" : "unavailable", checkedUrls: urls };
          completed.set(domain, result);
          // Unavailable is not safe, so it is never cached as a clean result.
          if (result.status === "checked") {
            try { await deps.cache.set(cacheKey, result, DAY_SECONDS); } catch { /* Verdict remains usable. */ }
          }
        } catch {
          if (!signal.aborted) completed.set(domain, { domain, threat: false, status: "unavailable" });
        }
      }));
    });
  } catch { /* Use completed checks; unresolved domains remain explicitly unavailable. */ }
  return [...invalid, ...domains.map(([domain]) => completed.get(domain) ?? { domain, threat: false, status: "unavailable" as const })];
}
