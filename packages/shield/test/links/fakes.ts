import { vi } from "vitest";
import { OPENPHISH_FEED_URL, RDAP_BASE } from "../../src/links/index.js";
import { fixtures } from "../brain/helpers.js";

export const NOW = Date.parse("2026-11-14T09:05:00.000Z");
export const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

export const FEED = [
  "https://phish-login.example/secure/verify/",
  "http://www.whole-host-phish.example/a?b=1",
  "https://docs.google.com/forms/d/bad-form",
  "not a url",
  "",
].join("\n");

export interface FakeNet {
  feed?: string | (() => Promise<Response>);
  /** registrable domain → registration date, "404", or "hang" */
  rdap?: Record<string, string>;
}

/** Fake fetch for the two fixed hosts. Anything else fails the test loudly. */
export function fakeNet(net: FakeNet = {}) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === OPENPHISH_FEED_URL) {
      if (typeof net.feed === "function") return net.feed();
      return new Response(net.feed ?? FEED);
    }
    if (url.startsWith(RDAP_BASE)) {
      const domain = url.slice(RDAP_BASE.length);
      const entry = net.rdap?.[domain];
      if (entry === "hang") {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (!entry || entry === "404") return new Response('{"errorCode":404}', { status: 404 });
      return new Response(JSON.stringify({
        objectClassName: "domain", ldhName: domain,
        events: [{ eventAction: "last changed", eventDate: daysAgo(1) }, { eventAction: "registration", eventDate: entry }],
      }), { headers: { "Content-Type": "application/rdap+json" } });
    }
    throw new Error(`unexpected network call: ${url}`);
  });
}

/** Brain fixtures with Safe Browsing configured (clean) and a fake link-intel fetch. */
export function intelFixtures(net: FakeNet = {}, env: Record<string, string> = {}) {
  const { deps } = fixtures();
  const linkIntelFetch = fakeNet(net);
  const full = { ...deps, env: { SAFE_BROWSING_KEY: "fake", ...env }, now: () => NOW, linkIntelFetch };
  return { deps: full, linkIntelFetch };
}

export const link = (url: string) => ({ url, domain: new URL(url).hostname });
export const calledUrls = (f: ReturnType<typeof fakeNet>) => f.mock.calls.map(([input]) => String(input));
