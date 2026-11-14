import { describe, expect, it, vi } from "vitest";
import type { CallContentRow, ConsentRow, MediaAuthorizationContext, MediaDeps, Membership, ObjectInfo } from "../../src/lib/media/contracts";
import { RECORDING_CONSENT_PURPOSE, voiceShareConsentPurpose } from "../../src/lib/media/contracts";
import { createMediaHandler } from "../../src/lib/media/handler";
import { objectFitsBucket, validateObjectPath } from "../../src/lib/media/paths";
import { createMediaService } from "../../src/lib/media/service";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FAM = id(1), OTHER_FAM = id(2), PARENT_P = id(10), CHILD_P = id(11), CIRCLE_P = id(12), OTHER_P = id(13);
const PARENT_U = id(20), CHILD_U = id(21), CIRCLE_U = id(22), OTHER_U = id(23);
const POST = id(30), CALL = id(31), CONSENT_YES = id(40), CONSENT_REC = id(41);
const NOW = new Date("2026-11-14T12:00:00Z");
const PATH = `${FAM}/post-1.mp3`, REC_PATH = `${FAM}/call-1.ogg`;
const FUTURE = "2026-12-01T00:00:00Z";

const consent = (o: Partial<ConsentRow>): ConsentRow => ({
  id: CONSENT_YES, familyId: FAM, personId: PARENT_P, callId: null, purpose: voiceShareConsentPurpose(CHILD_P),
  answer: true, version: "v1", createdAt: "2026-11-01T00:00:00Z", ...o,
});

function world(over: { memberships?: Membership[]; consents?: ConsentRow[]; info?: ObjectInfo | null; expires?: string; recExpires?: string; path?: string; recPath?: string | null; users?: Record<string, string> } = {}) {
  const memberships: Membership[] = over.memberships ?? [
    { familyId: FAM, userId: PARENT_U, personId: PARENT_P, role: "parent", revokedAt: null },
    { familyId: FAM, userId: CHILD_U, personId: CHILD_P, role: "child", revokedAt: null },
    { familyId: FAM, userId: CIRCLE_U, personId: CIRCLE_P, role: "circle", revokedAt: null },
    { familyId: OTHER_FAM, userId: OTHER_U, personId: OTHER_P, role: "parent", revokedAt: null },
  ];
  const consents = over.consents ?? [
    consent({}),
    consent({ id: CONSENT_REC, purpose: RECORDING_CONSENT_PURPOSE, callId: CALL }),
  ];
  const users = over.users ?? { "tok-parent": PARENT_U, "tok-child": CHILD_U, "tok-circle": CIRCLE_U, "tok-other": OTHER_U };
  const signed: Array<[string, string, number]> = [];
  const events: string[] = [];
  const contexts: MediaAuthorizationContext[] = [];
  const clock = { at: NOW.getTime() };
  const callContent: CallContentRow = { familyId: FAM, callId: CALL, consentId: CONSENT_REC, recordingObjectPath: over.recPath === undefined ? REC_PATH : over.recPath, expiresAt: over.recExpires ?? FUTURE };
  const deps: MediaDeps = {
    now: () => new Date(clock.at),
    authorizeMedia: async (c) => { events.push("authorize"); contexts.push(c); return "allow"; },
    auth: { verifyBearer: async (t) => (users[t] ? { userId: users[t] } : null) },
    repo: {
      getMembership: async (u, f) => memberships.find((m) => m.userId === u && m.familyId === f) ?? null,
      getVoicePost: async (p) => (p === POST ? { id: POST, familyId: FAM, senderId: PARENT_P, recipientId: CHILD_P, consentId: CONSENT_YES } : null),
      getVoiceContent: async () => ({ familyId: FAM, voicePostId: POST, objectPath: over.path ?? PATH, expiresAt: over.expires ?? FUTURE }),
      getCall: async (c) => (c === CALL ? { id: CALL, familyId: FAM, personId: PARENT_P } : null),
      getCallContent: async () => callContent,
      getConsent: async (f, c) => consents.find((x) => x.familyId === f && x.id === c) ?? null,
      listConsentHistory: async (f, p, purpose) => consents.filter((x) => x.familyId === f && x.personId === p && x.purpose === purpose),
    },
    storage: {
      stat: async () => { events.push("stat"); return over.info === undefined ? { size: 1000, contentType: "audio/mpeg" } : over.info; },
      createSignedUrl: async (b, p, s) => { events.push("sign"); signed.push([b, p, s]); return "https://storage.invalid/signed?token=SYNTHETIC"; },
    },
  };
  return { deps, signed, consents, events, contexts, clock };
}

