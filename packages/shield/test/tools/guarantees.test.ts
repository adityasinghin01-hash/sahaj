import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SAFE_FALLBACK_LINE,
  STOP_SCRIPTS,
  TOOL_LIMIT_MS,
  TOOL_TIMEOUT_MS,
  shieldTools,
  type ShieldToolName,
} from "../../src/tools";
import { ctx, hang, makeDeps } from "./fakes";

const SAMPLE_INPUT: Record<ShieldToolName, unknown> = {
  classify_scam: { said: "police wale video call pe hain, 9876543210" },
  check_message: { from_kind: "unknown_number", mentions: ["otp"], number_said: "9876543210" },
  family_check: { claimed_name: "Rahul", asked_for: "paise" },
  family_check_result: { check_id: "c1" },
  check_code_word: { heard: "neem ka ped" },
  money_sent: { amount_said: "5000", how: "UPI" },
};

const TOOL_NAMES = Object.keys(shieldTools) as ShieldToolName[];

const fallbackLineFor = (name: ShieldToolName) => (name === "money_sent" ? STOP_SCRIPTS[7] : SAFE_FALLBACK_LINE);

function lineOf(out: unknown): string | undefined {
  return (out as { line_hi?: string }).line_hi;
}

async function depsFor() {
  return makeDeps({
    rules: { level: "red", scam_type: "digital_arrest", hits: ["P4"] },
    checks: { c1: { state: "confirmed", familyId: "fam_1", toPersonId: "p_rahul", claimedName: "Rahul" } },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("every tool", () => {
  it("exposes the six tools by name", () => {
    expect(TOOL_NAMES.sort()).toEqual(
      ["check_code_word", "check_message", "classify_scam", "family_check", "family_check_result", "money_sent"].sort(),
    );
    for (const name of TOOL_NAMES) expect(shieldTools[name].name).toBe(name);
  });

  it.each(TOOL_NAMES)("%s writes a timeline event via sign()", async (name) => {
    const { deps } = await depsFor();
    await shieldTools[name].run(deps, ctx, SAMPLE_INPUT[name] as never);
    expect(deps.sign).toHaveBeenCalled();
    for (const [event] of deps.sign.mock.calls as unknown as [{ familyId: string; type: string; line: string }][]) {
      expect(event.familyId).toBe("fam_1");
      expect(event.type).toMatch(/^shield\.voice\./);
      expect(event.line.length).toBeGreaterThan(0);
    }
    // No phone number / OTP digits in the timeline either (1930 is the public cyber-fraud helpline).
    expect(JSON.stringify(deps.sign.mock.calls).replaceAll("1930", "")).not.toMatch(/\d{4,}/);
  });

  it.each(TOOL_NAMES)("%s never hands a 4+ digit run to the AI", async (name) => {
    const { deps, llmCalls } = await makeDeps();
    await shieldTools[name].run(deps, ctx, SAMPLE_INPUT[name] as never);
    for (const c of llmCalls) {
      expect(c.input).not.toMatch(/\d{4,}/);
      expect(c.system).not.toMatch(/\d{4,}/);
    }
  });

  it.each(TOOL_NAMES)("%s returns the safe fallback line at 3 s when a dependency hangs", async (name) => {
    vi.useFakeTimers();
    const { deps } = await depsFor();
    deps.sign.mockImplementation(() => hang());
    deps.db.getFamilyCheck.mockImplementation(() => hang());
    deps.db.getCodeWordHash.mockImplementation(() => hang());
    deps.db.findPersonByName.mockImplementation(() => hang());
    deps.llm.understand.mockImplementation(() => hang());

    let settled = false;
    const p = shieldTools[name].run(deps, ctx, SAMPLE_INPUT[name] as never).then((o) => {
      settled = true;
      return o;
    });
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = await p;
    expect(settled).toBe(true);
    expect(lineOf(out)).toBe(fallbackLineFor(name));
    // The fallback itself is signed (best effort).
    expect(deps.sign).toHaveBeenCalledWith(expect.objectContaining({ type: `shield.voice.${name}.fallback` }));
  });

  it.each(TOOL_NAMES)("%s returns the safe fallback when a dependency throws", async (name) => {
    const { deps } = await depsFor();
    deps.rules.scoreText.mockImplementation(() => {
      throw new Error("rules broke");
    });
    deps.db.getFamilyCheck.mockRejectedValue(new Error("db down"));
    deps.db.getCodeWordHash.mockRejectedValue(new Error("db down"));
    deps.db.findPersonByName.mockRejectedValue(new Error("db down"));
    deps.atlas.alertChild.mockRejectedValue(new Error("atlas down")); // money_sent must still say line 7
    const out = await shieldTools[name].run(deps, ctx, SAMPLE_INPUT[name] as never);
    expect(lineOf(out)).toBe(fallbackLineFor(name));
  });

  it("invalid input → safe fallback, not a throw", async () => {
    const { deps } = await depsFor();
    const out = await shieldTools.classify_scam.run(deps, ctx, { said: 42 } as never);
    expect(lineOf(out)).toBe(SAFE_FALLBACK_LINE);
    expect(deps.sign).toHaveBeenCalledWith(
      expect.objectContaining({ type: "shield.voice.classify_scam.fallback", data: expect.objectContaining({ reason: "invalid_input" }) }),
    );
  });

  it("real clock: classify_scam with everything hanging answers within 3 s", async () => {
    const { deps } = await makeDeps();
    deps.llm.understand.mockImplementation(() => hang());
    deps.sign.mockImplementation(() => hang());
    const started = Date.now();
    const out = await shieldTools.classify_scam.run(deps, ctx, { said: "kuch ajeeb call aaya" });
    const elapsed = Date.now() - started;
    expect(lineOf(out)).toBe(SAFE_FALLBACK_LINE);
    expect(elapsed).toBeLessThan(TOOL_LIMIT_MS);
    expect(elapsed).toBeGreaterThanOrEqual(TOOL_TIMEOUT_MS - 50);
  }, 10_000);
});
