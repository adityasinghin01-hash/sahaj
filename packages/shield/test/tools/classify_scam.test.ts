import { describe, expect, it, vi } from "vitest";
import { STOP_SCRIPTS, shieldTools } from "../../src/tools";
import { ctx, hang, makeDeps, SCAM_JUDGEMENT, textsSeenByAi } from "./fakes";

const classify = shieldTools.classify_scam;

describe("classify_scam", () => {
  it("red from rules: digital arrest → stop script 4, alerts + bridges child, skips the AI", async () => {
    const { deps } = await makeDeps({ rules: { level: "red", scam_type: "digital_arrest", hits: ["P4"] } });
    const out = await classify.run(deps, ctx, { said: "CBI wale video call pe arrest bol rahe hain" });

    expect(out).toEqual({
      scam_type: "digital_arrest",
      level: "red",
      stop_script_id: 4,
      line_hi: STOP_SCRIPTS[4],
      bridge_to: "child",
    });
    expect(deps.llm.understand).not.toHaveBeenCalled();
    expect(deps.atlas.alertChild).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: "fam_1",
        parentId: "maa_1",
        verdict: expect.objectContaining({ level: "red", scam_type: "digital_arrest" }),
      }),
    );
    await vi.waitFor(() => expect(deps.atlas.bridgeChild).toHaveBeenCalledTimes(1));
    expect(deps.atlas.startCircleChain).not.toHaveBeenCalled();
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ type: "shield.voice.classify_scam" }));
  });

  it("child does not join the bridge → circle chain starts", async () => {
    const { deps } = await makeDeps({ rules: { level: "red", scam_type: "otp_theft", hits: ["P2"] } });
    deps.atlas.bridgeChild.mockRejectedValueOnce(new Error("child did not join"));
    const out = await classify.run(deps, ctx, { said: "OTP maang rahe hain" });

    expect(out.stop_script_id).toBe(2);
    await vi.waitFor(() => expect(deps.atlas.startCircleChain).toHaveBeenCalledTimes(1));
    expect(deps.atlas.startCircleChain).toHaveBeenCalledWith({
      familyId: "fam_1",
      parentId: "maa_1",
      reason: "voice_report:otp_theft",
    });
  });

  it("not red → asks the AI with masked text only; AI can raise to red", async () => {
    const { deps, llmCalls } = await makeDeps({ judgement: SCAM_JUDGEMENT });
    const out = await classify.run(deps, ctx, {
      said: "Bank wale bol rahe 9876543210 se call karo aur OTP 4 8 2 9 1 3 batao, card ४१११२२२२",
    });

    expect(deps.llm.understand).toHaveBeenCalledTimes(1);
    for (const text of textsSeenByAi(llmCalls)) expect(text).not.toMatch(/\d{4,}/);
    expect(llmCalls[0]!.input).toContain("<MOBILE_10>");
    expect(llmCalls[0]!.input).toContain("<NUM>");
    // rules saw masked text too
    expect(deps.rules.scoreText.mock.calls[0]![0]).not.toMatch(/\d{4,}/);

    expect(out.level).toBe("red");
    expect(out.scam_type).toBe("kyc_block");
    expect(out.stop_script_id).toBe(2); // AI says it asks for an OTP
    expect(deps.atlas.alertChild).toHaveBeenCalledTimes(1);
  });

  it("AI cannot lower the rules level", async () => {
    const { deps } = await makeDeps({
      rules: { level: "yellow", scam_type: "lottery_prize", hits: ["P5"] },
      judgement: { ...SCAM_JUDGEMENT, is_scam: false, confidence: 0.99, asks_for: [] },
    });
    const out = await classify.run(deps, ctx, { said: "inaam jeeta hai bol rahe" });
    expect(out.level).toBe("yellow");
    expect(out.scam_type).toBe("lottery_prize");
    expect(out.stop_script_id).toBe(1);
    expect(deps.atlas.bridgeChild).not.toHaveBeenCalled();
  });

  it("green: no alert, no bridge, still a safe stop line", async () => {
    const { deps } = await makeDeps({ judgement: { ...SCAM_JUDGEMENT, is_scam: false, asks_for: [] } });
    const out = await classify.run(deps, ctx, { said: "beta ka phone tha" });
    expect(out.level).toBe("green");
    expect(out.line_hi).toBe(STOP_SCRIPTS[1]);
    expect(deps.atlas.alertChild).not.toHaveBeenCalled();
    expect(deps.sign).toHaveBeenCalledTimes(1);
  });

  it("slow AI (past its 2 s budget) → answers from rules within 3 s", async () => {
    vi.useFakeTimers();
    try {
      const { deps } = await makeDeps({ rules: { level: "yellow", scam_type: "parcel_customs", hits: ["P6"] } });
      deps.llm.understand.mockImplementationOnce(() => hang());
      const p = classify.run(deps, ctx, { said: "parcel customs mein ruka hai" });
      await vi.advanceTimersByTimeAsync(2000);
      const out = await p;
      expect(out.level).toBe("yellow");
      expect(out.scam_type).toBe("parcel_customs");
    } finally {
      vi.useRealTimers();
    }
  });

  it("AI throws → still answers from rules", async () => {
    const { deps } = await makeDeps({ rules: { level: "yellow", scam_type: "job_task", hits: [] } });
    deps.llm.understand.mockRejectedValueOnce(new Error("provider down"));
    const out = await classify.run(deps, ctx, { said: "ghar baithe kaam" });
    expect(out.level).toBe("yellow");
  });
});