describe("voice post access", () => {
  it("signs for the recipient with a 60s URL from the fixed bucket", async () => {
    const w = world();
    const r = await createMediaService(w.deps).voicePost("tok-child", POST);
    expect(r).toMatchObject({ ok: true, expiresInSeconds: 60 });
    expect(w.signed).toEqual([["sahaj-voice", PATH, 60]]);
  });
  it("signs for the sender", async () => {
    expect((await createMediaService(world().deps).voicePost("tok-parent", POST)).ok).toBe(true);
  });
  it("rejects unauthenticated, malformed and unknown tokens", async () => {
    const s = createMediaService(world().deps);
    for (const t of [null, "", "unknown", "x".repeat(5000)]) expect(await s.voicePost(t, POST)).toMatchObject({ ok: false, status: 401 });
  });
  it("rejects revoked members", async () => {
    const w = world();
    w.deps.repo.getMembership = async () => ({ familyId: FAM, userId: CHILD_U, personId: CHILD_P, role: "child", revokedAt: "2026-11-10T00:00:00Z" });
    expect(await createMediaService(w.deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, status: 404 });
    expect(w.signed).toEqual([]);
  });
  it("hides the post from another family", async () => {
    const r = await createMediaService(world().deps).voicePost("tok-other", POST);
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
  it("denies a family member who is neither sender nor recipient (circle and wrong child)", async () => {
    const w = world();
    expect(await createMediaService(w.deps).voicePost("tok-circle", POST)).toMatchObject({ ok: false, status: 403 });
    w.deps.repo.getMembership = async () => ({ familyId: FAM, userId: CHILD_U, personId: OTHER_P, role: "child", revokedAt: null });
    expect(await createMediaService(w.deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, status: 404 });
    expect(w.signed).toEqual([]);
  });
  it("denies a circle user even when bound as recipient", async () => {
    const w = world();
    w.deps.repo.getVoicePost = async () => ({ id: POST, familyId: FAM, senderId: PARENT_P, recipientId: CIRCLE_P, consentId: CONSENT_YES });
    expect(await createMediaService(w.deps).voicePost("tok-circle", POST)).toMatchObject({ ok: false, status: 403 });
  });
  it("denies when the sender refused", async () => {
    const w = world({ consents: [consent({ answer: false })] });
    expect(await createMediaService(w.deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, code: "consent_required" });
  });
  it("later refusal revokes an earlier yes, including equal timestamps", async () => {
    for (const at of ["2026-11-05T00:00:00Z", "2026-11-01T00:00:00Z"]) {
      const w = world({ consents: [consent({}), consent({ id: id(99), answer: false, createdAt: at })] });
      expect(await createMediaService(w.deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, code: "consent_required" });
    }
  });
  it("a later re-grant restores access", async () => {
    const w = world({ consents: [consent({}), consent({ id: id(98), answer: false, createdAt: "2026-11-05T00:00:00Z" }), consent({ id: id(97), createdAt: "2026-11-06T00:00:00Z" })] });
    expect((await createMediaService(w.deps).voicePost("tok-child", POST)).ok).toBe(true);
  });
  it("denies consent for a different recipient, person, purpose or family", async () => {
    for (const bad of [{ purpose: voiceShareConsentPurpose(CIRCLE_P) }, { personId: CHILD_P }, { purpose: "voice_share" }, { familyId: OTHER_FAM }]) {
      const w = world({ consents: [consent(bad)] });
      expect(await createMediaService(w.deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, status: 403 });
    }
  });
  it("denies when no consent row is linked", async () => {
    expect(await createMediaService(world({ consents: [] }).deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, code: "consent_required" });
  });
  it("denies aged consent when a maximum age is configured", async () => {
    const s = createMediaService(world().deps, { consentMaxAgeMs: 24 * 3600_000 });
    expect(await s.voicePost("tok-child", POST)).toMatchObject({ ok: false, code: "consent_required" });
  });
  it("denies expired content grants", async () => {
    const w = world({ expires: "2026-11-14T11:59:59Z" });
    expect(await createMediaService(w.deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, code: "expired", status: 410 });
    expect(w.signed).toEqual([]);
  });
  it("denies wrong MIME, oversize, empty and missing objects", async () => {
    for (const info of [{ size: 10, contentType: "text/html" }, { size: 10, contentType: "audio/mpeg2" }, { size: 15_728_641, contentType: "audio/mpeg" }, { size: 0, contentType: "audio/mpeg" }]) {
      const w = world({ info });
      expect(await createMediaService(w.deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, code: "invalid_object" });
      expect(w.signed).toEqual([]);
    }
    expect(await createMediaService(world({ info: null }).deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, status: 404 });
  });
  it("rejects stored paths outside the tenant or with traversal before touching storage", async () => {
    for (const path of [`${OTHER_FAM}/a.mp3`, `${FAM}/../${OTHER_FAM}/a.mp3`, `${FAM}/%2e%2e/a.mp3`, `${FAM}/a.exe`]) {
      const w = world({ path });
      const stat = vi.spyOn(w.deps.storage, "stat");
      expect(await createMediaService(w.deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, code: "invalid_object" });
      expect(stat).not.toHaveBeenCalled();
    }
  });
  it("returns unavailable without leaking errors when dependencies throw or return a bad URL", async () => {
    const w = world();
    w.deps.repo.getVoicePost = async () => { throw new Error("secret-db-detail"); };
    const r = await createMediaService(w.deps).voicePost("tok-child", POST);
    expect(r).toEqual({ ok: false, code: "unavailable", status: 503 });
    const w2 = world();
    w2.deps.storage.createSignedUrl = async () => "javascript:alert(1)";
    expect(await createMediaService(w2.deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, code: "unavailable" });
  });
  it("rejects non-uuid ids and unknown posts", async () => {
    const s = createMediaService(world().deps);
    expect(await s.voicePost("tok-child", "../x")).toMatchObject({ status: 404 });
    expect(await s.voicePost("tok-child", id(77))).toMatchObject({ status: 404 });
  });
  it("rejects signed URL lifetimes above 60 seconds or below 1", () => {
    for (const s of [61, 0, -1, 1.5, 3600]) expect(() => createMediaService(world().deps, { signedUrlSeconds: s })).toThrow();
    expect(() => createMediaService(world().deps, { signedUrlSeconds: 30 })).not.toThrow();
  });
});

describe("call recording access", () => {
  it("signs for the recorded parent from the recordings bucket", async () => {
    const w = world();
    expect(await createMediaService(w.deps).callRecording("tok-parent", CALL)).toMatchObject({ ok: true, expiresInSeconds: 60 });
    expect(w.signed).toEqual([["sahaj-recordings", REC_PATH, 60]]);
  });
  it("denies the child, circle and other families", async () => {
    const w = world();
    const s = createMediaService(w.deps);
    expect(await s.callRecording("tok-child", CALL)).toMatchObject({ ok: false, status: 404 });
    expect(await s.callRecording("tok-circle", CALL)).toMatchObject({ ok: false, status: 403 });
    expect(await s.callRecording("tok-other", CALL)).toMatchObject({ ok: false, status: 404 });
    expect(w.signed).toEqual([]);
  });
  it("denies on refusal, later revocation, wrong call, or missing recording", async () => {
    const rec = (o: Partial<ConsentRow>) => consent({ id: CONSENT_REC, purpose: RECORDING_CONSENT_PURPOSE, callId: CALL, ...o });
    for (const consents of [
      [rec({ answer: false })],
      [rec({}), rec({ id: id(60), answer: false, createdAt: "2026-11-02T00:00:00Z", callId: null })],
      [rec({ callId: id(61) })],
      [rec({ personId: CHILD_P })],
    ]) {
      expect(await createMediaService(world({ consents }).deps).callRecording("tok-parent", CALL)).toMatchObject({ ok: false, code: "consent_required" });
    }
    expect(await createMediaService(world({ recPath: null }).deps).callRecording("tok-parent", CALL)).toMatchObject({ ok: false, status: 404 });
  });
  it("denies expired recordings and traversal paths", async () => {
    expect(await createMediaService(world({ recExpires: "2026-01-01T00:00:00Z" }).deps).callRecording("tok-parent", CALL)).toMatchObject({ code: "expired" });
    expect(await createMediaService(world({ recPath: `${FAM}/..%2f..%2fx.ogg` }).deps).callRecording("tok-parent", CALL)).toMatchObject({ code: "invalid_object" });
  });
});

describe("path and object validation", () => {
  it("accepts tenant-scoped audio paths only", () => {
    expect(validateObjectPath(`${FAM}/a/b-1.m4a`, FAM)).toBe(`${FAM}/a/b-1.m4a`);
  });
  it.each([
    "", "/etc/passwd", `${FAM}`, `${FAM}/`, `${FAM}//a.mp3`, `${FAM}/./a.mp3`, `${FAM}/../a.mp3`, `${FAM}/..\\a.mp3`,
    `${FAM}/%2e%2e/a.mp3`, `${FAM}/%2E%2E%2Fa.mp3`, `${FAM}/a.mp3%00`, `${FAM}/a\u0000.mp3`, `${FAM}/.hidden.mp3`,
    `${FAM}/a b.mp3`, `${FAM}/a.mp3/`, "https://evil.invalid/a.mp3", `${FAM}/${"a".repeat(129)}.mp3`, `${OTHER_FAM}/a.mp3`,
    "AAAAAAAA-0000-4000-8000-000000000001/a.mp3", `${FAM}/a/b/c/d/e/f.mp3`,
  ])("rejects %j", (p) => expect(validateObjectPath(p, FAM)).toBeNull());
  it("rejects non-string input and a non-uuid tenant", () => {
    expect(validateObjectPath(undefined, FAM)).toBeNull();
    expect(validateObjectPath("x/a.mp3", "x")).toBeNull();
  });
  it("enforces per-bucket size limits", () => {
    expect(objectFitsBucket("sahaj-lines", { size: 5_242_880, contentType: "audio/wav" })).toBe(true);
    expect(objectFitsBucket("sahaj-lines", { size: 5_242_881, contentType: "audio/wav" })).toBe(false);
    expect(objectFitsBucket("sahaj-recordings", { size: 52_428_800, contentType: "audio/ogg; codecs=opus" })).toBe(true);
    expect(objectFitsBucket("sahaj-voice", { size: 1.5, contentType: "audio/ogg" })).toBe(false);
  });
});

describe("HTTP handler", () => {
  const call = (token: string | null, postId = POST, w = world()) =>
    createMediaHandler("voicePost", () => w.deps)(new Request("https://x.invalid/api/media/voice/" + postId, { headers: token ? { authorization: token } : {} }), postId);
  it("returns a no-store JSON body for authorized callers", async () => {
    const res = await call("Bearer tok-child");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ url: "https://storage.invalid/signed?token=SYNTHETIC", expires_in: 60 });
  });
  it("returns 401 with no hint for missing or malformed authorization", async () => {
    for (const t of [null, "Basic abc", "Bearer ", "Bearer a b", "bearer tok-child"]) {
      const res = await call(t);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    }
  });
  it("maps misconfiguration to 503 and never logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const bad = await createMediaHandler("voicePost", () => { throw new Error("missing key SECRET"); })(new Request("https://x.invalid"), POST);
    expect(bad.status).toBe(503);
    expect(await bad.text()).not.toContain("SECRET");
    await call("Bearer tok-child"); await call("Bearer nope");
    for (const s of spies) { expect(s).not.toHaveBeenCalled(); s.mockRestore(); }
  });
});

