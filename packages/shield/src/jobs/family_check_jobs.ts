/**
 * Timed steps of the voice family check, run from the database scheduler (Atlas: one DB row per
 * job + the 30 s cron tick). Nothing here keeps a timer in memory, so a restart loses nothing.
 *
 * - shield.family_check.escalate  (60 s after the WhatsApp card went out)
 *     still "asked" → escalateFamilyCheck (responder call). Answered → nothing.
 * - shield.family_check.callback  (2 min after the 2nd pending family_check_result)
 *     confirmed / denied → call Maa back with the matching line.
 *     still pending      → mark no_answer, call Maa back with the no-answer line, alert the child.
 *
 * Every job is idempotent: the first run claims a key in the job ledger and a second run with the
 * same payload does nothing extra.
 */
import { z } from "zod";
import { escalateFamilyCheck, scheduleCallback } from "../tools/family_check";
import { GENERIC_FAMILY } from "../tools/lines";
import { alertChild, makeVerdict, safeSign } from "../tools/runtime";
import type { FamilyCheckRecord, ShieldDeps, ToolCtx } from "../tools/types";
import { CALLBACK_LINES } from "../messages/callback_lines";

/* ------------------------------------------------------------------ interfaces Atlas implements */

/** Durable delayed job. Atlas implements it with a DB row picked up by the 30 s cron tick. */
export interface Scheduler {
  after(ms: number, job: string, payload: Record<string, unknown>): Promise<void>;
}

/**
 * Run-once ledger. `claim(key)` returns true the first time a key is seen and false after that,
 * e.g. `insert into … (key) values ($1) on conflict do nothing returning key`.
 */
export interface JobLedger {
  claim(key: string): Promise<boolean>;
}

export type Env = Record<string, string | undefined>;

/** Deps for handleShieldToolJob: the tool deps plus the ledger and one extra DB write. */
export interface ShieldJobDeps extends ShieldDeps {
  jobs: JobLedger;
  db: ShieldDeps["db"] & {
    /**
     * Sets state = 'no_answer' only while the check is still 'asked' (one conditional UPDATE).
     * Returns true if this call changed the row.
     */
    markFamilyCheckNoAnswer(checkId: string, at: Date): Promise<boolean>;
  };
  /** Optional: the child's first name for the no-answer line ("Riya ko bata diya hai"). */
  childName?(familyId: string): Promise<string | null>;
}

/* ------------------------------------------------------------------ names, delays */

export const SHIELD_JOBS = {
  escalate: "shield.family_check.escalate",
  callback: "shield.family_check.callback",
} as const;
export type ShieldJobName = (typeof SHIELD_JOBS)[keyof typeof SHIELD_JOBS];

export const ESCALATE_AFTER_MS = 60_000;
export const CALLBACK_AFTER_MS = 120_000;

export function isShieldJobName(name: string): name is ShieldJobName {
  return name === SHIELD_JOBS.escalate || name === SHIELD_JOBS.callback;
}

function defaultEnv(): Env {
  const proc = (globalThis as { process?: { env?: Env } }).process;
  return proc?.env ?? {};
}

