import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { labAuthConfig, LabModeConfigError, verifyLabJwt } from "@/lib/lab-auth";
import { serviceDatabase } from "@/lib/database";
import { supabaseAuth } from "@/lib/media/supabase";
import { createDefaultAuthPort } from "@/lib/core1/handler";
import { Core1CommandError } from "@/lib/core1/errors";
import { WebhookError } from "@/lib/webhook-security";

const SECRET = "lab-only-test-secret-".padEnd(40, "x");
const USER = "33333333-3333-4333-8333-333333333332";
const LOCAL_URL = "http://127.0.0.1:3203";

function b64(obj: unknown) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function mint(claims: Record<string, unknown>, secret = SECRET, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }) {
  const data = `${b64(header)}.${b64(claims)}`;
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}
const now = () => Math.floor(Date.now() / 1000);
const good = () => mint({ sub: USER, role: "authenticated", iat: now(), exp: now() + 600 });

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // Production auth would call the Supabase Auth server; tests never reach the network.
  fetchSpy = vi.fn(async () => new Response(JSON.stringify({ msg: "invalid JWT" }), { status: 401, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("SUPABASE_URL", LOCAL_URL);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  vi.stubEnv("SUPABASE_JWT_SECRET", SECRET);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("labAuthConfig", () => {
  it("is off unless SAHAJ_LAB_MODE is exactly 1", () => {
    expect(labAuthConfig({ SUPABASE_URL: LOCAL_URL, SUPABASE_JWT_SECRET: SECRET })).toEqual({ enabled: false });
    expect(labAuthConfig({ SAHAJ_LAB_MODE: "0", SUPABASE_URL: LOCAL_URL, SUPABASE_JWT_SECRET: SECRET })).toEqual({ enabled: false });
    expect(() => labAuthConfig({ SAHAJ_LAB_MODE: "true", SUPABASE_URL: LOCAL_URL, SUPABASE_JWT_SECRET: SECRET })).toThrow(LabModeConfigError);
    expect(labAuthConfig({ SAHAJ_LAB_MODE: "1", SUPABASE_URL: LOCAL_URL, SUPABASE_JWT_SECRET: SECRET })).toEqual({ enabled: true, secret: SECRET });
  });
  it("refuses a short secret or a non-loopback database", () => {
    expect(() => labAuthConfig({ SAHAJ_LAB_MODE: "1", SUPABASE_URL: LOCAL_URL, SUPABASE_JWT_SECRET: "short" })).toThrow("lab_mode_secret_missing");
    for (const url of ["https://abc.supabase.co", "http://10.0.0.5:3000", "not a url", ""]) {
      expect(() => labAuthConfig({ SAHAJ_LAB_MODE: "1", SUPABASE_URL: url, SUPABASE_JWT_SECRET: SECRET })).toThrow("lab_mode_requires_loopback_database");
    }
  });
});

describe("verifyLabJwt", () => {
  it("accepts a token minted like apps/shield-api/scripts/mint-lab-token.mjs", () => {
    expect(verifyLabJwt(good(), SECRET)).toEqual({ userId: USER });
  });
  it("rejects wrong secret, expiry, nbf, alg, role, sub and malformed input", () => {
    const t = now();
    const bad = [
      mint({ sub: USER, role: "authenticated", exp: t + 600 }, "another-secret-".padEnd(40, "y")),
      mint({ sub: USER, role: "authenticated", exp: t - 1 }),
      mint({ sub: USER, role: "authenticated", exp: t + 600, nbf: t + 300 }),
      mint({ sub: USER, role: "authenticated", exp: t + 600 }, SECRET, { alg: "none" }),
      mint({ sub: USER, role: "authenticated", exp: t + 600 }, SECRET, { alg: "HS256", crit: ["x"] }),
      mint({ sub: USER, role: "service_role", exp: t + 600 }),
      mint({ sub: "not-a-uuid", role: "authenticated", exp: t + 600 }),
      mint({ sub: USER, role: "authenticated" }),
      "a.b.c",
      "",
      good().slice(0, -2),
    ];
    for (const token of bad) expect(verifyLabJwt(token, SECRET)).toBeNull();
  });
});

describe("serviceDatabase auth in production mode (flag unset)", () => {
  it("still asks the Supabase Auth server and never accepts a locally signed token", async () => {
    const db = serviceDatabase();
    const { data, error } = await db.auth.getUser(good());
    expect(error).not.toBeNull();
    expect(data.user).toBeNull();
    expect(fetchSpy).toHaveBeenCalled();
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(`${LOCAL_URL}/auth/v1/user`);
    expect(await supabaseAuth(db).verifyBearer(good())).toBeNull();
    await expect(createDefaultAuthPort().getUser(good())).rejects.toBeInstanceOf(Core1CommandError);
  });
});

describe("serviceDatabase auth in lab mode (SAHAJ_LAB_MODE=1)", () => {
  beforeEach(() => vi.stubEnv("SAHAJ_LAB_MODE", "1"));

  it("verifies the lab JWT locally for Core 1, Core 2 and media AuthPorts without any network call", async () => {
    const db = serviceDatabase();
    const { data, error } = await db.auth.getUser(good());
    expect(error).toBeNull();
    expect(data.user?.id).toBe(USER);
    expect(await supabaseAuth(db).verifyBearer(good())).toEqual({ userId: USER });
    expect((await createDefaultAuthPort().getUser(good())).id).toBe(USER);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects bad tokens the same way production does", async () => {
    const db = serviceDatabase();
    const expired = mint({ sub: USER, role: "authenticated", exp: now() - 5 });
    expect((await db.auth.getUser(expired)).data.user).toBeNull();
    expect(await supabaseAuth(db).verifyBearer("garbage")).toBeNull();
    await expect(createDefaultAuthPort().getUser(expired)).rejects.toMatchObject({ code: "unauthorized_invalid_bearer_token", status: 401 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the flag is set against a hosted database", () => {
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.co");
    expect(() => serviceDatabase()).toThrow(WebhookError);
    try {
      serviceDatabase();
    } catch (error) {
      expect(error).toMatchObject({ code: "lab_mode_misconfigured", status: 503 });
    }
  });
});
