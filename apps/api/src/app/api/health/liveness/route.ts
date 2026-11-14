import { NextResponse } from "next/server";
import { evaluateLiveness } from "../../../../lib/health/liveness";

export const runtime = "nodejs";

/**
 * Dedicated liveness endpoint.
 * Returns HTTP 200 to confirm that the server process is alive and receiving traffic.
 */
export async function GET() {
  const liveness = evaluateLiveness();
  return NextResponse.json(liveness.body, {
    status: liveness.httpStatus,
    headers: { "Cache-Control": "no-store" }
  });
}
