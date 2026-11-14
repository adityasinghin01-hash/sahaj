/**
 * Busy-line watch for keypad parents (Core 3 Step 2.4). Sahaj never places an extra call to Maa
 * for this: it only reads the outcome of the check-in calls it already makes.
 *
 * recordCallStatus() is called by the Sarvam webhook handler for each check-in call outcome.
 * - busy       → start a streak, or extend the open one. Inside a check-in window, queue one
 *                check-in retry in 10 min (DEMO_TIMER_SCALE divides it).
 * - connected  → close the open streak.
 * - no_answer / failed → streak unchanged.
 * When a streak is long (≥ 45 min; demo: 3 busy results in a row) AND longer than her normal
 * (median of her closed streaks over the last 14 days, default 20 min), Riya gets one alert per
 * streak. No reply within 5 min → the circle chain starts (job shield.busy.circle).
 */
import { z } from "zod";
import type { ShieldDeps } from "../tools/types";
import { scaleDelay, timerScale, type Env, type Scheduler } from "../jobs/family_check_jobs";
import { buildBusyAlert, type BusyAlertMessage } from "./messages";

/* ------------------------------------------------------------------ constants */

export const BUSY_RETRY_AFTER_MS = 10 * 60_000;
export const BUSY_ALERT_MIN_MS = 45 * 60_000;
/** Demo mode (DEMO_TIMER_SCALE > 1): this many busy results in a row replace the 45 min rule. */
export const BUSY_DEMO_MIN_RESULTS = 3;
export const BUSY_NORMAL_DEFAULT_MS = 20 * 60_000;
export const BUSY_NORMAL_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
export const BUSY_CIRCLE_AFTER_MS = 5 * 60_000;
/**
 * A busy result more than this long after the previous one does not extend the streak: the old one
 * is closed as "stale" at its last busy result and a new one starts. Three missed 10 min retries.
 * Without it, a busy result in the morning window and one in the evening would read as one 8 h streak.
 */
export const BUSY_MAX_GAP_MS = 30 * 60_000;

export const BUSY_JOBS = {
  /** Consumed by the check-in caller (outside this package): retry the check-in call. */
  retry: "shield.busy.retry",
  /** Consumed by handleBusyJob below. */
  circle: "shield.busy.circle",
} as const;

/* ------------------------------------------------------------------ interfaces */

export interface BusyStreak {
  id: string;
  familyId: string;
  parentId: string;
  startedAt: Date;
  lastBusyAt: Date;
  busyCount: number;
  endedAt: Date | null;
  alertedAt: Date | null;
  childRepliedAt: Date | null;
  circledAt: Date | null;
}

/** Implemented by createBusyPg (src/db). */
export interface BusyDb {
  getOpenBusyStreak(familyId: string, parentId: string): Promise<BusyStreak | null>;
  getBusyStreak(id: string): Promise<BusyStreak | null>;
  /** Inserts an open streak. If one is already open for the parent (race), returns that one with created=false. */
  startBusyStreak(input: { familyId: string; parentId: string; at: Date }): Promise<{ streak: BusyStreak; created: boolean }>;
  /** +1 busy result, only if still open and `at` is later than last_busy_at. Null otherwise (duplicate / out of order / closed). */
  extendBusyStreak(id: string, at: Date): Promise<BusyStreak | null>;
  /** Closes an open streak. False if it was already closed. */
  closeBusyStreak(id: string, endedAt: Date, reason: "connected" | "stale"): Promise<boolean>;
  /** Lengths (ended_at − started_at, ms) of the parent's closed streaks that started in [since, until). */
  busyStreakDurationsMs(familyId: string, parentId: string, since: Date, until: Date): Promise<number[]>;
  /** Sets alerted_at only if unset. True for exactly one caller per streak. */
  claimBusyAlert(id: string, at: Date, minutes: number): Promise<boolean>;
  /** Sets child_replied_at if unset, scoped to the family. True if this call set it. */
  markBusyAlertReplied(id: string, familyId: string, at: Date): Promise<boolean>;
  /** Sets circled_at only if unset and the child has not replied. True for exactly one caller. */
  claimBusyCircle(id: string, at: Date): Promise<boolean>;
}

export interface BusyAlertInput {
  familyId: string;
  parentId: string;
  streakId: string;
  minutes: number;
  /** Both languages; Atlas sends the one matching Riya's setting. */
  messages: { en: BusyAlertMessage; hi: BusyAlertMessage };
}

export interface BusyDeps {
  db: BusyDb;
  scheduler: Scheduler;
  /** Atlas: deliver the busy alert to the first responder (push / WhatsApp). */
  alerts: { sendBusyAlert(input: BusyAlertInput): Promise<void> };
  atlas: Pick<ShieldDeps["atlas"], "startCircleChain">;
  sign: ShieldDeps["sign"];
  clock: ShieldDeps["clock"];
  env?: Env;
  /** Optional: how the family names this parent ("Maa"). Default "Maa". */
  parentName?(familyId: string, parentId: string): Promise<string | null>;
}

