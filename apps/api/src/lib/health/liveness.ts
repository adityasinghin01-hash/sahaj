import type { HealthCheckResult } from "./types";

/**
 * Liveness evaluation.
 * Confirms that the API process is alive and receiving traffic.
 * Always returns HTTP 200 without querying downstream dependencies.
 */
export function evaluateLiveness(options?: { now?: () => Date }): HealthCheckResult {
  const now = options?.now ? options.now() : new Date();
  return {
    httpStatus: 200,
    body: {
      ok: true,
      status: "pass",
      service: "sahaj-core1-api",
      stage: "phase-1-foundation",
      probe: "liveness",
      voice: "disabled",
      care_actions: "disabled",
      emergency_ready: false,
      timestamp: now.toISOString()
    }
  };
}
