import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export class AppHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}
export interface AppMember {
  family_id: string;
  user_id: string;
  person_id: string | null;
  role: string;
}
const Claims = z.object({
  sub: z.string().uuid(),
  exp: z.number().int(),
  role: z.literal("authenticated"),
  nbf: z.number().optional(),
});
export function verifyAppToken(
  req: Request,
  secret: string | undefined,
  now = Date.now(),
): string {
  if (!secret || secret.length < 32)
    throw new AppHttpError(500, "auth_not_configured");
  const token =
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
      req.headers.get("authorization") ?? "",
    )?.[1];
  if (!token || token.length > 8192)
    throw new AppHttpError(401, "unauthorized");
  try {
    const [head, body, sig] = token.split(".") as [string, string, string];
    const header = JSON.parse(Buffer.from(head, "base64url").toString());
    if (header.alg !== "HS256" || header.crit) throw new Error();
    const expected = createHmac("sha256", secret)
      .update(`${head}.${body}`)
      .digest();
    const actual = Buffer.from(sig, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error();
    const claims = Claims.parse(
      JSON.parse(Buffer.from(body, "base64url").toString()),
    );
    if (
      claims.exp <= now / 1000 ||
      (claims.nbf !== undefined && claims.nbf > now / 1000)
    )
      throw new Error();
    return claims.sub;
  } catch {
    throw new AppHttpError(401, "unauthorized");
  }
}
export async function requireAppMember(
  req: Request,
  secret: string | undefined,
  memberships: (userId: string) => Promise<AppMember[]>,
): Promise<AppMember> {
  const userId = verifyAppToken(req, secret);
  const members = await memberships(userId);
  const selected =
    req.headers.get("x-family-id") ??
    new URL(req.url).searchParams.get("family_id");
  if (selected && !z.string().uuid().safeParse(selected).success)
    throw new AppHttpError(400, "invalid_family");
  const member = selected
    ? members.find((m) => m.family_id === selected)
    : members.length === 1
      ? members[0]
      : undefined;
  if (!member)
    throw new AppHttpError(
      403,
      members.length > 1 && !selected ? "select_family" : "family_forbidden",
    );
  return member;
}
export function requireChild(member: AppMember) {
  if (member.role !== "child")
    throw new AppHttpError(403, "child_access_required");
}
