#!/usr/bin/env node
/**
 * Background cron worker for @sahaj/shield-api.
 *
 * Calls:
 *   - GET ${baseUrl}/api/cron/shield-jobs   every 30 seconds
 *   - GET ${baseUrl}/api/cron/weekly-drills once every 24 hours
 *
 * Authenticates via `x-cron-secret: ${CRON_SECRET}`.
 * Logs only endpoint names, HTTP status codes, and numeric result counts — never secrets.
 */

const BASE_JOBS_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 300_000;
const DAILY_DRILLS_INTERVAL_MS = 86_400_000;
const REQUEST_TIMEOUT_MS = 15_000;

function resolveBaseUrl(env) {
  const raw = (env.SHIELD_API_URL || env.SHIELD_API_HOSTPORT || "").trim();
  if (!raw) {
    throw new Error("SHIELD_API_URL (or SHIELD_API_HOSTPORT) is required");
  }
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  const parsed = new URL(withScheme);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("SHIELD_API_URL must be an http(s) URL without credentials");
  }
  return parsed.origin + parsed.pathname.replace(/\/$/, "");
}

function summarizePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const parts = [];
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}_count=${value.length}`);
    }
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

async function callCronEndpoint(baseUrl, path, secret, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("request_timeout")), REQUEST_TIMEOUT_MS);
  const onParentAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onParentAbort, { once: true });

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      headers: {
        "x-cron-secret": secret,
        accept: "application/json",
      },
      redirect: "error",
      signal: controller.signal,
    });

    let summary = "";
    const contentType = res.headers.get("content-type") || "";
    if (res.ok && contentType.includes("application/json")) {
      const json = await res.json().catch(() => null);
      summary = summarizePayload(json);
    }

    process.stdout.write(`cron ${path} status=${res.status}${summary}\n`);
    return res.ok;
  } catch (err) {
    if (signal.aborted) return false;
    const reason = err instanceof Error && err.name === "AbortError" ? "timeout" : "network_error";
    process.stderr.write(`cron ${path} error=${reason}\n`);
    return false;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onParentAbort);
  }
}

function sleepAbortable(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function main() {
  let baseUrl;
  try {
    baseUrl = resolveBaseUrl(process.env);
  } catch (err) {
    process.stderr.write(`ERROR: ${err instanceof Error ? err.message : "invalid URL"}\n`);
    process.exitCode = 1;
    return;
  }

  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    process.stderr.write("ERROR: CRON_SECRET is required\n");
    process.exitCode = 1;
    return;
  }

  const shutdown = new AbortController();
  const handleSignal = (sig) => {
    process.stdout.write(`cron-worker received ${sig}; shutting down\n`);
    shutdown.abort();
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));

  process.stdout.write(
    `cron-worker started target=${baseUrl} jobs_interval_ms=${BASE_JOBS_INTERVAL_MS} drills_interval_ms=${DAILY_DRILLS_INTERVAL_MS}\n`,
  );

  let consecutiveJobErrors = 0;
  let lastDailyDrillsAttemptAt = 0;
  let lastDailyDrillsSucceededAt = 0;
  let consecutiveDailyErrors = 0;

  while (!shutdown.signal.aborted) {
    const okJobs = await callCronEndpoint(
      baseUrl,
      "/api/cron/shield-jobs",
      secret,
      shutdown.signal,
    );
    if (shutdown.signal.aborted) break;

    if (okJobs) {
      consecutiveJobErrors = 0;
    } else {
      consecutiveJobErrors += 1;
    }

    const now = Date.now();
    const dailyDue = now - lastDailyDrillsSucceededAt >= DAILY_DRILLS_INTERVAL_MS;
    const dailyRetryWaitMs =
      consecutiveDailyErrors > 0
        ? Math.min(BASE_JOBS_INTERVAL_MS * 2 ** (consecutiveDailyErrors - 1), MAX_BACKOFF_MS)
        : 0;
    const canTryDaily = now - lastDailyDrillsAttemptAt >= dailyRetryWaitMs;

    if (dailyDue && canTryDaily) {
      lastDailyDrillsAttemptAt = now;
      const okDaily = await callCronEndpoint(
        baseUrl,
        "/api/cron/weekly-drills",
        secret,
        shutdown.signal,
      );
      if (shutdown.signal.aborted) break;

      if (okDaily) {
        lastDailyDrillsSucceededAt = Date.now();
        consecutiveDailyErrors = 0;
      } else {
        consecutiveDailyErrors += 1;
      }
    }

    const delayMs =
      consecutiveJobErrors === 0
        ? BASE_JOBS_INTERVAL_MS
        : Math.min(BASE_JOBS_INTERVAL_MS * 2 ** (consecutiveJobErrors - 1), MAX_BACKOFF_MS);

    await sleepAbortable(delayMs, shutdown.signal);
  }

  process.stdout.write("cron-worker stopped\n");
}

await main();

