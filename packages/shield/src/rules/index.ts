// Shield rules — pure checks over rules/rules.json (no I/O, no network).
export { RULES, RAW_RULES, RulesFileSchema, compile, SCRIPT_TYPE_IDS } from "./config";
export type { RulesFile, ScriptTypeId, ReasonText } from "./config";
export { normalizeText, asciiDigits } from "./text";
export { senderType, callerType } from "./sender";
export type { SenderType, CallerType, ContactOpts } from "./sender";
export { findLinks, registrableDomain, hostOf, isShortener, isApk, lookAlike, lookAlikeDetail } from "./links";
export type { FoundLink, LookAlikeResult } from "./links";
export { isOtp, findOtpCodes } from "./otp";
export { mask } from "./mask";
export { scoreText, hasTopicWords } from "./score";
export type { TextScore, RuleHit } from "./score";
export {
  findPatterns,
  evaluatePatterns,
  evaluatePhase2Patterns,
  checkP1,
  checkP5,
  checkP2Call,
  checkP2Notification,
  checkP3Notification,
  checkP3Install,
  checkP4Install,
  checkP9,
} from "./patterns";
export type {
  RuleEvent,
  RuleSmsEvent,
  RuleCallEvent,
  RuleAppOpenEvent,
  RuleNotificationEvent,
  RuleInstallEvent,
  PatternHit,
  Timestamp,
} from "./patterns";
export { buildVerdict } from "./verdict";
export type { VerdictInput, RuleVerdict } from "./verdict";

