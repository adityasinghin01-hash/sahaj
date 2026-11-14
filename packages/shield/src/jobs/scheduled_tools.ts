/**
 * The voice tools with the timed steps hooked in. Same names, inputs and outputs as `shieldTools`;
 * the only difference is that, when `deps.scheduler` is given, they also queue the DB jobs:
 *
 * - family_check: after the WhatsApp card is sent → shield.family_check.escalate at 60 s.
 *   (If the card failed, the tool already rings the family member at once, so nothing is queued.)
 * - family_check_result: on the 2nd "pending" for a check → shield.family_check.callback at 2 min.
 *
 * Without `deps.scheduler` every tool behaves exactly like `shieldTools`.
 * Queueing never changes what Maa hears: errors are signed, and the wait is capped so the tool
 * still answers inside the 3 s limit (a slow insert keeps running and is not cancelled).
 */
import { shieldTools, type ShieldToolName } from "../tools";
import { TIMED_OUT, TOOL_TIMEOUT_MS, safeSign, withTimeout } from "../tools/runtime";
import type { ShieldDeps, ToolCtx } from "../tools/types";
import {
  CALLBACK_AFTER_MS,
  ESCALATE_AFTER_MS,
  SHIELD_JOBS,
  familyCheckJobPayload,
  scaleDelay,
  type Env,
  type JobLedger,
  type Scheduler,
} from "./family_check_jobs";

/** Tool deps with the optional scheduler. A scheduler needs the ledger (to count pending results). */
export type ScheduledToolDeps = ShieldDeps & { env?: Env } & (
    | { scheduler?: undefined; jobs?: JobLedger }
    | { scheduler: Scheduler; jobs: JobLedger }
  );

/** Smallest wait given to the queue step even when the tool itself used most of the budget. */
const MIN_QUEUE_WAIT_MS = 50;

async function queue(deps: ScheduledToolDeps, ctx: ToolCtx, startedAt: number, step: string, work: () => Promise<void>) {
  const budget = Math.max(MIN_QUEUE_WAIT_MS, TOOL_TIMEOUT_MS - (Date.now() - startedAt));
  const running = work();
  running.catch(() => undefined);
  try {
    const res = await withTimeout(running, budget);
    if (res === TIMED_OUT) {
      // Still running in the background; only note that it was slow.
      void safeSign(deps, {
        familyId: ctx.familyId,
        type: "shield.voice.job_queue_slow",
        line: `Queueing "${step}" took longer than the tool budget.`,
        data: { step },
      });
    }
  } catch {
    await safeSign(deps, {
      familyId: ctx.familyId,
      type: "shield.voice.side_effect_failed",
      line: `Queueing "${step}" failed.`,
      data: { step },
    });
  }
}

type FamilyCheckTool = (typeof shieldTools)["family_check"];
type FamilyCheckResultTool = (typeof shieldTools)["family_check_result"];

const familyCheck: FamilyCheckTool = {
  ...shieldTools.family_check,
  async run(deps: ScheduledToolDeps, ctx, input) {
    const base = shieldTools.family_check;
    const scheduler = deps.scheduler;
    if (!scheduler) return base.run(deps, ctx, input);

    const startedAt = Date.now();
    let cardSent = false;
    // Watch the card send without changing it, so the timer is queued only when the card went out.
    const watched: ShieldDeps = Object.create(deps);
    watched.whatsapp = {
      async sendFamilyCheckCard(card) {
        await deps.whatsapp.sendFamilyCheckCard(card);
        cardSent = true;
      },
    };
    const out = await base.run(watched, ctx, input);

    if (out.status === "checking" && out.check_id && cardSent) {
      const checkId = out.check_id;
      await queue(deps, ctx, startedAt, SHIELD_JOBS.escalate, () =>
        scheduler.after(scaleDelay(ESCALATE_AFTER_MS, deps.env), SHIELD_JOBS.escalate, familyCheckJobPayload(checkId, ctx)),
      );
    }
    return out;
  },
};

const familyCheckResult: FamilyCheckResultTool = {
  ...shieldTools.family_check_result,
  async run(deps: ScheduledToolDeps, ctx, input) {
    const base = shieldTools.family_check_result;
    const startedAt = Date.now();
    const out = await base.run(deps, ctx, input);
    if (!deps.scheduler || out.status !== "pending") return out;

    const { scheduler, jobs } = deps;
    const checkId = String((input as { check_id?: unknown }).check_id ?? "").trim();
    if (!checkId) return out;

    await queue(deps, ctx, startedAt, SHIELD_JOBS.callback, async () => {
      // First pending: the agent waits ~20 s and asks again. Second (or later) pending: queue the callback once.
      const firstPending = await jobs.claim(`shield.family_check.pending_seen:${checkId}`);
      if (firstPending) return;
      const firstQueue = await jobs.claim(`shield.family_check.callback_queued:${checkId}`);
      if (!firstQueue) return;
      await scheduler.after(scaleDelay(CALLBACK_AFTER_MS, deps.env), SHIELD_JOBS.callback, familyCheckJobPayload(checkId, ctx));
    });
    return out;
  },
};

/** Drop-in replacement for `shieldTools` in the `/api/sarvam/tool/[name]` route. */
export const scheduledShieldTools: { [K in ShieldToolName]: (typeof shieldTools)[K] } = {
  ...shieldTools,
  family_check: familyCheck,
  family_check_result: familyCheckResult,
};

