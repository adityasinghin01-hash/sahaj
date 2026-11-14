import { describe, expect, it } from "vitest";
import { STOP_SCRIPTS, shieldTools } from "../../src/tools";
import { LINES } from "../../src/tools/lines";
import { ctx, makeDeps } from "./fakes";

const check = shieldTools.check_message;

describe("check_message", () => {
  it("red OTP message from an unknown number → OTP line, alerts child, number masked", async () => {
    const { deps } = await makeDeps({ rules: { level: "red", scam_type: "otp_theft", hits: ["P2"] } });
    const out = await check.run(deps, ctx, {
      from_kind: "unknown_number",
      mentions: ["bank", "OTP"],
      number_said: "98765 43210",
    });

    expect(out).toEqual({ level: "red", scam_type: "otp_theft", line_id: 2, line_hi: STOP_SCRIPTS[2] });
    const scored = deps.rules.scoreText.mock.calls[0]![0];
    expect(scored).not.toMatch(/\d{4,}/);
    expect(scored).toContain("<MOBILE_10>");
    expect(deps.atlas.alertChild).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: expect.objectContaining({ level: "red" }) }),
    );
    expect(deps.sign).toHaveBeenCalledWith(
      expect.objectContaining({ type: "shield.voice.check_message", data: expect.objectContaining({ number_kind: "mobile_10" }) }),
    );
    expect(JSON.stringify(deps.sign.mock.calls)).not.toMatch(/\d{4,}/);
  });

  it("red police mention → police video-call line", async () => {
    const { deps } = await makeDeps({ rules: { level: "red", scam_type: "digital_arrest", hits: [] } });
    const out = await check.run(deps, ctx, { from_kind: "not_sure", mentions: ["police"] });
    expect(out.line_id).toBe(4);
  });

  it("'whatsapp' does not count as an app/file mention", async () => {
    const { deps } = await makeDeps({ rules: { level: "red", scam_type: "unknown", hits: [] } });
    const out = await check.run(deps, ctx, { from_kind: "not_sure", mentions: ["whatsapp"] });
    expect(out.line_id).toBe(1);
  });

  it("yellow → alerts child", async () => {
    const { deps } = await makeDeps({ rules: { level: "yellow", scam_type: "electricity_cut", hits: ["P3"] } });
    const out = await check.run(deps, ctx, { from_kind: "bank_name", mentions: ["bijli"] });
    expect(out).toEqual({ level: "yellow", scam_type: "electricity_cut", line_id: null, line_hi: LINES.messageYellow });
    expect(deps.atlas.alertChild).toHaveBeenCalledTimes(1);
  });

  it("green → no alert", async () => {
    const { deps } = await makeDeps();
    const out = await check.run(deps, ctx, { from_kind: "saved", mentions: [] });
    expect(out.level).toBe("green");
    expect(out.line_hi).toBe(LINES.messageGreen);
    expect(deps.atlas.alertChild).not.toHaveBeenCalled();
    expect(deps.llm.understand).not.toHaveBeenCalled();
  });
});
