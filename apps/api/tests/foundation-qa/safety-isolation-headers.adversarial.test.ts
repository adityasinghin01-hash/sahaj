import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { evaluateReadiness } from "../../src/lib/health/readiness";
import { evaluateLiveness } from "../../src/lib/health/liveness";
import { GET as healthRoute } from "../../src/app/api/health/route";
import { GET as livenessRoute } from "../../src/app/api/health/liveness/route";
import { GET as readinessRoute } from "../../src/app/api/health/readiness/route";
import { defaultReadinessDependencies } from "../../src/lib/health/ports";
import type { ReadinessDependencies, DatabaseProbeResult } from "../../src/lib/health/types";

// Mock @supabase/supabase-js
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn()
}));

// Mock defaultReadinessDependencies
vi.mock("../../src/lib/health/ports", () => ({
  isRealDatabaseConfigured: vi.fn(),
  probeRealDatabase: vi.fn(),
  defaultReadinessDependencies: {
    isConfigured: vi.fn(),
    probeDatabase: vi.fn()
  }
}));

describe("Adversarial QA: Safety Redaction, Isolation, Liveness Independence & Headers", () => {
  const fixedNow = new Date("2026-11-14T20:00:00.000Z");
  const defaultOptions = { timeoutMs: 1000, now: () => fixedNow };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Safe error handling & Zero Credential/Error Leakage", () => {
    it("MUST fail safely to HTTP 503 when deps.isConfigured() throws an exception with secrets", async () => {
      const secretMsg = "CRITICAL_SECRET_KEY=eyJhGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.topsecret";
      const deps: ReadinessDependencies = {
        isConfigured: () => {
          throw new Error(secretMsg);
        },
        probeDatabase: vi.fn()
      };

      // In baseline 8133cf0, deps.isConfigured() was called without try/catch, crashing the caller
      const res = await evaluateReadiness(deps, defaultOptions);

      expect(res.httpStatus).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.status).toBe("degraded");
      expect(res.body.database?.status).toBe("not_configured");

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(secretMsg);
      expect(serialized).not.toContain("CRITICAL_SECRET_KEY");
      expect(serialized).not.toContain("topsecret");
    });

    it("redacts raw database errors, connection strings, and passwords in probeDatabase rejections", async () => {
      const sensitiveLeak = "postgresql://admin:super_secret_password_999@supabase-db.internal:5432/sahaj_db";
      const deps: ReadinessDependencies = {
        isConfigured: () => true,
        probeDatabase: () => Promise.reject(new Error(`Connection failed: ${sensitiveLeak}`))
      };

      const res = await evaluateReadiness(deps, defaultOptions);

      expect(res.httpStatus).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.status).toBe("degraded");
      expect(res.body.database?.status).toBe("unhealthy");
      expect(res.body.database?.code).toBe("database_error");

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(sensitiveLeak);
      expect(serialized).not.toContain("super_secret_password_999");
      expect(serialized).not.toContain("admin");
      expect(serialized).not.toContain("sahaj_db");
    });

    it("verifies response contains ONLY sanctioned fields and values", async () => {
      const deps: ReadinessDependencies = {
        isConfigured: () => true,
        probeDatabase: () =>
          Promise.resolve({
            ok: true,
            status: "connected",
            schemaOk: true,
            latencyMs: 8
          })
      };

      const res = await evaluateReadiness(deps, defaultOptions);

      expect(res.httpStatus).toBe(200);
      const keys = Object.keys(res.body).sort();
      expect(keys).toEqual([
        "care_actions",
        "database",
        "emergency_ready",
        "ok",
        "probe",
        "service",
        "stage",
        "status",
        "timestamp",
        "voice"
      ].sort());

      // Care actions & emergency readiness strictly disabled
      expect(res.body.voice).toBe("disabled");
      expect(res.body.care_actions).toBe("disabled");
      expect(res.body.emergency_ready).toBe(false);
      expect(res.body.stage).toBe("phase-1-foundation");
      expect(res.body.service).toBe("sahaj-core1-api");
    });
  });

  describe("Liveness independence from readiness state", () => {
    it("evaluateLiveness always returns 200 pass even when database dependencies are failing", () => {
      const res = evaluateLiveness({ now: () => fixedNow });

      expect(res.httpStatus).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe("pass");
      expect(res.body.probe).toBe("liveness");
      expect(res.body.voice).toBe("disabled");
      expect(res.body.care_actions).toBe("disabled");
      expect(res.body.emergency_ready).toBe(false);
      // Database object should not be present in liveness response
      expect((res.body as any).database).toBeUndefined();
    });

    it("GET /api/health?probe=liveness returns 200 without calling database dependencies", async () => {
      const req = new Request("http://localhost:3000/api/health?probe=liveness");
      const res = await healthRoute(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.status).toBe("pass");
      expect(data.probe).toBe("liveness");
      expect(defaultReadinessDependencies.probeDatabase).not.toHaveBeenCalled();
    });

    it("GET /api/health/liveness dedicated endpoint returns 200 with no-store header", async () => {
      const res = await livenessRoute();

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.status).toBe("pass");
      expect(data.probe).toBe("liveness");
      expect(defaultReadinessDependencies.probeDatabase).not.toHaveBeenCalled();
    });
  });

  describe("HTTP Cache-Control: no-store on all health endpoints", () => {
    it("attaches Cache-Control: no-store on ready response (200)", async () => {
      vi.mocked(defaultReadinessDependencies.isConfigured).mockReturnValue(true);
      vi.mocked(defaultReadinessDependencies.probeDatabase).mockResolvedValue({
        ok: true,
        status: "connected",
        schemaOk: true,
        latencyMs: 12
      });

      const req = new Request("http://localhost:3000/api/health");
      const res = await healthRoute(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("attaches Cache-Control: no-store on degraded response (503)", async () => {
      vi.mocked(defaultReadinessDependencies.isConfigured).mockReturnValue(false);

      const req = new Request("http://localhost:3000/api/health");
      const res = await healthRoute(req);

      expect(res.status).toBe(503);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("attaches Cache-Control: no-store on dedicated /api/health/readiness endpoint (503)", async () => {
      vi.mocked(defaultReadinessDependencies.isConfigured).mockReturnValue(false);

      const res = await readinessRoute();

      expect(res.status).toBe(503);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    });

    it("propagates client request abort signal returning 503 with Cache-Control: no-store", async () => {
      vi.mocked(defaultReadinessDependencies.isConfigured).mockReturnValue(true);

      const abortCtrl = new AbortController();
      abortCtrl.abort();

      const req = new Request("http://localhost:3000/api/health", {
        signal: abortCtrl.signal
      });

      const res = await healthRoute(req);
      expect(res.status).toBe(503);
      expect(res.headers.get("Cache-Control")).toBe("no-store");

      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.database?.status).toBe("timeout");
    });
  });
});