describe("trusted authorization decision", () => {
  it("runs after path/expiry checks and before storage stat or signing, with explicit context", async () => {
    const w = world();
    expect((await createMediaService(w.deps).voicePost("tok-child", POST)).ok).toBe(true);
    expect(w.events).toEqual(["authorize", "stat", "sign"]);
    expect(w.contexts[0]).toMatchObject({
      action: "read_voice_media", familyId: FAM,
      actor: { userId: CHILD_U, personId: CHILD_P, role: "child" },
      subject: { kind: "voice_post", id: POST, senderId: PARENT_P, recipientId: CHILD_P },
      consent: { id: CONSENT_YES, personId: PARENT_P, purpose: voiceShareConsentPurpose(CHILD_P) },
      object: { bucket: "sahaj-voice", path: PATH, expiresAt: FUTURE },
    });
  });
  it("passes recording context", async () => {
    const w = world();
    await createMediaService(w.deps).callRecording("tok-parent", CALL);
    expect(w.contexts[0]).toMatchObject({ action: "read_call_recording", subject: { kind: "call", id: CALL, personId: PARENT_P }, consent: { id: CONSENT_REC, callId: CALL }, object: { bucket: "sahaj-recordings" } });
  });
  it.each([["deny"], ["ask"], [undefined], [null], [true], ["ALLOW"], ["allow "]])("fails closed on decision %j", async (decision) => {
    const w = world();
    w.deps.authorizeMedia = async () => decision as never;
    expect(await createMediaService(w.deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, status: 403 });
    expect(w.events).not.toContain("stat"); expect(w.signed).toEqual([]);
  });
  it("fails closed when the authorizer throws or rejects", async () => {
    for (const fn of [() => { throw new Error("x"); }, async () => { throw new Error("x"); }]) {
      const w = world();
      w.deps.authorizeMedia = fn as never;
      expect(await createMediaService(w.deps).callRecording("tok-parent", CALL)).toMatchObject({ ok: false, status: 403 });
      expect(w.events).not.toContain("stat");
    }
  });
  it("is not consulted for callers that fail earlier checks", async () => {
    const w = world();
    await createMediaService(w.deps).voicePost("tok-circle", POST);
    await createMediaService(w.deps).voicePost("nope", POST);
    expect(w.contexts).toEqual([]);
  });
});

