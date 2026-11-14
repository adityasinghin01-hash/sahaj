import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CONSENT_HISTORY_LIMIT, defaultMediaDeps, supabaseAuth, supabaseRepository, supabaseStorage } from "../../src/lib/media/supabase";

const F = "00000000-0000-4000-8000-000000000001", P = "00000000-0000-4000-8000-000000000030", U = "00000000-0000-4000-8000-000000000020";
type Result = { data: unknown; error: unknown };

/** Minimal chainable stand-in for the parts of the Supabase client the adapters use. */
function fakeDb(config: { rows?: Record<string, Array<Record<string, unknown>>>; tables?: Record<string, Result>; rpc?: Record<string, Result>; user?: Result; info?: Result; signed?: Result } = {}) {
  const calls: { table?: string; ops: Array<[string, ...unknown[]]>; rpc?: [string, unknown]; auth?: string; storage?: Array<[string, ...unknown[]]> }[] = [];
  const db = {
    from(table: string) {
      const entry = { table, ops: [] as Array<[string, ...unknown[]]> }; calls.push(entry);
      const result = () => {
        const rows = config.rows?.[table];
        if (!rows) return Promise.resolve(config.tables?.[table] ?? { data: null, error: null });
        // In-memory evaluation of the recorded filters, so tests exercise real query semantics.
        let out = rows.filter((r) => entry.ops.every(([op, col, val]) => op === "eq" ? r[col as string] === val : op === "is" ? r[col as string] === val : true));
        const order = entry.ops.find((o) => o[0] === "order");
        if (order) out = [...out].sort((a, b) => String(b[order[1] as string]).localeCompare(String(a[order[1] as string])));
        const limit = entry.ops.find((o) => o[0] === "limit");
        if (limit) out = out.slice(0, limit[1] as number);
        return Promise.resolve({ data: out, error: null });
      };
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "is", "order", "limit"]) b[op] = (...a: unknown[]) => { entry.ops.push([op, ...a]); return b; };
      b.maybeSingle = () => { entry.ops.push(["maybeSingle"]); return result(); };
      b.then = (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => result().then(res, rej);
      return b;
    },
    rpc(name: string, args: unknown) { calls.push({ ops: [], rpc: [name, args] }); return Promise.resolve(config.rpc?.[name] ?? { data: null, error: { message: "function does not exist" } }); },
    auth: { getUser: (t: string) => { calls.push({ ops: [], auth: t }); return Promise.resolve(config.user ?? { data: { user: null }, error: { message: "bad" } }); } },
    storage: { from: (bucket: string) => ({
      info: (path: string) => { calls.push({ ops: [], storage: [["info", bucket, path]] }); return Promise.resolve(config.info ?? { data: null, error: { message: "nf" } }); },
      createSignedUrl: (path: string, s: number) => { calls.push({ ops: [], storage: [["sign", bucket, path, s]] }); return Promise.resolve(config.signed ?? { data: null, error: { message: "x" } }); },
    }) },
  };
  return { db: db as unknown as SupabaseClient, calls };
}
const opsOf = (calls: ReturnType<typeof fakeDb>["calls"], table: string) => calls.find((c) => c.table === table)!.ops;
afterEach(() => vi.unstubAllEnvs());

describe("supabaseAuth", () => {
  it("returns the verified user id from auth.getUser, passing the bearer through", async () => {
    const { db, calls } = fakeDb({ user: { data: { user: { id: U } }, error: null } });
    expect(await supabaseAuth(db).verifyBearer("tok")).toEqual({ userId: U });
    expect(calls[0].auth).toBe("tok");
  });
  it("returns null on error or missing user", async () => {
    expect(await supabaseAuth(fakeDb().db).verifyBearer("tok")).toBeNull();
    expect(await supabaseAuth(fakeDb({ user: { data: { user: {} }, error: null } }).db).verifyBearer("tok")).toBeNull();
  });
});

