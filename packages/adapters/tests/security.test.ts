import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWhatsAppButton, verifyTwilioFormSignature, verifyWhatsAppButton, verifyWhatsAppSignature } from "../src/security";
import { AdapterError } from "../src/contracts";
import { OTHER_PERSON, PERSON, PHONE, SECRET } from "./helpers";

const sig = (body: string, secret = "app-secret") => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

describe("WhatsApp raw-byte HMAC", () => {
  const raw = '{"object":"whatsapp_business_account","entry":[]}';
  it("accepts the exact bytes", () => expect(verifyWhatsAppSignature(raw, sig(raw), "app-secret")).toBe(true));
  it("accepts bytes as Uint8Array", () => expect(verifyWhatsAppSignature(new TextEncoder().encode(raw), sig(raw), "app-secret")).toBe(true));
  it("rejects reserialized JSON (whitespace change)", () => expect(verifyWhatsAppSignature(JSON.stringify(JSON.parse(raw), null, 1), sig(raw), "app-secret")).toBe(false));
  it("rejects tampered body, wrong secret, missing/odd header", () => {
    expect(verifyWhatsAppSignature(raw + " ", sig(raw), "app-secret")).toBe(false);
    expect(verifyWhatsAppSignature(raw, sig(raw), "other")).toBe(false);
    expect(verifyWhatsAppSignature(raw, null, "app-secret")).toBe(false);
    expect(verifyWhatsAppSignature(raw, sig(raw).toUpperCase(), "app-secret")).toBe(false);
    expect(verifyWhatsAppSignature(raw, "sha256=zz", "app-secret")).toBe(false);
    expect(verifyWhatsAppSignature(raw, sig(raw), "")).toBe(false);
  });
});

describe("Twilio form signature", () => {
  const url = "https://api.example.test/api/twilio/voice";
  const token = "synthetic-auth-token";
  const sign = (u: string, p: URLSearchParams) => {
    let v = u;
    for (const k of [...new Set(p.keys())].sort()) for (const x of [...new Set(p.getAll(k))].sort()) v += k + x;
    return createHmac("sha1", token).update(v).digest("base64");
  };
  // Twilio documented example values (docs: usage/security) are for a different URL; we compute the reference algorithm locally.
  const params = new URLSearchParams({ CallSid: "CA1234567890ABCDE", Digits: "1234", From: "+10000000000", To: "+10000000001" });
  it("accepts a valid signature", () => expect(verifyTwilioFormSignature(url, params, sign(url, params), token)).toBe(true));
  it("matches a fixed synthetic repeated-value vector using official SDK canonicalization", () => {
    // SDK toFormUrlEncodedParam uses Array.from(new Set(values)).sort().
    // Canonical input ends in A1A2B3; signature is fixed independently of this verifier.
    const repeated = new URLSearchParams([["B", "3"], ["A", "2"], ["A", "1"], ["A", "1"]]);
    expect(verifyTwilioFormSignature(url, repeated, "ET7sILwVT/XNAS7UQrUWi5obWPQ=", token)).toBe(true);
  });
  it("deduplicates repeated values like the official Twilio Node SDK", () => {
    const p = new URLSearchParams([["A", "1"], ["A", "1"], ["B", "2"]]);
    expect(verifyTwilioFormSignature(url, p, sign(url, p), token)).toBe(true);
    const deduped = new URLSearchParams([["A", "1"], ["B", "2"]]);
    expect(verifyTwilioFormSignature(url, p, sign(url, deduped), token)).toBe(true);
  });
  it("rejects wrong URL, tampered params, wrong token, http URL, missing signature", () => {
    const good = sign(url, params);
    expect(verifyTwilioFormSignature("https://evil.example.test/x", params, good, token)).toBe(false);
    expect(verifyTwilioFormSignature(url, new URLSearchParams({ ...Object.fromEntries(params), Digits: "9" }), good, token)).toBe(false);
    expect(verifyTwilioFormSignature(url, params, good, "x")).toBe(false);
    expect(verifyTwilioFormSignature(url.replace("https", "http"), params, good, token)).toBe(false);
    expect(verifyTwilioFormSignature(url, params, null, token)).toBe(false);
  });
});

describe("signed WhatsApp buttons", () => {
  const claims = { personId: PERSON, from: PHONE, action: "confirm_medicine", objectId: "33333333-3333-4333-8333-333333333333", nonce: "n-abcdefghijklmnopqrstuv", expiresAt: Date.now() + 60_000 };
  const expected = { personId: PERSON, from: PHONE, action: "confirm_medicine", objectId: claims.objectId };
  const fail = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as AdapterError).code; } return "no error"; };

  it("round-trips, fits the 256 char button id limit, and does not expose the phone number", () => {
    const token = signWhatsAppButton(claims, SECRET);
    expect(token.length).toBeLessThanOrEqual(256);
    expect(token).not.toContain(PHONE.slice(1));
    expect(token).not.toContain(PERSON);
    expect(verifyWhatsAppButton(token, expected, SECRET)).toEqual({ nonce: claims.nonce, expiresAt: claims.expiresAt });
  });
  it("rejects wrong sender, person, action, object", () => {
    const token = signWhatsAppButton(claims, SECRET);
    for (const bad of [{ from: "+919000000002" }, { personId: OTHER_PERSON }, { action: "cancel" }, { objectId: "other" }]) {
      expect(fail(() => verifyWhatsAppButton(token, { ...expected, ...bad }, SECRET))).toBe("invalid_signature");
    }
  });
  it("rejects expiry, tampering and a different secret", () => {
    const token = signWhatsAppButton({ ...claims, expiresAt: 1000 }, SECRET);
    expect(fail(() => verifyWhatsAppButton(token, expected, SECRET, 1000))).toBe("invalid_signature");
    const ok = signWhatsAppButton(claims, SECRET);
    const [nonce, , tag] = ok.split(".");
    const forged = `${nonce}.${(claims.expiresAt + 1e9).toString(36)}.${tag}`;
    expect(fail(() => verifyWhatsAppButton(forged, expected, SECRET))).toBe("invalid_signature");
    expect(fail(() => verifyWhatsAppButton(`${"A".repeat(22)}.${ok.split(".")[1]}.${tag}`, expected, SECRET))).toBe("invalid_signature");    expect(fail(() => verifyWhatsAppButton(ok, expected, SECRET + "x"))).toBe("invalid_signature");
    for (const junk of ["", "a", "a.b.c", ".", "x".repeat(300)]) expect(fail(() => verifyWhatsAppButton(junk, expected, SECRET))).toBe("invalid_signature");
  });
  it("refuses to sign with a short secret or missing fields", () => {
    expect(fail(() => signWhatsAppButton(claims, "short"))).toBe("invalid_payload");
    expect(fail(() => signWhatsAppButton({ ...claims, objectId: "" }, SECRET))).toBe("invalid_payload");
  });
});
