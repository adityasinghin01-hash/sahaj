import { NextResponse } from "next/server";
import { evaluateLiveness } from "../../../lib/health/liveness";
import { evaluateReadiness } from "../../../lib/health/readiness";
import { defaultReadinessDependencies } from "../../../lib/health/ports";

export const runtime = "nodejs";

/**
 * Health endpoint for Sahaj Core 1 API.
 * - Liveness probe: returns 200 when requested via ?probe=liveness (or ?probe=live)
 * - Readiness probe (default or ?probe=readiness): verifies configuration, database connection,
 *   and schema readiness through bounded injected ports. Returns 200 if ready, 503 if not ready.
 * - Never returns credentials, tenant identifiers, or database errors.
 * - All responses are marked with Cache-Control: no-store.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const probe = url.searchParams.get("probe") || url.searchParams.get("check");

  if (probe === "liveness" || probe === "live") {
    const liveness = evaluateLiveness();
    return NextResponse.json(liveness.body, {
      status: liveness.httpStatus,
      headers: { "Cache-Control": "no-store" }
    });
  }

  const readiness = await evaluateReadiness(defaultReadinessDependencies, {
    abortSignal: req.signal
  });
  return NextResponse.json(readiness.body, {
    status: readiness.httpStatus,
    headers: { "Cache-Control": "no-store" }
  });
}
