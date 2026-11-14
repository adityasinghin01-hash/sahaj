import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { evaluateReadiness } from "../../src/lib/health/readiness";
import { probeRealDatabase } from "../../src/lib/health/ports";
import type { ReadinessDependencies, DatabaseProbeResult } from "../../src/lib/health/types";

// Mock @supabase/supabase-js
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn()
}));

import { createClient } from "@supabase/supabase-js";

describe("Adversarial QA: Concurrency, Hanging Dependencies, Timeout & Cancellation", () => {
  const originalEnv = { ...process.env };
  const fixedNow = new Date("2026-11-14T20:00:00.000Z");
  const defaultOptions = { timeoutMs: 1000, now: () => fixedNow };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = { ...originalEnv };
  });

  describe("Hanging dependency bounded deadline", () => {
    it("MUST independently time out when dependency hangs indefinitely and never settles", async () => {
      vi.useFakeTimers();

      let probeCalled = false;
      const deps: ReadinessDependencies = {
        isConfigured: () => true,
        // Dependency returns a Promise that never resolves or rejects
        probeDatabase: () => {
          probeCalled = true;
          return new Promise<DatabaseProbeResult>(() => {});
        }
      };

      const readinessPromise = evaluateReadiness(deps, {
        timeoutMs: 500,
        now: () => fixedNow
      });

      expect(probeCalled).toBe(true);

      // Advance time beyond the bounded deadline
      await vi.advanceTimersByTimeAsync(500);

      const result = await readinessPromise;
      expect(result.httpStatus).toBe(503);
      expect(result.body.ok).toBe(false);
      expect(result.body.status).toBe("degraded");
      expect(result.body.database?.status).toBe("timeout");
      expect(result.body.database?.code).toBe("database_timeout");
    });

    it("clears independent deadline timer when probe settles before timeout", async () => {
      vi.useFakeTimers();
      const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

      const deps: ReadinessDependencies = {
        isConfigured: () => true,
        probeDatabase: () =>
          Promise.resolve({
            ok: true,
            status: "connected",
            schemaOk: true,
            latencyMs: 5
          })
      };

      const result = await evaluateReadiness(deps, {
        timeoutMs: 1000,
        now: () => fixedNow
      });

      expect(result.httpStatus).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });

  describe("Cancellation propagation & AbortSignal handling", () => {
    it("immediately returns 503 timeout without probing when external abortSignal is already aborted", async () => {
      const probeFn = vi.fn();
      const deps: ReadinessDependencies = {
        isConfigured: () => true,
        probeDatabase: probeFn
      };

      // In baseline 8133cf0, evaluateReadiness did not accept abortSignal in options
      const res = await (evaluateReadiness as any)(deps, {
        ...defaultOptions,
        abortSignal: AbortSignal.abort()
      });

      expect(res.httpStatus).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.database?.status).toBe("timeout");
      expect(res.body.database?.code).toBe("database_timeout");
      expect(probeFn).not.toHaveBeenCalled();
    });

    it("cancels in-flight probe and returns 503 timeout when external abortSignal fires mid-probe", async () => {
      let probeCancelled = false;
      const abortCtrl = new AbortController();

      const deps: ReadinessDependencies = {
        isConfigured: () => true,
        probeDatabase: (_timeoutMs: number, signal?: AbortSignal) => {
          if (signal) {
            signal.addEventListener("abort", () => {
              probeCancelled = true;
            });
          }
          return new Promise<DatabaseProbeResult>(() => {});
        }
      };

      const readinessPromise = (evaluateReadiness as any)(deps, {
        ...defaultOptions,
        abortSignal: abortCtrl.signal
      });

      // Fire cancellation while probe is in flight
      abortCtrl.abort();

      const res = await readinessPromise;
      expect(res.httpStatus).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.database?.status).toBe("timeout");
      expect(res.body.database?.code).toBe("database_timeout");
      expect(probeCancelled).toBe(true);
    });

    it("removes abort event listener from external signal when probe finishes cleanly", async () => {
      const abortCtrl = new AbortController();
      const removeListenerSpy = vi.spyOn(abortCtrl.signal, "removeEventListener");

      const deps: ReadinessDependencies = {
        isConfigured: () => true,
        probeDatabase: () =>
          Promise.resolve({
            ok: true,
            status: "connected",
            schemaOk: true,
            latencyMs: 10
          })
      };

      await (evaluateReadiness as any)(deps, {
        ...defaultOptions,
        abortSignal: abortCtrl.signal
      });

      expect(removeListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    it("probeRealDatabase aborts immediately when passed pre-aborted externalSignal", async () => {
      process.env.SUPABASE_URL = "https://synthetic.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-service-role-key";

      const abortedSignal = AbortSignal.abort();
      const result = await (probeRealDatabase as any)(500, abortedSignal);

      expect(result.ok).toBe(false);
      expect(result.status).toBe("timeout");
      expect(result.code).toBe("database_timeout");
      expect(createClient).not.toHaveBeenCalled();
    });
  });

  describe("Failure recovery & sequential resilience", () => {
    it("recovers cleanly from repeated intermittent failure to healthy 200 ready", async () => {
      let invocation = 0;
      const deps: ReadinessDependencies = {
        isConfigured: () => true,
        probeDatabase: vi.fn().mockImplementation(async () => {
          invocation++;
          if (invocation % 2 === 1) {
            // Odd invocations fail
            return {
              ok: false,
              status: "unreachable",
              code: "database_unreachable",
              latencyMs: 50
            };
          }
          // Even invocations recover
          return {
            ok: true,
            status: "connected",
            schemaOk: true,
            latencyMs: 10
          };
        })
      };

      // Iteration 1: Failure
      const res1 = await evaluateReadiness(deps, defaultOptions);
      expect(res1.httpStatus).toBe(503);
      expect(res1.body.ok).toBe(false);
      expect(res1.body.status).toBe("degraded");

      // Iteration 2: Recovery
      const res2 = await evaluateReadiness(deps, defaultOptions);
      expect(res2.httpStatus).toBe(200);
      expect(res2.body.ok).toBe(true);
      expect(res2.body.status).toBe("ready");

      // Iteration 3: Failure
      const res3 = await evaluateReadiness(deps, defaultOptions);
      expect(res3.httpStatus).toBe(503);

      // Iteration 4: Recovery
      const res4 = await evaluateReadiness(deps, defaultOptions);
      expect(res4.httpStatus).toBe(200);
      expect(res4.body.ok).toBe(true);
    });
  });
});
