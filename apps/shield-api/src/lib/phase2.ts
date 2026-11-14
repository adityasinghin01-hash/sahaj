import { z } from "zod";
import {
  BUSY_JOBS,
  handleBusyJob,
  onChildFeedback,
  pickWeeklyTip,
  recordBusyAlertReply,
  recordCallStatus,
  type BusyDeps,
  type CallStatusResult,
  type ChildFeedbackResult,
  type WarningsDeps,
  type WeeklyTip,
} from "@sahaj/shield";

export const CallStatusInputSchema = z.object({
  family_id: z.string().uuid(),
  parent_id: z.string().uuid(),
  status: z.enum(["connected", "no_answer", "busy", "failed"]),
  in_checkin_window: z.boolean(),
  at: z.string().datetime({ offset: true }).optional(),
});

export const BusyReplyInputSchema = z.object({
  streak_id: z.string().uuid(),
  family_id: z.string().uuid(),
  at: z.string().datetime({ offset: true }).optional(),
});

export const ChildFeedbackInputSchema = z.object({
  verdict_id: z.string().uuid(),
  feedback: z.enum(["safe", "fraud"]),
  family_id: z.string().uuid().optional(),
});

export const WeeklyTipInputSchema = z.object({
  family_id: z.string().uuid(),
  now: z.string().datetime({ offset: true }).optional(),
});

const BusyRetryPayloadSchema = z.object({
  family_id: z.string().uuid(),
  parent_id: z.string().uuid(),
  streak_id: z.string().uuid(),
});

export interface VerdictFeedbackRow {
  id: string;
  family_id: string;
  parent_id: string;
  child_feedback: "safe" | "fraud" | null;
  feedback_at: string | null;
}

export interface Phase2Store {
  hasParentInFamily: (familyId: string, parentId: string) => Promise<boolean>;
  hasFamily: (familyId: string) => Promise<boolean>;
  withVerdictFeedbackLock: <T>(verdictId: string, fn: () => Promise<T>) => Promise<T>;
  getVerdictRow: (verdictId: string) => Promise<VerdictFeedbackRow | null>;
  setVerdictFeedbackIfUnset: (
    verdictId: string,
    feedback: "safe" | "fraud",
    at: Date,
  ) => Promise<VerdictFeedbackRow | null>;
  recordBusyRetryOutbox: (input: {
    jobId: string;
    familyId: string;
    parentId: string;
    streakId: string;
  }) => Promise<void>;
}

export type RecordCallStatusResponse =
  | {
      ok: true;
      family_id: string;
      parent_id: string;
      at: string;
      result: CallStatusResult;
    }
  | { ok: false; status: 404; error: "parent_not_found" };

export type RecordBusyReplyResponse =
  | {
      ok: true;
      streak_id: string;
      family_id: string;
      parent_id: string;
      replied: boolean;
    }
  | { ok: false; status: 404; error: "streak_not_found" }
  | { ok: false; status: 403; error: "family_mismatch" };

export type RecordFeedbackResponse =
  | {
      ok: true;
      verdict_id: string;
      family_id: string;
      parent_id: string;
      feedback: "safe" | "fraud";
      feedback_at: string;
      repeated: boolean;
      result: ChildFeedbackResult;
    }
  | { ok: false; status: 404; error: "verdict_not_found" }
  | { ok: false; status: 403; error: "family_mismatch" }
  | {
      ok: false;
      status: 409;
      error: "feedback_conflict";
      verdict_id: string;
      family_id: string;
      parent_id: string;
      persisted_feedback: "safe" | "fraud";
      feedback_at: string | null;
    };

export type WeeklyTipResponse =
  | {
      ok: true;
      family_id: string;
      as_of: string;
      simulated_checkin: true;
      note: string;
      tip: WeeklyTip;
    }
  | { ok: false; status: 404; error: "family_not_found" };

export function createKeyedAsyncMutex() {
  const tails = new Map<string, Promise<void>>();
  return async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prev.then(() => next);
    tails.set(key, chain);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === chain) {
        tails.delete(key);
      }
    }
  };
}

