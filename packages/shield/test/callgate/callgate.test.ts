import { describe, expect, it, vi } from "vitest";
import { CALL_GATE_END_LINE, callScreen, numberFingerprint, screenCall, type CallGateDeps } from "../../src";
import { scoreVoiceText } from "../../src/runtime/rules";

const ctx = { familyId: "family", parentId: "parent" };
const RIYA = "+91 90000 00002";
const STRANGER = "+919000000005";
const SCAM_WHY = "Main police se bol raha hoon. Aapke naam par arrest warrant hai, digital arrest hoga. Video call par rahiye aur kisi ko mat bataiye.";

async function deps(opts: { enabled?: boolean; ai?: unknown; aiFails?: boolean } = {}) {
  const riyaHash = await numberFingerprint(RIYA);
  const understand = vi.fn(async () => opts.aiFails ? { ok: false as const, reason: "all_failed" }
    : { ok: true as const, data: opts.ai ?? { is_scam: false, scam_type: "unknown", confidence: 0.1 }, model: "claude" });
  const d: CallGateDeps = {
    env: { CALL_GATEWAY_ENABLED: opts.enabled === false ? undefined : "1" },
    db: {
      getParent: vi.fn(async input => input.familyId === ctx.familyId && input.parentId === ctx.parentId),
      isFamilyNumber: vi.fn(async input => input.familyId === ctx.familyId && input.phoneHash === riyaHash),
    },
    rules: { scoreText: scoreVoiceText },
    router: { understand: understand as CallGateDeps["router"]["understand"] },
    alertChild: vi.fn(async () => undefined),
    sign: vi.fn(async () => undefined),
  };
  return { d, understand };
}

describe("call gateway (Step 3.6)", () => {
  it("is OFF unless CALL_GATEWAY_ENABLED === '1'", async () => {
    for (const value of [undefined, "", "0", "true", "yes"]) {
      const { d } = await deps(); d.env = { CALL_GATEWAY_ENABLED: value };
      expect(await screenCall(d, ctx, { from: STRANGER, saidWho: "x", saidWhy: SCAM_WHY })).toEqual({ enabled: false });
      expect(d.db.getParent).not.toHaveBeenCalled();
    }
  });
  it("a saved family number is forwarded without any AI call", async () => {
    const { d, understand } = await deps();
    expect(await screenCall(d, ctx, { from: "9000000002", saidWho: "Riya", saidWhy: "Maa se baat" }))
      .toMatchObject({ enabled: true, action: "forward", reason: "saved_family" });
    expect(understand).not.toHaveBeenCalled();
  });
  it("an unknown caller with scam words is ended with the fixed line; Riya is alerted; Maa is told", async () => {
    const { d, understand } = await deps();
    const out = await screenCall(d, ctx, { from: STRANGER, saidWho: "Police officer", saidWhy: SCAM_WHY });
    expect(out).toMatchObject({ enabled: true, action: "end", reason: "scam", line: CALL_GATE_END_LINE, notify_parent: true });
    expect(understand).not.toHaveBeenCalled(); // rules alone were red
    expect(d.alertChild).toHaveBeenCalledWith(expect.objectContaining({ ...ctx,
      verdict: expect.objectContaining({ level: "red", actions: ["alert_child"] }) }));
  });
  it("an unknown caller the AI judges a scam is ended; a genuine one is forwarded", async () => {
    const scam = await deps({ ai: { is_scam: true, scam_type: "lottery_prize", confidence: 0.9 } });
    expect(await screenCall(scam.d, ctx, { from: STRANGER, saidWho: "Rahul", saidWhy: "Aapke liye ek khushkhabri hai" }))
      .toMatchObject({ action: "end", scam_type: "lottery_prize" });
    const genuine = await deps();
    expect(await screenCall(genuine.d, ctx, { from: STRANGER, saidWho: "Gupta Medical", saidWhy: "Dawa ki delivery ke liye ghar ka raasta poochna tha" }))
      .toMatchObject({ action: "forward", reason: "genuine" });
    expect(genuine.d.alertChild).not.toHaveBeenCalled();
  });
  it("only masked words reach the AI: never the caller number or any 4+ digit run", async () => {
    const { d, understand } = await deps({ ai: { is_scam: false, scam_type: "unknown", confidence: 0.2 } });
    await screenCall(d, ctx, { from: STRANGER, saidWho: "Courier 9000000006", saidWhy: "Parcel number 778899 ke liye address" });
    expect(understand).toHaveBeenCalledOnce();
    expect(JSON.stringify(understand.mock.calls)).not.toMatch(/9000000005|9000000006|778899|\p{Nd}{4,}/u);
  });
  it("fails open: AI failure, storage failure or a wrong parent forwards the call (nothing is blocked)", async () => {
    const failing = await deps({ aiFails: true });
    expect(await screenCall(failing.d, ctx, { from: STRANGER, saidWho: "Rahul", saidWhy: "Kuch baat karni thi" })).toMatchObject({ action: "forward" });
    const broken = await deps(); broken.d.db.isFamilyNumber = async () => { throw new Error("db"); };
    expect(await screenCall(broken.d, ctx, { from: STRANGER, saidWho: "x", saidWhy: SCAM_WHY })).toMatchObject({ action: "forward", reason: "unsure" });
    const outsider = await deps();
    expect(await screenCall(outsider.d, { ...ctx, parentId: "other" }, { from: STRANGER, saidWho: "x", saidWhy: SCAM_WHY })).toMatchObject({ action: "forward" });
    expect(outsider.d.alertChild).not.toHaveBeenCalled();
  });
  it("call_screen tool maps the agent's snake_case input", async () => {
    const { d } = await deps();
    expect(callScreen.name).toBe("call_screen");
    expect(await callScreen.run(d, ctx, { from: STRANGER, said_who: "Police", said_why: SCAM_WHY })).toMatchObject({ action: "end" });
    d.env = {};
    expect(await callScreen.run(d, ctx, { from: STRANGER, said_who: "Police", said_why: SCAM_WHY })).toEqual({ enabled: false });
  });
});
