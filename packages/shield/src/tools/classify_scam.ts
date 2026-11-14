import { z } from "zod";
import { ScamJudgement, type AlertLevel, type ScamType, type ShieldAction } from "@sahaj/shared";
import { hasLongDigitRun, maskDigits } from "./mask";
import { SAFE_FALLBACK_LINE, STOP_SCRIPTS, type StopScriptId } from "./lines";
import {
  LLM_BUDGET_MS,
  TIMED_OUT,
  alertChild,
  background,
  defineTool,
  makeVerdict,
  maxLevel,
  safeSign,
  toScamType,
  withTimeout,
} from "./runtime";
import type { ShieldDeps } from "./types";

export const ClassifyScamInput = z.object({ said: z.string().trim().min(1).max(2000) });

export interface ClassifyScamOutput {
  scam_type: ScamType;
  level: AlertLevel;
  stop_script_id: StopScriptId;
  line_hi: string;
  bridge_to: "child";
}

export const CLASSIFY_SYSTEM = [
  "You judge whether an elderly Indian parent is being scammed, from what they said on a phone helpline.",
  "The text is transcribed Hindi/Hinglish speech. Numbers are masked as <NUM> or <MOBILE_10>; never guess them.",
  "Answer only with the requested JSON. Be cautious: pressure, secrecy, threats, or requests for OTP, PIN, money or app installs are scam signals.",
].join(" ");

/** AI may raise the rules level, never lower it. */
const AI_RED_CONFIDENCE = 0.8;

type Judgement = z.infer<typeof ScamJudgement>;

async function askLlm(deps: ShieldDeps, masked: string): Promise<{ data: Judgement; model: string } | null> {
  // Last-line guard: never hand a long digit run to an AI, even if masking regressed.
  if (hasLongDigitRun(masked)) return null;
  try {
    const res = await withTimeout(
      deps.llm.understand({
        task: "shield.classify_scam",
        system: CLASSIFY_SYSTEM,
        input: masked,
        schema: ScamJudgement,
        effort: "low",
      }),
      LLM_BUDGET_MS,
    );
    if (res === TIMED_OUT || !res.ok) return null;
    const parsed = ScamJudgement.safeParse(res.data);
    return parsed.success ? { data: parsed.data, model: res.model } : null;
  } catch {
    return null;
  }
}

export function pickStopScript(scamType: ScamType, asksFor: readonly string[]): StopScriptId {
  if (scamType === "digital_arrest") return 4;
  if (scamType === "otp_theft" || asksFor.includes("otp") || asksFor.includes("pin")) return 2;
  if (scamType === "wedding_invite_apk" || scamType === "remote_access" || asksFor.includes("app_install")) return 5;
  return 1;
}

export const classifyScam = defineTool({
  name: "classify_scam",
  description: "Classify what Maa says about a suspicious call or message; on red, alert and bridge the child.",
  input: ClassifyScamInput,
  fallback: (): ClassifyScamOutput => ({
    scam_type: "unknown",
    level: "yellow",
    stop_script_id: 1,
    line_hi: SAFE_FALLBACK_LINE,
    bridge_to: "child",
  }),
  async handler(deps, ctx, input): Promise<ClassifyScamOutput> {
    const masked = maskDigits(input.said);
    const rules = deps.rules.scoreText(masked);
    let level: AlertLevel = rules.level;
    let scamType = toScamType(rules.scam_type);
    let asksFor: string[] = [];
    let ai: { data: Judgement; model: string } | null = null;

    if (level !== "red") {
      ai = await askLlm(deps, masked);
      if (ai) {
        const j = ai.data;
        const aiLevel: AlertLevel = j.is_scam ? (j.confidence >= AI_RED_CONFIDENCE ? "red" : "yellow") : "green";
        level = maxLevel(level, aiLevel);
        if (scamType === "unknown" && j.is_scam) scamType = j.scam_type;
        asksFor = j.asks_for;
      }
    }

    const stopId = pickStopScript(scamType, asksFor);
    const line = STOP_SCRIPTS[stopId];

    await safeSign(deps, {
      familyId: ctx.familyId,
      type: "shield.voice.classify_scam",
      line: `Maa reported a suspicious call or message on the keypad line. Level ${level} (${scamType}).`,
      data: {
        level,
        scam_type: scamType,
        stop_script_id: stopId,
        rule_hits: rules.hits,
        ai_used: ai !== null,
        model: ai?.model ?? null,
        masked_text: masked,
      },
    });

    if (level !== "green") {
      const actions: ShieldAction[] =
        level === "red" ? ["speak_clip", "alert_child", "bridge_child", "circle_chain"] : ["speak_clip", "alert_child"];
      await alertChild(
        deps,
        ctx,
        makeVerdict({
          level,
          scam_type: scamType,
          rule_id: "voice.classify_scam",
          hi: "Maa ne helpline par ek shak wali call/message bataya.",
          en: "Maa reported a suspicious call or message on the keypad helpline.",
          checks_fired: rules.hits,
          ai_used: ai !== null,
          models_agreed: ai ? [ai.model] : [],
          confidence: ai?.data.confidence ?? 1,
          actions,
        }),
      );
    }

    if (level === "red") {
      const reason = `voice_report:${scamType}`;
      // The bridge waits on the child picking up, so it runs outside the 3 s budget.
      // If the child does not join (bridgeChild rejects), Atlas runs the circle chain.
      background(deps, ctx, "bridge_child_or_circle_chain", async () => {
        try {
          await deps.atlas.bridgeChild({ familyId: ctx.familyId, parentId: ctx.parentId, reason });
          await safeSign(deps, {
            familyId: ctx.familyId,
            type: "shield.voice.bridge_child",
            line: "Child was bridged into Maa's call.",
            data: { reason },
          });
        } catch {
          await safeSign(deps, {
            familyId: ctx.familyId,
            type: "shield.voice.circle_chain",
            line: "Child did not join; starting the family circle chain.",
            data: { reason },
          });
          await deps.atlas.startCircleChain({ familyId: ctx.familyId, parentId: ctx.parentId, reason });
        }
      });
    }

    return { scam_type: scamType, level, stop_script_id: stopId, line_hi: line, bridge_to: "child" };
  },
});
