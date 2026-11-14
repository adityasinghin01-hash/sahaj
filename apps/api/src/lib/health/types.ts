export type ProbeType = "liveness" | "readiness";

export type DatabaseStatus =
  | "connected"
  | "not_configured"
  | "unreachable"
  | "timeout"
  | "missing_schema"
  | "unhealthy";

export type DatabaseErrorCode =
  | "database_not_configured"
  | "database_unreachable"
  | "database_timeout"
  | "schema_missing"
  | "database_error";

export interface DatabaseProbeResult {
  ok: boolean;
  status: DatabaseStatus;
  latencyMs?: number;
  schemaOk?: boolean;
  code?: DatabaseErrorCode;
}

export interface ReadinessDependencies {
  isConfigured: () => boolean;
  probeDatabase: (timeoutMs: number, abortSignal?: AbortSignal) => Promise<DatabaseProbeResult>;
}

export interface HealthResponse {
  ok: boolean;
  status: "pass" | "ready" | "degraded";
  service: "sahaj-core1-api";
  stage: "phase-1-foundation";
  probe: ProbeType;
  database?: {
    status: DatabaseStatus;
    latency_ms?: number;
    schema?: "present" | "missing";
    code?: DatabaseErrorCode;
  };
  voice: "disabled";
  care_actions: "disabled";
  emergency_ready: false;
  timestamp: string;
}

export interface HealthCheckResult {
  httpStatus: number;
  body: HealthResponse;
}
