import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * Lab-only login for apps/api.
 *
 * Production verifies every bearer with Supabase Auth (`auth.getUser`). The local lab has plain Postgres and no Auth
 * server, so with SAHAJ_LAB_MODE=1 the service client's `auth.getUser` is replaced by a local HS256 check of the same
 * tokens @sahaj/shield-api and the phone apps already use (signed with SUPABASE_JWT_SECRET,
 * apps/shield-api/scripts/mint-lab-token.mjs).
 *
 * Fail closed: lab mode only switches on with the exact flag "1", a secret of at least 32 characters and a loopback
 * SUPABASE_URL. Any other combination with the flag set throws, so a hosted deployment can never accept self-signed
 * tokens by accident. Without the flag nothing changes.
 */
export const LAB_MODE_ENV = "SAHAJ_LAB_MODE";

type Env = Readonly<Record<string, string | undefined>>;
export type LabAuthConfig = { enabled: false } | { enabled: true; secret: string };

export class LabModeConfigError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "LabModeConfigError";
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function labAuthConfig(env: Env = process.env): LabAuthConfig {
  const flag = env[LAB_MODE_ENV];
  if (flag === undefined || flag === "" || flag === "0") return { enabled: false };
  if (flag !== "1") throw new LabModeConfigError("lab_mode_flag_invalid");
  const secret = env.SUPABASE_JWT_SECRET;
  if (!secret || secret.length < 32) throw new LabModeConfigError("lab_mode_secret_missing");
  let host: string;
  try {
    host = new URL(env.SUPABASE_URL ?? "").hostname;
  } catch {
    throw new LabModeConfigError("lab_mode_requires_loopback_database");
  }
  if (!LOOPBACK.has(host)) throw new LabModeConfigError("lab_mode_requires_loopback_database");
  return { enabled: true, secret };
}

function decodeJson(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bad_part");
  return value as Record<string, unknown>;
}

/** Same rules as apps/shield-api verifyAppToken: HS256 only, valid signature, uuid sub, role authenticated, exp/nbf. */
export function verifyLabJwt(token: string, secret: string, nowMs = Date.now()): { userId: string } | null {
  if (typeof token !== "string" || token.length > 8192 || !TOKEN_RE.test(token)) return null;
  if (!secret || secret.length < 32) return null;
  try {
    const [head, body, sig] = token.split(".") as [string, string, string];
    const header = decodeJson(head);
    if (header.alg !== "HS256" || header.crit !== undefined) return null;
    const expected = createHmac("sha256", secret).update(`${head}.${body}`).digest();
    const actual = Buffer.from(sig, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const claims = decodeJson(body);
    const now = nowMs / 1000;
    if (typeof claims.sub !== "string" || !UUID_RE.test(claims.sub)) return null;
    if (claims.role !== "authenticated") return null;
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now) return null;
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now)) return null;
    return { userId: claims.sub.toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Returns the client unchanged unless lab mode is on. In lab mode only `auth.getUser(token)` is replaced; database
 * calls still go through the same client (PostgREST in front of the lab Postgres).
 */
export function applyLabAuth<T extends SupabaseClient>(client: T, env: Env = process.env): T {
  const config = labAuthConfig(env);
  if (!config.enabled) return client;
  const secret = config.secret;
  const getUser = async (jwt?: string) => {
    const verified = jwt ? verifyLabJwt(jwt, secret) : null;
    if (!verified) {
      return { data: { user: null }, error: { name: "AuthApiError", message: "invalid_lab_token", status: 401 } };
    }
    const user = {
      id: verified.userId,
      aud: "authenticated",
      role: "authenticated",
      app_metadata: {},
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    } as User;
    return { data: { user }, error: null };
  };
  Object.defineProperty(client.auth, "getUser", { value: getUser, configurable: true, writable: true });
  return client;
}
