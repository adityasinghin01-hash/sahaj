import { createHash, timingSafeEqual } from "node:crypto";

/** Avoid short-circuit plaintext comparisons for tokens supplied over the network. */
export function safeTokenEquals(actual: string | null | undefined, expected: string | null | undefined): boolean {
  if (!actual || !expected) return false;
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function bearerToken(request: Request): string | undefined {
  const value = request.headers.get("authorization");
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}
