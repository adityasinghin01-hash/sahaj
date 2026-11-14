/**
 * Shared scam warnings (Core 3 Step 2.5).
 * - onChildFeedback: the child marks a verdict "fraud" → its link domains, masked message template
 *   and (if the phone sent one) number fingerprint become shared indicators. "safe" adds nothing.
 * - pickWeeklyTip: the most-seen confirmed indicator of the last 7 days, across all families, as the
 *   check-in agent's `fraud_tip` (no personal data: only the summary lines are used).
 */
import { z } from "zod";
import type { ShieldDeps } from "../tools/types";
import { toScamType } from "../tools/runtime";
import { fingerprint, FINGERPRINT_RE, type IndicatorKind } from "./fingerprint";
import { cleanSummary, fallbackSummary, summarise, type SummaryLines } from "./summary";

/** An indicator is confirmed (shown as a tip to every family) once this many families reported it. */
export const CONFIRM_MIN_FAMILIES = 2;
export const TIP_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
/** Caps per verdict, so one odd event cannot write hundreds of rows. */
const MAX_DOMAINS = 10;
const MAX_TEMPLATES = 3;
const MAX_NUMBERS = 3;

/* ------------------------------------------------------------------ interfaces */

export interface FeedbackVerdict {
  id: string;
  familyId: string;
  scamType: string;
  /** What is stored on the verdict row, if anything. */
  childFeedback: "safe" | "fraud" | null;
  /** From the verdict's events. */
  linkDomains: string[];
  maskedTexts: string[];
  /** Event context `number_fingerprint` values the phone sent (hex SHA-256 of the last 10 digits). */
  numberFingerprints: string[];
}

export interface RecordIndicatorInput {
  kind: IndicatorKind;
  fingerprint: string;
  scamType: string;
  summaryHi: string;
  summaryEn: string;
  familyId: string;
  verdictId: string;
  seenAt: Date;
  confirmMinFamilies: number;
}

export interface IndicatorRecord {
  id: string;
  timesSeen: number;
  familiesAffected: number;
  confirmed: boolean;
  /** False when this verdict had already been counted for this indicator. */
  counted: boolean;
}

export interface TopIndicator {
  scamType: string;
  summaryHi: string;
  summaryEn: string;
  recentSightings: number;
}

/** Implemented by createWarningsPg (src/db). */
export interface WarningsDb {
  getVerdictForFeedback(verdictId: string): Promise<FeedbackVerdict | null>;
  recordScamIndicator(input: RecordIndicatorInput): Promise<IndicatorRecord>;
  /** The confirmed indicator with the most sightings in (since, until]. */
  topConfirmedIndicator(since: Date, until: Date): Promise<TopIndicator | null>;
}

export interface WarningsDeps {
  db: WarningsDb;
  llm: ShieldDeps["llm"];
  clock: ShieldDeps["clock"];
}

/* ------------------------------------------------------------------ onChildFeedback */

export const ChildFeedbackInput = z.object({
  verdictId: z.string().trim().min(1).max(200),
  feedback: z.enum(["fraud", "safe"]),
});
export type ChildFeedbackInput = z.infer<typeof ChildFeedbackInput>;

export interface ChildFeedbackResult {
  outcome: "ignored_safe" | "not_found" | "feedback_mismatch" | "recorded";
  indicators: { kind: IndicatorKind; id: string; counted: boolean; familiesAffected: number; confirmed: boolean }[];
  summarySource?: "llm" | "fallback";
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

async function fingerprints(kind: IndicatorKind, values: string[], max: number): Promise<string[]> {
  const out: string[] = [];
  for (const v of values) {
    const fp = await fingerprint(kind, v);
    if (fp && !out.includes(fp)) out.push(fp);
    if (out.length >= max) break;
  }
  return out;
}

export async function onChildFeedback(deps: WarningsDeps, raw: ChildFeedbackInput): Promise<ChildFeedbackResult> {
  const input = ChildFeedbackInput.parse(raw);
  if (input.feedback === "safe") return { outcome: "ignored_safe", indicators: [] };

  const verdict = await deps.db.getVerdictForFeedback(input.verdictId);
  if (!verdict) return { outcome: "not_found", indicators: [] };
  // The stored answer wins: if the row says "safe", a stale "fraud" call must not publish anything.
  if (verdict.childFeedback === "safe") return { outcome: "feedback_mismatch", indicators: [] };

  const texts = verdict.maskedTexts.filter((t) => typeof t === "string" && t.trim() !== "");
  const wanted: { kind: IndicatorKind; fp: string }[] = [
    ...(await fingerprints("domain", uniq(verdict.linkDomains), MAX_DOMAINS)).map((fp) => ({ kind: "domain" as const, fp })),
    ...(await fingerprints("template", uniq(texts), MAX_TEMPLATES)).map((fp) => ({ kind: "template" as const, fp })),
    ...uniq(verdict.numberFingerprints.map((f) => f.trim().toLowerCase()))
      .filter((f) => FINGERPRINT_RE.test(f))
      .slice(0, MAX_NUMBERS)
      .map((fp) => ({ kind: "number" as const, fp })),
  ];
  if (wanted.length === 0) return { outcome: "recorded", indicators: [] };

  const scamType = toScamType(verdict.scamType);
  const { lines, source } = await summarise(deps, texts[0] ?? null, scamType);
  const seenAt = deps.clock.now();

  const indicators: ChildFeedbackResult["indicators"] = [];
  for (const w of wanted) {
    const rec = await deps.db.recordScamIndicator({
      kind: w.kind,
      fingerprint: w.fp,
      scamType,
      summaryHi: lines.summary_hi,
      summaryEn: lines.summary_en,
      familyId: verdict.familyId,
      verdictId: verdict.id,
      seenAt,
      confirmMinFamilies: CONFIRM_MIN_FAMILIES,
    });
    indicators.push({ kind: w.kind, id: rec.id, counted: rec.counted, familiesAffected: rec.familiesAffected, confirmed: rec.confirmed });
  }
  return { outcome: "recorded", indicators, summarySource: source };
}

/* ------------------------------------------------------------------ pickWeeklyTip */

export interface WeeklyTip {
  fraud_tip_hi: string;
  fraud_tip_en: string;
}

/** Used when no confirmed indicator was seen in the last 7 days. */
export const DEFAULT_TIP: WeeklyTip = {
  fraud_tip_hi: fallbackSummary("unknown").summary_hi,
  fraud_tip_en: fallbackSummary("unknown").summary_en,
};

function tipFrom(lines: SummaryLines): WeeklyTip {
  return { fraud_tip_hi: lines.summary_hi, fraud_tip_en: lines.summary_en };
}

/**
 * `familyId` is accepted for the check-in agent's call shape; the tip itself is the same for every
 * family and never contains anything family-specific.
 */
export async function pickWeeklyTip(
  deps: Pick<WarningsDeps, "db">,
  input: { familyId: string; now: Date },
): Promise<WeeklyTip> {
  const since = new Date(input.now.getTime() - TIP_LOOKBACK_MS);
  const top = await deps.db.topConfirmedIndicator(since, input.now);
  if (!top) return DEFAULT_TIP;
  const fallback = fallbackSummary(top.scamType);
  // Re-checked on the way out, in case a row was written by something other than onChildFeedback.
  return tipFrom({
    summary_hi: cleanSummary(top.summaryHi) ?? fallback.summary_hi,
    summary_en: cleanSummary(top.summaryEn) ?? fallback.summary_en,
  });
}