describe("call-scoped recording consent", () => {
  const CALL_B = id(62);
  const rec = (o: Partial<ConsentRow>) => consent({ purpose: RECORDING_CONSENT_PURPOSE, callId: CALL, ...o });
  const run = (consents: ConsentRow[]) => createMediaService(world({ consents }).deps).callRecording("tok-parent", CALL);
  const A_YES = rec({ id: CONSENT_REC, createdAt: "2026-11-01T00:00:00Z" });
  it("A yes then A no then B yes stays denied", async () => {
    expect(await run([A_YES, rec({ id: id(70), answer: false, createdAt: "2026-11-02T00:00:00Z" }), rec({ id: id(71), callId: CALL_B, createdAt: "2026-11-03T00:00:00Z" })]))
      .toMatchObject({ ok: false, code: "consent_required" });
  });
  it("a refusal for call B does not revoke call A", async () => {
    expect((await run([A_YES, rec({ id: id(72), callId: CALL_B, answer: false, createdAt: "2026-11-03T00:00:00Z" })])).ok).toBe(true);
  });
  it("a later explicit global refusal revokes", async () => {
    expect(await run([A_YES, rec({ id: id(73), callId: null, answer: false, createdAt: "2026-11-02T00:00:00Z" })])).toMatchObject({ code: "consent_required" });
  });
  it("a global refusal followed by an other-call yes stays denied", async () => {
    expect(await run([A_YES, rec({ id: id(74), callId: null, answer: false, createdAt: "2026-11-02T00:00:00Z" }), rec({ id: id(75), callId: CALL_B, createdAt: "2026-11-04T00:00:00Z" })]))
      .toMatchObject({ code: "consent_required" });
  });
  it("a global yes never revives a refused call", async () => {
    expect(await run([A_YES, rec({ id: id(76), answer: false, createdAt: "2026-11-02T00:00:00Z" }), rec({ id: id(77), callId: null, createdAt: "2026-11-05T00:00:00Z" })]))
      .toMatchObject({ code: "consent_required" });
  });
  it("same-call regrant after refusal restores access (linked row is the original yes)", async () => {
    expect((await run([A_YES, rec({ id: id(78), answer: false, createdAt: "2026-11-02T00:00:00Z" }), rec({ id: id(79), createdAt: "2026-11-03T00:00:00Z" })])).ok).toBe(true);
  });
  it("a global refusal older than the call-A yes does not block it", async () => {
    expect((await run([rec({ id: id(80), callId: null, answer: false, createdAt: "2026-10-01T00:00:00Z" }), A_YES])).ok).toBe(true);
  });
  it("tied timestamps resolve to refusal, for call and global refusals", async () => {
    expect(await run([A_YES, rec({ id: id(81), answer: false, createdAt: A_YES.createdAt })])).toMatchObject({ code: "consent_required" });
    expect(await run([A_YES, rec({ id: id(82), callId: null, answer: false, createdAt: A_YES.createdAt })])).toMatchObject({ code: "consent_required" });
  });
  it("voice grants stay recipient-specific and independent of call scope", async () => {
    const w = world({ consents: [consent({ callId: CALL_B })] });
    expect((await createMediaService(w.deps).voicePost("tok-child", POST)).ok).toBe(true);
  });
});

