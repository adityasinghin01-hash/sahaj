#!/usr/bin/env node
// Joined lab: POST ${TICK_URL} (apps/api /api/cron/tick through the door) every 30 s with x-cron-secret.
// Logs status and counts only; never the secret or response bodies beyond these fields.
const url = process.env.TICK_URL, secret = process.env.CRON_SECRET;
if (!url || !secret) { console.error("cron-tick: TICK_URL and CRON_SECRET are required"); process.exit(2); }
async function tick() {
  try {
    const r = await fetch(url, { method: "POST", headers: { "x-cron-secret": secret }, signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => ({}));
    const summary = { claimed: j.claimed, routed: j.routed, failed: j.failed, workflow: j.workflow?.status, dispatch: j.providers?.dispatch?.status, error: j.error };
    console.log(new Date().toISOString(), "tick", r.status, JSON.stringify(summary));
  } catch (e) {
    console.log(new Date().toISOString(), "tick error", e?.name ?? "error");
  }
}
tick();
setInterval(tick, 30_000);
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