/* ------------------------------------------------------------------ input */

export const CallStatus = z.enum(["connected", "no_answer", "busy", "failed"]);
export type CallStatus = z.infer<typeof CallStatus>;

export const CallStatusInput = z.object({
  familyId: z.string().trim().min(1).max(200),
  parentId: z.string().trim().min(1).max(200),
  status: CallStatus,
  at: z.date(),
  inCheckinWindow: z.boolean(),
});
export type CallStatusInput = z.infer<typeof CallStatusInput>;

export type StreakChange = "started" | "extended" | "closed" | "unchanged" | "duplicate";

export interface CallStatusResult {
  streak: StreakChange;
  streakId: string | null;
  retryScheduled: boolean;
  alerted: boolean;
}

/* ------------------------------------------------------------------ math (exported for tests) */

export function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

export function isDemo(env?: Env): boolean {
  return timerScale(env) > 1;
}

/**
 * Streak length used for the alert rule and the alert text, in ms.
 * Real mode: time since the first busy result. Demo mode: busy results × 10 min (each result
 * stands for one real retry slot), so 3 results read as 30 min whatever the scale.
 */
export function streakLengthMs(streak: Pick<BusyStreak, "startedAt" | "busyCount">, at: Date, env?: Env): number {
  if (isDemo(env)) return streak.busyCount * BUSY_RETRY_AFTER_MS;
  return Math.max(0, at.getTime() - streak.startedAt.getTime());
}

export function shouldAlert(
  streak: Pick<BusyStreak, "startedAt" | "busyCount">,
  at: Date,
  normalMs: number,
  env?: Env,
): boolean {
  const longEnough = isDemo(env)
    ? streak.busyCount >= BUSY_DEMO_MIN_RESULTS
    : at.getTime() - streak.startedAt.getTime() >= BUSY_ALERT_MIN_MS;
  return longEnough && streakLengthMs(streak, at, env) > normalMs;
}

async function normalMs(deps: BusyDeps, familyId: string, parentId: string, at: Date): Promise<number> {
  const since = new Date(at.getTime() - BUSY_NORMAL_LOOKBACK_MS);
  const m = median(await deps.db.busyStreakDurationsMs(familyId, parentId, since, at));
  return m ?? BUSY_NORMAL_DEFAULT_MS;
}

/* ------------------------------------------------------------------ recordCallStatus */

type SignEvent = Parameters<ShieldDeps["sign"]>[0];

/** Timeline write that never throws (same rule as tools/runtime safeSign). */
async function signSafe(deps: Pick<BusyDeps, "sign">, event: SignEvent): Promise<void> {
  try {
    await deps.sign(event);
  } catch {
    // The timeline writer owns its retries.
  }
}

async function scheduleRetry(deps: BusyDeps, input: CallStatusInput, streakId: string): Promise<boolean> {
  try {
    await deps.scheduler.after(scaleDelay(BUSY_RETRY_AFTER_MS, deps.env), BUSY_JOBS.retry, {
      family_id: input.familyId,
      parent_id: input.parentId,
      streak_id: streakId,
    });
    return true;
  } catch {
    await signSafe(deps, {
      familyId: input.familyId,
      type: "shield.busy.side_effect_failed",
      line: "Queueing the check-in retry failed.",
      data: { step: "retry", streak_id: streakId },
    });
    return false;
  }
}

async function maybeAlert(deps: BusyDeps, streak: BusyStreak, at: Date): Promise<boolean> {
  if (streak.alertedAt) return false;
  const normal = await normalMs(deps, streak.familyId, streak.parentId, at);
  if (!shouldAlert(streak, at, normal, deps.env)) return false;

  const minutes = Math.floor(streakLengthMs(streak, at, deps.env) / 60_000);
  if (!(await deps.db.claimBusyAlert(streak.id, at, minutes))) return false;

  let parentName = "Maa";
  try {
    parentName = (await deps.parentName?.(streak.familyId, streak.parentId))?.trim() || "Maa";
  } catch {
    parentName = "Maa";
  }
  const messages = {
    en: buildBusyAlert({ lang: "en", parentName, minutes }),
    hi: buildBusyAlert({ lang: "hi", parentName, minutes }),
  };
  const sign = (type: string, line: string, data: Record<string, unknown>) =>
    signSafe(deps, { familyId: streak.familyId, type, line, data });

  try {
    await deps.alerts.sendBusyAlert({
      familyId: streak.familyId,
      parentId: streak.parentId,
      streakId: streak.id,
      minutes,
      messages,
    });
  } catch {
    await sign("shield.busy.side_effect_failed", "Sending the busy-line alert failed.", { step: "alert", streak_id: streak.id });
  }
  await sign("shield.busy.alerted", `Phone busy for ${minutes} min, longer than usual; child alerted.`, {
    streak_id: streak.id,
    minutes,
    normal_minutes: Math.round(normal / 60_000),
  });
  try {
    await deps.scheduler.after(scaleDelay(BUSY_CIRCLE_AFTER_MS, deps.env), BUSY_JOBS.circle, {
      streak_id: streak.id,
      family_id: streak.familyId,
      parent_id: streak.parentId,
    });
  } catch {
    await sign("shield.busy.side_effect_failed", "Queueing the circle step failed.", { step: "circle_queue", streak_id: streak.id });
  }
  return true;
}

