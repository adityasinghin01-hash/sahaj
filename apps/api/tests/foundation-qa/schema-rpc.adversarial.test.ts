import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { evaluateReadiness } from "../../src/lib/health/readiness";
import { probeRealDatabase, isRealDatabaseConfigured } from "../../src/lib/health/ports";
import type { ReadinessDependencies, DatabaseProbeResult } from "../../src/lib/health/types";

// Mock @supabase/supabase-js for adversarial RPC probing
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn()
}));

import { createClient } from "@supabase/supabase-js";

describe("Adversarial QA: Schema RPC Contract & Validation", () => {
  const originalEnv = { ...process.env };
  const fixedNow = new Date("2026-11-14T20:00:00.000Z");
  const defaultOptions = { timeoutMs: 1000, now: () => fixedNow };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("evaluateReadiness schemaOk requirement (Defect check on baseline 8133cf0)", () => {
    it("MUST return HTTP 503 degraded when probe.status is connected but schemaOk is false", async () => {
      // In baseline 8133cf0, evaluateReadiness checked (!probe.ok || probe.status !== 'connected'),
      // causing connected + schemaOk: false to incorrectly return HTTP 200 ready!
      const deps: ReadinessDependencies = {
        isConfigured: () => true,
        probeDatabase: vi.fn().mockResolvedValue({
          ok: true,
          status: "connected",
          schemaOk: false,
          latencyMs: 12
        } as DatabaseProbeResult)
      };

      const result = await evaluateReadiness(deps, defaultOptions);

      expect(result.httpStatus).toBe(503);
      expect(result.body.ok).toBe(false);
      expect(result.body.status).toBe("degraded");
      expect(result.body.database?.status).toBe("missing_schema");
      expect(result.body.database?.code).toBe("schema_missing");
    });

    it("MUST return HTTP 503 degraded when probe.status is connected but schemaOk is undefined", async () => {
      const deps: ReadinessDependencies = {
        isConfigured: () => true,
        probeDatabase: vi.fn().mockResolvedValue({
          ok: true,
          status: "connected",
          latencyMs: 10
        } as DatabaseProbeResult)
      };

      const result = await evaluateReadiness(deps, defaultOptions);

      expect(result.httpStatus).toBe(503);
      expect(result.body.ok).toBe(false);
      expect(result.body.status).toBe("degraded");
    });

    it("returns HTTP 200 ready ONLY when ok === true, status === 'connected', AND schemaOk === true", async () => {
      const deps: ReadinessDependencies = {
        isConfigured: () => true,
        probeDatabase: vi.fn().mockResolvedValue({
          ok: true,
          status: "connected",
          schemaOk: true,
          latencyMs: 15
        } as DatabaseProbeResult)
      };

      const result = await evaluateReadiness(deps, defaultOptions);

      expect(result.httpStatus).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.status).toBe("ready");
      expect(result.body.database?.status).toBe("connected");
      expect(result.body.database?.schema).toBe("present");
      expect(result.body.database?.latency_ms).toBe(15);
    });

    it("returns HTTP 503 degraded when probeDatabase returns missing_schema", async () => {
      const deps: ReadinessDependencies = {
        isConfigured: () => true,
        probeDatabase: vi.fn().mockResolvedValue({
          ok: false,
          status: "missing_schema",
          code: "schema_missing",
          schemaOk: false,
          latencyMs: 10
        } as DatabaseProbeResult)
      };

      const result = await evaluateReadiness(deps, defaultOptions);

      expect(result.httpStatus).toBe(503);
      expect(result.body.ok).toBe(false);
      expect(result.body.status).toBe("degraded");
      expect(result.body.database?.status).toBe("missing_schema");
      expect(result.body.database?.code).toBe("schema_missing");
    });
  });

  describe("probeRealDatabase: service-only foundation_readiness RPC contract", () => {
    beforeEach(() => {
      process.env.SUPABASE_URL = "https://synthetic.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";
    });

    it("calls service-only public.foundation_readiness RPC and succeeds with exact valid contract", async () => {
      const mockRpc = vi.fn().mockReturnValue({
        abortSignal: vi.fn().mockResolvedValue({
          data: {
            database: "connected",
            schema_ready: true,
            schema_version: "foundation-v4"
          },
          error: null
        })
      });

      vi.mocked(createClient).mockReturnValue({
        rpc: mockRpc
      } as unknown as ReturnType<typeof createClient>);

      const result = await probeRealDatabase(500);

      // In baseline 8133cf0, probeRealDatabase queried families table directly instead of rpc()
      expect(mockRpc).toHaveBeenCalledWith("foundation_readiness");
      expect(result.ok).toBe(true);
      expect(result.status).toBe("connected");
      expect(result.schemaOk).toBe(true);
    });

    it("accepts valid contract returned as stringified JSON", async () => {
      const mockRpc = vi.fn().mockReturnValue({
        abortSignal: vi.fn().mockResolvedValue({
          data: JSON.stringify({
            database: "connected",
            schema_ready: true,
            schema_version: "foundation-v4"
          }),
          error: null
        })
      });

      vi.mocked(createClient).mockReturnValue({
        rpc: mockRpc
      } as unknown as ReturnType<typeof createClient>);

      const result = await probeRealDatabase(500);

      expect(result.ok).toBe(true);
      expect(result.status).toBe("connected");
      expect(result.schemaOk).toBe(true);
    });

    it("adversarial: rejects RPC response with schema_ready = false as missing_schema", async () => {
      const mockRpc = vi.fn().mockReturnValue({
        abortSignal: vi.fn().mockResolvedValue({
          data: {
            database: "connected",
            schema_ready: false,
            schema_version: "foundation-v4"
          },
          error: null
        })
      });

      vi.mocked(createClient).mockReturnValue({
        rpc: mockRpc
      } as unknown as ReturnType<typeof createClient>);

      const result = await probeRealDatabase(500);

      expect(result.ok).toBe(false);
      expect(result.status).toBe("missing_schema");
      expect(result.code).toBe("schema_missing");
      expect(result.schemaOk).toBe(false);
    });

    it("adversarial: rejects RPC response with obsolete schema_version as missing_schema", async () => {
      const mockRpc = vi.fn().mockReturnValue({
        abortSignal: vi.fn().mockResolvedValue({
          data: {
            database: "connected",
            schema_ready: true,
            schema_version: "foundation-v3"
          },
          error: null
        })
      });

      vi.mocked(createClient).mockReturnValue({
        rpc: mockRpc
      } as unknown as ReturnType<typeof createClient>);

      const result = await probeRealDatabase(500);

      expect(result.ok).toBe(false);
      expect(result.status).toBe("missing_schema");
      expect(result.code).toBe("schema_missing");
      expect(result.schemaOk).toBe(false);
    });

    it("adversarial: rejects RPC response with wrong database status field", async () => {
      const mockRpc = vi.fn().mockReturnValue({
        abortSignal: vi.fn().mockResolvedValue({
          data: {
            database: "degraded",
            schema_ready: true,
            schema_version: "foundation-v4"
          },
          error: null
        })
      });

      vi.mocked(createClient).mockReturnValue({
        rpc: mockRpc
      } as unknown as ReturnType<typeof createClient>);

      const result = await probeRealDatabase(500);

      expect(result.ok).toBe(false);
      expect(result.status).toBe("missing_schema");
      expect(result.code).toBe("schema_missing");
      expect(result.schemaOk).toBe(false);
    });

    it("adversarial: rejects malformed unparseable JSON string from RPC", async () => {
      const mockRpc = vi.fn().mockReturnValue({
        abortSignal: vi.fn().mockResolvedValue({
          data: "<html>502 Bad Gateway</html>",
          error: null
        })
      });

      vi.mocked(createClient).mockReturnValue({
        rpc: mockRpc
      } as unknown as ReturnType<typeof createClient>);

      const result = await probeRealDatabase(500);

      expect(result.ok).toBe(false);
      expect(result.status).toBe("missing_schema");
      expect(result.code).toBe("schema_missing");
      expect(result.schemaOk).toBe(false);
    });

    it("adversarial: rejects primitive or null payloads from RPC", async () => {
      for (const payload of [null, undefined, 42, true, [], ["connected"]]) {
        const mockRpc = vi.fn().mockReturnValue({
          abortSignal: vi.fn().mockResolvedValue({
            data: payload,
            error: null
          })
        });

        vi.mocked(createClient).mockReturnValue({
          rpc: mockRpc
        } as unknown as ReturnType<typeof createClient>);

        const result = await probeRealDatabase(500);

        expect(result.ok).toBe(false);
        expect(result.status).toBe("missing_schema");
        expect(result.code).toBe("schema_missing");
        expect(result.schemaOk).toBe(false);
      }
    });

    it("adversarial: detects missing RPC (PostgreSQL 42883 or PGRST202) as missing_schema", async () => {
      const missingRpcErrors = [
        { code: "42883", message: "function foundation_readiness() does not exist" },
        { code: "PGRST202", message: "Could not find the function public.foundation_readiness" },
        { code: "PGRST100", message: "function does not exist in schema cache" }
      ];

      for (const err of missingRpcErrors) {
        const mockRpc = vi.fn().mockReturnValue({
          abortSignal: vi.fn().mockResolvedValue({
            data: null,
            error: err
          })
        });

        vi.mocked(createClient).mockReturnValue({
          rpc: mockRpc
        } as unknown as ReturnType<typeof createClient>);

        const result = await probeRealDatabase(500);

        expect(result.ok).toBe(false);
        expect(result.status).toBe("missing_schema");
        expect(result.code).toBe("schema_missing");
        expect(result.schemaOk).toBe(false);
      }
    });

    it("detects connection failures (ECONNREFUSED / fetch failed) as unreachable", async () => {
      const mockRpc = vi.fn().mockReturnValue({
        abortSignal: vi.fn().mockResolvedValue({
          data: null,
          error: { code: "ECONNREFUSED", message: "fetch failed to connect to host" }
        })
      });

      vi.mocked(createClient).mockReturnValue({
        rpc: mockRpc
      } as unknown as ReturnType<typeof createClient>);

      const result = await probeRealDatabase(500);

      expect(result.ok).toBe(false);
      expect(result.status).toBe("unreachable");
      expect(result.code).toBe("database_unreachable");
    });
  });
});
