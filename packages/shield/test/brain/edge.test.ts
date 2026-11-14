import { describe, expect, it, vi } from "vitest";
import { createRouter } from "@sahaj/adapters";
import { buildShieldGraph, handleScheduledJob } from "../../src/brain/index.js";
import { scaledDelay } from "../../src/brain/respond.js";
import { judge } from "../../src/brain/judgement.js";
import { event, fixtures, judgement, locks, verdict } from "./helpers.js";

describe("failure, privacy and scheduling boundaries", () => {
  it("uses the real twoLock router with fake providers and no event metadata", async () => {
    const { deps } = fixtures("green", true);
    const provider = vi.fn(async (req: { input: string; system: string }) => {
      expect(req.input).toBe("Share [MASKED] now"); expect(req.system).not.toMatch(/\p{Decimal_Number}/u);
      return { kind: "text" as const, text: JSON.stringify(judgement()) };
    });
    const router = createRouter({ claude: provider, muse: provider, gemini: provider });
    const graph = buildShieldGraph({ ...deps, twoLock: router.twoLock });
    const result = await graph.invoke({ event: event({ masked_text: "Share 123456 now", parent_id: "maa", context: { bank_account: "88889999" } }) });
    expect(result.decision.verdict.level).toBe("red"); expect(provider).toHaveBeenCalledTimes(2);
  });
  it("falls back to the rules when twoLock throws or exceeds its deadline", async () => {
    const { deps } = fixtures("yellow", true); deps.twoLock.mockRejectedValue(new Error("private provider error"));
    const result = await buildShieldGraph(deps).invoke({ event: event() });
    expect(result.decision.verdict.level).toBe("yellow");
    expect(JSON.stringify(deps.sign.mock.calls)).not.toContain("private provider error");
    vi.useFakeTimers();
    try {
      deps.twoLock.mockImplementation(async () => new Promise(() => {}));
      const result = judge(event(), deps);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toEqual(locks(null, null));
    } finally { vi.useRealTimers(); }
  });
  it.each([[null, false], [false, null], [false, false], [null, null]] as const)("keeps a clean rules result green with locks %s / %s", async (a, b) => {
    const { deps } = fixtures("green", true); deps.twoLock.mockResolvedValue(locks(a, b));
    const result = await buildShieldGraph(deps).invoke({ event: event() });
    expect(result.decision.verdict.level).toBe("green"); expect(deps.notify.childCard).not.toHaveBeenCalled();
  });
  it("does not let a slow parent-call provider delay either of Riya's alerts", async () => {
    const { deps } = fixtures("red");
    let finishCall!: (value: { status: "answered" }) => void;
    deps.calls.callParent.mockImplementation(() => new Promise(resolve => { finishCall = resolve; }));
    const invoked = buildShieldGraph(deps).invoke({ event: event({ channel: "keypad_voice" }) });
    await vi.waitFor(() => expect(deps.whatsapp.sendShieldAlert).toHaveBeenCalledOnce());
    expect(deps.notify.childCard).toHaveBeenCalledOnce(); expect(deps.scheduler.after).toHaveBeenCalled();
    finishCall({ status: "answered" }); await invoked;
  });
  it("signs a failed WhatsApp operation while still pushing, calling and scheduling", async () => {
    const { deps } = fixtures("red"); deps.whatsapp.sendShieldAlert.mockRejectedValue(new Error("private error"));
    await buildShieldGraph(deps).invoke({ event: event({ channel: "keypad_voice" }) });
    expect(deps.notify.childCard).toHaveBeenCalledOnce(); expect(deps.calls.callParent).toHaveBeenCalledOnce();
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ step: "whatsapp_alert", status: "failed" }));
    expect(deps.scheduler.after).toHaveBeenCalledWith(120000, "shield.no_reaction_check", { verdictId: "verdict-a" });
  });
  it("fails a gate closed when its adapter throws", async () => {
    const { deps } = fixtures("red"); deps.gate.check.mockRejectedValue(new Error("offline"));
    const result = await buildShieldGraph(deps).invoke({ event: event() });
    expect(result.decision.verdict.actions).toEqual([]); expect(deps.notify.childCard).not.toHaveBeenCalled();
  });
  it("propagates a signing failure before starting response effects", async () => {
    const { deps } = fixtures("red"); deps.sign.mockImplementation(async row => { if (row.step === "verdict") throw new Error("signing offline"); });
    await expect(buildShieldGraph(deps).invoke({ event: event() })).rejects.toThrow("signing offline");
    expect(deps.notify.childCard).not.toHaveBeenCalled(); expect(deps.db.insertVerdict).not.toHaveBeenCalled();
  });
  it("never carries arbitrary rules actions into the response ladder", async () => {
    const { deps } = fixtures("red");
    deps.rules.evaluate.mockResolvedValue({ verdict: { ...verdict("red"), actions: ["pause_call", "watch_numbers_24h", "offer_1930"] }, needs_ai: false, links: [] });
    const result = await buildShieldGraph(deps).invoke({ event: event() });
    expect(result.decision.verdict.actions).toEqual(["alert_child", "show_red_screen", "circle_chain"]);
  });
  it("filters DB history by the exact parent/family and thirty-minute window", async () => {
    const { deps } = fixtures();
    const valid = event({ idempotency_key: "recent-valid" });
    deps.db.getRecentEvents.mockResolvedValue([valid, event({ family_id: "another-family" }), event({ parent_id: "someone-else" }), event({ occurred_at: "2026-11-14T08:00:00.000Z" }), event({ occurred_at: "2026-11-14T10:00:00.000Z" })]);
    await buildShieldGraph(deps).invoke({ event: event() });
    expect(deps.rules.evaluate).toHaveBeenCalledWith(event(), [valid]);
  });
  it("refuses a parent belonging to another family", async () => {
    const { deps } = fixtures("red"); deps.db.getParent.mockResolvedValue({ id: "maa", family_id: "other" });
    await expect(buildShieldGraph(deps).invoke({ event: event() })).rejects.toThrow(/mismatch/);
    expect(deps.notify.childCard).not.toHaveBeenCalled();
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ step: "load", status: "failed" }));
  });
  it("does not cache an unavailable link check as safe; escalates unverified links to yellow", async () => {
    const { deps } = fixtures();
    deps.rules.evaluate.mockResolvedValue({ verdict: verdict(), needs_ai: false, links: [{ url: "https://example.com/", domain: "example.com" }] });
    const result = await buildShieldGraph(deps).invoke({ event: event() });
    expect(result.decision.verdict.level).toBe("yellow");
    expect(result.decision.verdict.reasons).toContainEqual(expect.objectContaining({ rule_id: "link.unverified" }));
    expect(deps.cache.set).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "no", "Infinity", ""])("uses the default delay for invalid scale %s", scale => {
    const { deps } = fixtures(); deps.env = { DEMO_TIMER_SCALE: scale }; expect(scaledDelay(deps)).toBe(120000);
  });
  it("skips a missing call line with a signed explanation", async () => {
    const { deps } = fixtures("red"); deps.db.getParent.mockResolvedValue({ id: "maa", family_id: "family-a" });
    await buildShieldGraph(deps).invoke({ event: event({ channel: "keypad_voice" }) });
    expect(deps.calls.callParent).not.toHaveBeenCalled(); expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ step: "call_parent", status: "skipped", details: { reason: "missing_line", attempt: 1 } }));
    expect(deps.whatsapp.sendShieldAlert).toHaveBeenCalledOnce();
  });
  it("signs a failed reaction lookup and does not guess that Riya ignored the alert", async () => {
    const { deps } = fixtures("red"); await buildShieldGraph(deps).invoke({ event: event() });
    deps.db.hasChildReaction.mockRejectedValue(new Error("database unavailable"));
    await expect(handleScheduledJob("shield.no_reaction_check", { verdictId: "verdict-a" }, deps)).rejects.toThrow();
    expect(deps.atlas.startCircleChain).not.toHaveBeenCalled();
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ step: "shield.no_reaction_check", status: "failed" }));
  });
  it("removes a denied fraud-reporting offer from both the persisted verdict and alert payload", async () => {
    const { deps } = fixtures("red");
    deps.gate.check.mockImplementation(async ({ action }) => ({ allowed: action !== "offer_1930" }));
    const result = await buildShieldGraph(deps).invoke({ event: event({ context: { money_already_left: true } }) });
    expect(result.decision.verdict.actions).not.toContain("offer_1930");
    expect(deps.notify.childCard).toHaveBeenCalledWith(expect.objectContaining({ offer1930: false }));
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ action: "offer_1930", status: "denied" }));
  });
  it("validates job names, persisted records and retry limits", async () => {
    const { deps } = fixtures();
    await expect(handleScheduledJob("other", {}, deps)).rejects.toThrow(/Unknown/);
    for (const attempt of [0, 1, 4, 2.5]) await expect(handleScheduledJob("retryCallParent", { verdictId: "a", attempt }, deps)).rejects.toThrow();
    await expect(handleScheduledJob("shield.no_reaction_check", { verdictId: "missing" }, deps)).rejects.toThrow(/not found/);
    await buildShieldGraph(deps).invoke({ event: event() });
    await handleScheduledJob("shield.no_reaction_check", { verdictId: "verdict-a" }, deps);
    expect(deps.atlas.startCircleChain).not.toHaveBeenCalled();
  });
});
