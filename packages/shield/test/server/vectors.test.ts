import { describe, expect, it } from "vitest";
import { handleShieldEvent, deriveDeviceSecret, signShieldBody } from "../../src/server";
import { sha256Hex, utf8, toHex } from "../../src/server/crypto";
import vectors from "./vectors.json";
import { makeServerDeps, signedEventRequest } from "./fakes";

describe("HMAC test vector (shared with the Kotlin side)", () => {
  it("device_secret and its SHA-256 match", async () => {
    expect(await deriveDeviceSecret(vectors.pairing_secret, vectors.device_id)).toBe(vectors.device_secret);
    expect(await sha256Hex(vectors.device_secret)).toBe(vectors.device_secret_sha256);
  });

  it("body bytes and sig match", async () => {
    expect(toHex(utf8(vectors.body))).toBe(vectors.body_utf8_hex);
    expect(await signShieldBody(vectors.device_secret, vectors.ts, vectors.body)).toBe(vectors.sig);
    expect(await signShieldBody(vectors.device_secret, vectors.ts, utf8(vectors.body))).toBe(vectors.sig);
  });

  it("the server accepts the vector request as-is", async () => {
    const f = makeServerDeps();
    f.deps.env.SHIELD_DEVICE_PAIRING_SECRET = vectors.pairing_secret;
    f.devices.set(vectors.device_id, {
      id: vectors.device_id,
      family_id: "fam_1",
      person_id: "maa_1",
      label: null,
      platform: "android",
      android_version: "14",
      protections: {},
      paired_at: f.now(),
      device_secret_hash: vectors.device_secret_sha256,
      last_heartbeat_at: null,
    });
    f.deps.clock.now = () => new Date(Number(vectors.ts) + 1000);
    const req = await signedEventRequest({
      deviceId: vectors.device_id,
      deviceSecret: vectors.device_secret,
      body: vectors.body,
      ts: Number(vectors.ts),
    });
    expect(req.headers.get("x-shield-sig")).toBe(vectors.sig);
    const res = await handleShieldEvent(req, f.deps);
    expect(res.status).toBe(200);
  });
});
