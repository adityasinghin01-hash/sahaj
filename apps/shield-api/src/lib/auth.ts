import { timingSafeEqual } from "node:crypto";

export const SARVAM_ALLOWED_IPS = new Set(["4.213.167.70", "35.154.84.150"]);

export function constantTimeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still run timingSafeEqual on equal-length buffer to avoid early-return timing leak on length.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function verifyHeaderToken(req: Request, headerName: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const actual = req.headers.get(headerName);
  if (!actual) return false;
  return constantTimeEqual(actual, expected);
}

export function verifyBearerToken(req: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!match?.[1]) return false;
  return constantTimeEqual(match[1].trim(), expected);
}

function normalizeIp(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

export function extractClientIp(req: Request): string | null {
  const realIp = req.headers.get("x-real-ip");
  if (realIp && realIp.trim().length > 0) return normalizeIp(realIp);

  const vercelFwd = req.headers.get("x-vercel-forwarded-for");
  if (vercelFwd) {
    const first = vercelFwd.split(",")[0]?.trim();
    if (first) return normalizeIp(first);
  }

  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return null;
}

export function isAllowedSarvamIp(req: Request, env: Readonly<Record<string, string | undefined>>): boolean {
  if (env.ALLOW_ANY_TOOL_IP === "1") return true;
  const ip = extractClientIp(req);
  return ip !== null && SARVAM_ALLOWED_IPS.has(ip);
}

