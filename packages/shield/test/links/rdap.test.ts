import { describe, expect, it, vi } from "vitest";
import { RULES } from "../../src/rules/index.js";
import { checkLinks } from "../../src/brain/links.js";
import { mergeVerdict } from "../../src/brain/judgement.js";
import {
  RDAP_BASE, RDAP_TTL_SECONDS, isValidRdapDomain, lookupRegistration, rdapCacheKey, rdapDomainFor, registrationDate,
} from "../../src/links/index.js";
import { verdict } from "../brain/helpers.js";
import { calledUrls, daysAgo, intelFixtures, link } from "./fakes.js";

const rdapCalls = (f: Parameters<typeof calledUrls>[0]) => calledUrls(f).filter(url => url.startsWith(RDAP_BASE));
const withIds = (level: "green" | "yellow", ids: string[]) => ({ ...verdict(level), reasons: [], checks_fired: ids });
const NEW_REASON = { rule_id: "link.new_domain", hi: "यह वेबसाइट कुछ ही दिन पहले बनी है।", en: "This website was registered only days ago." };

describe("RDAP new-domain age", () => {
  it("a 5-day-old domain with KYC wording is red", async () => {
    const { deps } = intelFixtures({ rdap: { "kyc-help.example": daysAgo(5) } });
    const results = await checkLinks([link("https://kyc-help.example/update")], deps);
    expect(results).toMatchObject([{ newDomain: true, domainAgeDays: 5, threat: false, status: "checked" }]);
    const merged = mergeVerdict(withIds("yellow", ["script.kyc_block", "link.present"]), results);
    expect(merged.level).toBe("red");
    expect(merged.reasons).toContainEqual(NEW_REASON);
    expect(merged.checks_fired).toContain("link.new_domain");
  });

  it("a 5-day-old domain alone is yellow; a shortener, look-alike or OTP context makes it red", async () => {
    const { deps } = intelFixtures({ rdap: { "fresh-site.example": daysAgo(5) } });
    const results = await checkLinks([link("https://fresh-site.example/photos")], deps);
    expect(mergeVerdict(withIds("green", ["link.present", "pattern.P5.yellow", "pattern.P5"]), results).level).toBe("yellow");
    for (const id of ["link.shortener", "link.look_alike", "otp.present", "signal.urgency", "pattern.P5.red", "sender.mobile_claims_brand"]) {
      expect(mergeVerdict(withIds("green", ["link.present", id]), results).level).toBe("red");
    }
  });

  it("a 2-year-old domain gives no signal", async () => {
    const { deps } = intelFixtures({ rdap: { "old-shop.example": daysAgo(730) } });
    const results = await checkLinks([link("https://old-shop.example/")], deps);
    expect(results).toMatchObject([{ domainAgeDays: 730 }]);
    expect(results[0]!.newDomain).toBeUndefined();
    expect(mergeVerdict(withIds("green", ["script.kyc_block"]), results).checks_fired).not.toContain("link.new_domain");
  });

  it("404 / unsupported TLD is unknown: no signal, cached for a day, not looked up again", async () => {
    const { deps, linkIntelFetch } = intelFixtures({ rdap: {} });
    const results = await checkLinks([link("https://nowhere.example/")], deps);
    expect(results[0]!.newDomain).toBeUndefined(); expect(results[0]!.domainAgeDays).toBeUndefined();
    expect(mergeVerdict(withIds("green", []), results)).toMatchObject({ level: "green", reasons: [] });
    expect(deps.cache.set).toHaveBeenCalledWith(rdapCacheKey("nowhere.example"),
      expect.objectContaining({ domain: "nowhere.example", registeredAt: null }), RDAP_TTL_SECONDS);
    expect(RDAP_TTL_SECONDS).toBe(86400);
    await checkLinks([link("https://nowhere.example/other")], deps);
    expect(rdapCalls(linkIntelFetch)).toHaveLength(1);
  });

  it("a timeout is unknown: no signal after three seconds", async () => {
    vi.useFakeTimers();
    try {
      const { deps } = intelFixtures({ rdap: { "slow.example": "hang" } }, { OPENPHISH_FEED: "0" });
      const work = lookupRegistration("slow.example", deps);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await work).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("an answer without a registration event is unknown", () => {
    expect(registrationDate({ events: [{ eventAction: "expiration", eventDate: "2030-01-01T00:00:00Z" }] })).toBeNull();
    expect(registrationDate({ events: "nope" })).toBeNull();
    expect(registrationDate(null)).toBeNull();
    expect(registrationDate({ events: [{ eventAction: "registration", eventDate: "2026-11-09T00:00:00Z" }] })).toBe("2026-11-09T00:00:00.000Z");
  });

  it("sends only the registrable domain, never the subdomain, path or query", async () => {
    const { deps, linkIntelFetch } = intelFixtures({ rdap: { "newsite.example": daysAgo(2) } });
    await checkLinks([link("https://login.newsite.example/account/verify?user=meena&ref=1#top")], deps);
    expect(rdapCalls(linkIntelFetch)).toEqual(["https://rdap.org/domain/newsite.example"]);
    const [, init] = linkIntelFetch.mock.calls.find(([url]) => String(url).startsWith(RDAP_BASE))!;
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("accept")).toBe("application/rdap+json");
    expect(rdapDomainFor("https://a.b.example.co.in/x?y")).toBe("example.co.in");
  });

  it("never looks up official brand domains, trusted suffixes, shorteners or IPs", async () => {
    const official = RULES.links.brands.flatMap(brand => brand.official).slice(0, 5);
    const { deps, linkIntelFetch } = intelFixtures();
    await checkLinks([...official.map(domain => link(`https://${domain}/login`)),
      link("https://www.example.bank.in/"), link("https://bit.ly/abc"), link("https://8.8.8.8/x")], deps);
    expect(rdapCalls(linkIntelFetch)).toEqual([]);
    for (const domain of official) expect(rdapDomainFor(domain)).toBeNull();
  });

  it("validates the domain strictly before building the URL", () => {
    expect(isValidRdapDomain("newsite.example")).toBe(true);
    expect(isValidRdapDomain("xn--80ak6aa92e.example")).toBe(true);
    for (const bad of ["localhost", "a..b", ".a.b", "a.b.", "evil.example/path", "evil.example?x", "EVIL.example", "a b.example", "10.0.0.1", `${"a".repeat(250)}.com`]) {
      expect(isValidRdapDomain(bad)).toBe(false);
    }
  });

  it("a cache hit avoids a second fetch", async () => {
    const { deps, linkIntelFetch } = intelFixtures({ rdap: { "fresh-site.example": daysAgo(5) } });
    await checkLinks([link("https://fresh-site.example/a")], deps);
    const again = await checkLinks([link("https://fresh-site.example/b")], deps);
    expect(again).toMatchObject([{ newDomain: true, domainAgeDays: 5 }]);
    expect(rdapCalls(linkIntelFetch)).toHaveLength(1);
  });

  it("is off with RDAP_LOOKUP=0", async () => {
    const { deps, linkIntelFetch } = intelFixtures({ rdap: { "fresh-site.example": daysAgo(5) } }, { RDAP_LOOKUP: "0" });
    expect((await checkLinks([link("https://fresh-site.example/a")], deps))[0]!.newDomain).toBeUndefined();
    expect(rdapCalls(linkIntelFetch)).toEqual([]);
  });
});
