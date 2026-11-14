import { z, type ZodType } from "zod";
import { ScamType, type AlertLevel, type ShieldAction, type Verdict } from "@sahaj/shared";
import type { ShieldDeps, ShieldTool, ToolCtx } from "./types";

/** Core 3 limit: a tool must answer within 3 s. */
export const TOOL_LIMIT_MS = 3000;
/** Hard budget for every handler: 200 ms under the limit, leaving room for validation and serialising the reply. */
export const TOOL_TIMEOUT_MS = 2800;
/** Soft budget for the LLM inside a handler, so a slow model falls back to the rules result, not the generic line. */
export const LLM_BUDGET_MS = 2000;

export const TIMED_OUT: unique symbol = Symbol("timed_out");

export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type SignEvent = Parameters<ShieldDeps["sign"]>[0];

/** Timeline write that never breaks the call: a failed sign must not stop Maa hearing the line. */
export async function safeSign(deps: ShieldDeps, event: SignEvent): Promise<void> {
  try {
    await deps.sign(event);
  } catch {
    // Swallowed on purpose. The timeline writer is responsible for its own retries.
  }
}

/** Fire-and-forget side effect (e.g. a bridge call that waits on a human). Failures are signed, never thrown. */
export function background(deps: ShieldDeps, ctx: ToolCtx, label: string, work: () => Promise<void>): void {
  void (async () => {
    try {
      await work();
    } catch {
      await safeSign(deps, {
        familyId: ctx.familyId,
        type: "shield.voice.side_effect_failed",
        line: `Background step "${label}" failed.`,
        data: { step: label },
      });
    }
  })();
}

const LEVEL_RANK: Record<AlertLevel, number> = { green: 0, yellow: 1, red: 2 };
export function maxLevel(a: AlertLevel, b: AlertLevel): AlertLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

export function toScamType(value: string): ScamType {
  const parsed = ScamType.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

export function makeVerdict(p: {
  level: AlertLevel;
  scam_type: string;
  rule_id: string;
  hi: string;
  en: string;
  checks_fired?: string[];
  ai_used?: boolean;
  models_agreed?: string[];
  confidence?: number;
  actions: ShieldAction[];
}): Verdict {
  return {
    level: p.level,
    scam_type: toScamType(p.scam_type),
    reasons: [{ rule_id: p.rule_id, hi: p.hi, en: p.en }],
    checks_fired: p.checks_fired ?? [],
    ai_used: p.ai_used ?? false,
    models_agreed: p.models_agreed ?? [],
    confidence: p.confidence ?? 1,
    actions: p.actions,
  };
}

/** Alert the child; a failure is signed but never blocks the spoken line. */
export async function alertChild(deps: ShieldDeps, ctx: ToolCtx, verdict: Verdict): Promise<void> {
  try {
    await deps.atlas.alertChild({ familyId: ctx.familyId, parentId: ctx.parentId, verdict });
  } catch {
    await safeSign(deps, {
      familyId: ctx.familyId,
      type: "shield.voice.side_effect_failed",
      line: "Alerting the child failed.",
      data: { step: "alert_child", level: verdict.level },
    });
  }
}

/**
 * Wraps a handler so that run():
 * - validates input with the tool's Zod schema,
 * - always resolves within TOOL_TIMEOUT_MS,
 * - returns the tool's safe fallback on timeout, invalid input or any thrown error (and signs that).
 */
export function defineTool<S extends ZodType, O>(def: {
  name: string;
  description: string;
  input: S;
  fallback: () => O;
  handler: (deps: ShieldDeps, ctx: ToolCtx, input: z.output<S>) => Promise<O>;
}): ShieldTool<S, O> {
  return {
    name: def.name,
    description: def.description,
    input: def.input,
    async run(deps, ctx, raw) {
      const work = (async () => def.handler(deps, ctx, def.input.parse(raw)))();
      work.catch(() => undefined); // late rejections after a timeout must not become unhandled
      let reason: "timeout" | "invalid_input" | "error";
      try {
        const result = await withTimeout(work, TOOL_TIMEOUT_MS);
        if (result !== TIMED_OUT) return result;
        reason = "timeout";
      } catch (err) {
        reason = err instanceof z.ZodError ? "invalid_input" : "error";
      }
      // Not awaited: the fallback must go out even if the timeline writer is the thing that is hanging.
      void safeSign(deps, {
        familyId: ctx.familyId,
        type: `shield.voice.${def.name}.fallback`,
        line: `Tool ${def.name} used the safe fallback line (${reason}).`,
        data: { reason, line_id: 1 },
      });
      return def.fallback();
    },
  };
}