describe("retention-bound URL lifetime", () => {
  const at = (s: number) => new Date(NOW.getTime() + s * 1000).toISOString();
  it.each([[1, 1], [2, 2], [59, 59], [60, 60], [61, 60], [3600, 60]])("retention in %ds gives expires_in %d", async (retention, expected) => {
    const w = world({ expires: at(retention) });
    const r = await createMediaService(w.deps).voicePost("tok-child", POST);
    expect(r).toMatchObject({ ok: true, expiresInSeconds: expected });
    expect(w.signed[0][2]).toBe(expected);
  });
  it("floors fractional seconds and rejects under one second", async () => {
    const w = world({ expires: new Date(NOW.getTime() + 1999).toISOString() });
    expect(await createMediaService(w.deps).voicePost("tok-child", POST)).toMatchObject({ ok: true, expiresInSeconds: 1 });
    const w2 = world({ expires: new Date(NOW.getTime() + 999).toISOString() });
    expect(await createMediaService(w2.deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, code: "expired" });
    expect(w2.signed).toEqual([]);
  });
  it("rechecks the clock after the storage call", async () => {
    const w = world({ expires: at(2) });
    const stat = w.deps.storage.stat;
    w.deps.storage.stat = async (b, p) => { const r = await stat(b, p); w.clock.at += 1500; return r; };
    expect(await createMediaService(w.deps).voicePost("tok-child", POST)).toMatchObject({ ok: false, code: "expired" });
    expect(w.signed).toEqual([]);
    const w2 = world({ expires: at(5) });
    const stat2 = w2.deps.storage.stat;
    w2.deps.storage.stat = async (b, p) => { const r = await stat2(b, p); w2.clock.at += 1500; return r; };
    expect(await createMediaService(w2.deps).voicePost("tok-child", POST)).toMatchObject({ ok: true, expiresInSeconds: 3 });
  });
  it("honors a shorter configured TTL and applies to recordings", async () => {
    const w = world({ recExpires: at(45) });
    expect(await createMediaService(w.deps, { signedUrlSeconds: 20 }).callRecording("tok-parent", CALL)).toMatchObject({ expiresInSeconds: 20 });
    const w2 = world({ recExpires: at(45) });
    expect(await createMediaService(w2.deps).callRecording("tok-parent", CALL)).toMatchObject({ expiresInSeconds: 45 });
  });
});

