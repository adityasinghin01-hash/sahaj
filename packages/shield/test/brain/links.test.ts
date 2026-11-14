import { describe, expect, it, vi } from "vitest";
import { checkLinks } from "../../src/brain/links.js";
import { fixtures } from "./helpers.js";
const link = (url = "https://example.com/a") => ({ url, domain: new URL(url).hostname });

describe("link reputation", () => {
  it("reuses checked clean URLs for a day, but checks a new path", async () => {
    const { deps } = fixtures(); deps.env = { SAFE_BROWSING_KEY: "fake" };
    expect(await checkLinks([link()], deps)).toMatchObject([{ status: "checked", threat: false }]);
    await checkLinks([link()], deps); expect(deps.safeBrowsingFetch).toHaveBeenCalledOnce();
    await checkLinks([link("https://example.com/other")], deps); expect(deps.safeBrowsingFetch).toHaveBeenCalledTimes(2);
    expect(deps.cache.set.mock.calls.every(([, , ttl]) => ttl === 86400)).toBe(true);
  });
  it("checks all paths on a domain, deduplicates URLs and ignores supplied cache domains", async () => {
    const { deps } = fixtures(); deps.env = { SAFE_BROWSING_KEY: "fake" };
    await checkLinks([link(), { url: "https://example.com/b", domain: "forged.com" }, link()], deps);
    expect(deps.safeBrowsingFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(deps.safeBrowsingFetch.mock.calls[0]![1]?.body));
    expect(body.threatInfo.threatEntries).toEqual([{ url: "https://example.com/a" }, { url: "https://example.com/b" }]);
    expect(deps.cache.set.mock.calls[0]![0]).toBe("shield.domain.v1:example.com");
  });
  it("checks a short link and its expanded destination", async () => {
    const { deps } = fixtures(); deps.env = { SAFE_BROWSING_KEY: "fake" };
    deps.sandbox.unshorten.mockResolvedValue("https://evil.example/path");
    deps.safeBrowsingFetch.mockResolvedValueOnce(new Response("{}")).mockResolvedValueOnce(new Response('{"matches":[{}]}'));
    expect(await checkLinks([link("https://bit.ly/abc")], deps)).toMatchObject([{ threat: true, status: "checked" }]);
    expect(deps.sandbox.unshorten).toHaveBeenCalledOnce();
    const body = JSON.parse(String(deps.safeBrowsingFetch.mock.calls[1]![1]?.body));
    expect(body.threatInfo.threatEntries).toEqual([{ url: "https://evil.example/path" }]);
  });
  it("caches an expanded destination under its own domain and avoids contaminating every short URL", async () => {
    const { deps } = fixtures(); deps.env = { SAFE_BROWSING_KEY: "fake" };
    deps.sandbox.unshorten.mockResolvedValueOnce("https://evil.example/path").mockResolvedValueOnce("https://clean.example/path");
    deps.safeBrowsingFetch.mockImplementation(async (_url, init) => {
      const urls = JSON.parse(String(init?.body)).threatInfo.threatEntries as { url: string }[];
      return new Response(JSON.stringify(urls.some(item => item.url.includes("evil.example")) ? { matches: [{}] } : {}));
    });
    expect(await checkLinks([link("https://bit.ly/bad")], deps)).toMatchObject([{ threat: true }]);
    expect(deps.cache.set).toHaveBeenCalledWith("shield.domain.v1:evil.example", expect.objectContaining({ threat: true }), 86400);
    const before = deps.safeBrowsingFetch.mock.calls.length;
    expect(await checkLinks([link("https://evil.example/path")], deps)).toMatchObject([{ threat: true }]);
    expect(deps.safeBrowsingFetch.mock.calls.length).toBe(before);
    expect(await checkLinks([link("https://bit.ly/good")], deps)).toMatchObject([{ threat: false, status: "checked" }]);
  });
  it("treats an unconfigured API, sandbox denial, provider error and bad JSON as unverified, never caches a clean result", async () => {
    const { deps } = fixtures();
    expect(await checkLinks([link()], deps)).toMatchObject([{ status: "unavailable" }]);
    deps.env = { SAFE_BROWSING_KEY: "fake" }; deps.safeBrowsingFetch.mockRejectedValue(new Error("secret provider error"));
    expect(await checkLinks([link()], deps)).toMatchObject([{ status: "unavailable" }]);
    deps.safeBrowsingFetch.mockResolvedValue(new Response("{}")); deps.sandbox.unshorten.mockRejectedValue(new Error("blocked IP"));
    expect(await checkLinks([link("https://bit.ly/abc")], deps)).toMatchObject([{ status: "unavailable" }]);
    deps.safeBrowsingFetch.mockResolvedValue(new Response("not json"));
    expect(await checkLinks([link()], deps)).toMatchObject([{ status: "unavailable" }]);
    expect(deps.cache.set).not.toHaveBeenCalled();
  });
  it("never fetches a private or invalid event URL", async () => {
    const { deps } = fixtures(); deps.env = { SAFE_BROWSING_KEY: "fake" };
    expect(await checkLinks([link("http://127.0.0.1/")], deps)).toMatchObject([{ status: "blocked" }]);
    expect(deps.safeBrowsingFetch).not.toHaveBeenCalled(); expect(deps.sandbox.unshorten).not.toHaveBeenCalled();
  });
  it("preserves a positive API result if cache writing fails", async () => {
    const { deps } = fixtures(); deps.env = { SAFE_BROWSING_KEY: "fake" };
    deps.safeBrowsingFetch.mockResolvedValue(new Response('{"matches":[{}]}'));
    deps.cache.set.mockRejectedValue(new Error("cache offline"));
    expect(await checkLinks([link()], deps)).toMatchObject([{ threat: true, status: "checked" }]);
  });
  it("bounds slow API, DNS and cache dependencies together at two seconds", async () => {
    vi.useFakeTimers();
    try {
      const { deps } = fixtures(); deps.env = { SAFE_BROWSING_KEY: "fake" };
      deps.safeBrowsingFetch.mockImplementation(async () => new Promise(() => {}));
      const work = checkLinks([link()], deps);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await work).toMatchObject([{ status: "unavailable" }]);
      expect(deps.cache.set).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("preserves a known threat when another API batch fails", async () => {
    const { deps } = fixtures(); deps.env = { SAFE_BROWSING_KEY: "fake" };
    deps.safeBrowsingFetch.mockResolvedValueOnce(new Response('{"matches":[{}]}')).mockRejectedValueOnce(new Error("unavailable"));
    expect(await checkLinks(Array.from({ length: 501 }, (_, n) => link(`https://example.com/${n}`)), deps)).toMatchObject([{ threat: true, status: "checked" }]);
  });
  it("respects the API maximum of five hundred URLs per request", async () => {
    const { deps } = fixtures(); deps.env = { SAFE_BROWSING_KEY: "fake" };
    await checkLinks(Array.from({ length: 501 }, (_, n) => link(`https://example.com/${n}`)), deps);
    expect(deps.safeBrowsingFetch).toHaveBeenCalledTimes(2);
    expect(deps.safeBrowsingFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).threatInfo.threatEntries.length)).toEqual([500, 1]);
  });
});
