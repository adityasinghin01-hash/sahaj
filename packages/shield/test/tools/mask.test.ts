import { describe, expect, it } from "vitest";
import { maskDigits } from "../../src/tools";
import { hasLongDigitRun } from "../../src/tools/mask";

describe("maskDigits", () => {
  it.each([
    ["call 9876543210 now", "call <MOBILE_10> now"],
    ["mera number 98765 43210 hai", "mera number <MOBILE_10> hai"],
    ["+91 98765-43210", "<MOBILE_10>"],
    ["09876543210", "<MOBILE_10>"],
    ["OTP 482913 hai", "OTP <NUM> hai"],
    ["OTP 4 8 2 9 hai", "OTP <NUM> hai"],
    ["account 1234", "account <NUM>"],
    ["paise 1,00,000 bheje", "paise <NUM> bheje"],
    ["OTP ४८२९१३ hai", "OTP <NUM> hai"],
    ["OTP ١٢٣٤ hai", "OTP <NUM> hai"],
    ["OTP １２３４ hai", "OTP <NUM> hai"],
    ["2 baje 100 rupaye", "2 baje 100 rupaye"],
    ["123", "123"],
  ])("%s → %s", (input, expected) => {
    expect(maskDigits(input)).toBe(expected);
  });

  it("leaves no run of 4+ digits in mixed text", () => {
    const raw = "Bank se call aaya, 9876543210, OTP 1 2 3 4 5 6 bolo, card 4111-1111-1111-1111, ref ९८७६५, ١٢٣٤, １２３４";
    const masked = maskDigits(raw);
    expect(masked).not.toMatch(/\p{Nd}{4,}/u);
    expect(hasLongDigitRun(masked)).toBe(false);
    expect(hasLongDigitRun("1   2   3   4")).toBe(true);
  });
});
