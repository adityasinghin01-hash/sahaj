import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { isRealDatabaseConfigured, probeRealDatabase } from "../../src/lib/health/ports";

// Mock @supabase/supabase-js
vi.mock("@supabase/supabase-js", () => {
  return {
    createClient: vi.fn()
  };
});

import { createClient } from "@supabase/supabase-js";

describe("probeRealDatabase port logic", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("reports not_configured when environment variables are missing", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(isRealDatabaseConfigured()).toBe(false);
    const result = await probeRealDatabase(500);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("not_configured");
    expect(result.code).toBe("database_not_configured");
  });

  it("reports connected and schemaOk when foundation_readiness RPC succeeds", async () => {
    process.env.SUPABASE_URL = "https://synthetic-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

    expect(isRealDatabaseConfigured()).toBe(true);

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
    expect(result.ok).toBe(true);
    expect(result.status).toBe("connected");
    expect(result.schemaOk).toBe(true);
    expect(result.latencyMs).toBeTypeOf("number");
    expect(mockRpc).toHaveBeenCalledWith("foundation_readiness");
  });

  it("reports missing_schema when foundation_readiness returns schema_ready=false", async () => {
    process.env.SUPABASE_URL = "https://synthetic-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

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

  it("reports missing_schema when RPC function is missing (PGRST202 / 42883)", async () => {
    process.env.SUPABASE_URL = "https://synthetic-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

    const mockRpc = vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockResolvedValue({
        data: null,
        error: {
          code: "PGRST202",
          message: "Could not find the function public.foundation_readiness() in the schema cache"
        }
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

  it("reports missing_schema when RPC response is malformed", async () => {
    process.env.SUPABASE_URL = "https://synthetic-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

    const mockRpc = vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockResolvedValue({
        data: { database: "connected", schema_version: "wrong-version" },
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
  });

  it("reports timeout when SDK returns an abort error object", async () => {
    process.env.SUPABASE_URL = "https://synthetic-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

    const mockRpc = vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockResolvedValue({
        data: null,
        error: { name: "AbortError", message: "The operation was aborted." }
      })
    });

    vi.mocked(createClient).mockReturnValue({
      rpc: mockRpc
    } as unknown as ReturnType<typeof createClient>);

    const result = await probeRealDatabase(500);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.code).toBe("database_timeout");
  });

  it("reports timeout when SDK throws an AbortError", async () => {
    process.env.SUPABASE_URL = "https://synthetic-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";

    const mockRpc = vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockRejectedValue(abortError)
    });

    vi.mocked(createClient).mockReturnValue({
      rpc: mockRpc
    } as unknown as ReturnType<typeof createClient>);

    const result = await probeRealDatabase(50);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.code).toBe("database_timeout");
  });

  it("reports unreachable when query fails with network error", async () => {
    process.env.SUPABASE_URL = "https://synthetic-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

    const mockRpc = vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockRejectedValue(new Error("fetch failed: ECONNREFUSED"))
    });

    vi.mocked(createClient).mockReturnValue({
      rpc: mockRpc
    } as unknown as ReturnType<typeof createClient>);

    const result = await probeRealDatabase(500);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("unreachable");
    expect(result.code).toBe("database_unreachable");
  });

  it("reports timeout when externalSignal is already aborted", async () => {
    process.env.SUPABASE_URL = "https://synthetic-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

    const abortedSignal = AbortSignal.abort();
    const result = await probeRealDatabase(500, abortedSignal);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.code).toBe("database_timeout");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("reports timeout and aborts when externalSignal fires during call", async () => {
    process.env.SUPABASE_URL = "https://synthetic-test.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

    const abortController = new AbortController();

    const mockRpc = vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockImplementation((signal: AbortSignal) => {
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      })
    });

    vi.mocked(createClient).mockReturnValue({
      rpc: mockRpc
    } as unknown as ReturnType<typeof createClient>);

    const probePromise = probeRealDatabase(1000, abortController.signal);

    // Abort externally
    abortController.abort();

    const result = await probePromise;
    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
    expect(result.code).toBe("database_timeout");
  });
});
