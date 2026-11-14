import { describe, expect, it } from "vitest";
import { STOP_SCRIPTS, shieldTools } from "../../src/tools";
import { constantTimeEqual, normalizeCodeWord } from "../../src/tools/check_code_word";
import { ctx, makeDeps } from "./fakes";

const WRONG = { ok: false, level: "red", line_hi: "Ye code word galat hai. Ye fraud ho sakta hai." };

describe("check_code_word", () => {
  it("right word (any case / spacing) → ok", async () => {
    const { deps } = await makeDeps({ codeWord: "neem ka ped" });
    expect(await shieldTools.check_code_word.run(deps, ctx, { heard: "  Neem   KA ped " })).toEqual({ ok: true });
    expect(deps.atlas.alertChild).not.toHaveBeenCalled();
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ type: "shield.voice.check_code_word", data: { ok: true, code_word_set: true } }));
  });

  it("wrong word → red + child alerted; the word never reaches the timeline or an AI", async () => {
    const { deps } = await makeDeps({ codeWord: "neem ka ped" });
    expect(await shieldTools.check_code_word.run(deps, ctx, { heard: "aam ka ped" })).toEqual(WRONG);
    expect(deps.atlas.alertChild).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: expect.objectContaining({ level: "red" }) }),
    );
    expect(JSON.stringify(deps.sign.mock.calls)).not.toContain("aam");
    expect(deps.llm.understand).not.toHaveBeenCalled();
  });

  it("no code word set for the family → red", async () => {
    const { deps } = await makeDeps({ codeWord: null });
    expect(await shieldTools.check_code_word.run(deps, ctx, { heard: "neem ka ped" })).toEqual(WRONG);
    expect(deps.atlas.alertChild).toHaveBeenCalledTimes(1);
  });

  it("empty word → red", async () => {
    const { deps } = await makeDeps({ codeWord: "" });
    expect(await shieldTools.check_code_word.run(deps, ctx, { heard: "   " })).toEqual(WRONG);
  });

  it("helpers", () => {
    expect(normalizeCodeWord("  A  b\tC ")).toBe("a b c");
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("ab", "abc")).toBe(false);
  });
});

describe("money_sent", () => {
  it("line 7, red alert with offer_1930, circle chain", async () => {
    const { deps } = await makeDeps();
    const out = await shieldTools.money_sent.run(deps, ctx, { amount_said: "25000", how: "UPI" });
    expect(out).toEqual({
      level: "red",
      line_id: 7,
      line_hi: "Paise chale gaye hain toh abhi 1930 par call kijiye. Riya ko sab bhej diya hai.",
    });
    expect(out.line_hi).toBe(STOP_SCRIPTS[7]);
    expect(deps.atlas.alertChild).toHaveBeenCalledWith(
      expect.objectContaining({
        verdict: expect.objectContaining({ level: "red", actions: expect.arrayContaining(["offer_1930", "circle_chain"]) }),
      }),
    );
    expect(deps.atlas.startCircleChain).toHaveBeenCalledWith({ familyId: "fam_1", parentId: "maa_1", reason: "voice_report:money_sent" });
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ type: "shield.voice.money_sent", data: expect.objectContaining({ amount_said: "<NUM>" }) }));
  });

  it("works with no details", async () => {
    const { deps } = await makeDeps();
    expect((await shieldTools.money_sent.run(deps, ctx, {})).line_id).toBe(7);
  });
});
