import { describe, expect, it } from "vitest";
import { SHIELD_HEADERS } from "@sahaj/shared";
import { createPairingCode, handleShieldEvent, handleShieldPair, hasUnmaskedDigits } from "../../src/server";
import { makeEvent, makeServerDeps, pairBody, pairRequest, signedEventRequest, type Fake } from "./fakes";

async function pairDevice(f: Fake, personId = "maa_1", familyId = "fam_1") {
  const c = await createPairingCode(f.deps, { familyId, userId: "riya_user" });
  if (!c.ok) throw new Error(c.reason);
  const res = await handleShieldPair(pairRequest(pairBody(c.code, { parent_person_id: personId })), f.deps);
  const body = (await res.json()) as { device_id: string; device_secret: string };
  return { deviceId: body.device_id, deviceSecret: body.device_secret };
}

async function setup() {
  const f = makeServerDeps();
  const dev = await pairDevice(f);
  f.db.insertEvent.mockClear();
  return { f, ...dev };
}

async function send(f: Fake, dev: { deviceId: string; deviceSecret: string }, body: string, extra: { ts?: number; signedBody?: string } = {}) {
  const req = await signedEventRequest({ ...dev, body, ts: extra.ts ?? f.now().getTime(), signedBody: extra.signedBody });
  const res = await handleShieldEvent(req, f.deps);
  await f.flush();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function expectNothingWritten(f: Fake) {
  expect(f.db.insertEvent).not.toHaveBeenCalled();
  expect(f.db.touchHeartbeat).not.toHaveBeenCalled();
  expect(f.atlas.enqueueShieldEvent).not.toHaveBeenCalled();
}

describe("handleShieldEvent", () => {
  it("valid event → 200, one insert, one hand-off, heartbeat updated", async () => {
    const { f, deviceId, deviceSecret } = await setup();
    const r = await send(f, { deviceId, deviceSecret }, JSON.stringify(makeEvent(deviceId)));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, event_id: f.events.get("evt-key-0001")!.id });
    expect(f.db.insertEvent).toHaveBeenCalledTimes(1);
    expect(f.db.insertEvent.mock.calls[0]![0]).toMatchObject({
      idempotency_key: "evt-key-0001",
      family_id: "fam_1",
      parent_id: "maa_1",
      device_id: deviceId,
      masked_text: "Aapka KYC block hoga, OTP <NUM> bataiye",
    });
    expect(f.atlas.enqueueShieldEvent).toHaveBeenCalledTimes(1);
    expect(f.atlas.enqueueShieldEvent).toHaveBeenCalledWith({ eventId: r.body.event_id, familyId: "fam_1", parentId: "maa_1" });
    expect(f.devices.get(deviceId)!.last_heartbeat_at).toEqual(f.now());
  });

  it("hands off through waitUntil and does not wait for the brain; answers in < 1 s", async () => {
    const { f, deviceId, deviceSecret } = await setup();
    f.atlas.enqueueShieldEvent.mockImplementation(() => new Promise(() => undefined)); // brain never finishes
    const req = await signedEventRequest({ deviceId, deviceSecret, body: JSON.stringify(makeEvent(deviceId)), ts: f.now().getTime() });
    const started = performance.now();
    const res = await handleShieldEvent(req, f.deps);
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    expect(f.deps.waitUntil).toHaveBeenCalled();
    expect(f.atlas.enqueueShieldEvent).toHaveBeenCalledTimes(1);
  });

  it("a failing hand-off is logged and does not change the response", async () => {
    const { f, deviceId, deviceSecret } = await setup();
    f.atlas.enqueueShieldEvent.mockRejectedValue(new Error("atlas down"));
    const r = await send(f, { deviceId, deviceSecret }, JSON.stringify(makeEvent(deviceId)));
    expect(r.status).toBe(200);
    expect(f.log.error).toHaveBeenCalledWith("shield.event.enqueue_failed", expect.objectContaining({ error: "atlas down" }));
  });

  it("replayed same body → 200 duplicate, no second hand-off", async () => {
    const { f, deviceId, deviceSecret } = await setup();
    const body = JSON.stringify(makeEvent(deviceId));
    expect((await send(f, { deviceId, deviceSecret }, body)).status).toBe(200);
    f.advance(1000);
    const again = await send(f, { deviceId, deviceSecret }, body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, duplicate: true });
    expect(f.events.size).toBe(1);
    expect(f.atlas.enqueueShieldEvent).toHaveBeenCalledTimes(1);
  });

  it("altered body (one char) → 401, nothing written", async () => {
    const { f, deviceId, deviceSecret } = await setup();
    const body = JSON.stringify(makeEvent(deviceId));
    const altered = body.replace('"local_level":"red"', '"local_level":"rad"');
    expect(altered).not.toBe(body);
    expect(altered.length).toBe(body.length);
    const r = await send(f, { deviceId, deviceSecret }, altered, { signedBody: body });
    expect(r.status).toBe(401);
    expectNothingWritten(f);
  });

  it("re-serialised JSON (same object, different bytes) → 401: the raw body is what is signed", async () => {
    const { f, deviceId, deviceSecret } = await setup();
    const body = JSON.stringify(makeEvent(deviceId));
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    expect((await send(f, { deviceId, deviceSecret }, pretty, { signedBody: body })).status).toBe(401);
    expectNothingWritten(f);
  });

  it("wrong device secret → 401", async () => {
    const { f, deviceId } = await setup();
    const r = await send(f, { deviceId, deviceSecret: "0".repeat(64) }, JSON.stringify(makeEvent(deviceId)));
    expect(r.status).toBe(401);
    expectNothingWritten(f);
  });

  it("ts 6 min old → 401 (also 6 min in the future); 4 min old is fine", async () => {
    const { f, deviceId, deviceSecret } = await setup();
    const body = JSON.stringify(makeEvent(deviceId));
    const now = f.now().getTime();
    expect((await send(f, { deviceId, deviceSecret }, body, { ts: now - 6 * 60 * 1000 })).status).toBe(401);
    expect((await send(f, { deviceId, deviceSecret }, body, { ts: now + 6 * 60 * 1000 })).status).toBe(401);
    expectNothingWritten(f);
    expect((await send(f, { deviceId, deviceSecret }, body, { ts: now - 4 * 60 * 1000 })).status).toBe(200);
  });

  it("unknown device → 401", async () => {
    const { f, deviceSecret } = await setup();
    const ghost = "00000000-0000-4000-8000-000000000000";
    const r = await send(f, { deviceId: ghost, deviceSecret }, JSON.stringify(makeEvent(ghost)));
    expect(r.status).toBe(401);
    expectNothingWritten(f);
  });

  it("family mismatch → 401", async () => {
    const { f, deviceId, deviceSecret } = await setup();
    const r = await send(f, { deviceId, deviceSecret }, JSON.stringify(makeEvent(deviceId, { family_id: "fam_2" })));
    expect(r.status).toBe(401);
    expectNothingWritten(f);
  });

  it("device_id mismatch or missing in the body → 401; parent mismatch → 401", async () => {
    const { f, deviceId, deviceSecret } = await setup();
    const other = await pairDevice(f, "papa_2", "fam_2");
    const dev = { deviceId, deviceSecret };
    expect((await send(f, dev, JSON.stringify(makeEvent(other.deviceId)))).status).toBe(401);
    expect((await send(f, dev, JSON.stringify(makeEvent(deviceId, { device_id: undefined })))).status).toBe(401);
    expect((await send(f, dev, JSON.stringify(makeEvent(deviceId, { parent_id: "papa_2" })))).status).toBe(401);
    expectNothingWritten(f);
  });

  it("unmasked digits in masked_text → 400, nothing stored", async () => {
    const { f, deviceId, deviceSecret } = await setup();
    const dev = { deviceId, deviceSecret };
    for (const text of ["OTP 4829 hai", "call 98765 43210", "OTP ४८२९", "OTP 4 8 2 9"]) {
      const r = await send(f, dev, JSON.stringify(makeEvent(deviceId, { masked_text: text })));
      expect(r.status, text).toBe(400);
      expect(r.body).toEqual({ error: "unmasked_digits" });
    }
    expectNothingWritten(f);
  });

  it("invalid event shape → 400, nothing stored", async () => {
    const { f, deviceId, deviceSecret } = await setup();
    const dev = { deviceId, deviceSecret };
    expect((await send(f, dev, JSON.stringify({ ...makeEvent(deviceId), kind: "email" }))).status).toBe(400);
    expect((await send(f, dev, "not json")).status).toBe(400);
    expectNothingWritten(f);
  });

  it("missing headers → 401", async () => {
    const { f, deviceId } = await setup();
    for (const drop of Object.values(SHIELD_HEADERS)) {
      const req = await signedEventRequest({ deviceId, deviceSecret: "x".repeat(64), body: "{}", ts: f.now().getTime() });
      const headers = new Headers(req.headers);
      headers.delete(drop);
      const res = await handleShieldEvent(new Request(req.url, { method: "POST", headers, body: "{}" }), f.deps);
      expect(res.status).toBe(401);
    }
    expectNothingWritten(f);
  });

  it("oversized body → 413", async () => {
    const { f, deviceId, deviceSecret } = await setup();
    const r = await send(f, { deviceId, deviceSecret }, "x".repeat(20 * 1024));
    expect(r.status).toBe(413);
    expectNothingWritten(f);
  });

  it("database failure → 500, no hand-off, no raw DB error message in logs", async () => {
    const { f, deviceId, deviceSecret } = await setup();
    f.db.insertEvent.mockRejectedValueOnce(new Error("raw postgres detail: masked_text=9876543210"));
    const r = await send(f, { deviceId, deviceSecret }, JSON.stringify(makeEvent(deviceId)));
    expect(r.status).toBe(500);
    expect(f.atlas.enqueueShieldEvent).not.toHaveBeenCalled();
    expect(f.log.error).toHaveBeenCalledWith("shield.event.failed", { error: "Error" });
    expect(JSON.stringify(f.log.error.mock.calls)).not.toContain("9876543210");
  });
});

describe("hasUnmaskedDigits", () => {
  it("flags 4+ digit runs in any script, allows short numbers and mask tokens", () => {
    expect(hasUnmaskedDigits("OTP 1234")).toBe(true);
    expect(hasUnmaskedDigits("12-34")).toBe(true);
    expect(hasUnmaskedDigits("९८७६")).toBe(true);
    expect(hasUnmaskedDigits("１２３４")).toBe(true);
    expect(hasUnmaskedDigits("OTP <NUM>, call <MOBILE_10>")).toBe(false);
    expect(hasUnmaskedDigits("2 baje 100 rupaye")).toBe(false);
  });
});
