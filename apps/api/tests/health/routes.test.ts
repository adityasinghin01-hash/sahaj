import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GET as healthRoute } from "../../src/app/api/health/route";
import { GET as livenessRoute } from "../../src/app/api/health/liveness/route";
import { GET as readinessRoute } from "../../src/app/api/health/readiness/route";

// Mock ports to avoid any real network calls in route tests
vi.mock("../../src/lib/health/ports", () => {
  return {
    defaultReadinessDependencies: {
      isConfigured: vi.fn(),
      probeDatabase: vi.fn()
    }
  };
});

import { defaultReadinessDependencies } from "../../src/lib/health/ports";

describe("Health API Route Handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/health?probe=liveness returns 200 with no-store cache header", async () => {
    const req = new Request("http://localhost:3000/api/health?probe=liveness");
    const res = await healthRoute(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.probe).toBe("liveness");
    expect(data.emergency_ready).toBe(false);
    expect(data.care_actions).toBe("disabled");
  });

  it("GET /api/health defaults to readiness probe and returns 200 when ready", async () => {
    vi.mocked(defaultReadinessDependencies.isConfigured).mockReturnValue(true);
    vi.mocked(defaultReadinessDependencies.probeDatabase).mockResolvedValue({
      ok: true,
      status: "connected",
      schemaOk: true,
      latencyMs: 10
    });

    const req = new Request("http://localhost:3000/api/health");
    const res = await healthRoute(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.status).toBe("ready");
    expect(data.probe).toBe("readiness");
    expect(data.database?.status).toBe("connected");
    expect(data.emergency_ready).toBe(false);
  });

  it("GET /api/health returns 503 when readiness probe fails", async () => {
    vi.mocked(defaultReadinessDependencies.isConfigured).mockReturnValue(false);
    vi.mocked(defaultReadinessDependencies.probeDatabase).mockResolvedValue({
      ok: false,
      status: "not_configured",
      code: "database_not_configured"
    });

    const req = new Request("http://localhost:3000/api/health");
    const res = await healthRoute(req);

    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.status).toBe("degraded");
    expect(data.database?.status).toBe("not_configured");
    expect(data.database?.code).toBe("database_not_configured");
    expect(data.emergency_ready).toBe(false);
  });

  it("GET /api/health/liveness returns 200 with no-store header", async () => {
    const res = await livenessRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.probe).toBe("liveness");
    expect(data.emergency_ready).toBe(false);
  });

  it("GET /api/health/readiness returns 503 when dependency fails", async () => {
    vi.mocked(defaultReadinessDependencies.isConfigured).mockReturnValue(true);
    vi.mocked(defaultReadinessDependencies.probeDatabase).mockResolvedValue({
      ok: false,
      status: "timeout",
      code: "database_timeout"
    });

    const res = await readinessRoute();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.database?.status).toBe("timeout");
    expect(data.database?.code).toBe("database_timeout");
  });

  it("GET /api/health with aborted request signal returns 503 timeout with no-store header", async () => {
    vi.mocked(defaultReadinessDependencies.isConfigured).mockReturnValue(true);

    const abortController = new AbortController();
    abortController.abort();

    const req = new Request("http://localhost:3000/api/health", {
      signal: abortController.signal
    });

    const res = await healthRoute(req);
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.status).toBe("degraded");
    expect(data.database?.status).toBe("timeout");
    expect(data.database?.code).toBe("database_timeout");
  });
});
