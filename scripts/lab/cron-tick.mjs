#!/usr/bin/env node
// Joined lab timers for apps/api, through the door. Every TICK_INTERVAL_SECONDS (30-60, default 30) it POSTs, with
// x-cron-secret, each tick route that exists in apps/api:
//   /api/cron/tick                Atlas/outbox tick: routes raw events, runs Core 1 command + Core 2 event jobs,
//                                 the TeleCMI missed-call nudge pass, Atlas jobs (when configured), dispatch and purge
//   /api/core2/cron/overdue       Core 2 late-home watches -> check-in -> escalation to the top trusted contact
//   /api/core2/device-status/tick Core 2 phone-dying / stale-heartbeat handover
//   /api/core2/news/tick          Core 2 gentle news pass
//   /api/core1/matcher/tick       Core 1 matcher pass
// (/api/cron/tick itself also runs the Core 1 check-in scheduler, Sarvam post-call projection and urgent escalation.)
// Shield's own jobs run in apps/shield-api/scripts/cron-worker.mjs. DEMO_TIMER_SCALE is applied by the servers to the
// timers themselves; this loop only has to run often enough, so the scale is reported, never re-applied here.
// Logs route, status and numeric counts only; never the secret or response bodies. `--once` runs one round and exits
// non-zero if any route failed (used by scripts/lab/joined-smoke.mjs).
const base = (process.env.TICK_BASE_URL || (process.env.TICK_URL || "").replace(/\/api\/cron\/tick$/, "")).replace(/\/$/, "");
const secret = process.env.CRON_SECRET;
if (!base || !secret) { console.error("cron-tick: TICK_BASE_URL and CRON_SECRET are required"); process.exit(2); }
const intervalS = Math.min(60, Math.max(30, Number(process.env.TICK_INTERVAL_SECONDS) || 30));
const scale = Number(process.env.DEMO_TIMER_SCALE) > 0 ? Number(process.env.DEMO_TIMER_SCALE) : 1;
export const TICK_ROUTES = ["/api/cron/tick", "/api/core2/cron/overdue", "/api/core2/device-status/tick", "/api/core2/news/tick", "/api/core1/matcher/tick"];

function counts(obj, prefix = "", out = {}, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 2) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" || typeof v === "boolean") out[prefix + k] = v;
    else if (k === "status" || k === "error") { if (typeof v === "string" && /^[a-z0-9_]{1,40}$/.test(v)) out[prefix + k] = v; }
    else if (v && typeof v === "object" && !Array.isArray(v)) counts(v, `${prefix}${k}.`, out, depth + 1);
  }
  return out;
}

async function hit(path) {
  try {
    const r = await fetch(base + path, { method: "POST", headers: { "x-cron-secret": secret, "content-type": "application/json" }, body: "{}",
      redirect: "error", signal: AbortSignal.timeout(20_000) });
    const j = await r.json().catch(() => ({}));
    console.log(new Date().toISOString(), path, r.status, JSON.stringify(counts(j)));
    return r.status < 500;
  } catch (e) {
    console.log(new Date().toISOString(), path, "error", e?.name ?? "error");
    return false;
  }
}
async function round() {
  let ok = true;
  for (const p of TICK_ROUTES) ok = (await hit(p)) && ok; // sequential: the outbox tick sees what the Core 2 ticks queued next round
  return ok;
}

if (process.argv.includes("--once")) {
  process.exit((await round()) ? 0 : 1);
} else {
  console.log(new Date().toISOString(), `cron-tick: every ${intervalS}s, DEMO_TIMER_SCALE=${scale} (applied server-side), routes ${TICK_ROUTES.length}`);
  let busy = false;
  const loop = async () => { if (busy) return; busy = true; try { await round(); } finally { busy = false; } };
  loop();
  setInterval(loop, intervalS * 1000);
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
}