/** DEMO_TIMER_SCALE (default 1) divides every delay. Missing, non-numeric or ≤ 0 counts as 1. */
export function timerScale(env: Env = defaultEnv()): number {
  const raw = env.DEMO_TIMER_SCALE;
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function scaleDelay(ms: number, env: Env = defaultEnv()): number {
  return Math.max(0, Math.round(ms / timerScale(env)));
}

/* ------------------------------------------------------------------ payload */

export const FamilyCheckJobPayload = z.object({
  check_id: z.string().trim().min(1).max(200),
  family_id: z.string().trim().min(1).max(200),
  parent_id: z.string().trim().min(1).max(200),
});
export type FamilyCheckJobPayload = z.infer<typeof FamilyCheckJobPayload>;

export function familyCheckJobPayload(checkId: string, ctx: ToolCtx): FamilyCheckJobPayload {
  return { check_id: checkId, family_id: ctx.familyId, parent_id: ctx.parentId };
}

export function jobKey(job: ShieldJobName, checkId: string): string {
  return `${job}:${checkId}`;
}

/* ------------------------------------------------------------------ handlers */

export type ShieldJobOutcome =
  | "unknown_job"
  | "invalid_payload"
  | "not_found"
  | "already_answered"
  | "duplicate"
  | "escalated"
  | "escalate_failed"
  | "callback_confirmed"
  | "callback_denied"
  | "callback_no_answer"
  | "callback_failed";

export interface ShieldJobResult {
  job: string;
  outcome: ShieldJobOutcome;
}

async function loadCheck(deps: ShieldDeps, p: FamilyCheckJobPayload): Promise<FamilyCheckRecord | null> {
  const rec = await deps.db.getFamilyCheck(p.check_id);
  // A check from another family is treated as missing.
  if (!rec || (rec.familyId !== undefined && rec.familyId !== p.family_id)) return null;
  return rec;
}

async function runEscalate(deps: ShieldJobDeps, p: FamilyCheckJobPayload): Promise<ShieldJobOutcome> {
  const rec = await loadCheck(deps, p);
  if (!rec) return "not_found";
  if (rec.state !== "asked") return "already_answered";
  if (!(await deps.jobs.claim(jobKey(SHIELD_JOBS.escalate, p.check_id)))) return "duplicate";
  const res = await escalateFamilyCheck(deps, p.check_id);
  if (res.escalated) return "escalated";
  return res.reason === "already_answered" ? "already_answered" : res.reason === "not_found" ? "not_found" : "escalate_failed";
}

async function runCallback(deps: ShieldJobDeps, p: FamilyCheckJobPayload): Promise<ShieldJobOutcome> {
  let rec = await loadCheck(deps, p);
  if (!rec) return "not_found";
  if (!(await deps.jobs.claim(jobKey(SHIELD_JOBS.callback, p.check_id)))) return "duplicate";

  const ctx: ToolCtx = { familyId: p.family_id, parentId: p.parent_id };

  if (rec.state === "asked") {
    const changed = await deps.db.markFamilyCheckNoAnswer(p.check_id, deps.clock.now());
    if (!changed) {
      // Answered between the read and the write: use the answer.
      rec = (await loadCheck(deps, p)) ?? rec;
    } else {
      rec = { ...rec, state: "no_answer" };
      await safeSign(deps, {
        familyId: ctx.familyId,
        type: "shield.voice.family_check_no_answer",
        line: "No answer to the family check after the wait; marked as no answer.",
        data: { check_id: p.check_id },
      });
    }
  }

  const name = rec.claimedName || GENERIC_FAMILY;
  if (rec.state === "confirmed") {
    const { ok } = await scheduleCallback(deps, ctx, CALLBACK_LINES.confirmed(name));
    return ok ? "callback_confirmed" : "callback_failed";
  }
  if (rec.state === "denied") {
    const { ok } = await scheduleCallback(deps, ctx, CALLBACK_LINES.denied(name));
    return ok ? "callback_denied" : "callback_failed";
  }

  // asked (could not be marked) or no_answer.
  let child: string | null = null;
  try {
    child = (await deps.childName?.(ctx.familyId)) ?? null;
  } catch {
    child = null;
  }
  const { ok } = await scheduleCallback(deps, ctx, CALLBACK_LINES.noAnswer(child?.trim() || null));
  await alertChild(
    deps,
    ctx,
    makeVerdict({
      level: "yellow",
      scam_type: "family_in_trouble",
      rule_id: "voice.family_check.no_answer",
      hi: `${name} ne pakka nahi kiya ki Maa ko call karne wale woh the. Maa ko paise na bhejne ko kaha.`,
      en: `${name} did not confirm being the caller who asked Maa for something. Maa was told not to send money.`,
      actions: ["speak_clip", "alert_child"],
    }),
  );
  return ok ? "callback_no_answer" : "callback_failed";
}

/**
 * Entry point for the Atlas cron tick. Never throws for a bad payload or unknown job; returns
 * the outcome so Atlas can log it. Running the same job twice does nothing extra.
 */
export async function handleShieldToolJob(
  name: string,
  payload: unknown,
  deps: ShieldJobDeps,
): Promise<ShieldJobResult> {
  if (!isShieldJobName(name)) return { job: name, outcome: "unknown_job" };
  const parsed = FamilyCheckJobPayload.safeParse(payload);
  if (!parsed.success) return { job: name, outcome: "invalid_payload" };
  const outcome = name === SHIELD_JOBS.escalate ? await runEscalate(deps, parsed.data) : await runCallback(deps, parsed.data);
  return { job: name, outcome };
}
