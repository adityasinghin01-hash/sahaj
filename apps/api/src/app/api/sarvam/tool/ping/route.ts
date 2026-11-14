import { NextResponse } from "next/server";
import { bearerToken, safeTokenEquals } from "@/lib/secrets";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const secret = process.env.SARVAM_TOOL_BEARER;
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (!safeTokenEquals(bearerToken(request), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ reply: "pong", stage: "test-only" });
}
