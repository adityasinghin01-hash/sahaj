import { describe, expect, it } from "vitest";
import { Verdict } from "@sahaj/shared";
import {
  RAW_RULES, RULES, SCRIPT_TYPE_IDS, buildVerdict, callerType, checkP6, checkP7, checkS4,
  findLinks, findPatterns, isApk, isOtp, lookAlike, mask, scoreText, senderType,
} from "../../src/rules";
import fixtures from "./fixtures.json";

type Fixture = { id: string; label: "scam" | "normal"; expect: "green" | "yellow" | "red"; sender: string; text: string };
const FX = fixtures as Fixture[];

describe("fixtures", () => {
  it("has at least 15 scam + 15 normal", () => {
    expect(FX.filter((f) => f.label === "scam").length).toBeGreaterThanOrEqual(15);
    expect(FX.filter((f) => f.label === "normal").length).toBeGreaterThanOrEqual(15);
  });
  for (const f of FX) {
    it(`${f.id} ${f.label} -> ${f.expect}`, () => {
      const v = buildVerdict({ text: f.text, sender: f.sender });
      expect(Verdict.safeParse(v).success).toBe(true);
      expect(v.level).toBe(f.expect);
      if (f.label === "normal") expect(v.reasons).toHaveLength(0);
      else expect(v.actions).toEqual(["show_red_screen", "speak_clip", "alert_child"]);
    });
  }
});

