import { describe, expect, it } from "vitest";
import {
  cleanSummary,
  DEFAULT_TIP,
  FALLBACK_SUMMARY,
  fingerprint,
  onChildFeedback,
  pickWeeklyTip,
} from "../../src/warnings";
import { DAY, makeWarningsDeps, NOW, verdict } from "./fakes";

const LLM_OK = {
  summary_en: "Fake bank KYC messages are going around. Never click a link to unblock your account.",
  summary_hi: "Nakli bank KYC message aa rahe hain. Account chalu karne ke liye link par click na karein.",
};

describe("onChildFeedback", () => {
  it("safe feedback adds nothing and reads nothing", async () => {
    const { deps, indicators } = makeWarningsDeps({ v1: verdict("v1", "fam_a") });
    const r = await onChildFeedback(deps, { verdictId: "v1", feedback: "safe" });
    expect(r).toEqual({ outcome: "ignored_safe", indicators: [] });
    expect(indicators).toHaveLength(0);
    expect(deps.db.getVerdictForFeedback).not.toHaveBeenCalled();
    expect(deps.llm.understand).not.toHaveBeenCalled();
  });

  it("fraud upserts the link domain + masked template (+ the number fingerprint when the phone sent one)", async () => {
    const numFp = (await fingerprint("number", "9876543210"))!;
    const { deps, indicators } = makeWarningsDeps(
      { v1: verdict("v1", "fam_a", { numberFingerprints: [numFp, "not-a-hash"] }) },
      LLM_OK,
    );
    const r = await onChildFeedback(deps, { verdictId: "v1", feedback: "fraud" });
    expect(r.outcome).toBe("recorded");
    expect(r.indicators.map((i) => i.kind).sort()).toEqual(["domain", "number", "template"]);
    expect(indicators.find((i) => i.kind === "domain")!.fingerprint).toBe(await fingerprint("domain", "sbi-update.co.in"));
    expect(indicators.find((i) => i.kind === "number")!.fingerprint).toBe(numFp);
    for (const i of indicators) {
      expect(i).toMatchObject({ scamType: "kyc_block", summaryEn: LLM_OK.summary_en, summaryHi: LLM_OK.summary_hi, timesSeen: 1 });
    }
  });

  it("never stores a raw value: no domain, number or message text in any indicator field", async () => {
    const { deps, indicators } = makeWarningsDeps({ v1: verdict("v1", "fam_a") });
    await onChildFeedback(deps, { verdictId: "v1", feedback: "fraud" });
    const stored = JSON.stringify(indicators).toLowerCase();
    expect(stored).not.toContain("sbi-update");
    expect(stored).not.toContain("9876543210");
    expect(stored).not.toContain("dear customer");
    expect(stored).not.toContain("kyc is blocked");
  });

  it("the same scam from 2 families → families_affected 2 and confirmed", async () => {
    const { deps, indicators } = makeWarningsDeps({
      v1: verdict("v1", "fam_a"),
      v2: verdict("v2", "fam_b", {
        // Same scam, different victim-specific digits and link path.
        linkDomains: ["http://WWW.sbi-update.co.in/other"],
        maskedTexts: ["dear customer your SBI KYC is blocked.  Update now at link or account closed. Ref <NUM>"],
      }),
    });
    const a = await onChildFeedback(deps, { verdictId: "v1", feedback: "fraud" });
    expect(a.indicators.every((i) => i.familiesAffected === 1 && !i.confirmed)).toBe(true);
    const b = await onChildFeedback(deps, { verdictId: "v2", feedback: "fraud" });
    expect(indicators).toHaveLength(2);
    expect(b.indicators.every((i) => i.familiesAffected === 2 && i.confirmed && i.counted)).toBe(true);
    expect(indicators.every((i) => i.timesSeen === 2 && i.familiesAffected === 2 && i.confirmed)).toBe(true);
  });

  it("two verdicts from one family: times_seen 2, families_affected 1, not confirmed", async () => {
    const { deps, indicators } = makeWarningsDeps({ v1: verdict("v1", "fam_a"), v2: verdict("v2", "fam_a") });
    await onChildFeedback(deps, { verdictId: "v1", feedback: "fraud" });
    await onChildFeedback(deps, { verdictId: "v2", feedback: "fraud" });
    expect(indicators.every((i) => i.timesSeen === 2 && i.familiesAffected === 1 && !i.confirmed)).toBe(true);
  });

  it("the same verdict marked fraud twice counts once", async () => {
    const { deps, indicators } = makeWarningsDeps({ v1: verdict("v1", "fam_a") });
    await onChildFeedback(deps, { verdictId: "v1", feedback: "fraud" });
    const again = await onChildFeedback(deps, { verdictId: "v1", feedback: "fraud" });
    expect(again.indicators.every((i) => !i.counted)).toBe(true);
    expect(indicators.every((i) => i.timesSeen === 1)).toBe(true);
  });

  it("a verdict stored as safe, or a missing verdict, publishes nothing", async () => {
    const { deps, indicators } = makeWarningsDeps({ v1: verdict("v1", "fam_a", { childFeedback: "safe" }) });
    expect((await onChildFeedback(deps, { verdictId: "v1", feedback: "fraud" })).outcome).toBe("feedback_mismatch");
    expect((await onChildFeedback(deps, { verdictId: "nope", feedback: "fraud" })).outcome).toBe("not_found");
    expect(indicators).toHaveLength(0);
  });

  it("the LLM only ever sees masked text", async () => {
    const { deps, llmInputs } = makeWarningsDeps(
      { v1: verdict("v1", "fam_a", { maskedTexts: ["Call 98765 43210 now, OTP ४५६७८९ is needed for KYC update"] }) },
      LLM_OK,
    );
    await onChildFeedback(deps, { verdictId: "v1", feedback: "fraud" });
    expect(llmInputs).toHaveLength(1);
    expect(llmInputs[0]).not.toMatch(/\d{4,}/);
    expect(llmInputs[0]).not.toMatch(/[\u0966-\u096F]/);
    expect(llmInputs[0]).toContain("<MOBILE_10>");
  });

  it("falls back to the fixed line per scam type when the LLM fails or writes something identifying", async () => {
    const bad = [
      null,
      { summary_en: "Scam from 9876543210 is going around today.", summary_hi: LLM_OK.summary_hi },
      { summary_en: LLM_OK.summary_en, summary_hi: "sbi-update.co.in par mat jaiye, yeh fraud hai." },
      { summary_en: "Contact fraud@bank for help with this scam.", summary_hi: LLM_OK.summary_hi },
      { summary_en: "", summary_hi: "" },
    ];
    for (const reply of bad) {
      const { deps, indicators } = makeWarningsDeps({ v1: verdict("v1", "fam_a", { scamType: "otp_theft" }) }, reply);
      const r = await onChildFeedback(deps, { verdictId: "v1", feedback: "fraud" });
      expect(r.summarySource).toBe("fallback");
      expect(indicators[0]).toMatchObject({
        summaryEn: FALLBACK_SUMMARY.otp_theft.summary_en,
        summaryHi: FALLBACK_SUMMARY.otp_theft.summary_hi,
      });
    }
  });

  it("an LLM that throws falls back too", async () => {
    const { deps, indicators } = makeWarningsDeps({ v1: verdict("v1", "fam_a") }, LLM_OK);
    deps.llm.understand.mockRejectedValueOnce(new Error("boom"));
    const r = await onChildFeedback(deps, { verdictId: "v1", feedback: "fraud" });
    expect(r.summarySource).toBe("fallback");
    expect(indicators[0]!.summaryEn).toBe(FALLBACK_SUMMARY.kyc_block.summary_en);
  });

  it("an unknown scam type is stored as unknown with its fallback line", async () => {
    const { deps, indicators } = makeWarningsDeps({ v1: verdict("v1", "fam_a", { scamType: "made_up" }) });
    await onChildFeedback(deps, { verdictId: "v1", feedback: "fraud" });
    expect(indicators[0]).toMatchObject({ scamType: "unknown", summaryEn: FALLBACK_SUMMARY.unknown.summary_en });
  });

  it("rejects bad input", async () => {
    const { deps } = makeWarningsDeps();
    await expect(onChildFeedback(deps, { verdictId: "v1", feedback: "maybe" as "safe" })).rejects.toThrow();
  });
});

