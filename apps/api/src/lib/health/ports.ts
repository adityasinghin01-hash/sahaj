import { createClient } from "@supabase/supabase-js";
import type { DatabaseProbeResult, ReadinessDependencies } from "./types";

/**
 * Checks if database credentials are present in the environment.
 */
export function isRealDatabaseConfigured(): boolean {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Boolean(url && url.trim().length > 0 && key && key.trim().length > 0);
}

/**
 * Expected response contract for the service-only public.foundation_readiness() RPC.
 */
export interface FoundationReadinessPayload {
  database: "connected";
  schema_ready: boolean;
  schema_version: "foundation-v4";
}

/**
 * Probes the connected Supabase instance using the service-only public.foundation_readiness() RPC.
 * Uses bounded Supabase abortSignal plus an independent deadline.
 * Consumes the exact JSON contract defensively, treating missing RPC, malformed responses,
 * and false schema as 503 missing_schema.
 * Recognizes SDK abort {error} responses as timeout.
 * Never queries or exposes private schemas directly.
 */
export async function probeRealDatabase(
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<DatabaseProbeResult> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return {
      ok: false,
      status: "not_configured",
      code: "database_not_configured"
    };
  }

  if (externalSignal?.aborted) {
    return {
      ok: false,
      status: "timeout",
      code: "database_timeout",
      latencyMs: 0
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let onExternalAbort: (() => void) | undefined;
  if (externalSignal) {
    onExternalAbort = () => controller.abort();
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const startTime = Date.now();

  try {
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const response = await supabase
      .rpc("foundation_readiness")
      .abortSignal(controller.signal);

    const latencyMs = Date.now() - startTime;

    // Check for abort/timeout in SDK error response
    const isTimeout =
      controller.signal.aborted ||
      Boolean(externalSignal?.aborted) ||
      response.error?.name === "AbortError" ||
      Boolean(response.error?.message?.toLowerCase().includes("abort")) ||
      response.error?.code === "20" ||
      response.error?.code === "ABORT_ERR";

    if (isTimeout) {
      return {
        ok: false,
        status: "timeout",
        code: "database_timeout",
        latencyMs
      };
    }

    if (response.error) {
      const errStr = `${response.error.message || ""} ${response.error.details || ""} ${response.error.code || ""}`.toLowerCase();

      // Check for missing RPC (PostgreSQL 42883 or PostgREST PGRST202: function not found)
      const isMissingRpc =
        response.error.code === "42883" ||
        response.error.code === "PGRST202" ||
        errStr.includes("does not exist") ||
        errStr.includes("could not find the function");

      if (isMissingRpc) {
        return {
          ok: false,
          status: "missing_schema",
          code: "schema_missing",
          schemaOk: false,
          latencyMs
        };
      }

      // Check for connection / unreachable errors
      const isUnreachable =
        response.error.code === "ECONNREFUSED" ||
        errStr.includes("econnrefused") ||
        errStr.includes("connection") ||
        errStr.includes("fetch failed");

      if (isUnreachable) {
        return {
          ok: false,
          status: "unreachable",
          code: "database_unreachable",
          latencyMs
        };
      }

      return {
        ok: false,
        status: "unhealthy",
        code: "database_error",
        latencyMs
      };
    }

    // Parse and defensively validate RPC response
    let payload = response.data as unknown;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return {
          ok: false,
          status: "missing_schema",
          code: "schema_missing",
          schemaOk: false,
          latencyMs
        };
      }
    }

    const validObject =
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload);

    if (!validObject) {
      return {
        ok: false,
        status: "missing_schema",
        code: "schema_missing",
        schemaOk: false,
        latencyMs
      };
    }

    const record = payload as Record<string, unknown>;

    if (
      record.database !== "connected" ||
      typeof record.schema_ready !== "boolean" ||
      record.schema_version !== "foundation-v4"
    ) {
      return {
        ok: false,
        status: "missing_schema",
        code: "schema_missing",
        schemaOk: false,
        latencyMs
      };
    }

    if (record.schema_ready !== true) {
      return {
        ok: false,
        status: "missing_schema",
        code: "schema_missing",
        schemaOk: false,
        latencyMs
      };
    }

    return {
      ok: true,
      status: "connected",
      latencyMs,
      schemaOk: true
    };
  } catch (err: unknown) {
    const latencyMs = Date.now() - startTime;
    const isAbort =
      controller.signal.aborted ||
      Boolean(externalSignal?.aborted) ||
      (err instanceof Error &&
        (err.name === "AbortError" || err.message.toLowerCase().includes("abort")));

    if (isAbort) {
      return {
        ok: false,
        status: "timeout",
        code: "database_timeout",
        latencyMs
      };
    }

    return {
      ok: false,
      status: "unreachable",
      code: "database_unreachable",
      latencyMs
    };
  } finally {
    clearTimeout(timer);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * Production dependency ports for readiness checking.
 */
export const defaultReadinessDependencies: ReadinessDependencies = {
  isConfigured: isRealDatabaseConfigured,
  probeDatabase: probeRealDatabase
};
