import { NextResponse } from "next/server";
import { evaluateReadiness } from "../../../../lib/health/readiness";
import { defaultReadinessDependencies } from "../../../../lib/health/ports";

export const runtime = "nodejs";

/**
 * Dedicated readiness endpoint.
 * Returns HTTP 200 when database and schema dependencies are ready; HTTP 503 otherwise.
 */
export async function GET(req?: Request) {
  const readiness = await evaluateReadiness(defaultReadinessDependencies, {
    abortSignal: req?.signal
  });
  return NextResponse.json(readiness.body, {
    status: readiness.httpStatus,
    headers: { "Cache-Control": "no-store" }
  });
}