describe("pickWeeklyTip", () => {
  async function seed() {
    const ctx = makeWarningsDeps(
      {
        // KYC scam: 2 families → confirmed, 3 sightings.
        k1: verdict("k1", "fam_a"),
        k2: verdict("k2", "fam_b"),
        k3: verdict("k3", "fam_c"),
        // OTP scam: 2 families → confirmed, 2 sightings.
        o1: verdict("o1", "fam_a", { scamType: "otp_theft", linkDomains: ["otp-help.in"], maskedTexts: [] }),
        o2: verdict("o2", "fam_d", { scamType: "otp_theft", linkDomains: ["otp-help.in"], maskedTexts: [] }),
        // Lottery: 1 family, 5 sightings → most seen but NOT confirmed.
        ...Object.fromEntries(
          [1, 2, 3, 4, 5].map((n) => [
            `l${n}`,
            verdict(`l${n}`, "fam_e", { scamType: "lottery_prize", linkDomains: ["win-prize.xyz"], maskedTexts: [] }),
          ]),
        ),
      },
      null,
    );
    for (const id of Object.keys(ctx.verdicts)) await onChildFeedback(ctx.deps, { verdictId: id, feedback: "fraud" });
    return ctx;
  }

  it("picks the most-seen CONFIRMED indicator of the last 7 days, any family", async () => {
    const { deps } = await seed();
    const tip = await pickWeeklyTip(deps, { familyId: "fam_z", now: NOW });
    expect(tip).toEqual({
      fraud_tip_hi: FALLBACK_SUMMARY.kyc_block.summary_hi,
      fraud_tip_en: FALLBACK_SUMMARY.kyc_block.summary_en,
    });
  });

  it("ignores sightings older than 7 days", async () => {
    const { deps } = await seed();
    const tip = await pickWeeklyTip(deps, { familyId: "fam_z", now: new Date(NOW.getTime() + 8 * DAY) });
    expect(tip).toEqual(DEFAULT_TIP);
  });

  it("with no confirmed indicator, returns the default tip", async () => {
    const { deps } = makeWarningsDeps();
    expect(await pickWeeklyTip(deps, { familyId: "fam_a", now: NOW })).toEqual(DEFAULT_TIP);
  });

  it("a stored summary with personal data is replaced on the way out", async () => {
    const { deps } = makeWarningsDeps();
    (deps.db.topConfirmedIndicator as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce({
      scamType: "digital_arrest",
      summaryHi: "Call 9876543210 now",
      summaryEn: "Visit police-help.in for help",
      recentSightings: 4,
    });
    const tip = await pickWeeklyTip(deps, { familyId: "fam_a", now: NOW });
    expect(tip).toEqual({
      fraud_tip_hi: FALLBACK_SUMMARY.digital_arrest.summary_hi,
      fraud_tip_en: FALLBACK_SUMMARY.digital_arrest.summary_en,
    });
  });
});

describe("fixed lines", () => {
  it("every fallback line passes the personal-data check unchanged and fits the column", () => {
    for (const lines of Object.values(FALLBACK_SUMMARY)) {
      expect(cleanSummary(lines.summary_en)).toBe(lines.summary_en);
      expect(cleanSummary(lines.summary_hi)).toBe(lines.summary_hi);
      expect(lines.summary_en.length).toBeLessThanOrEqual(200);
      expect(lines.summary_hi.length).toBeLessThanOrEqual(200);
    }
  });

  it("cleanSummary rejects links, domains, e-mails, handles, mask tokens and 4+ digit runs", () => {
    for (const bad of [
      "go to https://x.y now please",
      "visit www.example.com today",
      "visit example.co.in today",
      "mail a@b.com for help",
      "ask @scammer on telegram",
      "call <MOBILE_10> for help",
      "call 98765 43210 for help",
      "OTP ४५६७ do not share",
      "short",
      42,
    ]) {
      expect(cleanSummary(bad)).toBeNull();
    }
    expect(cleanSummary("  Do not   share an OTP with anyone.  ")).toBe("Do not share an OTP with anyone.");
  });
});
