import { describe, expect, it } from "vitest";
import { createPairingCode, handleShieldEvent, handleShieldPair, PAIRING_GENERIC_ERROR } from "../../src/server";
import { sha256Hex } from "../../src/server/crypto";
import { makeEvent, makeServerDeps, pairBody, pairRequest, signedEventRequest, type Fake } from "./fakes";

async function newCode(f: Fake, familyId = "fam_1") {
  const r = await createPairingCode(f.deps, { familyId, userId: "riya_user" });
  if (!r.ok) throw new Error(r.reason);
  return r.code;
}

async function pair(f: Fake, code: string, overrides: Record<string, unknown> = {}) {
  const res = await handleShieldPair(pairRequest(pairBody(code, overrides)), f.deps);
  return { res, body: (await res.json()) as Record<string, string> };
}

/** A 6-digit code that is not any active code of the fake. */
function wrongCode(f: Fake, taken: Set<string>, n: number) {
  const c = String(100000 + n);
  return taken.has(c) ? String(200000 + n) : c;
}

describe("createPairingCode", () => {
  it("returns a 6-digit code once, stores only its SHA-256, expires in 10 min", async () => {
    const f = makeServerDeps();
    const r = await createPairingCode(f.deps, { familyId: "fam_1", userId: "riya_user" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toMatch(/^\d{6}$/);
    expect(f.codes).toHaveLength(1);
    const stored = f.codes[0]!;
    expect(stored.code_hash).toBe(await sha256Hex(r.code));
    expect(JSON.stringify(stored)).not.toContain(r.code);
    expect(stored.created_by_user_id).toBe("riya_user");
    expect(stored.expires_at.getTime() - f.now().getTime()).toBe(10 * 60 * 1000);
    expect(r.expires_at).toBe(stored.expires_at.toISOString());
  });

  it("allows at most 5 active codes per family", async () => {
    const f = makeServerDeps();
    for (let i = 0; i < 5; i++) await newCode(f);
    const sixth = await createPairingCode(f.deps, { familyId: "fam_1", userId: "riya_user" });
    expect(sixth).toEqual({ ok: false, reason: "too_many_active_codes" });
    // Another family is not affected, and expired codes stop counting.
    expect((await createPairingCode(f.deps, { familyId: "fam_2", userId: "u2" })).ok).toBe(true);
    f.advance(10 * 60 * 1000 + 1);
    expect((await createPairingCode(f.deps, { familyId: "fam_1", userId: "riya_user" })).ok).toBe(true);
  });
});

describe("handleShieldPair", () => {
  it("happy path: returns a device secret that verifies a signed event end-to-end", async () => {
    const f = makeServerDeps();
    const code = await newCode(f);
    const { res, body } = await pair(f, code);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.device_id).toBeTruthy();
    expect(body.device_secret).toMatch(/^[0-9a-f]{64}$/);

    const row = f.devices.get(body.device_id!)!;
    expect(row).toMatchObject({
      family_id: "fam_1",
      person_id: "maa_1",
      label: "Maa ka phone",
      platform: "android",
      android_version: "14",
      protections: { sms: true, screening: true, overlay: false },
    });
    // Only the hash is stored, never the secret.
    expect(row.device_secret_hash).toBe(await sha256Hex(body.device_secret!));
    expect(JSON.stringify(row)).not.toContain(body.device_secret);
    expect(f.codes[0]!.used_at).not.toBeNull();

    const req = await signedEventRequest({
      deviceId: body.device_id!,
      deviceSecret: body.device_secret!,
      body: JSON.stringify(makeEvent(body.device_id!)),
      ts: f.now().getTime(),
    });
    const evRes = await handleShieldEvent(req, f.deps);
    expect(evRes.status).toBe(200);
    expect(await evRes.json()).toMatchObject({ ok: true });
  });

  it("used code → 400 generic", async () => {
    const f = makeServerDeps();
    const code = await newCode(f);
    expect((await pair(f, code)).res.status).toBe(200);
    const again = await pair(f, code);
    expect(again.res.status).toBe(400);
    expect(again.body).toEqual({ error: PAIRING_GENERIC_ERROR });
    expect(f.devices.size).toBe(1);
  });

  it("expired code → 400 generic", async () => {
    const f = makeServerDeps();
    const code = await newCode(f);
    f.advance(10 * 60 * 1000 + 1);
    const r = await pair(f, code);
    expect(r.res.status).toBe(400);
    expect(r.body).toEqual({ error: PAIRING_GENERIC_ERROR });
    expect(f.devices.size).toBe(0);
  });

  it("wrong code → 400 with the same generic error", async () => {
    const f = makeServerDeps();
    const code = await newCode(f);
    const r = await pair(f, code === "000000" ? "000001" : "000000");
    expect(r.res.status).toBe(400);
    expect(r.body).toEqual({ error: PAIRING_GENERIC_ERROR });
  });

  it("a code from another family does not pair this family's parent", async () => {
    const f = makeServerDeps();
    const code = await newCode(f, "fam_2");
    const r = await pair(f, code, { parent_person_id: "maa_1" });
    expect(r.res.status).toBe(400);
    expect(f.devices.size).toBe(0);
  });

  it("single use under concurrent requests", async () => {
    const f = makeServerDeps();
    const code = await newCode(f);
    const results = await Promise.all(Array.from({ length: 5 }, () => pair(f, code)));
    expect(results.filter((r) => r.res.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.res.status === 400)).toHaveLength(4);
    expect(f.devices.size).toBe(1);
  });

  it("5 wrong codes from one family within 10 min → locked, even the right code fails", async () => {
    const f = makeServerDeps();
    const code = await newCode(f);
    const taken = new Set([code]);
    for (let i = 0; i < 5; i++) {
      f.advance(60 * 1000);
      expect((await pair(f, wrongCode(f, taken, i))).res.status).toBe(400);
    }
    const locked = await pair(f, code);
    expect(locked.res.status).toBe(429);
    expect(locked.body).toEqual({ error: "too_many_attempts" });
    expect(f.devices.size).toBe(0);
    expect(await createPairingCode(f.deps, { familyId: "fam_1", userId: "riya_user" })).toEqual({
      ok: false,
      reason: "locked",
    });

    // Other families are not locked.
    const other = await newCode(f, "fam_2");
    expect((await pair(f, other, { parent_person_id: "papa_2" })).res.status).toBe(200);

    // After the lock, the old (possibly guessed) code is dead; a fresh code works.
    f.advance(10 * 60 * 1000 + 1);
    expect((await pair(f, code)).res.status).toBe(400);
    const fresh = await newCode(f);
    expect((await pair(f, fresh)).res.status).toBe(200);
  });

  it("4 wrong codes do not lock, and failures older than 10 min do not count", async () => {
    const f = makeServerDeps();
    const taken = new Set<string>();
    for (let i = 0; i < 4; i++) await pair(f, wrongCode(f, taken, i));
    f.advance(10 * 60 * 1000 + 1);
    await pair(f, wrongCode(f, taken, 9));
    const code = await newCode(f);
    expect((await pair(f, code)).res.status).toBe(200);
  });

  it("unknown parent or bad body → 400, nothing written", async () => {
    const f = makeServerDeps();
    const code = await newCode(f);
    expect((await pair(f, code, { parent_person_id: "nobody" })).res.status).toBe(400);
    expect((await pair(f, code, { platform: "ios" })).res.status).toBe(400);
    expect((await handleShieldPair(pairRequest("{not json"), f.deps)).status).toBe(400);
    expect(f.devices.size).toBe(0);
    expect(f.codes[0]!.used_at).toBeNull();
  });

  it("refuses to run with a missing pairing secret", async () => {
    const f = makeServerDeps();
    const code = await newCode(f);
    f.deps.env.SHIELD_DEVICE_PAIRING_SECRET = "";
    expect((await pair(f, code)).res.status).toBe(500);
    expect(f.devices.size).toBe(0);
    expect(JSON.stringify(f.log.error.mock.calls)).not.toContain("SHIELD_DEVICE_PAIRING_SECRET");
  });
});
