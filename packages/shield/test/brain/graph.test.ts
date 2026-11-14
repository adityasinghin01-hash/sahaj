import { describe, expect, it } from "vitest";
import { buildShieldGraph, handleScheduledJob } from "../../src/brain/index.js";
import { event, fixtures, locks } from "./helpers.js";

const run = (deps: ReturnType<typeof fixtures>["deps"], e = event()) => buildShieldGraph(deps).invoke({ event: e });
describe("Shield graph", () => {
  it("runs all eight nodes, persists red KYC before alerting, with three reasons, no AI, under four seconds", async () => {
    const { deps } = fixtures("red", true);
    deps.notify.childCard.mockImplementation(async () => { expect(deps.db.insertVerdict).toHaveBeenCalledOnce(); });
    const start = performance.now();
    const out = await run(deps);
    expect(performance.now() - start).toBeLessThan(4000);
    expect(out.decision?.verdict.level).toBe("red"); expect(out.decision?.verdict.reasons.length).toBeGreaterThanOrEqual(3);
    expect(deps.twoLock).not.toHaveBeenCalled(); expect(deps.whatsapp.sendShieldAlert).toHaveBeenCalledOnce();
    expect(deps.notify.childCard).toHaveBeenCalledWith(expect.objectContaining({ quiet: false, push: true }));
    const steps = deps.sign.mock.calls.map(([r]) => r.step);
    for (const node of ["load", "rules", "links", "ai", "verdict", "gate", "respond", "sign"]) expect(steps).toContain(node);
    expect(steps).toContain("confirm_red_screen"); expect(deps.calls.callParent).not.toHaveBeenCalled();
    expect(deps.db.getRecentEvents).toHaveBeenCalledWith({ familyId: "family-a", parentId: "maa", since: "2026-11-14T08:35:00.000Z", until: "2026-11-14T09:05:00.000Z" });
  });
  it.each([[true, true, "red"], [true, false, "yellow"], [null, null, "yellow"], [true, null, "yellow"], [null, true, "yellow"], [false, false, "yellow"]] as const)("merges locks %s / %s into %s", async (a, b, expected) => {
    const { deps } = fixtures("yellow", true); deps.twoLock.mockResolvedValue(locks(a, b));
    const out = await run(deps); expect(out.decision?.verdict.level).toBe(expected);
    expect(deps.twoLock).toHaveBeenCalledWith(expect.objectContaining({ task: "shield.judge" }));
    expect(out.decision?.verdict.models_agreed).toEqual(a !== null && a === b ? ["claude", "muse"] : []);
  });
  it("keeps clean green quiet", async () => {
    const { deps } = fixtures(); const out = await run(deps);
    expect(out.decision?.verdict.level).toBe("green"); expect(out.decision?.verdict.actions).toEqual([]);
    expect(deps.twoLock).not.toHaveBeenCalled(); expect(deps.notify.childCard).not.toHaveBeenCalled();
  });
  it("sends a quiet yellow card and push without WhatsApp", async () => {
    const { deps } = fixtures("yellow"); await run(deps);
    expect(deps.notify.childCard).toHaveBeenCalledWith(expect.objectContaining({ quiet: true, push: true }));
    expect(deps.whatsapp.sendShieldAlert).not.toHaveBeenCalled();
  });
  it.each(["123456", "१२३४५६", "١٢٣٤٥٦"])("never passes digit runs %s to AI", async digits => {
    const { deps } = fixtures("yellow", true);
    deps.twoLock.mockImplementation(async req => {
      expect(req.input).not.toMatch(/\p{Decimal_Number}{4,}/u); expect(req.system).not.toMatch(/\p{Decimal_Number}+/u);
      expect(req.input).not.toContain("line-maa"); return locks();
    });
    await run(deps, event({ masked_text: `Please share ${digits}`, context: { unrelated: "999999" } }));
    expect(deps.twoLock).toHaveBeenCalledOnce();
  });
  it("turns Safe Browsing matches red and caches the domain for a day", async () => {
    const { deps } = fixtures(); deps.env = { SAFE_BROWSING_KEY: "fake-key" };
    deps.rules.evaluate.mockResolvedValue({ verdict: (await deps.rules.evaluate()).verdict, needs_ai: false, links: [{ url: "https://evil.example/kyc", domain: "evil.example" }] });
    deps.safeBrowsingFetch.mockResolvedValue(new Response(JSON.stringify({ matches: [{ threatType: "SOCIAL_ENGINEERING" }] })));
    const out = await run(deps); expect(out.decision?.verdict.level).toBe("red");
    expect(deps.cache.set).toHaveBeenCalledWith("shield.domain.v1:evil.example", expect.objectContaining({ threat: true }), 86400);
    await run(deps); expect(deps.safeBrowsingFetch).toHaveBeenCalledOnce();
    const [url, init] = deps.safeBrowsingFetch.mock.calls[0]!;
    expect(String(url)).toBe("https://safebrowsing.googleapis.com/v4/threatMatches:find?key=fake-key");
    expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toMatchObject({ threatInfo: { threatEntryTypes: ["URL"], threatEntries: [{ url: "https://evil.example/kyc" }] } });
  });
  it("drops and signs gate denials before any effects or schedules", async () => {
    const { deps } = fixtures("red"); deps.gate.check.mockResolvedValue({ allowed: false });
    const out = await run(deps, event({ channel: "keypad_voice", context: { money_already_left: true } }));
    expect(out.decision?.verdict.actions).toEqual([]); expect(deps.notify.childCard).not.toHaveBeenCalled();
    expect(deps.calls.callParent).not.toHaveBeenCalled(); expect(deps.scheduler.after).not.toHaveBeenCalled();
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ step: "gate.action", status: "denied" }));
  });
  it.each([false, true])("offers fraud reporting only on explicit money loss: %s", async lost => {
    const { deps } = fixtures("red"); const out = await run(deps, event({ context: { money_already_left: lost } }));
    expect(out.decision?.verdict.actions.includes("offer_1930")).toBe(lost);
    expect(deps.notify.childCard).toHaveBeenCalledWith(expect.objectContaining({ offer1930: lost }));
  });
});

