import { describe, expect, it } from "vitest";
import {
  fingerprint,
  FINGERPRINT_RE,
  normaliseNumber,
  normaliseTemplate,
  numberFingerprint,
  registrableDomain,
} from "../../src/warnings/fingerprint";
import { sha256Hex } from "../../src/tools/check_code_word";

describe("normalisation", () => {
  it("number → last 10 digits, any format", () => {
    for (const raw of ["+91 98765-43210", "09876543210", "919876543210", "98765 43210", "(987) 654-3210", "९८७६५४३२१०"]) {
      expect(normaliseNumber(raw)).toBe("9876543210");
    }
    expect(normaliseNumber("12345")).toBeNull();
    expect(normaliseNumber("VM-HDFCBK")).toBeNull();
  });

  it("domain → registrable domain, lowercase", () => {
    expect(registrableDomain("https://Login.SBI-Update.co.in/kyc?x=1")).toBe("sbi-update.co.in");
    expect(registrableDomain("WWW.Example.COM.")).toBe("example.com");
    expect(registrableDomain("a.b.example.com:8080/path")).toBe("example.com");
    expect(registrableDomain("bit.ly/abc")).toBe("bit.ly");
    expect(registrableDomain("kyc-help.github.io")).toBe("kyc-help.github.io");
    expect(registrableDomain("x.y.netlify.app")).toBe("y.netlify.app");
    expect(registrableDomain("http://192.168.1.5/login")).toBe("192.168.1.5");
    expect(registrableDomain("co.in")).toBeNull();
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain("not a domain")).toBeNull();
    expect(registrableDomain("")).toBeNull();
  });

  it("template → masked, digits removed, lowercase, whitespace collapsed", () => {
    const a = normaliseTemplate("Dear Customer,  your KYC is BLOCKED.\nCall 9876543210 or pay Rs 4999 now");
    const b = normaliseTemplate("dear customer, your kyc is blocked. call 9123456789 or pay rs 1250 now");
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d/);
    expect(a).toBe("dear customer, your kyc is blocked. call <mobile_> or pay rs <num> now");
    expect(normaliseTemplate("hi 123")).toBeNull(); // too short to share
  });
});

describe("fingerprint", () => {
  const raws: [Parameters<typeof fingerprint>[0], string][] = [
    ["number", "9876543210"],
    ["number", "+91 98765 43210"],
    ["domain", "sbi-update.co.in"],
    ["domain", "https://login.sbi-update.co.in/x"],
    ["template", "your kyc is blocked, update now"],
    ["template", "Your KYC is blocked. Call 9876543210"],
  ];

  it("is hex SHA-256 of the normalised value and never equals the raw or normalised value", async () => {
    for (const [kind, raw] of raws) {
      const fp = await fingerprint(kind, raw);
      expect(fp).toMatch(FINGERPRINT_RE);
      expect(fp).not.toBe(raw);
      expect(fp).not.toContain(raw);
      const { normalise } = await import("../../src/warnings");
      const norm = normalise(kind, raw)!;
      expect(fp).not.toBe(norm);
      expect(fp).toBe(await sha256Hex(norm));
    }
  });

  it("the same scam in different shapes gives the same fingerprint", async () => {
    expect(await fingerprint("number", "+91 98765 43210")).toBe(await fingerprint("number", "09876543210"));
    expect(await fingerprint("domain", "https://a.sbi-update.co.in/x")).toBe(await fingerprint("domain", "SBI-UPDATE.co.in"));
    expect(await numberFingerprint("98765-43210")).toBe(await fingerprint("number", "9876543210"));
  });

  it("returns null for values that do not normalise", async () => {
    expect(await fingerprint("number", "12345")).toBeNull();
    expect(await fingerprint("domain", "localhost")).toBeNull();
    expect(await fingerprint("template", "ok")).toBeNull();
  });
});