describe("supabaseRepository", () => {
  it("looks up only live memberships by user and family", async () => {
    const { db, calls } = fakeDb({ tables: { family_memberships: { data: { family_id: F, user_id: U, person_id: P, role: "child", revoked_at: null }, error: null } } });
    expect(await supabaseRepository(db).getMembership(U, F)).toEqual({ familyId: F, userId: U, personId: P, role: "child", revokedAt: null });
    const ops = opsOf(calls, "family_memberships");
    expect(ops).toContainEqual(["eq", "user_id", U]);
    expect(ops).toContainEqual(["eq", "family_id", F]);
    expect(ops).toContainEqual(["is", "revoked_at", null]);
  });
  it("returns null when no row and fails closed on database errors or malformed rows", async () => {
    expect(await supabaseRepository(fakeDb().db).getMembership(U, F)).toBeNull();
    const err = fakeDb({ tables: { voice_posts: { data: null, error: { message: "boom" } } } });
    await expect(supabaseRepository(err.db).getVoicePost(P)).rejects.toThrow("db_error");
    const bad = fakeDb({ tables: { calls: { data: { id: 5, family_id: F, person_id: P }, error: null } } });
    await expect(supabaseRepository(bad.db).getCall(P)).rejects.toThrow("bad_row");
  });
  it("maps consent rows, filters history by family, person and purpose", async () => {
    const row = { id: "c1", family_id: F, person_id: P, call_id: null, purpose: "call_recording", answer: true, version: "v1", created_at: "2026-11-01T00:00:00Z" };
    const { db, calls } = fakeDb({ tables: { consents: { data: [row, { ...row, id: "c2", answer: "yes" }], error: null } } });
    const out = await supabaseRepository(db).listConsentHistory(F, P, "call_recording");
    expect(out.map((c) => [c.id, c.answer, c.callId])).toEqual([["c1", true, null], ["c2", false, null]]); // non-boolean is never an affirmative
    const ops = opsOf(calls, "consents");
    expect(ops).toContainEqual(["eq", "family_id", F]);
    expect(ops).toContainEqual(["eq", "person_id", P]);
    expect(ops).toContainEqual(["eq", "purpose", "call_recording"]);
    await expect(supabaseRepository(fakeDb({ tables: { consents: { data: null, error: { message: "x" } } } }).db).listConsentHistory(F, P, "p")).rejects.toThrow("db_error");
  });
  it("rejects non-uuid or oversized filter values before querying", async () => {
    const { db, calls } = fakeDb();
    const repo = supabaseRepository(db);
    await expect(repo.listConsentHistory("x,or=(1=1)", P, "p")).rejects.toThrow("bad_filter");
    await expect(repo.listConsentHistory(F, P, "p", "not-a-uuid")).rejects.toThrow("bad_filter");
    await expect(repo.listConsentHistory(F, P, "x".repeat(201))).rejects.toThrow("bad_filter");
    expect(calls).toEqual([]);
  });
  it("calls the voice metadata RPC with exact arguments and maps the object", async () => {
    const { db, calls } = fakeDb({ rpc: { get_voice_media_metadata: { data: { family_id: F, voice_post_id: P, object_path: `${F}/a.mp3`, expires_at: "2026-12-01T00:00:00Z" }, error: null } } });
    expect(await supabaseRepository(db).getVoiceContent(F, P)).toEqual({ familyId: F, voicePostId: P, objectPath: `${F}/a.mp3`, expiresAt: "2026-12-01T00:00:00Z" });
    expect(calls.find((c) => c.rpc)!.rpc).toEqual(["get_voice_media_metadata", { p_family_id: F, p_post_id: P }]);
    expect(calls.some((c) => c.table)).toBe(false); // never reads sahaj_private through PostgREST tables
  });
  it("calls the call metadata RPC with exact arguments and maps nullable recording path", async () => {
    const C = "00000000-0000-4000-8000-000000000031";
    const { db, calls } = fakeDb({ rpc: { get_call_media_metadata: { data: { family_id: F, call_id: C, consent_id: P, recording_object_path: null, expires_at: "2026-12-01T00:00:00Z" }, error: null } } });
    expect(await supabaseRepository(db).getCallContent(F, C)).toMatchObject({ callId: C, consentId: P, recordingObjectPath: null });
    expect(calls.find((c) => c.rpc)!.rpc).toEqual(["get_call_media_metadata", { p_family_id: F, p_call_id: C }]);
  });
  it("treats RPC null as absent and fails closed on missing function, mismatched or malformed results", async () => {
    const none = fakeDb({ rpc: { get_voice_media_metadata: { data: null, error: null } } });
    expect(await supabaseRepository(none.db).getVoiceContent(F, P)).toBeNull();
    await expect(supabaseRepository(fakeDb().db).getVoiceContent(F, P)).rejects.toThrow("db_error"); // RPC not yet applied
    const other = "00000000-0000-4000-8000-000000000002";
    const wrongFamily = fakeDb({ rpc: { get_voice_media_metadata: { data: { family_id: other, voice_post_id: P, object_path: "x", expires_at: "t" }, error: null } } });
    await expect(supabaseRepository(wrongFamily.db).getVoiceContent(F, P)).rejects.toThrow("bad_row");
    const wrongPost = fakeDb({ rpc: { get_call_media_metadata: { data: { family_id: F, call_id: other, consent_id: P, recording_object_path: "x", expires_at: "t" }, error: null } } });
    await expect(supabaseRepository(wrongPost.db).getCallContent(F, P)).rejects.toThrow("bad_row");
    for (const data of [[], "str", 5]) {
      await expect(supabaseRepository(fakeDb({ rpc: { get_voice_media_metadata: { data, error: null } } }).db).getVoiceContent(F, P)).rejects.toThrow("bad_row");
    }
  });
});