describe("durable ladder", () => {
  it.each(["keypad_voice", "gateway_sms", "busy_watch"] as const)("calls Maa on %s, retries at scaled two minutes, caps at three total attempts", async channel => {
    const { deps } = fixtures("red"); deps.env = { DEMO_TIMER_SCALE: "10" };
    await run(deps, event({ channel }));
    expect(deps.calls.callParent).toHaveBeenCalledWith(expect.objectContaining({ lineId: "line-maa", attempt: 1 }));
    expect(deps.scheduler.after).toHaveBeenCalledWith(12000, "retryCallParent", { verdictId: "verdict-a", attempt: 2 });
    await handleScheduledJob("retryCallParent", { verdictId: "verdict-a", attempt: 2 }, deps);
    await handleScheduledJob("retryCallParent", { verdictId: "verdict-a", attempt: 3 }, deps);
    expect(deps.calls.callParent).toHaveBeenCalledTimes(3);
    expect(deps.scheduler.after.mock.calls.filter(([, name]) => name === "retryCallParent")).toHaveLength(2);
  });
  it("starts the family circle if Riya has not reacted; skips after any tap", async () => {
    const { deps } = fixtures("red"); await run(deps);
    expect(deps.scheduler.after).toHaveBeenCalledWith(120000, "shield.no_reaction_check", { verdictId: "verdict-a" });
    await handleScheduledJob("shield.no_reaction_check", { verdictId: "verdict-a" }, deps);
    expect(deps.atlas.startCircleChain).toHaveBeenCalledOnce();
    deps.db.hasChildReaction.mockResolvedValue(true);
    await handleScheduledJob("shield.no_reaction_check", { verdictId: "verdict-a" }, deps);
    expect(deps.atlas.startCircleChain).toHaveBeenCalledOnce();
  });
  it("rechecks gate consent on a delayed job", async () => {
    const { deps } = fixtures("red"); await run(deps, event({ channel: "keypad_voice" }));
    deps.gate.check.mockResolvedValue({ allowed: false });
    await handleScheduledJob("retryCallParent", { verdictId: "verdict-a", attempt: 2 }, deps);
    await handleScheduledJob("shield.no_reaction_check", { verdictId: "verdict-a" }, deps);
    expect(deps.calls.callParent).toHaveBeenCalledOnce(); expect(deps.atlas.startCircleChain).not.toHaveBeenCalled();
  });
  it("does not retry answered calls", async () => {
    const { deps } = fixtures("red"); deps.calls.callParent.mockResolvedValue({ status: "answered" });
    await run(deps, event({ channel: "keypad_voice" }));
    expect(deps.scheduler.after.mock.calls.some(([, name]) => name === "retryCallParent")).toBe(false);
  });
});