describe("required behaviours", () => {
  it("SBI KYC bit.ly from 10-digit sender -> red with >= 3 reasons", () => {
    const v = buildVerdict({ text: "SBI KYC expire ho raha hai, update karein: bit.ly/xyz", sender: "9876501234" });
    expect(v.level).toBe("red");
    expect(v.reasons.length).toBeGreaterThanOrEqual(3);
    expect(v.scam_type).toBe("kyc_block");
    for (const r of v.reasons) { expect(r.hi).toBeTruthy(); expect(r.en).toBeTruthy(); }
  });

  it("normal bank OTP from AX-HDFCBK-S with no call -> green", () => {
    const v = buildVerdict({ text: "482913 is your OTP for HDFC Bank. Do not share.", sender: "AX-HDFCBK-S" });
    expect(v.level).toBe("green");
    expect(v.actions).toEqual([]);
  });

  it("OTP SMS while unknown-number call is active -> P1 red", () => {
    const text = "482913 is your OTP for HDFC Bank. Do not share.";
    const v = buildVerdict({ text, sender: "AX-HDFCBK-S", caller: "9876543210" });
    expect(v.level).toBe("red");
    expect(v.checks_fired).toContain("pattern.P1");
    const t0 = Date.parse("2026-11-14T10:00:00Z");
    expect(findPatterns([
      { kind: "call", at: t0, number: "9876543210" },
      { kind: "sms", at: t0 + 60_000, sender: "AX-HDFCBK-S", text },
    ])).toEqual(["P1"]);
    // call ended 4 min ago -> still P1; 6 min ago -> no
    const ended = [{ kind: "call" as const, at: t0, ended_at: t0 + 60_000, number: "9876543210" }];
    expect(findPatterns([...ended, { kind: "sms", at: t0 + 60_000 + 240_000, text }])).toEqual(["P1"]);
    expect(findPatterns([...ended, { kind: "sms", at: t0 + 60_000 + 360_000, text }])).toEqual([]);
    // saved contact / 1600 caller -> no P1
    expect(buildVerdict({ text, sender: "AX-HDFCBK-S", caller: "1600123456" }).level).toBe("green");
    expect(buildVerdict({ text, sender: "AX-HDFCBK-S", caller: "9876543210", caller_saved: true }).level).toBe("green");
  });

  it("look-alike", () => {
    expect(lookAlike("sbi-kyc-update.in")).toBe(true);
    expect(lookAlike("onlinesbi.sbi")).toBe(false);
    expect(lookAlike("www.sbi.co.in")).toBe(false);
    expect(lookAlike("xn--sb-kyc-9ya.com")).toBe(true);
    expect(lookAlike("example.com")).toBe(false);
  });

  it("mask() output never contains an unmasked 4+ digit run", () => {
    for (const f of FX) expect(mask(f.text)).not.toMatch(/[0-9]{4,}/);
    const no1600 = mask("Call 98765 43210 or +1 415 555 0123, OTP 482913 pay at http://x12345.com/a?id=998877 acct 123456789");
    expect(no1600).not.toMatch(/[0-9]{4,}/);
    const m = mask("Call 98765 43210 or +1 415 555 0123 or 1600123456, OTP 482913 pay at http://x12345.com/a?id=998877 acct 123456789");
    expect(m.replace(/<1600_NUMBER>/g, "")).not.toMatch(/[0-9]{4,}/);
    expect(m).toContain("<MOBILE_10>");
    expect(m).toContain("<INTL>");
    expect(m).toContain("<1600_NUMBER>");
    expect(m).toContain("<URL:");
    expect(m).toContain("******");
    expect(m).toContain("<NUM>");
  });

  it("every regex in rules.json compiles in JS and uses only portable syntax", () => {
    const patterns: string[] = [];
    const walk = (node: unknown, key = ""): void => {
      if (typeof node === "string") {
        if (key === "pattern" || key.endsWith("_pattern")) patterns.push(node);
      } else if (Array.isArray(node)) node.forEach((n) => walk(n, key));
      else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, k);
    };
    walk(RAW_RULES);
    expect(patterns.length).toBeGreaterThan(10);
    for (const p of patterns) {
      expect(() => new RegExp(p, "i")).not.toThrow();
      expect(p, p).not.toMatch(/\(\?<[=!]/);      // lookbehind
      expect(p, p).not.toMatch(/\(\?<[A-Za-z]/);  // named group
      expect(p, p).not.toMatch(/\\p\{|\\u\{/);    // /u-only escapes
    }
  });
});

describe("rules.json content", () => {
  it("script phrase counts", () => {
    const first5 = ["digital_arrest", "kyc_block", "electricity_cut", "parcel_customs", "lottery_prize"] as const;
    expect(SCRIPT_TYPE_IDS).toHaveLength(10);
    for (const t of SCRIPT_TYPE_IDS) {
      const phrases = RULES.scam_scripts.types[t].phrases;
      expect(phrases.length, t).toBeGreaterThanOrEqual((first5 as readonly string[]).includes(t) ? 15 : 6);
      for (const lang of ["hi", "hinglish", "en"] as const) expect(phrases.some((p) => p.lang === lang), `${t}/${lang}`).toBe(true);
    }
  });
  it("sections", () => {
    expect(RULES.thresholds.ask_ai_between[0]).toBeLessThan(RULES.thresholds.ask_ai_between[1]);
    expect(Object.keys(RULES.patterns).sort()).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]);
    for (const id of ["P2", "P3", "P4", "P6", "P7", "P8", "P9"] as const) expect(RULES.patterns[id].phase).toBe(2);
    expect(RULES.links.brands.length).toBeGreaterThanOrEqual(22);
  });
});

describe("unit checks", () => {
  it("senderType", () => {
    expect(senderType("VM-SBIBNK-S")).toBe("business_header");
    expect(senderType("AX-HDFCBK")).toBe("business_header");
    expect(senderType("9876543210")).toBe("mobile_10");
    expect(senderType("+91 98765 43210")).toBe("mobile_10");
    expect(senderType("+14155550123")).toBe("international");
    expect(senderType("56767")).toBe("short_code");
    expect(senderType("9876543210", { saved: true })).toBe("saved_contact");
    expect(senderType("")).toBe("unknown");
  });
  it("callerType", () => {
    expect(callerType("1600123456")).toBe("series_1600");
    expect(callerType("+911600123456")).toBe("series_1600");
    expect(callerType("1409876543")).toBe("series_140");
    expect(callerType("+919876543210")).toBe("mobile_10");
    expect(callerType("+447911123456")).toBe("international");
    expect(callerType(undefined)).toBe("unknown");
  });
  it("findLinks", () => {
    const l = findLinks("Open https://www.onlinesbi.sbi/login. or bit.ly/xyz, and mail a@b.com");
    expect(l.map((x) => x.registrableDomain)).toEqual(["onlinesbi.sbi", "bit.ly"]);
    expect(findLinks("visit bseskarnataka.co.in/pay")[0]?.registrableDomain).toBe("bseskarnataka.co.in");
  });
  it("isOtp / isApk", () => {
    expect(isOtp("123456 is your OTP")).toBe(true);
    expect(isOtp("आपका ओटीपी 4821 है")).toBe(true);
    expect(isOtp("Rs 2500 debited from account")).toBe(false);
    expect(isOtp("Your code is ******")).toBe(true);
    expect(isApk("download app.apk now")).toBe(true);
    expect(isApk("apkpure is fine")).toBe(false);
  });
  it("scoreText works on masked text", () => {
    const raw = scoreText("SBI KYC expire ho raha hai, update karein: bit.ly/xyz");
    const masked = scoreText(mask("SBI KYC expire ho raha hai, update karein: bit.ly/xyz"));
    expect(raw.scam_type).toBe("kyc_block");
    expect(masked.scam_type).toBe("kyc_block");
    expect(masked.hits.some((h) => h.rule_id === "link.shortener")).toBe(true);
  });
  it("P5 yellow with one signal; needs_ai window", () => {
    const v = buildVerdict({ text: "Track your order at example.com/t/123", sender: "9876543210" });
    expect(v.level).toBe("yellow");
    expect(v.actions).toEqual(["alert_child"]);
    const mid = buildVerdict({ text: "You have won a lottery", sender: "AX-ABCDEF-S" });
    expect(mid.needs_ai).toBe(true);
  });
});

describe("phase 2 rules, boundaries, and spoofing defense", () => {
  it("P9 fires red for banking/UPI package during active unknown call", () => {
    const v = buildVerdict({
      caller: "9800000305",
      at: 1763114490000,
      events: [
        { kind: "call", at: 1763114400000, number: "9800000305", direction: "in" },
        { kind: "app_open", at: 1763114490000, package: "com.phonepe.app" },
      ],
    });
    expect(v.level).toBe("red");
    expect(v.checks_fired).toContain("pattern.P9");
  });

  it("P9 stays green for saved contact, ended call, series_1600, or non-banking app", () => {
    const saved = buildVerdict({
      caller: "9800000101",
      caller_saved: true,
      at: 1763114490000,
      events: [
        { kind: "call", at: 1763114400000, number: "9800000101", saved_contact: true },
        { kind: "app_open", at: 1763114490000, package: "com.phonepe.app" },
      ],
    });
    expect(saved.level).toBe("green");

    const ended = buildVerdict({
      at: 1763114490000,
      events: [
        { kind: "call", at: 1763114400000, ended_at: 1763114460000, number: "9800000305" },
        { kind: "app_open", at: 1763114490000, package: "com.phonepe.app" },
      ],
    });
    expect(ended.level).toBe("green");

    const bank1600 = buildVerdict({
      at: 1763114490000,
      events: [
        { kind: "call", at: 1763114400000, number: "1600123456" },
        { kind: "app_open", at: 1763114490000, package: "com.phonepe.app" },
      ],
    });
    expect(bank1600.level).toBe("green");

    const whatsapp = buildVerdict({
      at: 1763114490000,
      events: [
        { kind: "call", at: 1763114400000, number: "9800000305" },
        { kind: "app_open", at: 1763114490000, package: "com.whatsapp" },
      ],
    });
    expect(whatsapp.level).toBe("green");
  });

  it("P2 fires red at >= 600s for unknown video / WhatsApp call and stays green below or cancelled", () => {
    const below = buildVerdict({
      at: 1763114999000,
      events: [{ kind: "notification", at: 1763114999000, source: "whatsapp", whatsapp_call_unsaved: true, call_seconds: 599 }],
    });
    expect(below.level).toBe("green");

    const cancelled = buildVerdict({
      at: 1763115120000,
      events: [{ kind: "notification", at: 1763115120000, source: "whatsapp", whatsapp_call_unsaved: true, call_seconds: 720, cancelled: true }],
    });
    expect(cancelled.level).toBe("green");

    const hit = buildVerdict({
      at: 1763115000000,
      events: [{ kind: "notification", at: 1763115000000, source: "whatsapp", whatsapp_call_unsaved: true, call_seconds: 600 }],
    });
    expect(hit.level).toBe("red");
    expect(hit.scam_type).toBe("digital_arrest");
    expect(hit.checks_fired).toContain("pattern.P2");

    const videoCall = buildVerdict({
      caller: "+447911000202",
      at: 1763115900000,
      events: [{ kind: "call", at: 1763114400000, ended_at: 1763115900000, number: "+447911000202", video: true }],
    });
    expect(videoCall.level).toBe("red");
    expect(videoCall.checks_fired).toContain("pattern.P2");
  });

  it("P3/P4 fire red for APK notification, sideload <= 24h, and remote-control package; reject missing/malformed", () => {
    const apk = buildVerdict({ kind: "notification", at: 1763114400000, source: "whatsapp", attachment_apk: true });
    expect(apk.level).toBe("red");
    expect(apk.checks_fired).toContain("pattern.P3");

    const sideload = buildVerdict({
      kind: "install",
      at: 1763114400000,
      package: "com.example.card",
      installer: "com.whatsapp",
      installed_hours_ago: 12,
    });
    expect(sideload.level).toBe("red");
    expect(sideload.checks_fired).toContain("pattern.P3");

    const remote = buildVerdict({
      kind: "install",
      at: 1763114400000,
      package: "com.anydesk.anydeskandroid",
      installer: "com.android.vending",
      installed_hours_ago: 1,
    });
    expect(remote.level).toBe("red");
    expect(remote.checks_fired).toContain("pattern.P4");

    const malformed = buildVerdict({
      kind: "install",
      at: 1763114400000,
      context: { installer: 123, installed_hours_ago: "bad" },
    });
    expect(malformed.level).toBe("green");
  });

  it("ignores spoofed local_level and matched_rules when server evidence fails", () => {
    const spoofed = buildVerdict({
      kind: "app_open",
      at: 1763114490000,
      package: "com.whatsapp",
      on_call_with_unsaved: true,
      local_level: "red",
      matched_rules: ["pattern.P9", "script.digital_arrest"],
    });
    expect(spoofed.level).toBe("green");
    expect(spoofed.checks_fired).not.toContain("pattern.P9");
  });

  it("P6 fires yellow for long unsaved voice call via long_vs_normal or duration_ms >= 1200000, not on video/saved/short", () => {
    const byFlag = buildVerdict({
      kind: "call_state",
      caller_type: "mobile_10",
      at: 1763114400000,
      context: { long_vs_normal: true, duration_ms: 300000 },
    });
    expect(byFlag.level).toBe("yellow");
    expect(byFlag.scam_type).toBe("digital_arrest");
    expect(byFlag.checks_fired).toContain("pattern.P6");
    expect(byFlag.actions).toEqual(["alert_child"]);

    const byDuration = buildVerdict({
      kind: "call_in",
      caller_type: "unknown",
      at: 1763114400000,
      context: { duration_ms: 1200000 },
    });
    expect(byDuration.level).toBe("yellow");
    expect(byDuration.checks_fired).toContain("pattern.P6");

    const saved = buildVerdict({
      kind: "call_state",
      caller_saved: true,
      at: 1763114400000,
      context: { long_vs_normal: true, duration_ms: 1500000 },
    });
    expect(saved.level).toBe("green");
    expect(saved.checks_fired).not.toContain("pattern.P6");

    const shortCall = buildVerdict({
      kind: "call_state",
      caller_type: "mobile_10",
      at: 1763114400000,
      context: { duration_ms: 1199999 },
    });
    expect(shortCall.level).toBe("green");
    expect(shortCall.checks_fired).not.toContain("pattern.P6");

    const videoCall = buildVerdict({
      kind: "call_state",
      caller_type: "mobile_10",
      at: 1763114400000,
      context: { video: true, long_vs_normal: true, duration_ms: 1500000 },
    });
    expect(videoCall.level).toBe("red");
    expect(videoCall.checks_fired).toContain("pattern.P2");
    expect(videoCall.checks_fired).not.toContain("pattern.P6");

    const malformed = buildVerdict({
      kind: "call_state",
      caller_type: "mobile_10",
      at: 1763114400000,
      context: { long_vs_normal: "true", duration_ms: "1500000" },
    });
    expect(malformed.level).toBe("green");
    expect(malformed.checks_fired).not.toContain("pattern.P6");

    expect(checkP6({ kind: "call", at: 0, caller_type: "mobile_10", long_vs_normal: true })).toBe(true);
    expect(checkP6({ kind: "call", at: 0, caller_type: "series_1600", long_vs_normal: true })).toBe(false);
  });

  it("P7 fires yellow for bank impersonation from non-1600 caller, and S4 gives green note for series_1600", () => {
    const voiceHit = buildVerdict({
      kind: "voice_report",
      caller_type: "mobile_10",
      at: 1763114400000,
      context: { claimed_bank: true },
    });
    expect(voiceHit.level).toBe("yellow");
    expect(voiceHit.scam_type).toBe("kyc_block");
    expect(voiceHit.checks_fired).toContain("pattern.P7");
    expect(voiceHit.reasons.some((r) => r.en.includes("1600") && r.hi.includes("1600"))).toBe(true);

    const callHit = buildVerdict({
      kind: "call_in",
      caller: "9800000301",
      at: 1763114400000,
      context: { claimed_bank: true },
    });
    expect(callHit.level).toBe("yellow");
    expect(callHit.checks_fired).toContain("pattern.P7");

    const bank1600 = buildVerdict({
      kind: "call_in",
      caller_type: "series_1600",
      at: 1763114400000,
      context: { claimed_bank: true },
    });
    expect(bank1600.level).toBe("green");
    expect(bank1600.checks_fired).not.toContain("pattern.P7");
    expect(bank1600.checks_fired).toContain("caller.series_1600");
    expect(bank1600.reasons.some((r) => r.en.toLowerCase().includes("registered bank number"))).toBe(true);

    const s4Only = buildVerdict({ kind: "call_in", caller: "1600123456", at: 1763114400000 });
    expect(s4Only.level).toBe("green");
    expect(s4Only.reasons.length).toBeGreaterThanOrEqual(1);
    expect(s4Only.reasons[0]?.en.toLowerCase()).toContain("registered bank number");

    const malformedP7 = buildVerdict({
      kind: "voice_report",
      caller_type: "mobile_10",
      at: 1763114400000,
      context: { claimed_bank: "yes" },
      local_level: "red",
      matched_rules: ["pattern.P7"],
    });
    expect(malformedP7.level).toBe("green");
    expect(malformedP7.checks_fired).not.toContain("pattern.P7");

    expect(checkP7({ kind: "voice_report", at: 0, caller_type: "unknown", claimed_bank: true })).toBe(true);
    expect(checkP7({ kind: "voice_report", at: 0, caller_type: "series_1600", claimed_bank: true })).toBe(false);
    expect(checkS4({ caller_type: "series_1600" })).toBe(true);
    expect(checkS4({ caller_type: "mobile_10" })).toBe(false);
  });
});