describe("supabaseStorage", () => {
  it("maps camelized storage.info size and contentType and passes bucket and path", async () => {
    const { db, calls } = fakeDb({ info: { data: { size: 123, contentType: "audio/mpeg", name: "a" }, error: null } });
    expect(await supabaseStorage(db).stat("sahaj-voice", `${F}/a.mp3`)).toEqual({ size: 123, contentType: "audio/mpeg" });
    expect(calls[0].storage).toEqual([["info", "sahaj-voice", `${F}/a.mp3`]]);
  });
  it("returns null for errors, snake_case or incomplete metadata and unknown buckets", async () => {
    expect(await supabaseStorage(fakeDb().db).stat("sahaj-voice", "p")).toBeNull();
    expect(await supabaseStorage(fakeDb({ info: { data: { size: 1, content_type: "audio/mpeg" }, error: null } }).db).stat("sahaj-voice", "p")).toBeNull();
    const { db, calls } = fakeDb({ info: { data: { size: 1, contentType: "audio/mpeg" }, error: null } });
    expect(await supabaseStorage(db).stat("public" as never, "p")).toBeNull();
    expect(calls).toEqual([]);
  });
  it("signs with the given lifetime and returns null on failure or unknown bucket", async () => {
    const { db, calls } = fakeDb({ signed: { data: { signedUrl: "https://storage.invalid/s" }, error: null } });
    expect(await supabaseStorage(db).createSignedUrl("sahaj-recordings", `${F}/a.ogg`, 42)).toBe("https://storage.invalid/s");
    expect(calls[0].storage).toEqual([["sign", "sahaj-recordings", `${F}/a.ogg`, 42]]);
    expect(await supabaseStorage(fakeDb().db).createSignedUrl("sahaj-voice", "p", 1)).toBeNull();
    expect(await supabaseStorage(db).createSignedUrl("other" as never, "p", 1)).toBeNull();
  });
});

describe("default production wiring", () => {
  it("throws when server configuration is missing", () => {
    vi.stubEnv("SUPABASE_URL", ""); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(() => defaultMediaDeps()).toThrow();
  });
  it("denies every media authorization until a real adapter is configured", async () => {
    vi.stubEnv("SUPABASE_URL", "https://project.invalid"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-not-a-key");
    const deps = defaultMediaDeps();
    const ctx = { action: "read_voice_media", familyId: F } as never;
    expect(await deps.authorizeMedia(ctx)).toBe("deny");
  });
});

describe("call-scoped consent history queries", () => {
  const A = "00000000-0000-4000-8000-0000000000a1", B = "00000000-0000-4000-8000-0000000000b1";
  const row = (i: number, o: Record<string, unknown>) => ({ id: `c${i}`, family_id: F, person_id: P, call_id: A, purpose: "call_recording", answer: true, version: "v1", created_at: new Date(Date.UTC(2026, 10, 1) + i * 1000).toISOString(), ...o });
  const many = Array.from({ length: CONSENT_HISTORY_LIMIT + 50 }, (_, i) => row(1000 + i, { id: `other${i}`, call_id: B }));
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

  it("an old call-A grant is still returned when 250 newer unrelated call grants exist", async () => {
    const { db } = fakeDb({ rows: { consents: [row(1, { id: "A-yes" }), ...many] } });
    expect(ids(await supabaseRepository(db).listConsentHistory(F, P, "call_recording", A))).toEqual(["A-yes"]);
  });
  it("loads exact call rows and global refusals only, never global grants or other calls", async () => {
    const { db, calls } = fakeDb({ rows: { consents: [
      row(1, { id: "A-yes" }), row(2, { id: "A-no", answer: false }), row(3, { id: "G-no", call_id: null, answer: false }),
      row(4, { id: "G-yes", call_id: null }), row(5, { id: "B-yes", call_id: B }),
      row(6, { id: "other-person", person_id: B }), row(7, { id: "other-purpose", purpose: "x" }), row(8, { id: "other-family", family_id: B }),
    ] } });
    expect(ids(await supabaseRepository(db).listConsentHistory(F, P, "call_recording", A))).toEqual(["A-no", "A-yes", "G-no"]);
    const queries = calls.filter((c) => c.table === "consents");
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.ops).toContainEqual(["eq", "family_id", F]);
      expect(q.ops).toContainEqual(["eq", "person_id", P]);
      expect(q.ops).toContainEqual(["eq", "purpose", "call_recording"]);
    }
  });
  it("fails closed when a result page is full (possible truncation)", async () => {
    const rows = Array.from({ length: CONSENT_HISTORY_LIMIT }, (_, i) => row(i, { id: `a${i}` }));
    await expect(supabaseRepository(fakeDb({ rows: { consents: rows } }).db).listConsentHistory(F, P, "call_recording", A)).rejects.toThrow("history_truncated");
    await expect(supabaseRepository(fakeDb({ rows: { consents: rows.map((r) => ({ ...r, call_id: null })) } }).db).listConsentHistory(F, P, "call_recording")).rejects.toThrow("history_truncated");
  });
  it("unscoped (voice) history still filters by family, person and purpose only", async () => {
    const { db } = fakeDb({ rows: { consents: [row(1, { id: "v1", purpose: "voice_share:x", call_id: B }), row(2, { id: "v2", purpose: "voice_share:x", call_id: null }), row(3, { id: "z", purpose: "other" })] } });
    expect(ids(await supabaseRepository(db).listConsentHistory(F, P, "voice_share:x"))).toEqual(["v1", "v2"]);
  });
});