export function createPhase2Service(opts: {
  store: Phase2Store;
  busyDeps: BusyDeps;
  warningsDeps: WarningsDeps;
  clock: { now(): Date };
  fallbackHandleScheduledJob: (name: string, payload: unknown) => Promise<unknown>;
  /**
   * Places the real check-in retry call (Sarvam outbound, purpose "checkin", with
   * agent_variables family_id / parent_id / in_checkin_window=true / streak_id so the call-status
   * webhook loops back into the busy watch). Absent or `placed:false` → dev_outbox, as before.
   */
  placeCheckinRetry?: (input: { familyId: string; parentId: string; streakId: string; jobId: string }) =>
    Promise<{ placed: boolean }>;
}) {
  const { store, busyDeps, warningsDeps, clock } = opts;

  async function submitCallStatus(
    input: z.infer<typeof CallStatusInputSchema>,
  ): Promise<RecordCallStatusResponse> {
    const exists = await store.hasParentInFamily(input.family_id, input.parent_id);
    if (!exists) {
      return { ok: false, status: 404, error: "parent_not_found" };
    }
    const at = input.at ? new Date(input.at) : clock.now();
    const result = await recordCallStatus(busyDeps, {
      familyId: input.family_id,
      parentId: input.parent_id,
      status: input.status,
      inCheckinWindow: input.in_checkin_window,
      at,
    });
    return {
      ok: true,
      family_id: input.family_id,
      parent_id: input.parent_id,
      at: at.toISOString(),
      result,
    };
  }

  async function submitBusyReply(
    input: z.infer<typeof BusyReplyInputSchema>,
  ): Promise<RecordBusyReplyResponse> {
    const streak = await busyDeps.db.getBusyStreak(input.streak_id);
    if (!streak) {
      return { ok: false, status: 404, error: "streak_not_found" };
    }
    if (streak.familyId !== input.family_id) {
      return { ok: false, status: 403, error: "family_mismatch" };
    }
    const at = input.at ? new Date(input.at) : clock.now();
    const replied = await recordBusyAlertReply(busyDeps, {
      streakId: streak.id,
      familyId: streak.familyId,
      at,
    });
    return {
      ok: true,
      streak_id: streak.id,
      family_id: streak.familyId,
      parent_id: streak.parentId,
      replied,
    };
  }

  async function submitChildFeedback(
    input: z.infer<typeof ChildFeedbackInputSchema>,
  ): Promise<RecordFeedbackResponse> {
    return store.withVerdictFeedbackLock(input.verdict_id, async () => {
      const existing = await store.getVerdictRow(input.verdict_id);
      if (!existing) {
        return { ok: false, status: 404, error: "verdict_not_found" };
      }
      if (input.family_id && existing.family_id !== input.family_id) {
        return { ok: false, status: 403, error: "family_mismatch" };
      }

      if (existing.child_feedback !== null && existing.child_feedback !== input.feedback) {
        return {
          ok: false,
          status: 409,
          error: "feedback_conflict",
          verdict_id: existing.id,
          family_id: existing.family_id,
          parent_id: existing.parent_id,
          persisted_feedback: existing.child_feedback,
          feedback_at: existing.feedback_at,
        };
      }

      let current = existing;
      const repeated = existing.child_feedback === input.feedback;
      if (!repeated) {
        const at = clock.now();
        const inserted = await store.setVerdictFeedbackIfUnset(existing.id, input.feedback, at);
        if (!inserted) {
          const latest = await store.getVerdictRow(existing.id);
          if (!latest) return { ok: false, status: 404, error: "verdict_not_found" };
          if (latest.child_feedback && latest.child_feedback !== input.feedback) {
            return {
              ok: false,
              status: 409,
              error: "feedback_conflict",
              verdict_id: latest.id,
              family_id: latest.family_id,
              parent_id: latest.parent_id,
              persisted_feedback: latest.child_feedback,
              feedback_at: latest.feedback_at,
            };
          }
          current = latest;
        } else {
          current = inserted;
        }
      }

      const result = await onChildFeedback(warningsDeps, {
        verdictId: current.id,
        feedback: input.feedback,
      });

      return {
        ok: true,
        verdict_id: current.id,
        family_id: current.family_id,
        parent_id: current.parent_id,
        feedback: input.feedback,
        feedback_at: current.feedback_at ?? clock.now().toISOString(),
        repeated,
        result,
      };
    });
  }

  async function fetchWeeklyTip(
    input: z.infer<typeof WeeklyTipInputSchema>,
  ): Promise<WeeklyTipResponse> {
    const exists = await store.hasFamily(input.family_id);
    if (!exists) {
      return { ok: false, status: 404, error: "family_not_found" };
    }
    const now = input.now ? new Date(input.now) : clock.now();
    const tip = await pickWeeklyTip({ db: warningsDeps.db }, { familyId: input.family_id, now });
    return {
      ok: true,
      family_id: input.family_id,
      as_of: now.toISOString(),
      simulated_checkin: true,
      note: "Check-in call delivery belongs to Singhal's check-in caller; this endpoint returns weekly tip text only.",
      tip,
    };
  }

  async function dispatchScheduledJob(name: string, payload: unknown, jobId: string): Promise<unknown> {
    if (name === BUSY_JOBS.circle) {
      return handleBusyJob(name, payload, busyDeps);
    }
    if (name === BUSY_JOBS.retry) {
      const parsed = BusyRetryPayloadSchema.safeParse(payload);
      if (!parsed.success) {
        return { job: BUSY_JOBS.retry, outcome: "invalid_payload" as const };
      }
      const streak = await busyDeps.db.getBusyStreak(parsed.data.streak_id);
      if (
        !streak ||
        streak.familyId !== parsed.data.family_id ||
        streak.parentId !== parsed.data.parent_id
      ) {
        return { job: BUSY_JOBS.retry, outcome: "not_found" as const };
      }
      if (streak.endedAt || streak.childRepliedAt) {
        return { job: BUSY_JOBS.retry, outcome: "already_resolved" as const };
      }
      if (opts.placeCheckinRetry) {
        const placed = await opts.placeCheckinRetry({
          familyId: streak.familyId, parentId: streak.parentId, streakId: streak.id, jobId,
        });
        if (placed.placed) {
          await busyDeps.sign({
            familyId: streak.familyId,
            type: "shield.busy.retry_call_placed",
            line: "Check-in retry call placed.",
            data: { streak_id: streak.id, parent_id: streak.parentId, simulated: false },
          });
          return { job: BUSY_JOBS.retry, outcome: "call_placed" as const, streak_id: streak.id };
        }
      }
      await store.recordBusyRetryOutbox({
        jobId,
        familyId: streak.familyId,
        parentId: streak.parentId,
        streakId: streak.id,
      });
      await busyDeps.sign({
        familyId: streak.familyId,
        type: "shield.busy.retry_requested",
        line: "Simulated check-in retry request recorded in dev_outbox.",
        data: { streak_id: streak.id, parent_id: streak.parentId, simulated: true },
      });
      return {
        job: BUSY_JOBS.retry,
        outcome: "outbox_simulated" as const,
        streak_id: streak.id,
      };
    }
    return opts.fallbackHandleScheduledJob(name, payload);
  }

  return {
    submitCallStatus,
    submitBusyReply,
    submitChildFeedback,
    fetchWeeklyTip,
    dispatchScheduledJob,
  };
}
