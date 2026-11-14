import { describe, expect, it } from "vitest";
import { LINK_INTEL_USER_AGENT, lookupRegistration } from "../../src/links/rdap";
import { loadOpenPhishFeed } from "../../src/links/openphish";
import { daysAgo, intelFixtures } from "./fakes";

// rdap.org answers 403 to Node's default "node" User-Agent (seen live 14 Nov); both lookups must name the client.
describe("link checks send a named User-Agent", () => {
  it("RDAP and the OpenPhish feed both send LINK_INTEL_USER_AGENT", async () => {
    const { deps, linkIntelFetch } = intelFixtures({ rdap: { "fresh-site.in": daysAgo(3) } });
    await lookupRegistration("fresh-site.in", deps as never);
    await loadOpenPhishFeed(deps as never);
    const agents = linkIntelFetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("User-Agent"));
    expect(agents.length).toBeGreaterThanOrEqual(2);
    for (const agent of agents) expect(agent).toBe(LINK_INTEL_USER_AGENT);
    expect(LINK_INTEL_USER_AGENT).not.toMatch(/^node/i);
  });
});
