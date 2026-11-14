import { describe, expect, it } from "vitest";
import { buildShieldGraph } from "../../src/brain/index.js";
import { event, verdict } from "./helpers.js";
import { daysAgo, intelFixtures, link } from "../links/fakes.js";

describe("brain with key-free link checks", () => {
  it("a phishing-feed link makes the verdict red and skips the AI", async () => {
    const { deps } = intelFixtures();
    deps.rules.evaluate.mockResolvedValue({ verdict: verdict("green"), needs_ai: true, links: [link("https://phish-login.example/secure/verify")] });
    const result = await buildShieldGraph(deps).invoke({ event: event() });
    expect(result.decision.verdict.level).toBe("red");
    expect(result.decision.verdict.checks_fired).toContain("link.phish_feed");
    expect(deps.twoLock).not.toHaveBeenCalled();
    const linksRow = deps.sign.mock.calls.map(([row]) => row).find(row => row.step === "links")!;
    expect(linksRow.details).toMatchObject({ threats: 1, unverified: 0 });
    // Signed timeline rows carry counts only, never the URL or domain.
    expect(JSON.stringify(deps.sign.mock.calls)).not.toContain("phish-login");
  });

  it("a days-old website alone gives a quiet yellow", async () => {
    const { deps } = intelFixtures({ rdap: { "fresh-site.example": daysAgo(3) } });
    deps.rules.evaluate.mockResolvedValue({ verdict: verdict("green"), needs_ai: false, links: [link("https://fresh-site.example/photos")] });
    const result = await buildShieldGraph(deps).invoke({ event: event({ masked_text: "Photos: <URL:fresh-site.example>" }) });
    expect(result.decision.verdict.level).toBe("yellow");
    expect(result.decision.verdict.checks_fired).toEqual(["link.new_domain"]);
  });
});
