import { describe, expect, it } from "vitest";
import { checkLinks } from "../../src/brain/links.js";
import { mergeVerdict } from "../../src/brain/judgement.js";
import {
  OPENPHISH_CACHE_KEY, OPENPHISH_FEED_URL, OPENPHISH_MAX_ENTRIES, OPENPHISH_TTL_SECONDS,
  normaliseFeedUrl, parseFeed,
} from "../../src/links/index.js";
import { verdict } from "../brain/helpers.js";
import { calledUrls, intelFixtures, link } from "./fakes.js";

const feedCalls = (f: Parameters<typeof calledUrls>[0]) => calledUrls(f).filter(url => url === OPENPHISH_FEED_URL).length;

describe("OpenPhish feed", () => {
  it("flags a link whose normalised URL is on the feed, as a red phishing-list threat", async () => {
    const { deps, linkIntelFetch } = intelFixtures();
    const results = await checkLinks([link("https://PHISH-LOGIN.example/secure/verify#x")], deps);
    expect(results).toMatchObject([{ domain: "phish-login.example", threat: true, phishFeed: true, status: "checked" }]);
    const merged = mergeVerdict(verdict("green"), results);
    expect(merged.level).toBe("red");
    expect(merged.reasons).toContainEqual({ rule_id: "link.phish_feed", hi: "यह लिंक फ़िशिंग सूची में है।", en: "This link is on a public phishing list." });
    expect(merged.checks_fired).not.toContain("link.safe_browsing");
    // Fixed URL, plain GET, no body: nothing from the message goes to OpenPhish.
    const [input, init] = linkIntelFetch.mock.calls.find(([url]) => String(url) === OPENPHISH_FEED_URL)!;
    expect(String(input)).toBe("https://openphish.com/feed.txt");
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
  });

  it("flags any path on a feed hostname, but only the exact URL on shared hosts", async () => {
    const { deps } = intelFixtures();
    expect(await checkLinks([link("https://whole-host-phish.example/another/page")], deps))
      .toMatchObject([{ phishFeed: true, threat: true }]);
    expect((await checkLinks([link("https://docs.google.com/forms/d/someone-else")], deps))[0]!.phishFeed).toBeUndefined();
    expect(await checkLinks([link("https://docs.google.com/forms/d/bad-form")], deps)).toMatchObject([{ phishFeed: true }]);
  });

  it("leaves a link that is not on the feed alone", async () => {
    const { deps } = intelFixtures();
    const results = await checkLinks([link("https://clean-site.example/x")], deps);
    expect(results).toMatchObject([{ threat: false, status: "checked" }]);
    expect(results[0]!.phishFeed).toBeUndefined();
    expect(mergeVerdict(verdict("green"), results)).toMatchObject({ level: "green", reasons: [] });
  });

  it("fails open when the download fails: no signal and never 'unverified' by itself", async () => {
    for (const feed of [async () => new Response("down", { status: 503 }), async () => { throw new Error("network"); }, async () => new Response("")]) {
      const { deps } = intelFixtures({ feed });
      const results = await checkLinks([link("https://phish-login.example/secure/verify")], deps);
      expect(results).toMatchObject([{ threat: false, status: "checked" }]);
      const merged = mergeVerdict(verdict("green"), results);
      expect(merged.level).toBe("green");
      expect(merged.checks_fired).not.toContain("link.unverified");
      expect(deps.cache.set).not.toHaveBeenCalledWith(OPENPHISH_CACHE_KEY, expect.anything(), expect.anything());
    }
  });

  it("is off with OPENPHISH_FEED=0 or without an injected fetch", async () => {
    const off = intelFixtures({}, { OPENPHISH_FEED: "0" });
    expect((await checkLinks([link("https://phish-login.example/secure/verify")], off.deps))[0]!.threat).toBe(false);
    expect(feedCalls(off.linkIntelFetch)).toBe(0);
    const { deps, linkIntelFetch } = intelFixtures();
    const { linkIntelFetch: _drop, ...noFetch } = deps;
    expect((await checkLinks([link("https://phish-login.example/secure/verify")], noFetch))[0]!.threat).toBe(false);
    expect(linkIntelFetch).not.toHaveBeenCalled();
  });

  it("caches the parsed feed for twelve hours under one key and downloads once", async () => {
    const { deps, linkIntelFetch } = intelFixtures();
    await checkLinks([link("https://a-site.example/")], deps);
    await checkLinks([link("https://b-site.example/")], deps);
    expect(feedCalls(linkIntelFetch)).toBe(1);
    expect(deps.cache.set).toHaveBeenCalledWith(OPENPHISH_CACHE_KEY, expect.objectContaining({
      feed: { urls: expect.arrayContaining(["phish-login.example/secure/verify"]), hosts: expect.arrayContaining(["whole-host-phish.example"]) },
    }), OPENPHISH_TTL_SECONDS);
    expect(OPENPHISH_TTL_SECONDS).toBe(43200);
    // A second process with the same shared cache reads it instead of downloading.
    const other = intelFixtures();
    const stored = deps.cache.set.mock.calls.find(([key]) => key === OPENPHISH_CACHE_KEY)![1];
    other.deps.cache.get.mockImplementation(async key => key === OPENPHISH_CACHE_KEY ? stored : undefined);
    expect(await checkLinks([link("https://phish-login.example/secure/verify")], other.deps)).toMatchObject([{ phishFeed: true }]);
    expect(feedCalls(other.linkIntelFetch)).toBe(0);
  });

  it("stores only normalised URLs and hostnames, capped at 20 000", () => {
    expect(normaliseFeedUrl("HTTP://www.Evil.example:8080/Path/?q=1#frag")).toBe("evil.example/Path?q=1");
    expect(normaliseFeedUrl("ftp://evil.example/")).toBeNull();
    const big = Array.from({ length: OPENPHISH_MAX_ENTRIES + 50 }, (_, n) => `https://p${n}.example/x`).join("\n");
    const parsed = parseFeed(big);
    expect(parsed.urls).toHaveLength(OPENPHISH_MAX_ENTRIES);
    expect(parsed.hosts.length).toBeLessThanOrEqual(OPENPHISH_MAX_ENTRIES);
    expect(parseFeed("https://bit.ly/abc\nhttps://sbi.co.in/x").hosts).toEqual([]);
  });
});
