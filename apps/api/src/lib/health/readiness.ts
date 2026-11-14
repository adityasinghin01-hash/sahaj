import type {
  ReadinessDependencies,
  HealthCheckResult,
  HealthResponse,
  DatabaseProbeResult,
  DatabaseStatus,
  DatabaseErrorCode
} from "./types";

export const DEFAULT_DATABASE_TIMEOUT_MS = 3000;

/**
 * Bounded readiness evaluation.
 * Injected ports verify configuration, database connectivity, and required schema.
 * Enforces an independent bounded deadline even if the dependency ignores its timeout or never settles.
 * Distinguishes liveness (200) from readiness failure (503).
 * Never exposes credentials, tenant identifiers, or raw database errors.
 */
export async function evaluateReadiness(
  deps: ReadinessDependencies,
  options?: { timeoutMs?: number; now?: () => Date; abortSignal?: AbortSignal }
): Promise<HealthCheckResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DATABASE_TIMEOUT_MS;
  const now = options?.now ? options.now() : new Date();

  // If external abort signal is already aborted
  if (options?.abortSignal?.aborted) {
    const body: HealthResponse = {
      ok: false,
      status: "degraded",
      service: "sahaj-core1-api",
      stage: "phase-1-foundation",
      probe: "readiness",
      database: {
        status: "timeout",
        code: "database_timeout"
      },
      voice: "disabled",
      care_actions: "disabled",
      emergency_ready: false,
      timestamp: now.toISOString()
    };
    return { httpStatus: 503, body };
  }

  // 1. Dependency check: Configuration (fail safely on exceptions)
  let isConfigured = false;
  try {
    isConfigured = Boolean(deps.isConfigured());
  } catch {
    isConfigured = false;
  }

  if (!isConfigured) {
    const body: HealthResponse = {
      ok: false,
      status: "degraded",
      service: "sahaj-core1-api",
      stage: "phase-1-foundation",
      probe: "readiness",
      database: {
        status: "not_configured",
        code: "database_not_configured"
      },
      voice: "disabled",
      care_actions: "disabled",
      emergency_ready: false,
      timestamp: now.toISOString()
    };
    return { httpStatus: 503, body };
  }

  // 2. Bounded probe execution with independent deadline and timer clearance
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;

  let probe: DatabaseProbeResult;
  try {
    const deadlinePromise = new Promise<DatabaseProbeResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({
          ok: false,
          status: "timeout",
          code: "database_timeout"
        });
      }, timeoutMs);

      if (options?.abortSignal) {
        onExternalAbort = () => {
          controller.abort();
          resolve({
            ok: false,
            status: "timeout",
            code: "database_timeout"
          });
        };
        options.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    });

    const probePromise = deps.probeDatabase(timeoutMs, controller.signal);

    probe = await Promise.race([probePromise, deadlinePromise]);
  } catch {
    probe = {
      ok: false,
      status: "unhealthy",
      code: "database_error"
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (options?.abortSignal && onExternalAbort) {
      options.abortSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  // 3. Evaluate probe result: requires ok === true, status === "connected", and schemaOk === true
  const isReady = probe.ok === true && probe.status === "connected" && probe.schemaOk === true;

  if (!isReady) {
    const isMissingSchema = probe.schemaOk === false || probe.status === "missing_schema";
    const dbStatus: DatabaseStatus = isMissingSchema ? "missing_schema" : probe.status;
    const dbCode: DatabaseErrorCode = isMissingSchema
      ? "schema_missing"
      : (probe.code ?? "database_error");

    const body: HealthResponse = {
      ok: false,
      status: "degraded",
      service: "sahaj-core1-api",
      stage: "phase-1-foundation",
      probe: "readiness",
      database: {
        status: dbStatus,
        code: dbCode,
        ...(probe.latencyMs !== undefined ? { latency_ms: probe.latencyMs } : {})
      },
      voice: "disabled",
      care_actions: "disabled",
      emergency_ready: false,
      timestamp: now.toISOString()
    };
    return { httpStatus: 503, body };
  }

  // 4. Healthy: Connected and schema verified
  const body: HealthResponse = {
    ok: true,
    status: "ready",
    service: "sahaj-core1-api",
    stage: "phase-1-foundation",
    probe: "readiness",
    database: {
      status: "connected",
      latency_ms: probe.latencyMs ?? 0,
      schema: "present"
    },
    voice: "disabled",
    care_actions: "disabled",
    emergency_ready: false,
    timestamp: now.toISOString()
  };
  return { httpStatus: 200, body };
}