describe("bounded consent history availability", () => {
  const CALL_B = id(63);
  const rec = (o: Partial<ConsentRow>) => consent({ purpose: RECORDING_CONSENT_PURPOSE, callId: CALL, ...o });
  const noise = Array.from({ length: 250 }, (_, i) => rec({ id: id(1000 + i), callId: CALL_B, createdAt: new Date(Date.UTC(2026, 10, 5) + i * 1000).toISOString() }));
  /** Repository that honors the scope contract: exact call rows plus global refusals only. */
  const scoped = (w: ReturnType<typeof world>) => {
    const asked: Array<string | undefined> = [];
    w.deps.repo.listConsentHistory = async (f, p, purpose, callId) => {
      asked.push(callId);
      return w.consents.filter((c) => c.familyId === f && c.personId === p && c.purpose === purpose &&
        (callId === undefined || c.callId === callId || (c.callId === null && !c.answer)));
    };
    return asked;
  };
  it("passes the requested call to the history query and keeps access despite 250 newer other-call grants", async () => {
    const w = world({ consents: [rec({ id: CONSENT_REC, createdAt: "2026-11-01T00:00:00Z" }), ...noise] });
    const asked = scoped(w);
    expect((await createMediaService(w.deps).callRecording("tok-parent", CALL)).ok).toBe(true);
    expect(asked).toEqual([CALL]);
  });
  it("still revokes on a same-call refusal or global refusal among the noise", async () => {
    for (const refusal of [rec({ id: id(2000), answer: false, createdAt: "2026-11-02T00:00:00Z" }), rec({ id: id(2001), callId: null, answer: false, createdAt: "2026-11-02T00:00:00Z" })]) {
      const w = world({ consents: [rec({ id: CONSENT_REC, createdAt: "2026-11-01T00:00:00Z" }), refusal, ...noise] });
      scoped(w);
      expect(await createMediaService(w.deps).callRecording("tok-parent", CALL)).toMatchObject({ ok: false, code: "consent_required" });
    }
  });
  it("a global grant cannot restore a refused call even though it is newest", async () => {
    const w = world({ consents: [rec({ id: CONSENT_REC, createdAt: "2026-11-01T00:00:00Z" }), rec({ id: id(2002), answer: false, createdAt: "2026-11-02T00:00:00Z" }), rec({ id: id(2003), callId: null, createdAt: "2026-11-09T00:00:00Z" })] });
    scoped(w);
    expect(await createMediaService(w.deps).callRecording("tok-parent", CALL)).toMatchObject({ code: "consent_required" });
  });
  it("answers 503 and does not authorize or sign when the history is truncated", async () => {
    const w = world();
    w.deps.repo.listConsentHistory = async () => { throw new Error("history_truncated"); };
    expect(await createMediaService(w.deps).callRecording("tok-parent", CALL)).toEqual({ ok: false, code: "unavailable", status: 503 });
    expect(w.events).toEqual([]);
  });
  it("voice history is requested without a call scope", async () => {
    const w = world();
    const asked = scoped(w);
    expect((await createMediaService(w.deps).voicePost("tok-child", POST)).ok).toBe(true);
    expect(asked).toEqual([undefined]);
  });
});
