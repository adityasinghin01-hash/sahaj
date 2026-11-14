import { describe, expect, it } from "vitest";
import type { ShieldAction, Verdict } from "@sahaj/shared";
import { buildCircleAlert, buildShieldAlert, MAX_BODY_LINES, SNIPPET_MAX, type ShieldAlertMessage } from "../../src/messages";

function verdict(p: Partial<Verdict> & { en?: string; hi?: string } = {}): Verdict {
  return {
    level: p.level ?? "yellow",
    scam_type: p.scam_type ?? "kyc_block",
    reasons: p.reasons ?? [{ rule_id: "r1", en: p.en ?? "Asked Maa to update KYC by a link.", hi: p.hi ?? "Link se KYC update karne ko kaha." }],
    checks_fired: [],
    ai_used: false,
    models_agreed: [],
    confidence: 1,
    actions: p.actions ?? (["speak_clip", "alert_child"] as ShieldAction[]),
  };
}

const LEAKY = verdict({
  level: "red",
  scam_type: "otp_theft",
  en: "Caller 98765 43210 asked for OTP 482913 and ₹1,00,000 to account 123456789012 right now please hurry",
  hi: "Caller ९८७६५४३२१० ne OTP 4829 maanga, 1930 par shikayat karein",
  actions: ["speak_clip", "alert_child", "offer_1930", "circle_chain"],
});

function allText(m: ShieldAlertMessage): string {
  return [m.title, m.body, ...m.buttons.map((b) => b.label)].join("\n");
}

const cases: [string, ShieldAlertMessage][] = [];
for (const lang of ["en", "hi"] as const) {
  for (const channel of ["device", "keypad_voice", "gateway_sms", "busy_watch"] as const) {
    for (const v of [verdict(), verdict({ level: "red" }), LEAKY, verdict({ reasons: [], actions: [] })]) {
      cases.push([`${lang}/${channel}/${v.level}`, buildShieldAlert(v, { lang, parentName: "Maa", channel })]);
      cases.push([
        `circle ${lang}/${channel}/${v.level}`,
        buildCircleAlert(v, { lang, parentName: "Maa", childName: "Riya", channel }),
      ]);
    }
  }
}

describe("buildShieldAlert", () => {
  it("English is the default; title matches the card", () => {
    const m = buildShieldAlert(verdict(), { parentName: "Maa", channel: "device" });
    expect(m.title).toBe("Possible scam on Maa's phone");
    expect(m.buttons.map((b) => b.id)).toEqual(["call_parent", "safe", "fraud"]);
    expect(m.buttons[0].label).toBe("Call Maa");
  });

  it("Hindi title matches the card", () => {
    const m = buildShieldAlert(verdict(), { lang: "hi", parentName: "Maa", channel: "device" });
    expect(m.title).toBe("Maa ke phone par fraud ho sakta hai");
    expect(m.buttons.map((b) => b.id)).toEqual(["call_parent", "safe", "fraud"]);
    expect(m.buttons[0].label).toBe("Maa ko call karein");
    expect(m.body).toContain("Kyun:");
  });

  it("body is what happened / why / what Sahaj did", () => {
    const m = buildShieldAlert(verdict(), { parentName: "Maa", channel: "keypad_voice" });
    expect(m.body.split("\n")).toEqual([
      "Maa reported a suspicious call or message on the Sahaj helpline.",
      "Why: Asked Maa to update KYC by a link.",
      "Sahaj warned Maa.",
    ]);
  });

  it("red adds 'Call Maa now' (both languages); yellow does not", () => {
    expect(buildShieldAlert(verdict({ level: "red" }), { parentName: "Maa", channel: "device" }).body).toContain("Call Maa now.");
    expect(buildShieldAlert(verdict({ level: "red" }), { lang: "hi", parentName: "Maa", channel: "device" }).body).toContain(
      "Maa ko abhi call karein.",
    );
    expect(buildShieldAlert(verdict(), { parentName: "Maa", channel: "device" }).body).not.toContain("now");
  });

  it("uses the parent's name and masks digits in it", () => {
    const m = buildShieldAlert(verdict(), { parentName: "Nani 98765 43210", channel: "device" });
    expect(m.title).toBe("Possible scam on Nani •••'s phone");
  });

  it("falls back to the scam label when there is no reason", () => {
    const m = buildShieldAlert(verdict({ reasons: [], scam_type: "digital_arrest" }), { parentName: "Maa", channel: "device" });
    expect(m.body.split("\n")[1]).toBe("Why: a fake police 'digital arrest'");
  });

  it("masks numbers and OTPs from the reason and cuts the snippet to 80 chars", () => {
    for (const lang of ["en", "hi"] as const) {
      const m = buildShieldAlert(LEAKY, { lang, parentName: "Maa", channel: "device" });
      const whyLine = m.body.split("\n")[1]!;
      const reason = whyLine.replace(/^(Why|Kyun): /, "");
      expect(reason.length).toBeLessThanOrEqual(SNIPPET_MAX);
      expect(m.body).not.toMatch(/482913|4829|98765|123456789012/);
      expect(m.body).toContain("•••");
    }
  });
});

describe("buildCircleAlert", () => {
  it("tells the next person that Riya has not responded (en)", () => {
    const m = buildCircleAlert(verdict({ level: "red" }), { parentName: "Maa", childName: "Riya", channel: "device" });
    expect(m.title).toBe("Riya hasn't responded. Maa may need help");
    expect(m.body.split("\n")[0]).toBe("Riya hasn't responded to a scam alert about Maa.");
    expect(m.body).toContain("Call Maa now.");
    expect(m.buttons.map((b) => b.id)).toEqual(["call_parent", "safe", "fraud"]);
  });

  it("Hindi", () => {
    const m = buildCircleAlert(verdict(), { lang: "hi", parentName: "Maa", childName: "Riya", channel: "device" });
    expect(m.title).toBe("Riya ne jawab nahi diya. Maa ko madad chahiye ho sakti hai");
    expect(m.body).toContain("Maa ko abhi call karein.");
  });
});

describe("every alert (both languages, all channels, both builders)", () => {
  it.each(cases)("%s: no 4+ digit run, ≤ 3 body lines, 3 buttons", (_label, m) => {
    expect(allText(m)).not.toMatch(/\d{4,}/);
    expect(allText(m).replace(/[\s\-.,/()]/g, "")).not.toMatch(/\d{4,}/);
    expect(allText(m)).not.toMatch(/[\u0966-\u096F]/);
    const lines = m.body.split("\n");
    expect(lines.length).toBeLessThanOrEqual(MAX_BODY_LINES);
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(0);
      expect(line.length).toBeLessThanOrEqual(160);
    }
    expect(m.buttons).toHaveLength(3);
    expect(m.title.length).toBeGreaterThan(0);
  });
});