export async function recordCallStatus(deps: BusyDeps, raw: CallStatusInput): Promise<CallStatusResult> {
  const input = CallStatusInput.parse(raw);
  const { familyId, parentId, at } = input;
  let open = await deps.db.getOpenBusyStreak(familyId, parentId);

  if (input.status === "connected") {
    if (!open) return { streak: "unchanged", streakId: null, retryScheduled: false, alerted: false };
    const endedAt = at.getTime() < open.lastBusyAt.getTime() ? open.lastBusyAt : at;
    const closed = await deps.db.closeBusyStreak(open.id, endedAt, "connected");
    return { streak: closed ? "closed" : "unchanged", streakId: open.id, retryScheduled: false, alerted: false };
  }

  if (input.status !== "busy") {
    return { streak: "unchanged", streakId: open?.id ?? null, retryScheduled: false, alerted: false };
  }

  if (open && at.getTime() - open.lastBusyAt.getTime() > scaleDelay(BUSY_MAX_GAP_MS, deps.env)) {
    await deps.db.closeBusyStreak(open.id, open.lastBusyAt, "stale");
    open = null;
  }

  let streak: BusyStreak | null;
  let change: StreakChange;
  if (open) {
    streak = await deps.db.extendBusyStreak(open.id, at);
    change = "extended";
  } else {
    const started = await deps.db.startBusyStreak({ familyId, parentId, at });
    if (started.created) {
      streak = started.streak;
      change = "started";
    } else {
      // Another busy result opened the streak first.
      streak = await deps.db.extendBusyStreak(started.streak.id, at);
      change = "extended";
    }
  }
  if (!streak) {
    // Same or older busy result than the one already counted (webhook redelivery): no retry, no alert.
    return { streak: "duplicate", streakId: open?.id ?? null, retryScheduled: false, alerted: false };
  }

  const retryScheduled = input.inCheckinWindow ? await scheduleRetry(deps, input, streak.id) : false;
  const alerted = await maybeAlert(deps, streak, at);
  return { streak: change, streakId: streak.id, retryScheduled, alerted };
}

/* ------------------------------------------------------------------ child reply + circle job */

/** Riya tapped a button on (or otherwise answered) the busy alert. Stops the circle step. */
export async function recordBusyAlertReply(
  deps: Pick<BusyDeps, "db" | "clock">,
  input: { streakId: string; familyId: string; at?: Date },
): Promise<boolean> {
  return deps.db.markBusyAlertReplied(input.streakId, input.familyId, input.at ?? deps.clock.now());
}

export const BusyCirclePayload = z.object({
  streak_id: z.string().trim().min(1).max(200),
  family_id: z.string().trim().min(1).max(200),
  parent_id: z.string().trim().min(1).max(200),
});

export type BusyJobOutcome = "unknown_job" | "invalid_payload" | "not_found" | "replied" | "duplicate" | "circled" | "circle_failed";

/** Entry point for the Atlas cron tick, for job shield.busy.circle. Never throws for bad input. */
export async function handleBusyJob(name: string, payload: unknown, deps: BusyDeps): Promise<{ job: string; outcome: BusyJobOutcome }> {
  if (name !== BUSY_JOBS.circle) return { job: name, outcome: "unknown_job" };
  const parsed = BusyCirclePayload.safeParse(payload);
  if (!parsed.success) return { job: name, outcome: "invalid_payload" };
  const p = parsed.data;

  const streak = await deps.db.getBusyStreak(p.streak_id);
  if (!streak || streak.familyId !== p.family_id) return { job: name, outcome: "not_found" };
  if (streak.childRepliedAt) return { job: name, outcome: "replied" };
  if (!(await deps.db.claimBusyCircle(streak.id, deps.clock.now()))) {
    // Either already circled, or the reply landed between the read and the claim.
    const again = await deps.db.getBusyStreak(streak.id);
    return { job: name, outcome: again?.childRepliedAt ? "replied" : "duplicate" };
  }
  try {
    await deps.atlas.startCircleChain({ familyId: streak.familyId, parentId: streak.parentId, reason: "busy_line_no_reply" });
  } catch {
    await signSafe(deps, {
      familyId: streak.familyId,
      type: "shield.busy.side_effect_failed",
      line: "Starting the circle chain after the busy alert failed.",
      data: { step: "circle_chain", streak_id: streak.id },
    });
    return { job: name, outcome: "circle_failed" };
  }
  await signSafe(deps, {
    familyId: streak.familyId,
    type: "shield.busy.circled",
    line: "No reply to the busy-line alert in 5 min; the family circle was called.",
    data: { streak_id: streak.id },
  });
  return { job: name, outcome: "circled" };
}
