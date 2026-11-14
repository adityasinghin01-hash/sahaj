#!/usr/bin/env node
/** Explicit opt-in real-provider diagnostics. Importing this module performs no checks.
 * node scripts/lab/live-check.mjs [--send-whatsapp]
 * Env: ${LAB_ENV_FILE:-$HOME/dev/sahaj-secrets/shield.env}; values are never printed.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { z } from "zod";

const ENV_NAMES = [
  "ANTHROPIC_API_KEY", "MUSE_API_KEY", "MUSE_BASE_URL", "MUSE_MODEL",
  "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL",
  "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "LAB_PHONE_ROHIT", "LAB_API_URL",
];
export function loadLiveEnv(shell = process.env) {
  const path = shell.LAB_ENV_FILE ?? join(homedir(), "dev", "sahaj-secrets", "shield.env");
  const file = path && existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  return { ...file, ...shell };
}

/** The workspace already installs jiti (Next/Expo's TS loader). No build or provider call.
 * Relative .js imports in the adapters' TypeScript sources need this resolution bridge.
 */
export async function loadLiveAdapters() {
  const { default: jitiFactory } = await import("jiti");
  const jiti = jitiFactory(fileURLToPath(import.meta.url), { cache: false });
  return jiti("../../packages/adapters/src/llm/index.ts");
}
class CheckFailure extends Error {}
const requireCheck = (ok, reason) => { if (!ok) throw new CheckFailure(reason); };
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export async function runLiveChecks({
  env, sendWhatsapp = false, fetchFn = fetch, loadAdapters = loadLiveAdapters,
  output = (line) => { process.stdout.write(`${line}\n`); }, sleep = delay,
}) {
  const results = [];
  output(`Configured variable names: ${ENV_NAMES.filter((name) => env[name]?.trim()).join(", ") || "none"}`);
  const task = `sahaj-lab-live-${randomBytes(8).toString("hex").replace(/[0-9]/g, (d) => String.fromCharCode(103 + Number(d)))}`;
  const startedAt = new Date().toISOString();
  let adapters;
  let tracer;
  let traceAttempts = 0;
  const adaptersForRun = async () => {
    adapters ??= await loadAdapters();
    tracer ??= adapters.createLangfuseTrace({ env });
    return adapters;
  };
  const onTrace = (attempt) => { traceAttempts++; tracer?.onTrace(attempt); };
  const maskedSms = "URGENT account KYC blocked. Send OTP ****** to <MOBILE_10> at <URL:kyc-demo.example>.";
  const request = {
    task, system: "You are Sahaj, an AI scam safety assistant. Never request money, OTP, PIN or bank details. Classify the masked SMS. Return only JSON matching the schema.",
    input: maskedSms, schema: z.object({ scam: z.boolean() }), effort: "low", timeoutMs: 10000,
  };
  async function check(name, required, fn, skipReason) {
    const start = performance.now();
    const missing = required.filter((key) => !env[key]?.trim());
    let status = "PASS";
    let detail = "";
    if (skipReason || missing.length) {
      status = "SKIPPED";
      detail = skipReason ?? `missing env: ${missing.join(", ")}`;
    } else {
      try { await fn(); }
      catch (error) {
        status = "FAIL";
        // Only errors defined here contain fixed, safe diagnostic codes.
        detail = error instanceof CheckFailure ? error.message : "request_or_configuration_failed";
      }
    }
    const ms = Math.round(performance.now() - start);
    const result = { name, status, ms, detail };
    results.push(result);
    output(`${status} ${name} (${ms} ms)${detail ? ` — ${detail}` : ""}`);
  }
  const http = async (url, init = {}) => {
    const response = await fetchFn(url, { redirect: "error", signal: AbortSignal.timeout(10000), ...init });
    requireCheck(response.ok, `http_${response.status}`);
    return response;
  };
  const langfuseUrl = (path) => {
    const base = new URL(env.LANGFUSE_BASE_URL);
    requireCheck(!base.username && !base.password && ["https:", "http:"].includes(base.protocol), "invalid_langfuse_url");
    return new URL(`${base.pathname.replace(/\/$/, "")}${path}`, base.origin);
  };
  const basicAuth = () => ({ Authorization: `Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString("base64")}` });
  try {
    await check("Claude", ["ANTHROPIC_API_KEY"], async () => {
      const { createDefaultRouter } = await adaptersForRun();
      // Isolate keys: a fallback must never turn a failed Claude check green.
      const router = createDefaultRouter({ env: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }, onTrace });
      const result = await router.understand(request);
      requireCheck(result.ok && result.model === "claude", "claude_did_not_succeed");
    });
    await check("Muse", ["MUSE_API_KEY"], async () => {
      const { createDefaultRouter } = await adaptersForRun();
      const router = createDefaultRouter({ env: { MUSE_API_KEY: env.MUSE_API_KEY, MUSE_BASE_URL: env.MUSE_BASE_URL, MUSE_MODEL: env.MUSE_MODEL }, onTrace });
      const result = await router.understand(request);
      requireCheck(result.ok && result.model === "muse", "muse_did_not_succeed");
    });
    await check("Langfuse", ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"], async () => {
      const { createDefaultRouter } = await adaptersForRun();
      requireCheck(tracer.enabled, "trace_adapter_disabled");
      if (!traceAttempts) {
        // Exercise the router's actual metadata trace path without any paid call.
        // It records not_configured failures, never a fabricated provider success.
        await createDefaultRouter({ env: {}, onTrace }).understand(request);
      }
      await tracer.flush();
      // Langfuse retired GET /api/public/traces (410); read v2 observations from this run's start.
      for (let attempt = 0; attempt < 8; attempt++) {
        const url = langfuseUrl("/api/public/v2/observations");
        url.searchParams.set("fromStartTime", startedAt);
        url.searchParams.set("toStartTime", new Date(Date.now() + 60_000).toISOString());
        url.searchParams.set("limit", "50");
        url.searchParams.set("fields", "core,basic,metadata"); // v2 omits metadata unless asked
        const page = await (await http(url, { headers: basicAuth() })).json();
        // A pre-existing or unrelated trace must not prove this run succeeded.
        if (page.data?.some((o) => o.metadata?.task === task || JSON.stringify(o.metadata ?? {}).includes(task))) return;
        if (attempt < 7) await sleep(1500);
      }
      throw new CheckFailure("fresh_run_trace_not_visible");
    });
    await check("OpenPhish", [], async () => {
      const feed = await (await http("https://openphish.com/feed.txt", { redirect: "follow" })).text();
      requireCheck(feed.split(/\r?\n/).some((line) => /^https?:\/\/\S+$/.test(line.trim())), "empty_or_invalid_feed");
    });
    await check("RDAP", [], async () => {
      const record = await (await http("https://rdap.org/domain/google.com", { redirect: "follow", headers: { Accept: "application/rdap+json", "User-Agent": "sahaj-shield/0.1 (+https://github.com/adityasinghin01-hash/sahaj)" } })).json();
      requireCheck(record.ldhName?.toLowerCase() === "google.com", "unexpected_rdap_domain");
    });
    await check("WhatsApp token", ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"], async () => {
      requireCheck(/^[0-9]+$/.test(env.WHATSAPP_PHONE_NUMBER_ID), "invalid_phone_number_id");
      const data = await (await http(`https://graph.facebook.com/v27.0/${env.WHATSAPP_PHONE_NUMBER_ID}`, {
        headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}` },
      })).json();
      requireCheck(data.id === env.WHATSAPP_PHONE_NUMBER_ID, "unexpected_whatsapp_phone_id");
    });
    await check("WhatsApp send", ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "LAB_PHONE_ROHIT"], async () => {
      requireCheck(/^\+?[1-9][0-9]{9,14}$/.test(env.LAB_PHONE_ROHIT), "invalid_lab_phone_rohit");
      requireCheck(/^[0-9]+$/.test(env.WHATSAPP_PHONE_NUMBER_ID), "invalid_phone_number_id");
      // Exactly one POST, no retries and no destination fallback.
      const data = await (await http(`https://graph.facebook.com/v27.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: "POST", headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: env.LAB_PHONE_ROHIT.replace(/^\+/, ""), type: "text", text: { body: "Sahaj lab test ✓" } }),
      })).json();
      requireCheck(typeof data.messages?.[0]?.id === "string", "whatsapp_send_not_accepted");
    }, sendWhatsapp ? undefined : "requires --send-whatsapp");
    await check("Lab health", [], async () => {
      const base = new URL(env.LAB_API_URL || "http://127.0.0.1:3100");
      requireCheck(base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) && !base.username && !base.password, "lab_url_must_be_loopback_http");
      const health = await (await http(new URL("/api/health", base))).json();
      requireCheck(health.ok === true && health.ports?.router === "real", "lab_router_not_real");
    });
  } finally { await tracer?.shutdown(); }
  return { results, exitCode: results.some((result) => result.status === "FAIL") ? 1 : 0 };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write("Usage: node scripts/lab/live-check.mjs [--send-whatsapp]\nLoads LAB_ENV_FILE or the default shield.env; sends no WhatsApp text without the flag.\n");
    return;
  }
  if (args.some((arg) => arg !== "--send-whatsapp")) throw new CheckFailure("unknown_flag");
  // Provider SDKs must not print raw failures, secrets, URLs with ids, or routing data.
  const saved = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((name) => [name, console[name]]));
  try {
    for (const name of Object.keys(saved)) console[name] = () => {};
    const { exitCode } = await runLiveChecks({ env: loadLiveEnv(), sendWhatsapp: args.includes("--send-whatsapp") });
    process.exitCode = exitCode;
  } finally { Object.assign(console, saved); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write("FAIL live-check setup (values hidden)\n");
    process.exitCode = 1;
  });
}
