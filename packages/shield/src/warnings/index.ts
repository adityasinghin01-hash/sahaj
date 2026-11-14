export {
  fingerprint,
  numberFingerprint,
  normalise,
  normaliseNumber,
  normaliseTemplate,
  registrableDomain,
  FINGERPRINT_RE,
  MIN_TEMPLATE_CHARS,
  type IndicatorKind,
} from "./fingerprint";
export { cleanSummary, fallbackSummary, summarise, FALLBACK_SUMMARY, SUMMARY_MAX, type SummaryLines } from "./summary";
export {
  onChildFeedback,
  pickWeeklyTip,
  ChildFeedbackInput,
  CONFIRM_MIN_FAMILIES,
  TIP_LOOKBACK_MS,
  DEFAULT_TIP,
  type ChildFeedbackResult,
  type FeedbackVerdict,
  type IndicatorRecord,
  type RecordIndicatorInput,
  type TopIndicator,
  type WarningsDb,
  type WarningsDeps,
  type WeeklyTip,
} from "./feedback";
